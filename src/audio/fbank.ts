/**
 * Kaldi-compatible log-mel filterbank, a TypeScript port of the parts of
 * kaldi-native-fbank (Apache-2.0, k2-fsa) that sherpa-onnx uses for the models
 * in this plugin: frame extraction (snip_edges on/off, DC removal,
 * pre-emphasis, povey/hamming/hann windows), a power spectrum, Kaldi mel banks
 * and log with an FLT_EPSILON floor. The sherpa-onnx configurations are below
 * ({@link SENSEVOICE_FBANK}, {@link SPEAKER_FBANK}, {@link CED_FBANK}).
 */
import { powerSpectrum } from "./fft.js";

export type WindowType = "povey" | "hamming" | "hann" | "hanning" | "rectangular";

export interface FbankOptions {
    sampleRate: number;
    frameLengthMs: number;
    frameShiftMs: number;
    numBins: number;
    lowFreq: number;
    /** > 0: absolute Hz; ≤ 0: offset from Nyquist (Kaldi convention). */
    highFreq: number;
    windowType: WindowType;
    preemph: number;
    removeDc: boolean;
    snipEdges: boolean;
    /** log(max(x, FLT_EPSILON)) of the mel energies; false keeps linear power. */
    useLog: boolean;
    /** Multiply input samples first (32768 for models trained on int16-range audio). */
    inputScale: number;
}

const FLT_EPSILON = 1.1920928955078125e-7;

/** sherpa-onnx's SenseVoice front end (hamming, snip_edges, 20 Hz..Nyquist, int16 range). */
export const SENSEVOICE_FBANK: FbankOptions = {
    sampleRate: 16000,
    frameLengthMs: 25,
    frameShiftMs: 10,
    numBins: 80,
    lowFreq: 20,
    highFreq: 0,
    windowType: "hamming",
    preemph: 0.97,
    removeDc: true,
    snipEdges: true,
    useLog: true,
    inputScale: 32768,
};

/** sherpa-onnx's default FeatureExtractorConfig, used for 3D-Speaker CAM++ embeddings. */
export const SPEAKER_FBANK: FbankOptions = {
    sampleRate: 16000,
    frameLengthMs: 25,
    frameShiftMs: 10,
    numBins: 80,
    lowFreq: 20,
    highFreq: -400,
    windowType: "povey",
    preemph: 0.97,
    removeDc: true,
    snipEdges: false,
    useLog: true,
    inputScale: 1,
};

/** sherpa-onnx's CED front end: 32 ms hann frames, 64 linear-power mel bins 0..8 kHz. */
export const CED_FBANK: FbankOptions = {
    sampleRate: 16000,
    frameLengthMs: 32,
    frameShiftMs: 10,
    numBins: 64,
    lowFreq: 0,
    highFreq: 8000,
    windowType: "hann",
    preemph: 0,
    removeDc: false,
    snipEdges: false,
    useLog: false,
    inputScale: 1,
};

const melScale = (f: number) => 1127 * Math.log(1 + f / 700);

function windowFunction(type: WindowType, n: number): Float64Array {
    const w = new Float64Array(n);
    const a = type === "hann" ? (2 * Math.PI) / n : (2 * Math.PI) / (n - 1);
    for (let i = 0; i < n; i++) {
        switch (type) {
            case "hann":
            case "hanning":
                w[i] = 0.5 - 0.5 * Math.cos(a * i);
                break;
            case "hamming":
                w[i] = 0.54 - 0.46 * Math.cos(a * i);
                break;
            case "povey":
                w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
                break;
            default:
                w[i] = 1;
        }
    }
    return w;
}

interface MelBin {
    first: number;
    weights: Float64Array;
}

function melBanks(o: FbankOptions, paddedSize: number): MelBin[] {
    const numFftBins = paddedSize / 2;
    const nyquist = o.sampleRate / 2;
    const highFreq = o.highFreq > 0 ? o.highFreq : nyquist + o.highFreq;
    if (o.lowFreq < 0 || o.lowFreq >= nyquist || highFreq <= 0 || highFreq > nyquist || highFreq <= o.lowFreq) {
        throw new Error(`bad mel range ${o.lowFreq}..${highFreq} Hz (Nyquist ${nyquist})`);
    }
    const binWidth = o.sampleRate / paddedSize;
    const melLow = melScale(o.lowFreq);
    const melHigh = melScale(highFreq);
    const delta = (melHigh - melLow) / (o.numBins + 1);
    const bins: MelBin[] = [];
    for (let b = 0; b < o.numBins; b++) {
        const left = melLow + b * delta;
        const center = melLow + (b + 1) * delta;
        const right = melLow + (b + 2) * delta;
        const w: number[] = [];
        let first = -1;
        for (let i = 0; i < numFftBins; i++) {
            const mel = melScale(binWidth * i);
            if (mel > left && mel < right) {
                const weight = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
                if (first === -1) first = i;
                // Kaldi keeps the contiguous run first..last; zeros inside it stay zeros.
                while (first + w.length < i) w.push(0);
                w.push(weight);
            }
        }
        bins.push({ first: Math.max(first, 0), weights: Float64Array.from(w) });
    }
    return bins;
}

/** A configured filterbank; `compute` is pure and can be called many times. */
export class Fbank {
    readonly opts: FbankOptions;
    readonly frameLength: number;
    readonly frameShift: number;
    readonly paddedSize: number;
    private readonly window: Float64Array;
    private readonly bins: MelBin[];
    private readonly re: Float64Array;
    private readonly im: Float64Array;
    private readonly power: Float64Array;

    constructor(opts: FbankOptions) {
        this.opts = opts;
        this.frameLength = Math.trunc(opts.sampleRate * 0.001 * opts.frameLengthMs);
        this.frameShift = Math.trunc(opts.sampleRate * 0.001 * opts.frameShiftMs);
        let p = 1;
        while (p < this.frameLength) p <<= 1;
        this.paddedSize = p;
        this.window = windowFunction(opts.windowType, this.frameLength);
        this.bins = melBanks(opts, p);
        this.re = new Float64Array(p);
        this.im = new Float64Array(p);
        this.power = new Float64Array(p / 2 + 1);
    }

    get dim(): number {
        return this.opts.numBins;
    }

    numFrames(numSamples: number): number {
        const { frameLength: len, frameShift: shift } = this;
        if (this.opts.snipEdges) return numSamples < len ? 0 : 1 + Math.floor((numSamples - len) / shift);
        return Math.floor((numSamples + Math.floor(shift / 2)) / shift);
    }

    /** Features of `samples` (16 kHz mono, [-1, 1]) as a row-major [frames × dim] array. */
    compute(samples: Float32Array): { data: Float32Array; frames: number } {
        const n = samples.length;
        const frames = n === 0 ? 0 : this.numFrames(n);
        const dim = this.opts.numBins;
        const out = new Float32Array(frames * dim);
        const { re, im, power, window, bins, frameLength: len, frameShift: shift } = this;
        const { inputScale: scale, removeDc, preemph, snipEdges, useLog } = this.opts;
        for (let f = 0; f < frames; f++) {
            const start = snipEdges ? f * shift : shift * f + Math.floor(shift / 2) - Math.floor(len / 2);
            re.fill(0);
            if (start >= 0 && start + len <= n) {
                for (let s = 0; s < len; s++) re[s] = samples[start + s]! * scale;
            } else {
                for (let s = 0; s < len; s++) {
                    let k = start + s;
                    while (k < 0 || k >= n) k = k < 0 ? -k - 1 : 2 * n - 1 - k;
                    re[s] = samples[k]! * scale;
                }
            }
            if (removeDc) {
                let sum = 0;
                for (let s = 0; s < len; s++) sum += re[s]!;
                const mean = sum / len;
                for (let s = 0; s < len; s++) re[s] = re[s]! - mean;
            }
            if (preemph !== 0) {
                for (let s = len - 1; s > 0; s--) re[s] = re[s]! - preemph * re[s - 1]!;
                re[0] = re[0]! - preemph * re[0]!;
            }
            for (let s = 0; s < len; s++) re[s] = re[s]! * window[s]!;
            powerSpectrum(re, im, power);
            const row = f * dim;
            for (let b = 0; b < dim; b++) {
                const { first, weights } = bins[b]!;
                let e = 0;
                for (let k = 0; k < weights.length; k++) e += weights[k]! * power[first + k]!;
                out[row + b] = useLog ? Math.log(Math.max(e, FLT_EPSILON)) : e;
            }
        }
        return { data: out, frames };
    }
}
