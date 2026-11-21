/**
 * Pick a parser for a document: the MIME type first, then the file extension,
 * then a look at the leading bytes. Generic MIME types (octet-stream, zip) never win
 * over a specific extension.
 */
export type DocFormat =
    | "pdf"
    | "docx"
    | "sheet"
    | "csv"
    | "pptx"
    | "eml"
    | "msg"
    | "html"
    | "markdown"
    | "text"
    | "epub"
    | "legacy"
    | "archive"
    | "image"
    | "media";

const MIME: Record<string, DocFormat> = {
    "application/pdf": "pdf",
    "application/x-pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-word.document.macroenabled.12": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12": "sheet",
    "application/vnd.ms-excel.sheet.binary.macroenabled.12": "sheet",
    "application/vnd.ms-excel": "sheet",
    "application/vnd.oasis.opendocument.spreadsheet": "sheet",
    "text/csv": "csv",
    "application/csv": "csv",
    "text/tab-separated-values": "csv",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "pptx",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptx",
    "message/rfc822": "eml",
    "application/vnd.ms-outlook": "msg",
    "text/html": "html",
    "application/xhtml+xml": "html",
    "text/markdown": "markdown",
    "text/x-markdown": "markdown",
    "text/plain": "text",
    "application/json": "text",
    "application/xml": "text",
    "text/xml": "text",
    "application/x-yaml": "text",
    "text/yaml": "text",
    "application/epub+zip": "epub",
    "application/msword": "legacy",
    "application/vnd.ms-powerpoint": "legacy",
    "application/rtf": "legacy",
    "text/rtf": "legacy",
    "application/vnd.oasis.opendocument.text": "legacy",
    "application/vnd.oasis.opendocument.presentation": "legacy",
    "application/vnd.apple.pages": "legacy",
    "application/vnd.apple.keynote": "legacy",
    "application/vnd.apple.numbers": "legacy",
    "application/x-hwp": "legacy",
    "application/vnd.ms-outlook-pst": "legacy",
    "application/zip": "archive",
    "application/x-7z-compressed": "archive",
    "application/x-tar": "archive",
    "application/gzip": "archive",
    "application/x-rar-compressed": "archive",
    "application/vnd.rar": "archive",
};

const EXT: Record<string, DocFormat> = {
    pdf: "pdf",
    docx: "docx",
    docm: "docx",
    dotx: "docx",
    dotm: "docx",
    xlsx: "sheet",
    xlsm: "sheet",
    xlsb: "sheet",
    xltx: "sheet",
    xltm: "sheet",
    xls: "sheet",
    xlt: "sheet",
    ods: "sheet",
    fods: "sheet",
    csv: "csv",
    tsv: "csv",
    pptx: "pptx",
    pptm: "pptx",
    ppsx: "pptx",
    potx: "pptx",
    eml: "eml",
    mht: "eml",
    mhtml: "eml",
    msg: "msg",
    html: "html",
    htm: "html",
    xhtml: "html",
    xht: "html",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
    qmd: "markdown",
    rmd: "markdown",
    txt: "text",
    text: "text",
    log: "text",
    json: "text",
    jsonl: "text",
    ndjson: "text",
    xml: "text",
    yaml: "text",
    yml: "text",
    toml: "text",
    ini: "text",
    srt: "text",
    vtt: "text",
    epub: "epub",
    // Legacy binary and long-tail formats: handed to xberg-wasm, loaded lazily.
    doc: "legacy",
    dot: "legacy",
    wps: "legacy",
    ppt: "legacy",
    pps: "legacy",
    pot: "legacy",
    rtf: "legacy",
    odt: "legacy",
    ott: "legacy",
    fodt: "legacy",
    odp: "legacy",
    otp: "legacy",
    fodp: "legacy",
    fodg: "legacy",
    pages: "legacy",
    key: "legacy",
    numbers: "legacy",
    hwp: "legacy",
    hwpx: "legacy",
    pst: "legacy",
    fb2: "legacy",
    rst: "legacy",
    org: "legacy",
    adoc: "legacy",
    asciidoc: "legacy",
    tex: "legacy",
    latex: "legacy",
    typ: "legacy",
    docbook: "legacy",
    dbk: "legacy",
    jats: "legacy",
    nxml: "legacy",
    ipynb: "legacy",
    bib: "legacy",
    ris: "legacy",
    opml: "legacy",
    dbf: "legacy",
    // Not documents for this slot.
    zip: "archive",
    "7z": "archive",
    rar: "archive",
    tar: "archive",
    gz: "archive",
    tgz: "archive",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    bmp: "image",
    tif: "image",
    tiff: "image",
    heic: "image",
    avif: "image",
    mp4: "media",
    mov: "media",
    mkv: "media",
    webm: "media",
    mp3: "media",
    wav: "media",
    m4a: "media",
    flac: "media",
    ogg: "media",
};

export function extensionOf(filename: string | undefined): string {
    if (!filename) return "";
    const base = filename.split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
    if (bytes.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
    return true;
}

function asciiIncludes(bytes: Uint8Array, needle: string, limit = bytes.length): boolean {
    const n = needle.length;
    const end = Math.min(bytes.length, limit) - n;
    const first = needle.charCodeAt(0);
    outer: for (let i = 0; i <= end; i++) {
        if (bytes[i] !== first) continue;
        for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
        return true;
    }
    return false;
}

/** Best guess from content alone (used when MIME and extension say nothing). */
export function sniff(bytes: Uint8Array): DocFormat | undefined {
    if (asciiIncludes(bytes, "%PDF-", 1024)) return "pdf";
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
        // ZIP container: entry names are stored in plain ASCII.
        if (asciiIncludes(bytes, "mimetypeapplication/epub+zip", 128)) return "epub";
        if (asciiIncludes(bytes, "mimetypeapplication/vnd.oasis.opendocument.spreadsheet", 128)) return "sheet";
        if (asciiIncludes(bytes, "mimetypeapplication/vnd.oasis.opendocument", 128)) return "legacy";
        if (asciiIncludes(bytes, "word/")) return "docx";
        if (asciiIncludes(bytes, "ppt/")) return "pptx";
        if (asciiIncludes(bytes, "xl/")) return "sheet";
        return "archive";
    }
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
        // OLE compound file: .doc / .xls / .ppt / .msg. Stream names are UTF-16LE.
        const u16 = (s: string) => {
            const out: number[] = [];
            for (const ch of s) out.push(ch.charCodeAt(0), 0);
            return out;
        };
        const has = (s: string) => {
            const sig = u16(s);
            for (let i = 0; i + sig.length <= bytes.length; i++) if (startsWith(bytes, sig, i)) return true;
            return false;
        };
        if (has("__substg1.0_")) return "msg";
        if (has("Workbook") || has("Book")) return "sheet";
        return "legacy";
    }
    if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "legacy"; // {\rtf
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0xff, 0xd8, 0xff])) return "image";
    const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2048)).trimStart().toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html") || /<(head|body)[\s>]/.test(head)) return "html";
    if (/^(received|return-path|mime-version|from|message-id|delivered-to):/m.test(head) && /\n\n|\r\n\r\n/.test(head)) {
        return "eml";
    }
    // Mostly printable → plain text.
    let printable = 0;
    const sample = bytes.subarray(0, 4096);
    for (const b of sample) if (b === 9 || b === 10 || b === 13 || b >= 32) printable++;
    if (sample.length && printable / sample.length > 0.95) return "text";
    return undefined;
}

export function detectFormat(mime: string | undefined, filename: string | undefined, bytes: Uint8Array): DocFormat | undefined {
    const m = (mime ?? "").split(";")[0]!.trim().toLowerCase();
    const fromMime = MIME[m];
    const fromExt = EXT[extensionOf(filename)];
    // A specific MIME type wins; generic ones (zip, plain text) yield to a known extension.
    if (fromMime && fromMime !== "archive" && fromMime !== "text") return fromMime;
    if (fromExt) return fromExt;
    if (fromMime) return fromMime === "archive" ? (sniff(bytes) ?? "archive") : fromMime;
    return sniff(bytes);
}
