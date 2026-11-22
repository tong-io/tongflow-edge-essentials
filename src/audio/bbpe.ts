/**
 * Byte-level BPE (icefall "bbpe") detokenization, as sherpa-onnx's
 * `SymbolTable::DecodeByteBpe`: every token character stands for one byte
 * (icefall's `PRINTABLE_BASE_CHARS` table), `▁` is a word boundary, and the
 * bytes are UTF-8. Used by the Zipformer-CTC zh model, whose 1000 tokens are
 * byte pieces of Chinese characters.
 */

/** icefall `byte_utils.PRINTABLE_BASE_CHARS`: the code point that stands for byte b. */
function printableBaseChars(): number[] {
    const out: number[] = [];
    const add = (a: number, b: number) => {
        for (let c = a; c <= b; c++) out.push(c);
    };
    add(256, 287);
    add(32, 126);
    add(288, 305);
    add(308, 318);
    add(321, 328);
    add(330, 382);
    add(384, 422);
    return out;
}

let table: Map<number, number> | undefined;

/** Code point → byte. `⁇` (BPE unk, U+2047) maps to a space, as in sherpa-onnx. */
export function byteBpeTable(): Map<number, number> {
    if (!table) {
        table = new Map();
        printableBaseChars().forEach((cp, b) => table!.set(cp, b));
        table.set(8263, 32);
    }
    return table;
}

const WORD_BOUNDARY = 0x2581; // ▁

/** True when the token table looks byte-level (sherpa-onnx: most symbols are in the table). */
export function isByteBpe(symbols: readonly string[]): boolean {
    const t = byteBpeTable();
    let inTable = 0;
    let total = 0;
    for (const s of symbols) {
        if (!s || /^<.*>$/.test(s)) continue;
        total++;
        if ([...s].every((ch) => ch.codePointAt(0) === WORD_BOUNDARY || t.has(ch.codePointAt(0)!))) inTable++;
    }
    return total > 0 && inTable / total > 0.9;
}

/** The text of a concatenated byte-BPE token string. Invalid UTF-8 is dropped. */
export function decodeByteBpe(text: string): string {
    const t = byteBpeTable();
    const bytes: number[] = [];
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp === WORD_BOUNDARY) {
            const last = bytes[bytes.length - 1];
            if (last !== undefined && last !== 32 && last >= 0x20 && last < 0x7f) bytes.push(32);
            continue;
        }
        const b = t.get(cp);
        if (b !== undefined) bytes.push(b);
        else if (cp >= 0x20 && cp < 0x7f) bytes.push(cp);
        // anything else cannot come from this table: skipped, as sherpa-onnx does
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes)).replace(/�/g, "");
}
