/**
 * Packed vector format "TFV1" — the binary payload of the `embed-text` slot's
 * `vectors` FileRef. Edge plugins write it, the host reads it (and vice versa).
 *
 * Layout (all little-endian):
 *
 *   offset 0  4 bytes  magic, ASCII "TFV1"
 *   offset 4  u32      dims   (> 0)
 *   offset 8  u32      count  (>= 0)
 *   offset 12 f32[count * dims]  row-major: vector 0, vector 1, ...
 *
 * Total byte length is exactly 12 + 4 * dims * count; anything else is rejected.
 */

export const TFV1_MAGIC = 'TFV1';
export const TFV1_HEADER_BYTES = 12;

const MAGIC_BYTES = [0x54, 0x46, 0x56, 0x31] as const; // "TFV1"
const MAX_U32 = 0xffff_ffff;

export interface UnpackedVectors {
  dims: number;
  count: number;
  /** One Float32Array per vector. Views over a single freshly allocated buffer. */
  vectors: Float32Array[];
}

/**
 * Pack equal-length vectors into a TFV1 byte array.
 * @param dims required when `vectors` is empty; otherwise checked against every vector.
 */
export function packVectors(
  vectors: ReadonlyArray<ArrayLike<number>>,
  dims?: number,
): Uint8Array<ArrayBuffer> {
  const d = dims ?? vectors[0]?.length;
  if (d === undefined) {
    throw new RangeError('packVectors: dims is required when there are no vectors');
  }
  assertU32('dims', d, 1);
  assertU32('count', vectors.length, 0);
  const out = new Uint8Array(TFV1_HEADER_BYTES + 4 * d * vectors.length);
  const view = new DataView(out.buffer);
  MAGIC_BYTES.forEach((b, i) => view.setUint8(i, b));
  view.setUint32(4, d, true);
  view.setUint32(8, vectors.length, true);
  let offset = TFV1_HEADER_BYTES;
  vectors.forEach((v, i) => {
    if (v.length !== d) {
      throw new RangeError(`packVectors: vector ${i} has length ${v.length}, expected ${d}`);
    }
    for (let j = 0; j < d; j++) {
      view.setFloat32(offset, v[j] as number, true);
      offset += 4;
    }
  });
  return out;
}

/** Read a TFV1 payload. Always copies, so the result never aliases the input. */
export function unpackVectors(input: ArrayBuffer | ArrayBufferView): UnpackedVectors {
  const bytes = toBytes(input);
  if (!isPackedVectors(bytes)) {
    throw new RangeError('unpackVectors: not a TFV1 payload (bad magic or too short)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  if (dims === 0) throw new RangeError('unpackVectors: dims must be > 0');
  const expected = TFV1_HEADER_BYTES + 4 * dims * count;
  if (bytes.byteLength !== expected) {
    throw new RangeError(
      `unpackVectors: byte length ${bytes.byteLength} does not match header (dims=${dims}, count=${count}, expected ${expected})`,
    );
  }
  const data = new Float32Array(dims * count);
  if (LITTLE_ENDIAN_HOST) {
    new Uint8Array(data.buffer).set(bytes.subarray(TFV1_HEADER_BYTES));
  } else {
    for (let i = 0; i < data.length; i++) {
      data[i] = view.getFloat32(TFV1_HEADER_BYTES + 4 * i, true);
    }
  }
  const vectors: Float32Array[] = [];
  for (let i = 0; i < count; i++) vectors.push(data.subarray(i * dims, (i + 1) * dims));
  return { dims, count, vectors };
}

/** True when the bytes start with the TFV1 magic and hold at least a header. */
export function isPackedVectors(input: ArrayBuffer | ArrayBufferView): boolean {
  const bytes = toBytes(input);
  return (
    bytes.byteLength >= TFV1_HEADER_BYTES && MAGIC_BYTES.every((b, i) => bytes[i] === b)
  );
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

function assertU32(name: string, n: number, min: number): void {
  if (!Number.isInteger(n) || n < min || n > MAX_U32) {
    throw new RangeError(`packVectors: ${name} must be an integer in [${min}, 2^32-1], got ${n}`);
  }
}
