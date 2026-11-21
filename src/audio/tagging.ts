/**
 * Audio event tagging with CED-tiny (AudioSet, 527 classes; weights CC-BY-4.0
 * by Heinrich Dinkel et al., Xiaomi) on the sherpa-onnx int8 export, with
 * sherpa-onnx's CED front end. Long audio is tagged in 10 s windows (CED's
 * training length) and each class keeps its highest score.
 */
import type { EdgeContext } from "../context.js";
import { createSession, loadOrt, type OrtSession } from "../ml/ort.js";
import { fetchModelFile } from "../models/hub.js";
import { CED_TINY } from "../models/registry.js";
import { checkpoint } from "./checkpoint.js";
import { CED_FBANK, Fbank } from "./fbank.js";

export interface AudioTag {
    label: string;
    score: number;
}

/** AudioSet `class_labels_indices.csv` (index,mid,display_name) → display names by index. */
export function parseLabels(csv: string): string[] {
    const names: string[] = [];
    for (const line of csv.split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const m = /^(\d+),([^,]*),(.*)$/.exec(line);
        if (!m) continue;
        let name = m[3]!.trim();
        if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/""/g, '"');
        names[Number(m[1])] = name;
    }
    return names;
}

let modelPromise: Promise<{ session: OrtSession; labels: string[]; ort: typeof import("onnxruntime-web") }> | null = null;

async function load(ctx: EdgeContext) {
    modelPromise ??= (async () => {
        const [model, csv] = await Promise.all([
            fetchModelFile(ctx, CED_TINY, CED_TINY.files.model),
            fetchModelFile(ctx, CED_TINY, CED_TINY.files.labels),
        ]);
        const ort = await loadOrt(ctx);
        return { session: await createSession(ctx, model), labels: parseLabels(new TextDecoder().decode(csv)), ort };
    })();
    modelPromise.catch(() => {
        modelPromise = null;
    });
    return modelPromise;
}

const fbank = new Fbank(CED_FBANK);
export const TAG_WINDOW = 10 * 16000;

/**
 * sherpa-onnx `AmplitudeToDB` on the linear mel power: 10·log10(max(x, 1e-10)),
 * floored at (max − 120 dB). The running max starts at FLT_MIN, as in sherpa.
 */
export function amplitudeToDb(p: Float32Array): void {
    let max = 1.1754943508222875e-38;
    for (let i = 0; i < p.length; i++) {
        const x = 10 * Math.log10(Math.max(p[i]!, 1e-10));
        if (x > max) max = x;
        p[i] = x;
    }
    const floor = max - 120;
    for (let i = 0; i < p.length; i++) if (p[i]! < floor) p[i] = floor;
}

/** Per-class probabilities of one window (16 kHz mono). */
async function tagWindow(m: Awaited<ReturnType<typeof load>>, samples: Float32Array): Promise<Float32Array> {
    const { data, frames } = fbank.compute(samples);
    amplitudeToDb(data);
    const dim = fbank.dim;
    // The model takes [batch, mel, time].
    const t = new Float32Array(dim * frames);
    for (let f = 0; f < frames; f++) for (let d = 0; d < dim; d++) t[d * frames + f] = data[f * dim + d]!;
    const x = new m.ort.Tensor("float32", t, [1, dim, frames]);
    const out = await m.session.run({ feats: x });
    const prob = (out.prob!.data as Float32Array).slice();
    x.dispose();
    out.prob!.dispose();
    return prob;
}

/** Window boundaries for tagging: 10 s windows; a final remainder under 5 s joins the previous window. */
export function tagWindows(n: number, win = TAG_WINDOW): [number, number][] {
    const out: [number, number][] = [];
    for (let s = 0; s < n; s += win) out.push([s, Math.min(n, s + win)]);
    if (out.length > 1 && out[out.length - 1]![1] - out[out.length - 1]![0] < 5 * 16000) {
        const last = out.pop()!;
        out[out.length - 1]![1] = last[1];
    }
    return out;
}

/** Top tags over the whole recording (max over 10 s windows). */
export async function tagAudio(
    samples: Float32Array,
    ctx: EdgeContext,
    options: { topK?: number; minScore?: number } = {},
    onFraction?: (f: number) => void,
): Promise<AudioTag[]> {
    const m = await load(ctx);
    const windows = tagWindows(samples.length);
    let best: Float32Array | null = null;
    for (let i = 0; i < windows.length; i++) {
        await checkpoint(ctx.signal);
        const [a, b] = windows[i]!;
        const p = await tagWindow(m, samples.subarray(a, b));
        if (!best) best = p;
        else for (let k = 0; k < p.length; k++) if (p[k]! > best[k]!) best[k] = p[k]!;
        onFraction?.((i + 1) / windows.length);
    }
    if (!best) return [];
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0.1;
    const idx = Array.from(best.keys()).sort((x, y) => best[y]! - best[x]!);
    const tags: AudioTag[] = [];
    for (const k of idx) {
        if (tags.length >= topK) break;
        if (best[k]! < minScore && tags.length > 0) break;
        tags.push({ label: m.labels[k] ?? `class ${k}`, score: Math.round(best[k]! * 10000) / 10000 });
    }
    return tags;
}
