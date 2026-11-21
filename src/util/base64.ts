type U8WithBase64 = typeof Uint8Array & { fromBase64?: (s: string) => Uint8Array };
type U8InstWithBase64 = Uint8Array & { toBase64?: () => string };

/** Decode `bytesBase64` (a bare base64 string; a `data:` URL prefix is tolerated). */
export function decodeBase64(input: string): Uint8Array {
    let s = input;
    if (s.startsWith("data:")) {
        const comma = s.indexOf(",");
        s = comma >= 0 ? s.slice(comma + 1) : "";
    }
    s = s.replace(/[\s]/g, "");
    const U8 = Uint8Array as U8WithBase64;
    if (typeof U8.fromBase64 === "function") {
        try {
            return U8.fromBase64(s);
        } catch {
            // fall through: lenient path below accepts url-safe / unpadded input
        }
    }
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function encodeBase64(bytes: Uint8Array): string {
    const b = bytes as U8InstWithBase64;
    if (typeof b.toBase64 === "function") return b.toBase64();
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(bin);
}

/** A standalone ArrayBuffer holding exactly these bytes (some libraries want one). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer;
    }
    return bytes.slice().buffer as ArrayBuffer;
}
