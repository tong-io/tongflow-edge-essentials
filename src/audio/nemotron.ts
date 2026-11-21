/**
 * Nemotron-3-Diarization (NVIDIA, OpenMDW-1.1): Streaming Sortformer with an
 * Arrival-Order Speaker Cache, up to 8 speakers, on onnxruntime-web (wasm EP).
 *
 * The ONNX export (`onnx-community/Nemotron-3-Diarization-ONNX`, q4 = 83 MB) is one
 * encoder step: `input_features` (the chunk's log-mel frames) + `cached_embeds` (speaker
 * cache + FIFO, encoder width 512) + `attention_mask` (encoder frames) →
 * `logits` (10 ms frames of the whole step × 8 speakers), `chunk_embeds` (the chunk's
 * stacked-frame embeddings) and `silence_embeds`. Everything around it is ported from
 * Hugging Face transformers (Apache-2.0) `Nemotron3DiarizationForAudioFrameClassification`
 * (offline mode) and `NemotronAsrStreamingFeatureExtractor`:
 *
 *  - features: pre-emphasis 0.97, centred STFT (n_fft 512, 400-sample symmetric Hann,
 *    hop 160, zero padding), power spectrum, 128 Slaney mel bins 0–8 kHz,
 *    log(x + 2^-24), no normalization;
 *  - chunks of 340 encoder frames (8 mel frames each, 80 ms) with 40 frames of
 *    look-ahead; the FIFO (40 frames) overflows into the speaker cache (264 frames),
 *    which is compressed by per-speaker frame scores when full;
 *  - logits → sigmoid > 0.5 per speaker → segments (the same post-processing as the
 *    pyannote path: drop < 0.3 s, merge same-speaker gaps ≤ 0.5 s, renumber by arrival).
 */
import type { EdgeContext } from "../context.js";
import { loadOrt, type OrtSession } from "../ml/ort.js";
import { fetchModelFile } from "../models/hub.js";
import { NEMOTRON_DIARIZATION } from "../models/alt-registry.js";
import { checkpoint } from "./checkpoint.js";
import type { SpeakerSegment } from "./diarize.js";
import { powerSpectrum } from "./fft.js";

export const NEMO_MEL = {
    sampleRate: 16000,
    nFft: 512,
    winLength: 400,
    hop: 160,
    nMels: 128,
    preemph: 0.97,
} as const;

/** Model hyper-parameters (config.json of the checkpoint; offline mode). */
export const NEMOTRON_CONFIG = {
    subsampling: 8,
    hidden: 512,
    speakers: 8,
    chunkLength: 340,
    chunkRightContext: 40,
    chunkLeftContext: 0,
    fifoLength: 40,
    updatePeriod: 300,
    cacheLength: 264,
    silenceFramesPerSpeaker: 1,
    predictionScoreThreshold: 0.25,
    latestFramesScoreBoost: 0.05,
    minPositiveScoresRate: 0.5,
    strongBoostRate: 0.75,
    weakBoostRate: 1.5,
} as const;

/* ---------------------------------------------------------------- features */

function hzToMelSlaney(f: number): number {
    const logstep = Math.log(6.4) / 27;
    return f >= 1000 ? 15 + Math.log(f / 1000) / logstep : (3 * f) / 200;
}
function melToHzSlaney(m: number): number {
    const logstep = Math.log(6.4) / 27;
    return m >= 15 ? 1000 * Math.exp(logstep * (m - 15)) : (200 * m) / 3;
}

/** Slaney-scale, Slaney-normalized triangular filters, [nMels][nFft/2+1] (librosa / transformers `mel_filter_bank`). */
export function slaneyMelBank(nFft: number, nMels: number, sampleRate: number, fMin = 0, fMax = sampleRate / 2): Float32Array[] {
    const bins = nFft / 2 + 1;
    const fftFreqs = Array.from({ length: bins }, (_, i) => (i * sampleRate) / 2 / (bins - 1));
    const mMin = hzToMelSlaney(fMin);
    const mMax = hzToMelSlaney(fMax);
    const pts = Array.from({ length: nMels + 2 }, (_, i) => melToHzSlaney(mMin + ((mMax - mMin) * i) / (nMels + 1)));
    const out: Float32Array[] = [];
    for (let m = 0; m < nMels; m++) {
        const lo = pts[m]!;
        const c = pts[m + 1]!;
        const hi = pts[m + 2]!;
        const enorm = 2 / (hi - lo);
        const row = new Float32Array(bins);
        for (let k = 0; k < bins; k++) {
            const f = fftFreqs[k]!;
            const down = (f - lo) / (c - lo);
            const up = (hi - f) / (hi - c);
            row[k] = Math.max(0, Math.min(down, up)) * enorm;
        }
        out.push(row);
    }
    return out;
}

let melBank: Float32Array[] | undefined;
let window512: Float64Array | undefined;

/**
 * Log-mel features [frames × 128] of 16 kHz mono audio, and the number of valid frames
 * (`floor(n / hop)`; the frames after it are zero, as the feature extractor's mask does).
 */
export function nemoLogMel(samples: Float32Array): { data: Float32Array; frames: number; valid: number } {
    const { nFft, winLength, hop, nMels, preemph } = NEMO_MEL;
    melBank ??= slaneyMelBank(nFft, nMels, NEMO_MEL.sampleRate);
    if (!window512) {
        // torch.hann_window(400, periodic=False), zero-padded (centred) to n_fft.
        window512 = new Float64Array(nFft);
        const off = (nFft - winLength) >> 1;
        for (let i = 0; i < winLength; i++) window512[off + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (winLength - 1));
    }
    const n = samples.length;
    const x = new Float32Array(n);
    if (n) x[0] = samples[0]!;
    for (let i = 1; i < n; i++) x[i] = samples[i]! - preemph * samples[i - 1]!;
    const frames = 1 + Math.floor(n / hop);
    const valid = Math.floor(n / hop);
    const pad = nFft >> 1;
    const out = new Float32Array(frames * nMels);
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);
    const pow = new Float64Array(nFft / 2 + 1);
    const bins = nFft / 2 + 1;
    for (let f = 0; f < valid; f++) {
        const start = f * hop - pad;
        for (let i = 0; i < nFft; i++) {
            const j = start + i;
            re[i] = j >= 0 && j < n ? x[j]! * window512[i]! : 0;
        }
        powerSpectrum(re, im, pow);
        const row = f * nMels;
        for (let m = 0; m < nMels; m++) {
            const w = melBank[m]!;
            let s = 0;
            for (let k = 0; k < bins; k++) s += w[k]! * pow[k]!;
            out[row + m] = Math.log(s + 2 ** -24);
        }
    }
    return { data: out, frames, valid };
}

/* ---------------------------------------------------------------- speaker cache (AOSC + FIFO) */

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Concatenate row-major blocks. */
function concat(...parts: Float32Array[]): Float32Array {
    const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/**
 * The streaming state of Sortformer for one recording (batch 1): a port of
 * transformers' `Nemotron3DiarizationSpeakerCache`.
 */
export class SpeakerCache {
    readonly H = NEMOTRON_CONFIG.hidden;
    readonly K = NEMOTRON_CONFIG.speakers;
    private embeds: Float32Array = new Float32Array(0); // [nCache × H]
    private probs: Float32Array = new Float32Array(0); // [nCache × K]
    private fifo: Float32Array = new Float32Array(0); // [nFifo × H]
    private compressed = false;
    private readonly minPositive: number;
    private readonly nStrong: number;
    private readonly nWeak: number;

    constructor(
        private readonly fifoLength: number = NEMOTRON_CONFIG.fifoLength,
        private readonly updatePeriod: number = NEMOTRON_CONFIG.updatePeriod,
        private readonly cacheLength: number = NEMOTRON_CONFIG.cacheLength,
    ) {
        const c = NEMOTRON_CONFIG;
        const budget = Math.floor(cacheLength / c.speakers) - c.silenceFramesPerSpeaker;
        this.minPositive = Math.floor(budget * c.minPositiveScoresRate);
        this.nStrong = Math.floor(budget * c.strongBoostRate);
        this.nWeak = Math.floor(budget * c.weakBoostRate);
    }

    get cacheFrames(): number {
        return this.embeds.length / this.H;
    }
    get fifoFrames(): number {
        return this.fifo.length / this.H;
    }

    /** The cached frames the next step attends to: speaker cache, then FIFO. */
    cached(): Float32Array {
        return concat(this.embeds, this.fifo);
    }

    /** Speaker probabilities at the encoder rate: sigmoid, averaged over each group of 8 logit frames. */
    static poolProbs(logits: Float32Array, frames: number, K: number, factor: number, mask?: Uint8Array): Float32Array {
        const out = new Float32Array(frames * K);
        for (let f = 0; f < frames; f++) {
            if (mask && !mask[f]) continue;
            for (let k = 0; k < K; k++) {
                let s = 0;
                for (let j = 0; j < factor; j++) s += sigmoid(logits[(f * factor + j) * K + k]!);
                out[f * K + k] = s / factor;
            }
        }
        return out;
    }

    /**
     * Push a processed step: `inputEmbeds` = cached frames + look-back + chunk + look-ahead
     * (`stepFrames` rows), `logits` over all of them (×8 frames).
     */
    update(inputEmbeds: Float32Array, logits: Float32Array, silence: Float32Array, chunkFrames: number, mask?: Uint8Array, lookback = 0): void {
        const { H, K } = this;
        const nc = this.cacheFrames;
        const nf = this.fifoFrames;
        const stepFrames = inputEmbeds.length / H;
        const probs = SpeakerCache.poolProbs(logits, stepFrames, K, NEMOTRON_CONFIG.subsampling, mask);
        const cs = nc + nf + lookback;
        const chunk = inputEmbeds.subarray(cs * H, (cs + chunkFrames) * H);
        let fifo = concat(this.fifo, chunk);
        const n = fifo.length / H;
        const popped = n <= this.fifoLength ? 0 : Math.min(Math.max(this.updatePeriod, n - this.fifoLength), n);
        if (popped) {
            const fifoProbs = concat(probs.subarray(nc * K, (nc + nf) * K), probs.subarray(cs * K, (cs + chunkFrames) * K));
            const stored = this.compressed ? this.probs : probs.subarray(0, nc * K);
            let cacheEmbeds = concat(this.embeds, fifo.subarray(0, popped * H));
            let cacheProbs = concat(stored, fifoProbs.subarray(0, popped * K));
            fifo = fifo.slice(popped * H);
            if (cacheEmbeds.length / H > this.cacheLength) {
                [cacheEmbeds, cacheProbs] = this.compress(cacheEmbeds, cacheProbs, silence);
                this.compressed = true;
            }
            this.embeds = cacheEmbeds;
            this.probs = cacheProbs;
        }
        this.fifo = fifo;
    }

    /** Per-frame, per-speaker importance (−∞ = never kept), as `_get_frame_scores`. */
    frameScores(probs: Float32Array, frames: number): Float64Array {
        const { K } = this;
        const thr = NEMOTRON_CONFIG.predictionScoreThreshold;
        const sc = new Float64Array(frames * K);
        const positive = new Int32Array(K);
        for (let f = 0; f < frames; f++) {
            let sumLc = 0;
            for (let k = 0; k < K; k++) sumLc += Math.log(Math.max(1 - probs[f * K + k]!, thr));
            for (let k = 0; k < K; k++) {
                const p = probs[f * K + k]!;
                const v = p > 0.5 ? Math.log(Math.max(p, thr)) - Math.log(Math.max(1 - p, thr)) + sumLc - Math.log(0.5) : -Infinity;
                sc[f * K + k] = v;
                if (v > 0) positive[k]!++;
            }
        }
        for (let k = 0; k < K; k++) {
            if (positive[k]! < this.minPositive) continue;
            for (let f = 0; f < frames; f++) {
                const p = probs[f * K + k]!;
                if (p > 0.5 && !(sc[f * K + k]! > 0)) sc[f * K + k] = -Infinity;
            }
        }
        return sc;
    }

    /** Add `boost` to the `count` best frames of every speaker. */
    private boost(sc: Float64Array, frames: number, count: number, boost: number): void {
        const { K } = this;
        const idx = Array.from({ length: frames }, (_, i) => i);
        for (let k = 0; k < K; k++) {
            idx.sort((a, b) => sc[b * K + k]! - sc[a * K + k]! || a - b);
            for (let i = 0; i < Math.min(count, frames); i++) sc[idx[i]! * K + k] = sc[idx[i]! * K + k]! + boost;
        }
    }

    /** Keep the `cacheLength` most important frames, grouped by speaker, in time order per speaker. */
    private compress(embeds: Float32Array, probs: Float32Array, silence: Float32Array): [Float32Array, Float32Array] {
        const { H, K } = this;
        const L = this.cacheLength;
        const N = probs.length / K;
        const nSil = NEMOTRON_CONFIG.silenceFramesPerSpeaker;
        const sc = this.frameScores(probs, N);
        for (let f = L; f < N; f++) for (let k = 0; k < K; k++) sc[f * K + k] = sc[f * K + k]! + NEMOTRON_CONFIG.latestFramesScoreBoost;
        this.boost(sc, N, this.nStrong, -2 * Math.log(0.5));
        this.boost(sc, N, this.nWeak, -Math.log(0.5));
        const M = N + nSil; // scored frames: N real + silence slots (score +∞)
        // Flattened speaker-major: index = k * M + f.
        const flat: { i: number; s: number }[] = [];
        for (let k = 0; k < K; k++) {
            for (let f = 0; f < M; f++) flat.push({ i: k * M + f, s: f < N ? sc[f * K + k]! : Infinity });
        }
        flat.sort((a, b) => b.s - a.s || a.i - b.i);
        const sentinel = M * K;
        const top = flat.slice(0, L).map((x) => (x.s === -Infinity ? sentinel : x.i));
        top.sort((a, b) => a - b);
        const outE = new Float32Array(L * H);
        const outP = new Float32Array(L * K);
        top.forEach((t, r) => {
            const f = t === sentinel ? N : Math.min(t % M, N);
            if (f >= N) outE.set(silence, r * H); // silence slot (probs stay 0)
            else {
                outE.set(embeds.subarray(f * H, (f + 1) * H), r * H);
                outP.set(probs.subarray(f * K, (f + 1) * K), r * K);
            }
        });
        return [outE, outP];
    }
}

/* ---------------------------------------------------------------- segments */

/** Per-speaker activity (sigmoid > threshold) at 10 ms → segments, gaps merged, short ones dropped, renumbered by arrival. */
export function logitsToSegments(
    logits: Float32Array,
    frames: number,
    K: number,
    o: { threshold?: number; minOn?: number; minOff?: number; frameS?: number } = {},
): SpeakerSegment[] {
    const thr = o.threshold ?? 0.5;
    const z = Math.log(thr / (1 - thr)); // sigmoid(x) > thr ⟺ x > logit(thr)
    const frameS = o.frameS ?? NEMO_MEL.hop / NEMO_MEL.sampleRate;
    const minOn = o.minOn ?? 0.3;
    const minOff = o.minOff ?? 0.5;
    const out: SpeakerSegment[] = [];
    for (let k = 0; k < K; k++) {
        const segs: SpeakerSegment[] = [];
        let on = -1;
        for (let f = 0; f <= frames; f++) {
            const v = f < frames && logits[f * K + k]! > z;
            if (v && on < 0) on = f;
            else if (!v && on >= 0) {
                segs.push({ speaker: k, start: on * frameS, end: f * frameS });
                on = -1;
            }
        }
        const merged: SpeakerSegment[] = [];
        for (const s of segs) {
            const last = merged[merged.length - 1];
            if (last && s.start - last.end <= minOff) last.end = s.end;
            else merged.push({ ...s });
        }
        for (const s of merged) if (s.end - s.start >= minOn) out.push(s);
    }
    out.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
    const ids = new Map<number, number>();
    return out.map((s) => {
        let id = ids.get(s.speaker);
        if (id === undefined) ids.set(s.speaker, (id = ids.size));
        return { speaker: id, start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 };
    });
}

/* ---------------------------------------------------------------- model */

let session: Promise<{ s: OrtSession; ort: typeof import("onnxruntime-web") }> | null = null;

function loadNemotron(ctx: EdgeContext) {
    session ??= (async () => {
        const spec = NEMOTRON_DIARIZATION;
        const [graph, data] = await Promise.all([fetchModelFile(ctx, spec, spec.files.model), fetchModelFile(ctx, spec, spec.files.data)]);
        const ort = await loadOrt(ctx);
        const s = await ort.InferenceSession.create(graph, {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all",
            externalData: [{ path: "model_q4.onnx_data", data }],
        });
        return { s, ort };
    })();
    session.catch(() => {
        session = null;
    });
    return session;
}

/** Speaker logits [frames × 8] at 10 ms for the whole recording (offline chunked mode). */
export async function nemotronLogits(
    samples: Float32Array,
    ctx: EdgeContext,
    onFraction?: (f: number, message: string) => void,
): Promise<{ logits: Float32Array; frames: number }> {
    const { s, ort } = await loadNemotron(ctx);
    const c = NEMOTRON_CONFIG;
    const { data: mel, frames: T, valid } = nemoLogMel(samples);
    const M = NEMO_MEL.nMels;
    const nEmb = Math.ceil(T / c.subsampling);
    const cache = new SpeakerCache();
    const logits = new Float32Array(T * c.speakers);
    let written = 0;
    for (let st = 0; st < nEmb; st += c.chunkLength) {
        await checkpoint(ctx.signal);
        onFraction?.(st / nEmb, "segmenting speakers");
        const en = Math.min(st + c.chunkLength, nEmb);
        const nChunk = en - st;
        const cst = Math.max(st - c.chunkLeftContext, 0);
        const lookback = st - cst;
        const ctxEnd = Math.min(en + c.chunkRightContext, nEmb);
        const melSlice = mel.subarray(cst * c.subsampling * M, Math.min(ctxEnd * c.subsampling, T) * M);
        const cached = cache.cached();
        const nCached = cached.length / c.hidden;
        const stepFrames = nCached + (ctxEnd - cst);
        const mask = new Uint8Array(stepFrames);
        const maskI64 = new BigInt64Array(stepFrames);
        for (let i = 0; i < stepFrames; i++) {
            const v = i < nCached || (cst + i - nCached) * c.subsampling < valid ? 1 : 0;
            mask[i] = v;
            maskI64[i] = BigInt(v);
        }
        const feeds = {
            input_features: new ort.Tensor("float32", melSlice, [1, melSlice.length / M, M]),
            cached_embeds: new ort.Tensor("float32", cached, [1, nCached, c.hidden]),
            attention_mask: new ort.Tensor("int64", maskI64, [1, stepFrames]),
        };
        const out = await s.run(feeds);
        const lg = out.logits!.data as Float32Array;
        const chunkEmb = out.chunk_embeds!.data as Float32Array;
        const silence = (out.silence_embeds!.data as Float32Array).slice();
        const input = new Float32Array(cached.length + chunkEmb.length);
        input.set(cached);
        input.set(chunkEmb, cached.length);
        cache.update(input, lg, silence, nChunk, mask, lookback);
        const a = (nCached + lookback) * c.subsampling;
        const take = Math.min(nChunk * c.subsampling, T - written);
        logits.set(lg.subarray(a * c.speakers, (a + take) * c.speakers), written * c.speakers);
        written += take;
        for (const t of Object.values(out)) t.dispose();
        for (const t of Object.values(feeds)) t.dispose();
    }
    onFraction?.(1, "segmenting speakers");
    return { logits, frames: Math.min(written, valid) };
}

export interface NemotronOptions {
    /** Speaker probability above which a frame counts as speech (default 0.5). */
    threshold?: number;
}

/** Diarize 16 kHz mono audio with Nemotron-3-Diarization: `[{speaker,start,end}]`, speakers by arrival. */
export async function diarizeNemotron(
    samples: Float32Array,
    ctx: EdgeContext,
    o: NemotronOptions = {},
    onFraction?: (f: number, message: string) => void,
): Promise<SpeakerSegment[]> {
    if (!samples.length) return [];
    const { logits, frames } = await nemotronLogits(samples, ctx, onFraction);
    return logitsToSegments(logits, frames, NEMOTRON_CONFIG.speakers, o.threshold !== undefined ? { threshold: o.threshold } : {});
}
