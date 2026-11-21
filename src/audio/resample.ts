/**
 * Streaming band-limited resampler: a TypeScript port of Kaldi's
 * `LinearResample` (as in kaldi-native-fbank / sherpa-onnx, Apache-2.0), a
 * Hann-windowed sinc filter evaluated at the rational phases of
 * in_rate/out_rate. sherpa-onnx resamples with cutoff 0.99 · min(rate)/2 and 6
 * zero crossings; so does {@link Resampler} by default, so features match.
 */
function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a;
}

export class Resampler {
    readonly inRate: number;
    readonly outRate: number;
    private readonly cutoff: number;
    private readonly numZeros: number;
    private readonly inUnit: number;
    private readonly outUnit: number;
    private readonly firstIndex: Int32Array;
    private readonly weights: Float32Array[];
    private inputOffset = 0;
    private outputOffset = 0;
    private remainder = new Float32Array(0);

    constructor(inRate: number, outRate: number, cutoff = 0.99 * 0.5 * Math.min(inRate, outRate), numZeros = 6) {
        if (!(inRate > 0 && outRate > 0 && cutoff > 0 && cutoff * 2 <= inRate && cutoff * 2 <= outRate && numZeros > 0)) {
            throw new Error("Resampler: invalid arguments");
        }
        this.inRate = Math.round(inRate);
        this.outRate = Math.round(outRate);
        this.cutoff = cutoff;
        this.numZeros = numZeros;
        const base = gcd(this.inRate, this.outRate);
        this.inUnit = this.inRate / base;
        this.outUnit = this.outRate / base;
        this.firstIndex = new Int32Array(this.outUnit);
        this.weights = [];
        const width = numZeros / (2 * cutoff);
        for (let i = 0; i < this.outUnit; i++) {
            const t = i / this.outRate;
            const minIdx = Math.ceil((t - width) * this.inRate);
            const maxIdx = Math.floor((t + width) * this.inRate);
            const w = new Float32Array(maxIdx - minIdx + 1);
            for (let j = 0; j < w.length; j++) {
                w[j] = this.filter((minIdx + j) / this.inRate - t) / this.inRate;
            }
            this.firstIndex[i] = minIdx;
            this.weights.push(w);
        }
    }

    private filter(t: number): number {
        const width = this.numZeros / (2 * this.cutoff);
        const window = Math.abs(t) < width ? 0.5 * (1 + Math.cos(((2 * Math.PI * this.cutoff) / this.numZeros) * t)) : 0;
        const f = t !== 0 ? Math.sin(2 * Math.PI * this.cutoff * t) / (Math.PI * t) : 2 * this.cutoff;
        return f * window;
    }

    private numOutput(totalInput: number, flush: boolean): number {
        const tick = (this.inRate / gcd(this.inRate, this.outRate)) * this.outRate;
        const ticksPerIn = tick / this.inRate;
        let interval = totalInput * ticksPerIn;
        if (!flush) interval -= Math.floor((this.numZeros / (2 * this.cutoff)) * tick);
        if (interval <= 0) return 0;
        const ticksPerOut = tick / this.outRate;
        let last = Math.floor(interval / ticksPerOut);
        if (last * ticksPerOut === interval) last--;
        return last + 1;
    }

    /** Resample the next block of input. Pass `flush` with the last block (it may be empty). */
    process(input: Float32Array, flush = false): Float32Array {
        if (this.inRate === this.outRate) return input.slice();
        const n = input.length;
        const totalIn = this.inputOffset + n;
        const totalOut = this.numOutput(totalIn, flush);
        const out = new Float32Array(Math.max(0, totalOut - this.outputOffset));
        const rem = this.remainder;
        for (let s = this.outputOffset; s < totalOut; s++) {
            const unit = Math.floor(s / this.outUnit);
            const wrapped = s - unit * this.outUnit;
            const w = this.weights[wrapped]!;
            const first = this.firstIndex[wrapped]! + unit * this.inUnit - this.inputOffset;
            let acc = 0;
            if (first >= 0 && first + w.length <= n) {
                for (let i = 0; i < w.length; i++) acc += w[i]! * input[first + i]!;
            } else {
                for (let i = 0; i < w.length; i++) {
                    const k = first + i;
                    if (k < 0) {
                        if (rem.length + k >= 0) acc += w[i]! * rem[rem.length + k]!;
                    } else if (k < n) {
                        acc += w[i]! * input[k]!;
                    }
                }
            }
            out[s - this.outputOffset] = acc;
        }
        if (flush) {
            this.inputOffset = 0;
            this.outputOffset = 0;
            this.remainder = new Float32Array(0);
        } else {
            const need = Math.ceil((this.inRate * this.numZeros) / this.cutoff);
            const next = new Float32Array(need);
            for (let idx = -need; idx < 0; idx++) {
                const k = idx + n;
                if (k >= 0) next[idx + need] = input[k]!;
                else if (k + rem.length >= 0) next[idx + need] = rem[k + rem.length]!;
            }
            this.remainder = next;
            this.inputOffset = totalIn;
            this.outputOffset = totalOut;
        }
        return out;
    }
}

/** One-shot resample of a whole buffer. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
    if (Math.round(inRate) === Math.round(outRate)) return input;
    return new Resampler(inRate, outRate).process(input, true);
}
