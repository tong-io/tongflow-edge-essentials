/**
 * Shot-boundary logic for `split-video`: TransNetV2's sliding window and its
 * predictions → scenes rule, plus a model-free frame-difference fallback.
 */

export const TNV2_W = 48;
export const TNV2_H = 27;
export const TNV2_WINDOW = 100;
/** Frames 25..74 of each window are kept; the window advances by 50. */
export const TNV2_STEP = 50;
export const TNV2_CONTEXT = 25;

/**
 * Frame indices of every 100-frame window over `n` frames (TransNetV2's `input_iterator`):
 * the sequence is padded with 25 copies of the first frame in front and enough copies of the
 * last frame at the end (25 + up to 50) so the windows tile it.
 */
export function windowIndices(n: number): number[][] {
    if (n <= 0) return [];
    const padEnd = TNV2_CONTEXT + TNV2_STEP - (n % TNV2_STEP === 0 ? TNV2_STEP : n % TNV2_STEP);
    const seq: number[] = [];
    for (let i = 0; i < TNV2_CONTEXT; i++) seq.push(0);
    for (let i = 0; i < n; i++) seq.push(i);
    for (let i = 0; i < padEnd; i++) seq.push(n - 1);
    const out: number[][] = [];
    for (let p = 0; p + TNV2_WINDOW <= seq.length; p += TNV2_STEP) out.push(seq.slice(p, p + TNV2_WINDOW));
    return out;
}

/** Stitch per-window predictions (each length 100) into one per frame. */
export function stitch(windows: Float32Array[], n: number): Float32Array {
    const out = new Float32Array(n);
    let k = 0;
    for (const w of windows) {
        for (let i = TNV2_CONTEXT; i < TNV2_CONTEXT + TNV2_STEP && k < n; i++) out[k++] = w[i]!;
    }
    return out;
}

export function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

/** TransNetV2 `predictions_to_scenes`: runs below `threshold` are scenes `[start, end]` (inclusive frames). */
export function predictionsToScenes(pred: ArrayLike<number>, threshold = 0.5): [number, number][] {
    const scenes: [number, number][] = [];
    let prev = 0, start = 0, t = 0;
    for (let i = 0; i < pred.length; i++) {
        t = pred[i]! > threshold ? 1 : 0;
        if (prev === 1 && t === 0) start = i;
        if (prev === 0 && t === 1 && i !== 0) scenes.push([start, i]);
        prev = t;
    }
    if (pred.length && t === 0) scenes.push([start, pred.length - 1]);
    if (!scenes.length) return [[0, Math.max(0, pred.length - 1)]];
    return scenes;
}

/**
 * Indices `k` (1..n-1) where a new shot starts at sampled frame `k`, from per-frame
 * transition probabilities: one boundary per transition run (the start of the next scene).
 */
export function boundariesFromScenes(scenes: [number, number][]): number[] {
    return scenes.slice(1).map((s) => s[0]);
}

/** Mean absolute RGB difference between consecutive small frames (0..255). */
export function frameDiffs(frames: Uint8Array[]): Float32Array {
    const d = new Float32Array(frames.length);
    for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1]!, b = frames[i]!;
        let s = 0;
        for (let k = 0; k < a.length; k++) s += Math.abs(a[k]! - b[k]!);
        d[i] = s / a.length;
    }
    return d;
}

/** 16-bin-per-channel color histogram distance (0..1) between consecutive frames. */
export function histDiffs(frames: Uint8Array[]): Float32Array {
    const BINS = 16;
    const hist = (f: Uint8Array) => {
        const h = new Float32Array(3 * BINS);
        const n = f.length / 3;
        for (let k = 0; k < f.length; k += 3) {
            h[(f[k]! >> 4)]! += 1 / n;
            h[BINS + (f[k + 1]! >> 4)]! += 1 / n;
            h[2 * BINS + (f[k + 2]! >> 4)]! += 1 / n;
        }
        return h;
    };
    const hs = frames.map(hist);
    const d = new Float32Array(frames.length);
    for (let i = 1; i < hs.length; i++) {
        let s = 0;
        for (let k = 0; k < hs[i]!.length; k++) s += Math.abs(hs[i]![k]! - hs[i - 1]![k]!);
        d[i] = s / 6; // each channel's L1 distance is ≤ 2
    }
    return d;
}

/**
 * Model-free cut detector (PySceneDetect-style): a frame starts a new shot when its
 * histogram distance to the previous frame is above `threshold` and clearly above the
 * local level, and at least `minGap` frames passed since the last cut.
 */
export function diffBoundaries(frames: Uint8Array[], threshold = 0.35, minGap = 2): number[] {
    const h = histDiffs(frames);
    const p = frameDiffs(frames);
    const out: number[] = [];
    let last = -Infinity;
    for (let i = 1; i < frames.length; i++) {
        // Combine color-distribution change with a pixel change (moving content keeps
        // histograms similar; a flash changes pixels but not much else).
        const score = 0.7 * h[i]! + 0.3 * Math.min(1, p[i]! / 80);
        let local = 0, cnt = 0;
        for (let k = Math.max(1, i - 4); k <= Math.min(frames.length - 1, i + 4); k++) {
            if (k === i) continue;
            local += 0.7 * h[k]! + 0.3 * Math.min(1, p[k]! / 80);
            cnt++;
        }
        local = cnt ? local / cnt : 0;
        if (score > threshold && score > 2 * local && i - last >= minGap) {
            out.push(i);
            last = i;
        }
    }
    return out;
}

/** Index of the largest jump in a short run of full-rate frames (refines a cut between two samples). */
export function sharpestCut(frames: Uint8Array[]): number {
    const d = frameDiffs(frames);
    let best = 1, bestV = -1;
    for (let i = 1; i < d.length; i++) if (d[i]! > bestV) {
        bestV = d[i]!;
        best = i;
    }
    return best;
}
