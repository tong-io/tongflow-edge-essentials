/**
 * Chinese-aware text chunker for the `chunk-text` slot.
 *
 * The text is cut into blocks (paragraphs, Markdown tables, fenced code, headings),
 * blocks are packed greedily into chunks of at most `maxChars`, and a block that is
 * too long on its own is split at sentence ends (。！？；… and their English
 * counterparts, and line breaks), then hard-cut as a last resort. A table that fits
 * in one chunk is never split; a longer one is split between rows and every piece
 * repeats the header row. Consecutive prose chunks share an overlap of about
 * `overlap` characters, taken at sentence boundaries from the end of the previous
 * chunk. Lengths are UTF-16 code units: one per CJK character.
 */

export const DEFAULT_MAX_CHARS = 500;
export const DEFAULT_OVERLAP = 80;
/** Smaller limits make chunks that are too short to retrieve anything. */
export const MIN_MAX_CHARS = 50;
/** bge-*-zh reads at most 512 tokens; far longer chunks would be truncated by the model anyway. */
export const MAX_MAX_CHARS = 8000;

export interface ChunkOptions {
    /** Upper bound of a chunk's length, overlap included. Default 500. */
    maxChars?: number;
    /** Target overlap between consecutive prose chunks. Default `min(80, maxChars / 5)`. */
    overlap?: number;
}

type Kind = "para" | "heading" | "table" | "code";

interface Block {
    kind: Kind;
    text: string;
}

/** A packable piece. `joiner` goes before it when it follows other text in a chunk. */
interface Unit {
    kind: Kind;
    text: string;
    joiner: string;
}

const TERMINATORS = new Set(["。", "！", "？", "；", "!", "?", ";", "…", "．"]);
const CLOSERS = new Set(["”", "’", '"', "'", "」", "』", "）", ")", "】", "]", "》", "〉"]);
const SOFT_BREAKS = new Set(["，", "、", "：", ",", ":", " ", "\t", "\n", "　"]);

const isTableLine = (line: string) => /^\s*\|/.test(line);
const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const isFence = (line: string) => /^\s*(```|~~~)/.test(line);
const isHeading = (line: string) => /^#{1,6}\s/.test(line);

/** Normalize line ends and join the collected parts. */
function prepare(texts: readonly string[]): string {
    return texts
        .map((t) => (typeof t === "string" ? t.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim() : ""))
        .filter(Boolean)
        .join("\n\n");
}

function toBlocks(text: string): Block[] {
    const blocks: Block[] = [];
    const lines = text.split("\n");
    let para: string[] = [];
    const flushPara = () => {
        if (para.length) blocks.push({ kind: "para", text: para.join("\n") });
        para = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (isFence(line)) {
            flushPara();
            const fence = line.trim().slice(0, 3);
            const code = [line];
            while (++i < lines.length) {
                code.push(lines[i]!);
                if (lines[i]!.trim().startsWith(fence)) break;
            }
            blocks.push({ kind: "code", text: code.join("\n") });
        } else if (isTableLine(line)) {
            flushPara();
            const rows = [line];
            while (i + 1 < lines.length && isTableLine(lines[i + 1]!)) rows.push(lines[++i]!);
            blocks.push({ kind: "table", text: rows.join("\n") });
        } else if (isHeading(line)) {
            flushPara();
            blocks.push({ kind: "heading", text: line.trim() });
        } else if (!line.trim()) {
            flushPara();
        } else {
            para.push(line);
        }
    }
    flushPara();
    return blocks;
}

/**
 * Split prose after sentence terminators (with any closing quotes/brackets),
 * after an English period followed by whitespace, and after line breaks.
 * Each sentence keeps its trailing whitespace, so concatenating them gives the input back.
 */
export function splitSentences(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i]!;
        let end = -1;
        if (TERMINATORS.has(c)) {
            let j = i + 1;
            while (j < n && (TERMINATORS.has(text[j]!) || CLOSERS.has(text[j]!))) j++;
            end = j;
        } else if (c === "." && (i + 1 >= n || /\s/.test(text[i + 1]!))) {
            end = i + 1;
        } else if (c === "\n") {
            end = i + 1;
        }
        if (end > 0) {
            while (end < n && /\s/.test(text[end]!)) end++;
            out.push(text.slice(start, end));
            start = i = end;
        } else {
            i++;
        }
    }
    if (start < n) out.push(text.slice(start));
    return out.filter((s) => s.trim());
}

/** Never cut between the halves of a surrogate pair. */
function safeCut(text: string, at: number): number {
    if (at <= 0 || at >= text.length) return at;
    const code = text.charCodeAt(at);
    return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

/** Cut a run without sentence ends into pieces ≤ max, preferring commas and spaces near the end. */
export function hardCut(text: string, max: number): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > max) {
        let cut = -1;
        for (let k = max; k >= Math.floor(max * 0.7); k--) {
            if (SOFT_BREAKS.has(rest[k - 1]!)) {
                cut = k;
                break;
            }
        }
        if (cut < 0) cut = max;
        cut = safeCut(rest, cut);
        if (cut <= 0) cut = max;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
}

/** Split a table longer than `max` between rows, repeating the header in every piece. */
function splitTable(text: string, max: number): string[] {
    const rows = text.split("\n");
    const header = rows.length > 1 && isTableSeparator(rows[1]!) ? rows.slice(0, 2).join("\n") : "";
    const body = header ? rows.slice(2) : rows;
    const pieces: string[] = [];
    const prefix = header && header.length + 1 < max / 2 ? header + "\n" : "";
    let cur = "";
    for (const row of body) {
        if (prefix.length + row.length > max) {
            // A single row longer than a chunk: it cannot stay a table row.
            if (cur) pieces.push(prefix + cur);
            cur = "";
            pieces.push(...hardCut(row, max));
            continue;
        }
        const next = cur ? `${cur}\n${row}` : row;
        if (prefix.length + next.length > max) {
            pieces.push(prefix + cur);
            cur = row;
        } else {
            cur = next;
        }
    }
    if (cur) pieces.push(prefix + cur);
    return pieces;
}

function toUnits(blocks: Block[], max: number): Unit[] {
    const units: Unit[] = [];
    for (const b of blocks) {
        if (b.text.length <= max) {
            units.push({ kind: b.kind, text: b.text, joiner: "\n\n" });
            continue;
        }
        if (b.kind === "table") {
            splitTable(b.text, max).forEach((t) => units.push({ kind: "table", text: t, joiner: "\n\n" }));
            continue;
        }
        if (b.kind === "code") {
            // Long code: split between lines (each piece ≤ max), lines themselves hard-cut.
            const lines = b.text.split("\n").flatMap((l) => hardCut(l, max - 1));
            let cur = "";
            for (const l of lines) {
                if (cur && cur.length + 1 + l.length > max) {
                    units.push({ kind: "code", text: cur, joiner: "\n\n" });
                    cur = l;
                } else cur = cur ? `${cur}\n${l}` : l;
            }
            if (cur) units.push({ kind: "code", text: cur, joiner: "\n\n" });
            continue;
        }
        // Prose (or an absurdly long heading): sentences, then hard cuts.
        let first = true;
        for (const s of splitSentences(b.text)) {
            for (const piece of s.length > max ? hardCut(s, max) : [s]) {
                units.push({ kind: "para", text: piece, joiner: first ? "\n\n" : "" });
                first = false;
            }
        }
    }
    return units;
}

/** The last sentences of `text` that fit in `budget` characters (or its last `budget` characters). */
function tailOverlap(text: string, budget: number): string {
    if (budget <= 0) return "";
    const body = text.trimEnd();
    if (!body) return "";
    const sentences = splitSentences(body);
    let tail = "";
    for (let i = sentences.length - 1; i >= 0; i--) {
        const next = sentences[i]! + tail;
        if (next.trim().length > budget) break;
        tail = next;
    }
    if (tail.trim()) return tail.trimStart();
    // The last sentence alone is longer than the budget: take its end, starting after a soft break if there is one.
    let start = safeCut(body, body.length - budget);
    for (let k = start; k < body.length - Math.floor(budget / 2); k++) {
        if (SOFT_BREAKS.has(body[k]!) || TERMINATORS.has(body[k]!)) {
            start = k + 1;
            break;
        }
    }
    return body.slice(start).trimStart();
}

/** Chunk the collected texts. Empty input gives `[]`. */
export function chunkText(texts: readonly string[] | string, options: ChunkOptions = {}): string[] {
    const max = Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS)));
    const overlap = Math.max(0, Math.min(Math.floor(options.overlap ?? Math.min(DEFAULT_OVERLAP, max / 5)), Math.floor(max / 2)));
    const text = prepare(typeof texts === "string" ? [texts] : texts);
    if (!text) return [];
    const units = toUnits(toBlocks(text), max);

    const chunks: string[] = [];
    let cur: Unit[] = [];
    let curLen = 0;
    const lengthWith = (u: Unit) => (cur.length ? curLen + u.joiner.length + u.text.length : u.text.length);
    const push = (u: Unit) => {
        curLen = lengthWith(u);
        cur.push(u);
    };
    const render = (us: Unit[]) => us.map((u, i) => (i ? u.joiner + u.text : u.text)).join("");

    for (const u of units) {
        if (lengthWith(u) <= max) {
            push(u);
            continue;
        }
        // Flush. Trailing headings move on with the content they introduce.
        const carried: Unit[] = [];
        while (cur.length > 1 && cur[cur.length - 1]!.kind === "heading") carried.unshift(cur.pop()!);
        const prev = cur;
        const prevText = render(prev);
        if (prevText.trim()) chunks.push(prevText.trim());
        cur = [];
        curLen = 0;
        for (const h of carried) push(h);
        if (cur.length && lengthWith(u) > max) {
            // The carried heading and this unit do not fit together: keep the heading alone.
            chunks.push(render(cur).trim());
            cur = [];
            curLen = 0;
        }
        // Overlap only between prose: never into or out of a table, code or a new section.
        const last = prev[prev.length - 1];
        if (!cur.length && overlap > 0 && u.kind === "para" && last?.kind === "para") {
            let tail = tailOverlap(prevText, Math.min(overlap, max - u.text.length - u.joiner.length - 1));
            // Mid-paragraph English: the space between the sentences went with the trimmed chunk end.
            if (tail && !u.joiner && /[\x21-\x7e]$/.test(tail) && /^[\x21-\x7e]/.test(u.text)) tail += " ";
            if (tail) push({ kind: "para", text: tail, joiner: "" });
        }
        push(u);
    }
    const rest = render(cur).trim();
    if (rest) chunks.push(rest);
    return chunks.filter((c) => c.trim().length > 0);
}
