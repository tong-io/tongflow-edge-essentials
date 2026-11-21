/**
 * In-place iterative radix-2 complex FFT on separate real/imaginary arrays.
 * Sizes are powers of two (512 for every feature extractor here). Tables are
 * cached per size.
 */
interface FftTables {
    rev: Uint32Array;
    cos: Float64Array;
    sin: Float64Array;
}

const tables = new Map<number, FftTables>();

function getTables(n: number): FftTables {
    let t = tables.get(n);
    if (t) return t;
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    const bits = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n);
        sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { rev, cos, sin };
    tables.set(n, t);
    return t;
}

/** Forward FFT of (re, im), in place. */
export function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    const { rev, cos, sin } = getTables(n);
    for (let i = 0; i < n; i++) {
        const j = rev[i]!;
        if (j > i) {
            let t = re[i]!;
            re[i] = re[j]!;
            re[j] = t;
            t = im[i]!;
            im[i] = im[j]!;
            im[j] = t;
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
            for (let k = 0; k < half; k++) {
                const wr = cos[k * step]!;
                const wi = sin[k * step]!;
                const a = start + k;
                const b = a + half;
                const xr = re[b]! * wr - im[b]! * wi;
                const xi = re[b]! * wi + im[b]! * wr;
                re[b] = re[a]! - xr;
                im[b] = im[a]! - xi;
                re[a] = re[a]! + xr;
                im[a] = im[a]! + xi;
            }
        }
    }
}

/**
 * Power spectrum |X[k]|² for k = 0..n/2 of a real frame (zero imaginary part),
 * written into `out` (length ≥ n/2 + 1). `re` is overwritten.
 */
export function powerSpectrum(re: Float64Array, scratchIm: Float64Array, out: Float64Array): void {
    scratchIm.fill(0);
    fft(re, scratchIm);
    const half = re.length / 2;
    for (let k = 0; k <= half; k++) out[k] = re[k]! * re[k]! + scratchIm[k]! * scratchIm[k]!;
}
