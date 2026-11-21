/**
 * Speaker diarization: pyannote segmentation-3.0 (MIT) for local speaker
 * activity in 10 s windows, 3D-Speaker CAM++ zh-cn (Apache-2.0) embeddings of
 * each local speaker, complete-linkage clustering, then pyannote's
 * reconstruction. A TypeScript port of sherpa-onnx's
 * `OfflineSpeakerDiarizationPyannoteImpl` (Apache-2.0), on onnxruntime-web.
 */
import type { EdgeContext } from "../context.js";
import { createSession, loadOrt, type OrtSession } from "../ml/ort.js";
import { metaInt, readOnnxMetadata } from "../ml/onnx-meta.js";
import { fetchModelFile } from "../models/hub.js";
import { CAMPLUS_ZH, PYANNOTE_SEGMENTATION } from "../models/registry.js";
import { checkpoint } from "./checkpoint.js";
import { clusterEmbeddings, normalizeRows } from "./cluster.js";
import { Fbank, SPEAKER_FBANK } from "./fbank.js";

export interface SpeakerSegment {
    speaker: number;
    start: number;
    end: number;
}

export interface DiarizeOptions {
    /** Known number of speakers; otherwise the threshold decides. */
    numSpeakers?: number;
    /** Clustering threshold on cosine distance (sherpa-onnx default 0.5). */
    threshold?: number;
    /** Drop segments shorter than this (s). */
    minDurationOn?: number;
    /** Merge same-speaker segments closer than this (s). */
    minDurationOff?: number;
}

interface SegMeta {
    sampleRate: number;
    windowSize: number;
    windowShift: number;
    rfSize: number;
    rfShift: number;
    numSpeakers: number;
    powerset: Int8Array[]; // class → speaker activity
}

/** Powerset class → multi-label speaker activity (pyannote `Powerset`). */
export function powersetMapping(numClasses: number, numSpeakers: number, maxClasses: number): Int8Array[] {
    const map: Int8Array[] = Array.from({ length: numClasses }, () => new Int8Array(numSpeakers));
    let k = 1;
    for (let i = 1; i <= maxClasses; i++) {
        if (i === 1) {
            for (let j = 0; j < numSpeakers; j++, k++) map[k]![j] = 1;
        } else if (i === 2) {
            for (let j = 0; j < numSpeakers; j++) {
                for (let m = j + 1; m < numSpeakers; m++, k++) {
                    map[k]![j] = 1;
                    map[k]![m] = 1;
                }
            }
        } else {
            throw new Error(`powerset_max_classes ${maxClasses} is not supported`);
        }
    }
    return map;
}

/** One chunk's 0/1 activity, row-major [frames × speakers]. */
interface ChunkLabels {
    frames: number;
    data: Int8Array;
}

class Models {
    constructor(
        readonly seg: OrtSession,
        readonly emb: OrtSession,
        readonly meta: SegMeta,
        readonly embDim: number,
        readonly globalMean: boolean,
        readonly ort: typeof import("onnxruntime-web"),
    ) {}
}

let modelsPromise: Promise<Models> | null = null;

async function loadModels(ctx: EdgeContext): Promise<Models> {
    modelsPromise ??= (async () => {
        const [segBytes, embBytes] = await Promise.all([
            fetchModelFile(ctx, PYANNOTE_SEGMENTATION, PYANNOTE_SEGMENTATION.files.model),
            fetchModelFile(ctx, CAMPLUS_ZH, CAMPLUS_ZH.files.model),
        ]);
        const sm = readOnnxMetadata(segBytes);
        const em = readOnnxMetadata(embBytes);
        const windowSize = metaInt(sm, "window_size");
        const meta: SegMeta = {
            sampleRate: metaInt(sm, "sample_rate"),
            windowSize,
            windowShift: Math.max(1, Math.floor(0.1 * windowSize)), // sherpa window_shift_ratio 0.1
            rfSize: metaInt(sm, "receptive_field_size"),
            rfShift: metaInt(sm, "receptive_field_shift"),
            numSpeakers: metaInt(sm, "num_speakers"),
            powerset: powersetMapping(metaInt(sm, "num_classes"), metaInt(sm, "num_speakers"), metaInt(sm, "powerset_max_classes")),
        };
        if (meta.sampleRate !== 16000 || metaInt(em, "sample_rate") !== 16000) throw new Error("diarization models must be 16 kHz");
        if (metaInt(em, "normalize_samples") !== 1) throw new Error("unexpected CAM++ normalize_samples");
        const ort = await loadOrt(ctx);
        const [seg, emb] = await Promise.all([createSession(ctx, segBytes), createSession(ctx, embBytes)]);
        return new Models(seg, emb, meta, metaInt(em, "output_dim"), em.feature_normalize_type === "global-mean", ort);
    })();
    modelsPromise.catch(() => {
        modelsPromise = null;
    });
    return modelsPromise;
}

async function segmentChunk(md: Models, window: Float32Array): Promise<ChunkLabels> {
    const { ort, meta } = md;
    const x = new ort.Tensor("float32", window, [1, 1, meta.windowSize]);
    const out = await md.seg.run({ x });
    const y = out.y!;
    const [, frames, classes] = y.dims as number[];
    const logits = y.data as Float32Array;
    const S = meta.numSpeakers;
    const data = new Int8Array(frames! * S);
    for (let f = 0; f < frames!; f++) {
        let best = 0;
        for (let c = 1; c < classes!; c++) if (logits[f * classes! + c]! > logits[f * classes! + best]!) best = c;
        data.set(meta.powerset[best]!, f * S);
    }
    x.dispose();
    y.dispose();
    return { frames: frames!, data };
}

const speakerFbank = new Fbank(SPEAKER_FBANK);

async function embed(md: Models, samples: Float32Array): Promise<Float32Array | null> {
    const { data, frames } = speakerFbank.compute(samples);
    if (!frames) return null;
    const dim = speakerFbank.dim;
    if (md.globalMean) {
        const mean = new Float64Array(dim);
        for (let f = 0; f < frames; f++) for (let d = 0; d < dim; d++) mean[d] = mean[d]! + data[f * dim + d]!;
        for (let d = 0; d < dim; d++) mean[d] = mean[d]! / frames;
        for (let f = 0; f < frames; f++) for (let d = 0; d < dim; d++) data[f * dim + d] = data[f * dim + d]! - mean[d]!;
    }
    const x = new md.ort.Tensor("float32", data, [1, frames, dim]);
    const out = await md.emb.run({ x });
    const e = out.embedding!;
    const v = (e.data as Float32Array).slice(0, md.embDim);
    x.dispose();
    e.dispose();
    return v.some((z) => Number.isNaN(z)) ? null : v;
}

/** Diarize 16 kHz mono audio. `onFraction` gets 0..1 progress. */
export async function diarize(
    audio: Float32Array,
    ctx: EdgeContext,
    options: DiarizeOptions = {},
    onFraction?: (f: number, message: string) => void,
): Promise<SpeakerSegment[]> {
    const md = await loadModels(ctx);
    const { meta } = md;
    const { windowSize: ws, windowShift: shift, rfShift, numSpeakers: S } = meta;
    const n = audio.length;
    if (n <= 0) return [];

    // 1. Local segmentation over sliding windows.
    const labels: ChunkLabels[] = [];
    const window = new Float32Array(ws);
    const numChunks = n <= ws ? 1 : Math.floor((n - ws) / shift) + 1;
    const hasLast = n > ws && (n - ws) % shift > 0;
    const totalChunks = numChunks + (hasLast ? 1 : 0);
    for (let i = 0; i < totalChunks; i++) {
        if ((i & 7) === 0) {
            await checkpoint(ctx.signal);
            onFraction?.(0.3 * (i / totalChunks), "segmenting speakers");
        }
        window.fill(0);
        const start = i * shift;
        window.set(audio.subarray(start, Math.min(n, start + ws)));
        labels.push(await segmentChunk(md, window.slice()));
    }
    const opts = { minOn: options.minDurationOn ?? 0.3, minOff: options.minDurationOff ?? 0.5 };
    if (labels.length === 1) {
        // A single window: local speakers are the answer (sherpa's one-chunk case).
        return renumber(toSegments(labels[0]!.data, labels[0]!.frames, S, meta, opts));
    }

    // 2. Speakers per frame over the whole recording.
    const totalFrames = Math.floor((ws + (labels.length - 1) * shift) / rfShift) + 1;
    const count = new Float64Array(totalFrames);
    const weight = new Float64Array(totalFrames);
    const chunkStart = (i: number) => Math.round((i * shift) / rfShift);
    labels.forEach((l, i) => {
        const s0 = chunkStart(i);
        for (let f = 0; f < l.frames && s0 + f < totalFrames; f++) {
            let sum = 0;
            for (let s = 0; s < S; s++) sum += l.data[f * S + s]!;
            count[s0 + f] = count[s0 + f]! + sum;
            weight[s0 + f] = weight[s0 + f]! + 1;
        }
    });
    const speakersPerFrame = new Int32Array(totalFrames);
    let anySpeech = false;
    for (let f = 0; f < totalFrames; f++) {
        speakersPerFrame[f] = Math.trunc(count[f]! / (weight[f]! + 1e-12) + 0.5);
        if (speakersPerFrame[f]) anySpeech = true;
    }
    if (!anySpeech) return [];

    // 3. Sample ranges of each (chunk, local speaker), overlapped frames excluded.
    const pairs: { chunk: number; speaker: number; ranges: [number, number][] }[] = [];
    labels.forEach((l, c) => {
        const offset = c * shift;
        for (let s = 0; s < S; s++) {
            let active = 0;
            for (let f = 0; f < l.frames; f++) if (l.data[f * S + s] && rowSum(l, f, S) < 2) active++;
            if (active < 10) continue;
            const ranges: [number, number][] = [];
            let on = false;
            let startF = 0;
            for (let f = 0; f < l.frames; f++) {
                const v = l.data[f * S + s] && rowSum(l, f, S) < 2;
                if (v && !on) {
                    on = true;
                    startF = f;
                } else if (!v && on) {
                    on = false;
                    ranges.push([Math.trunc((startF / l.frames) * ws + offset), Math.trunc((f / l.frames) * ws + offset)]);
                }
            }
            if (on) ranges.push([Math.trunc((startF / l.frames) * ws + offset), Math.trunc(((l.frames - 1) / l.frames) * ws + offset)]);
            pairs.push({ chunk: c, speaker: s, ranges });
        }
    });
    if (!pairs.length) return [];

    // 4. One embedding per pair.
    const D = md.embDim;
    const embeddings: Float32Array[] = [];
    const valid: typeof pairs = [];
    for (let i = 0; i < pairs.length; i++) {
        if ((i & 3) === 0) {
            await checkpoint(ctx.signal);
            onFraction?.(0.3 + 0.65 * (i / pairs.length), "computing speaker embeddings");
        }
        const p = pairs[i]!;
        let len = 0;
        for (const [a, b] of p.ranges) len += Math.max(0, Math.min(b, n) - a);
        const buf = new Float32Array(len);
        let off = 0;
        for (const [a, b] of p.ranges) {
            const seg = audio.subarray(a, Math.min(b, n));
            buf.set(seg, off);
            off += seg.length;
        }
        const e = await embed(md, buf);
        if (e) {
            embeddings.push(e);
            valid.push({ ...p, ranges: p.ranges });
        }
    }
    if (!valid.length) return [];
    onFraction?.(0.96, "clustering speakers");

    // 5. Cluster reliable embeddings; attach the others to the nearest centroid.
    const clusters = clusterWithActiveRatio(embeddings, valid, n, D, ws, options);

    // 6. Re-label chunks with global clusters and reconstruct.
    const K = Math.max(...clusters) + 1;
    const toCluster = new Map<number, number>();
    valid.forEach((p, i) => toCluster.set(p.chunk * S + p.speaker, clusters[i]!));
    let rows = totalFrames;
    if ((n - ws) % shift > 0) rows = Math.min(rows, Math.floor(n / rfShift) + 1);
    const spk = new Int32Array(rows * K);
    labels.forEach((l, c) => {
        const s0 = chunkStart(c);
        for (let s = 0; s < S; s++) {
            const k = toCluster.get(c * S + s);
            if (k === undefined) continue;
            for (let f = 0; f < l.frames; f++) {
                const r = s0 + f;
                if (r < rows && l.data[f * S + s]) spk[r * K + k] = spk[r * K + k]! + 1;
            }
        }
    });
    const final = new Int8Array(rows * K);
    const order = Array.from({ length: K }, (_, i) => i);
    for (let r = 0; r < rows; r++) {
        const want = speakersPerFrame[r]!;
        if (!want) continue;
        order.sort((a, b) => spk[r * K + b]! - spk[r * K + a]! || a - b);
        for (let j = 0; j < Math.min(want, K); j++) {
            const k = order[j]!;
            if (spk[r * K + k]! > 0) final[r * K + k] = 1;
        }
    }
    onFraction?.(1, "done");
    return renumber(toSegments(final, rows, K, meta, opts));
}

function rowSum(l: ChunkLabels, f: number, S: number): number {
    let s = 0;
    for (let k = 0; k < S; k++) s += l.data[f * S + k]!;
    return s;
}

/** sherpa-onnx `ClusterEmbeddings`: cluster embeddings with ≥ 20% clean speech in their window. */
function clusterWithActiveRatio(
    embeddings: Float32Array[],
    pairs: { ranges: [number, number][] }[],
    n: number,
    D: number,
    ws: number,
    options: DiarizeOptions,
): Int32Array {
    const rows = embeddings.length;
    const flat = new Float32Array(rows * D);
    embeddings.forEach((e, i) => flat.set(e, i * D));
    const copt = { threshold: options.threshold ?? 0.5, numClusters: options.numSpeakers ?? 0 };
    const minSamples = 0.2 * ws;
    let keep: number[] = [];
    pairs.forEach((p, i) => {
        let len = 0;
        for (const [a, b] of p.ranges) len += Math.max(0, Math.min(b, n) - a);
        if (len >= minSamples) keep.push(i);
    });
    // Bound clustering memory (n²/2 floats) on very long recordings.
    const MAX_CLUSTERED = 6000;
    if (keep.length > MAX_CLUSTERED) {
        const step = keep.length / MAX_CLUSTERED;
        keep = Array.from({ length: MAX_CLUSTERED }, (_, i) => keep[Math.floor(i * step)]!);
    }
    if (rows <= MAX_CLUSTERED && (keep.length === rows || keep.length <= Math.max(2, copt.numClusters))) {
        return clusterEmbeddings(flat, rows, D, copt);
    }
    normalizeRows(flat, rows, D);
    const kept = new Float32Array(keep.length * D);
    keep.forEach((r, i) => kept.set(flat.subarray(r * D, r * D + D), i * D));
    const keptLabels = clusterEmbeddings(kept, keep.length, D, copt);
    const K = Math.max(...keptLabels) + 1;
    const centroids = new Float32Array(K * D);
    keep.forEach((_, i) => {
        const k = keptLabels[i]!;
        for (let d = 0; d < D; d++) centroids[k * D + d] = centroids[k * D + d]! + kept[i * D + d]!;
    });
    normalizeRows(centroids, K, D);
    const labels = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
        let best = 0;
        let bestSim = -Infinity;
        for (let k = 0; k < K; k++) {
            let sim = 0;
            for (let d = 0; d < D; d++) sim += flat[r * D + d]! * centroids[k * D + d]!;
            if (sim > bestSim) {
                bestSim = sim;
                best = k;
            }
        }
        labels[r] = best;
    }
    keep.forEach((r, i) => (labels[r] = keptLabels[i]!));
    return labels;
}

/** Frame activity → merged, filtered segments in seconds (sherpa `ComputeResult`). */
function toSegments(
    act: Int8Array,
    frames: number,
    K: number,
    meta: SegMeta,
    o: { minOn: number; minOff: number },
): SpeakerSegment[] {
    const scale = meta.rfShift / meta.sampleRate;
    const offset = (0.5 * meta.rfSize) / meta.sampleRate;
    const out: SpeakerSegment[] = [];
    for (let k = 0; k < K; k++) {
        const segs: SpeakerSegment[] = [];
        let on = frames > 0 && act[k] === 1;
        let startF = 0;
        for (let f = 1; f < frames; f++) {
            const v = act[f * K + k] === 1;
            if (on && !v) {
                segs.push({ speaker: k, start: startF * scale + offset, end: f * scale + offset });
                on = false;
            } else if (!on && v) {
                on = true;
                startF = f;
            }
        }
        if (on) segs.push({ speaker: k, start: startF * scale + offset, end: (frames - 1) * scale + offset });
        // Merge gaps ≤ minOff.
        const merged: SpeakerSegment[] = [];
        for (const s of segs) {
            const last = merged[merged.length - 1];
            if (last && last.end < s.start && last.end + o.minOff >= s.start) last.end = s.end;
            else merged.push({ ...s });
        }
        for (const s of merged) if (s.end - s.start > o.minOn) out.push(s);
    }
    return out.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
}

/** Speakers numbered 0, 1, … in order of first appearance; times rounded to ms. */
function renumber(segs: SpeakerSegment[]): SpeakerSegment[] {
    const ids = new Map<number, number>();
    return segs.map((s) => {
        let id = ids.get(s.speaker);
        if (id === undefined) {
            id = ids.size;
            ids.set(s.speaker, id);
        }
        return { speaker: id, start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 };
    });
}
