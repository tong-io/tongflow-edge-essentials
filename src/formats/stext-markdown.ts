/**
 * MuPDF structured text (`StructuredText.asJSON()`) → Markdown-flavoured text.
 * Pure logic, unit tested in Node; `formats/mupdf.ts` feeds it.
 *
 * MuPDF gives text blocks in reading order, each with lines that carry a bbox,
 * the baseline origin and the font (size, weight). From that:
 * - **Headings**: short lines set noticeably larger than the body text (the most
 *   common size, weighted by characters) become `#`/`##`/`###`, largest first; a
 *   short bold line at body size becomes the next level down.
 * - **Paragraphs**: consecutive body lines are joined while the baseline step stays
 *   at the page's usual line spacing for that size, the previous line ran to the
 *   column's right edge, and the next line does not start a list item. CJK lines are
 *   joined without a space, Latin ones with one.
 * - **Tables**: a block whose lines sit side by side on one baseline is a row; two
 *   or more such rows in a row become a GitHub-flavoured Markdown table.
 * - **Images** (with `preserve-images`): an `![](name)` line where the figure sits,
 *   when the caller extracted it (`imageName` returns its file name).
 */
import { toMarkdownTable } from "../util/markdown.js";
import { tidyText } from "../util/text.js";

export interface StextRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface StextLine {
    bbox: StextRect;
    font?: { name?: string; size?: number; weight?: string; style?: string };
    /** Baseline origin. */
    x?: number;
    y?: number;
    text: string;
    wmode?: number;
}

export type StextBlock =
    | { type: "text"; bbox: StextRect; lines: StextLine[] }
    | { type: "image"; bbox: StextRect }
    | { type: "structure"; contents?: StextBlock[] }
    | { type: string; bbox?: StextRect; lines?: StextLine[]; contents?: StextBlock[] };

export interface StextPage {
    blocks: StextBlock[];
}

/** A line or a table row, in reading order, with what the layout rules need. */
type Item =
    | { kind: "line"; text: string; size: number; bold: boolean; x: number; right: number; base: number; blockStart: boolean }
    | { kind: "row"; cells: string[]; size: number }
    | { kind: "image"; index: number };

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const LIST_START = /^\s*(?:[-*•·▪●○◦‣]\s|\d{1,3}[.)、．]\s?|[（(]\d{1,3}[）)]|[一二三四五六七八九十]{1,3}[、.．]|[a-zA-Z][.)]\s)/;
const BULLET = /^\s*[•·▪●○◦‣]\s*/;

/** Flatten `structure` blocks (the `structured` / `segment` options) into plain blocks. */
export function flattenBlocks(blocks: readonly StextBlock[]): StextBlock[] {
    const out: StextBlock[] = [];
    for (const b of blocks) {
        if (b.type === "structure") out.push(...flattenBlocks((b as { contents?: StextBlock[] }).contents ?? []));
        else out.push(b);
    }
    return out;
}

const sizeOf = (l: StextLine) => Math.round((l.font?.size ?? l.bbox.h / 1.2) * 2) / 2;
const isBold = (l: StextLine) => l.font?.weight === "bold" || /bold|black|heavy|semibold|demi/i.test(l.font?.name ?? "");
const baseOf = (l: StextLine) => l.y ?? l.bbox.y + l.bbox.h * 0.8;

/** Join two pieces of one paragraph: no space between CJK text, one between Latin words. */
export function joinLines(a: string, b: string): string {
    const left = a.replace(/\s+$/, "");
    const right = b.replace(/^\s+/, "");
    if (!left) return right;
    if (!right) return left;
    if (CJK.test(left.at(-1)!) || CJK.test(right[0]!)) return left + right;
    // MuPDF's `dehyphenate` already joins most; a trailing hyphen between letters is a break.
    if (/[A-Za-z]-$/.test(left) && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
    return `${left} ${right}`;
}

/** Lines of one block grouped by baseline: a group of two or more is a table row. */
function rowsOf(lines: StextLine[]): StextLine[][] {
    const rows: StextLine[][] = [];
    for (const l of lines) {
        const base = baseOf(l);
        const tol = Math.max(1.5, sizeOf(l) * 0.4);
        const row = rows.find((r) => Math.abs(baseOf(r[0]!) - base) <= tol);
        if (row) row.push(l);
        else rows.push([l]);
    }
    for (const r of rows) r.sort((a, b) => a.bbox.x - b.bbox.x);
    return rows;
}

function itemsOf(page: StextPage, imageName: (index: number) => string | undefined, counter: { image: number }): Item[] {
    const items: Item[] = [];
    for (const b of flattenBlocks(page.blocks)) {
        if (b.type === "image") {
            const index = counter.image++;
            if (imageName(index)) items.push({ kind: "image", index });
            continue;
        }
        if (b.type !== "text" || !b.lines?.length) continue;
        const lines = b.lines.filter((l) => l.text.trim() && (l.wmode ?? 0) === 0);
        const vertical = b.lines.filter((l) => l.text.trim() && (l.wmode ?? 0) !== 0);
        const rows = rowsOf(lines);
        // A block of side-by-side cells (MuPDF puts each table row in one block).
        const tabular = rows.length >= 1 && rows.every((r) => r.length >= 2) && lines.length >= 2;
        let first = true;
        for (const r of rows) {
            if (tabular) {
                items.push({ kind: "row", cells: r.map((l) => l.text.trim()), size: sizeOf(r[0]!) });
                continue;
            }
            // Pieces of one visual line split by MuPDF (a wide gap): keep them on one line.
            const text = r.map((l) => l.text.trim()).join(" ");
            const l0 = r[0]!;
            const last = r[r.length - 1]!;
            items.push({
                kind: "line",
                text,
                size: sizeOf(l0),
                bold: r.every(isBold),
                x: l0.bbox.x,
                right: last.bbox.x + last.bbox.w,
                base: baseOf(l0),
                blockStart: first,
            });
            first = false;
        }
        for (const l of vertical) {
            items.push({ kind: "line", text: l.text.trim(), size: sizeOf(l), bold: isBold(l), x: l.bbox.x, right: l.bbox.x + l.bbox.w, base: baseOf(l), blockStart: true });
        }
    }
    return items;
}

/** The most common font size, weighted by characters. */
export function bodySize(items: readonly { kind: string; size?: number; text?: string }[]): number {
    const weight = new Map<number, number>();
    for (const it of items) {
        if (it.kind !== "line" || !it.size) continue;
        weight.set(it.size, (weight.get(it.size) ?? 0) + (it.text?.length ?? 0));
    }
    let best = 0;
    let bestW = -1;
    for (const [s, w] of weight) if (w > bestW || (w === bestW && s < best)) [best, bestW] = [s, w];
    return best || 10;
}

const MAX_HEADING_CHARS = 80;

function isHeadingLine(it: Extract<Item, { kind: "line" }>, body: number): boolean {
    if (it.text.length > MAX_HEADING_CHARS) return false;
    if (it.size >= body * 1.15) return true;
    // A short bold line at body size that does not read like a sentence.
    return it.bold && it.size >= body - 0.5 && it.text.length <= 40 && !/[。.;；,，:：]$/.test(it.text);
}

/**
 * The usual baseline step per font size: the lower quartile of the steps between
 * consecutive lines of that size (paragraph breaks are the larger steps; with short
 * paragraphs they can be half of all steps, so the median is not safe).
 */
function lineSteps(items: readonly Item[]): Map<number, number> {
    const steps = new Map<number, number[]>();
    let prev: Extract<Item, { kind: "line" }> | undefined;
    for (const it of items) {
        if (it.kind !== "line") {
            prev = undefined;
            continue;
        }
        if (prev && prev.size === it.size) {
            const d = it.base - prev.base;
            if (d > 0 && d < it.size * 3) {
                const list = steps.get(it.size) ?? [];
                list.push(d);
                steps.set(it.size, list);
            }
        }
        prev = it;
    }
    const out = new Map<number, number>();
    for (const [s, list] of steps) {
        list.sort((a, b) => a - b);
        out.set(s, list[Math.floor((list.length - 1) / 4)]!);
    }
    return out;
}

export interface StextMarkdownOptions {
    /** The file name to reference for the document's `index`-th image block, or undefined to leave it out. */
    imageName?: (index: number) => string | undefined;
}

/**
 * Markdown-flavoured text of a document from its pages' structured text, pages
 * separated by a blank line (as the pdf.js path does).
 */
export function stextToMarkdown(pages: readonly StextPage[], opts: StextMarkdownOptions = {}): string {
    const imageName = opts.imageName ?? (() => undefined);
    const counter = { image: 0 };
    const perPage = pages.map((p) => itemsOf(p, imageName, counter));
    const body = bodySize(perPage.flat());
    // Heading levels: distinct larger sizes, largest first (at most three), then bold at body size.
    const larger = [
        ...new Set(perPage.flat().filter((i): i is Extract<Item, { kind: "line" }> => i.kind === "line" && i.size >= body * 1.15 && i.text.length <= MAX_HEADING_CHARS).map((i) => i.size)),
    ].sort((a, b) => b - a);
    const levelOf = (it: Extract<Item, { kind: "line" }>) => {
        const i = larger.indexOf(it.size);
        return i >= 0 ? Math.min(i + 1, 3) : Math.min(larger.length + 1, 4);
    };

    const out: string[] = [];
    for (const items of perPage) {
        const steps = lineSteps(items);
        const parts: string[] = [];
        let para: Extract<Item, { kind: "line" }>[] = [];
        let table: string[][] = [];
        const flushPara = () => {
            if (!para.length) return;
            let text = para.map((l) => l.text).reduce(joinLines);
            text = text.replace(BULLET, "- ");
            parts.push(text);
            para = [];
        };
        const flushTable = () => {
            if (!table.length) return;
            if (table.length >= 2) parts.push(toMarkdownTable(table));
            else parts.push(table[0]!.join(" "));
            table = [];
        };
        for (const it of items) {
            if (it.kind === "row") {
                flushPara();
                table.push(it.cells);
                continue;
            }
            flushTable();
            if (it.kind === "image") {
                flushPara();
                parts.push(`![](${imageName(it.index)})`);
                continue;
            }
            if (isHeadingLine(it, body)) {
                flushPara();
                parts.push(`${"#".repeat(levelOf(it))} ${it.text}`);
                continue;
            }
            const prev = para.at(-1);
            if (prev) {
                const step = it.base - prev.base;
                const usual = steps.get(it.size) ?? it.size * 1.2;
                // The column's right edge, as far as this paragraph and the next line show it.
                const right = Math.max(it.right, ...para.map((l) => l.right));
                const continues =
                    Math.abs(prev.size - it.size) <= 0.5 &&
                    step > 0 &&
                    step <= usual * 1.12 + 0.5 &&
                    // the previous line ran to the right edge (a short line ends its paragraph)
                    prev.right >= right - Math.max(2 * it.size, (right - prev.x) * 0.06) &&
                    !LIST_START.test(it.text) &&
                    // a first-line indent starts a new paragraph; a hanging list indent does not
                    it.x <= prev.x + it.size * 0.8;
                if (!continues) flushPara();
            }
            para.push(it);
        }
        flushPara();
        flushTable();
        const page = tidyText(parts.join("\n\n"));
        if (page) out.push(page);
    }
    return out.join("\n\n");
}
