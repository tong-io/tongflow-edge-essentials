/**
 * Browser stand-in for `iconv-lite`, which msgreader imports to decode ANSI
 * (non-Unicode) strings. iconv-lite needs Node's Buffer; TextDecoder covers decoding
 * in every browser and worker. Encoding is never used when only reading .msg files.
 */
const ALIASES: Record<string, string> = {
    cp936: "gbk",
    ms936: "gbk",
    cp950: "big5",
    cp932: "shift_jis",
    ms932: "shift_jis",
    cp949: "euc-kr",
    utf16le: "utf-16le",
    ucs2: "utf-16le",
    "ucs-2": "utf-16le",
    latin1: "windows-1252",
    binary: "windows-1252",
};

function label(enc: string): string {
    const e = enc.toLowerCase().replace(/_/g, "-");
    if (ALIASES[e]) return ALIASES[e]!;
    const m = /^(?:cp|windows-?)(\d{3,4})$/.exec(e);
    if (m) return `windows-${m[1]}`;
    return e;
}

export function decode(bytes: Uint8Array, encoding: string): string {
    return new TextDecoder(label(encoding)).decode(bytes);
}

export function encode(): never {
    throw new Error("iconv-lite encode is not available in the edge runtime");
}

export function encodingExists(encoding: string): boolean {
    try {
        new TextDecoder(label(encoding));
        return true;
    } catch {
        return false;
    }
}

export default { decode, encode, encodingExists };
