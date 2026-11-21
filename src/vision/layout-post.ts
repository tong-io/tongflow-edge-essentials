/** PP-DocLayout post-processing: threshold, cross-class de-duplication, reading order. */
import { type Box, columnOrder, coverage, iou } from "./geometry.js";

/** Page furniture read before / after the body. */
const HEADER_LABELS = new Set(["header", "header_image"]);
const FOOTER_LABELS = new Set(["footer", "footer_image", "number"]);

/** The 23 PP-DocLayout classes (S and M share them; also in each repo's inference.yml). */
export const DOCLAYOUT_LABELS = [
    "paragraph_title", "image", "text", "number", "abstract", "content", "figure_title", "formula",
    "table", "table_title", "reference", "doc_title", "footnote", "header", "algorithm", "footer",
    "seal", "chart_title", "chart", "formula_number", "header_image", "footer_image", "aside_text",
];

export interface LayoutRegion {
    label: string;
    score: number;
    /** `[x1, y1, x2, y2]` in source pixels. */
    box: [number, number, number, number];
}

/**
 * Rows of `[class, score, x1, y1, x2, y2]` (Paddle's fused multiclass NMS output, already in
 * source pixels) → regions above `threshold`, clipped, with near-duplicates of different
 * classes dropped (a box mostly inside a higher-scored one of similar size), in reading
 * order ({@link columnOrder}: headers, then bands/columns, then footers and page numbers).
 */
export function layoutRegions(
    rows: Float32Array,
    count: number,
    labels: string[],
    srcW: number,
    srcH: number,
    threshold = 0.5,
): LayoutRegion[] {
    const cand: { label: string; score: number; b: Box }[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * 6;
        const cls = Math.round(rows[o]!), score = rows[o + 1]!;
        if (cls < 0 || score < threshold) continue;
        const b = {
            x1: Math.max(0, Math.min(srcW, rows[o + 2]!)),
            y1: Math.max(0, Math.min(srcH, rows[o + 3]!)),
            x2: Math.max(0, Math.min(srcW, rows[o + 4]!)),
            y2: Math.max(0, Math.min(srcH, rows[o + 5]!)),
        };
        if (b.x2 - b.x1 < 2 || b.y2 - b.y1 < 2) continue;
        cand.push({ label: labels[cls] ?? String(cls), score, b });
    }
    cand.sort((a, b) => b.score - a.score);
    const kept: typeof cand = [];
    for (const c of cand) {
        const dup = kept.some((k) => iou(k.b, c.b) > 0.8 || (coverage(c.b, k.b) > 0.9 && coverage(k.b, c.b) > 0.7));
        if (!dup) kept.push(c);
    }
    const order = columnOrder(
        kept.map((k) => k.b),
        kept.map((k) => HEADER_LABELS.has(k.label)),
        kept.map((k) => FOOTER_LABELS.has(k.label)),
    );
    return order.map((i) => {
        const k = kept[i]!;
        return {
            label: k.label,
            score: Math.round(k.score * 1000) / 1000,
            box: [Math.round(k.b.x1), Math.round(k.b.y1), Math.round(k.b.x2), Math.round(k.b.y2)],
        };
    });
}

/* ---------- region filenames: the layout label travels with the crop ---------- */

/** Longest page stem (UTF-8 bytes) kept in a region filename, so the label survives store-key length caps (TongFlow: 120). */
export const REGION_STEM_MAX_BYTES = 80;

/** Cut `s` to at most `max` UTF-8 bytes on a character boundary. */
function utf8Prefix(s: string, max: number): string {
    let bytes = 0, out = "";
    for (const ch of s) {
        const n = new TextEncoder().encode(ch).length;
        if (bytes + n > max) break;
        bytes += n;
        out += ch;
    }
    return out;
}

/**
 * `layout-detect`'s name for region `index` (0-based) of `count`:
 * `<page stem>-r<NN>-<label>.png`. `NN` is the 1-based reading-order index, zero-padded to
 * the width of `count`; `<label>` is the PP-DocLayout class (lowercase, `_`-separated). The
 * stem is cut to {@link REGION_STEM_MAX_BYTES} bytes and has `/ \` replaced, so the
 * `-r<NN>-<label>` tail is never truncated. Example: `page1-r03-table.png`.
 */
export function regionFilename(stem: string, index: number, count: number, label: string): string {
    const pad = String(count).length;
    const safe = utf8Prefix(stem.replace(/[\\/]/g, "_"), REGION_STEM_MAX_BYTES) || "page";
    return `${safe}-r${String(index + 1).padStart(pad, "0")}-${label}.png`;
}

const REGION_TAIL = /-r(\d+)-([a-z][a-z_]*)\.[A-Za-z0-9]+$/;

/**
 * The PP-DocLayout label a {@link regionFilename} carries, or `undefined` when the name does
 * not end in `-r<NN>-<label>.<ext>` with one of {@link DOCLAYOUT_LABELS} (any directory part is
 * ignored).
 */
export function regionLabelOf(filename: string | undefined): string | undefined {
    if (!filename) return undefined;
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const m = REGION_TAIL.exec(base);
    return m && DOCLAYOUT_LABELS.includes(m[2]!) ? m[2] : undefined;
}
