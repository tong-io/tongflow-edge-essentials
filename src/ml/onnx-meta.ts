/**
 * Read an ONNX model's custom metadata (`ModelProto.metadata_props`, field 14)
 * straight from the protobuf bytes. onnxruntime-web has no API for it, and
 * the sherpa-onnx exports keep their front-end parameters there (SenseVoice
 * CMVN, pyannote window sizes, CAM++ normalization). Only the top level is
 * walked; the graph and its weights are skipped by length.
 */
function readVarint(buf: Uint8Array, pos: { p: number }): number {
    let result = 0;
    let shift = 0;
    for (;;) {
        if (pos.p >= buf.length) throw new Error("truncated ONNX protobuf");
        const b = buf[pos.p++]!;
        result += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) return result;
        shift += 7;
        if (shift > 63) throw new Error("bad varint in ONNX protobuf");
    }
}

function skip(buf: Uint8Array, pos: { p: number }, wire: number): void {
    switch (wire) {
        case 0:
            readVarint(buf, pos);
            return;
        case 1:
            pos.p += 8;
            return;
        case 2: {
            const len = readVarint(buf, pos); // read first: `pos.p += readVarint()` would drop the varint's bytes
            pos.p += len;
            return;
        }
        case 5:
            pos.p += 4;
            return;
        default:
            throw new Error(`unsupported protobuf wire type ${wire}`);
    }
}

const utf8 = new TextDecoder();

function readEntry(buf: Uint8Array): [string, string] {
    const pos = { p: 0 };
    let key = "";
    let value = "";
    while (pos.p < buf.length) {
        const tag = readVarint(buf, pos);
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        if ((field === 1 || field === 2) && wire === 2) {
            const len = readVarint(buf, pos);
            const s = utf8.decode(buf.subarray(pos.p, pos.p + len));
            pos.p += len;
            if (field === 1) key = s;
            else value = s;
        } else {
            skip(buf, pos, wire);
        }
    }
    return [key, value];
}

/** Custom metadata of an ONNX model as a plain map. */
export function readOnnxMetadata(model: Uint8Array): Record<string, string> {
    const out: Record<string, string> = {};
    const pos = { p: 0 };
    while (pos.p < model.length) {
        const tag = readVarint(model, pos);
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        if (field === 14 && wire === 2) {
            const len = readVarint(model, pos);
            const [k, v] = readEntry(model.subarray(pos.p, pos.p + len));
            if (k) out[k] = v;
            pos.p += len;
        } else {
            skip(model, pos, wire);
        }
    }
    return out;
}

/** A required integer metadata value. */
export function metaInt(meta: Record<string, string>, key: string): number {
    const v = Number.parseInt(meta[key] ?? "", 10);
    if (!Number.isFinite(v)) throw new Error(`model metadata has no integer "${key}"`);
    return v;
}

/** A required comma-separated float vector. */
export function metaFloats(meta: Record<string, string>, key: string): Float32Array {
    const s = meta[key];
    if (!s) throw new Error(`model metadata has no "${key}"`);
    return Float32Array.from(s.split(",").filter((x) => x.trim() !== "").map(Number));
}
