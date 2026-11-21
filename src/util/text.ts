/**
 * Decode bytes of unknown encoding: a BOM wins, then strict UTF-8, then GB18030
 * (a superset of GBK/GB2312, the usual encoding of Chinese text files that are not
 * UTF-8). GB18030 maps every byte sequence, so it is the last resort.
 */
export function decodeText(bytes: Uint8Array): string {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        try {
            return new TextDecoder("gb18030").decode(bytes);
        } catch {
            return new TextDecoder("utf-8").decode(bytes);
        }
    }
}

/** Collapse runs of blank lines and trim trailing spaces; keeps paragraph breaks. */
export function tidyText(s: string): string {
    return s
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t ]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    thinsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    middot: "·",
    bull: "•",
    copy: "©",
    reg: "®",
    trade: "™",
};

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body: string) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? m;
    });
}

/**
 * Plain text of a small rich-text HTML fragment (a slide text box, a cell):
 * block ends and <br> become line breaks, tags are dropped, entities decoded.
 */
export function htmlFragmentToText(html: string): string {
    const s = html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|table|blockquote)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "");
    return tidyText(decodeEntities(s));
}

export function fileStem(filename: string | undefined, fallback = "document"): string {
    if (!filename) return fallback;
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return stem || fallback;
}
