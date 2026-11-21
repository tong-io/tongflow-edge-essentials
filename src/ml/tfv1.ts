/**
 * Packed vector format "TFV1": the binary payload of the `vectors` FileRef of
 * `embed-text` / `embed-image`. Copied from scanall's `@scanall/kb`
 * (`packages/kb/src/vectors.ts`), which reads it on the host; this plugin does
 * not depend on that package.
 *
 * Layout, all little-endian:
 *
 *   offset 0   4 bytes  magic, ASCII "TFV1"
 *   offset 4   u32      dims   (> 0)
 *   offset 8   u32      count  (>= 0)
 *   offset 12  f32[count * dims]  row-major: vector 0, vector 1, ...
 */

export const TFV1_HEADER_BYTES = 12;
const MAGIC_BYTES = [0x54, 0x46, 0x56, 0x31] as const; // "TFV1"
const MAX_U32 = 0xffff_ffff;

/**
 * Pack equal-length vectors into a TFV1 byte array.
 * @param dims required when `vectors` is empty; otherwise checked against every vector.
 */
export function packVectors(vectors: ReadonlyArray<ArrayLike<number>>, dims?: number): Uint8Array<ArrayBuffer> {
    const d = dims ?? vectors[0]?.length;
    if (d === undefined) throw new RangeError("packVectors: dims is required when there are no vectors");
    assertU32("dims", d, 1);
    assertU32("count", vectors.length, 0);
    const out = new Uint8Array(TFV1_HEADER_BYTES + 4 * d * vectors.length);
    const view = new DataView(out.buffer);
    MAGIC_BYTES.forEach((b, i) => view.setUint8(i, b));
    view.setUint32(4, d, true);
    view.setUint32(8, vectors.length, true);
    let offset = TFV1_HEADER_BYTES;
    vectors.forEach((v, i) => {
        if (v.length !== d) throw new RangeError(`packVectors: vector ${i} has length ${v.length}, expected ${d}`);
        for (let j = 0; j < d; j++) {
            view.setFloat32(offset, v[j] as number, true);
            offset += 4;
        }
    });
    return out;
}

function assertU32(name: string, n: number, min: number): void {
    if (!Number.isInteger(n) || n < min || n > MAX_U32) {
        throw new RangeError(`packVectors: ${name} must be an integer in [${min}, 2^32-1], got ${n}`);
    }
}

/** Matryoshka truncation: keep the first `dims` components and L2-normalize again. */
export function truncateNormalize(v: ArrayLike<number>, dims: number): Float32Array {
    if (!Number.isInteger(dims) || dims < 1 || dims > v.length) {
        throw new RangeError(`dims must be an integer in [1, ${v.length}], got ${dims}`);
    }
    const out = new Float32Array(dims);
    let sq = 0;
    for (let i = 0; i < dims; i++) {
        const x = v[i] as number;
        out[i] = x;
        sq += x * x;
    }
    const norm = Math.sqrt(sq);
    if (norm > 0) for (let i = 0; i < dims; i++) out[i]! /= norm;
    return out;
}
