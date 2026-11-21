/**
 * SLANet_plus decoding (PaddleOCR `TableLabelDecode` with `merge_no_span_structure`)
 * and the table matcher that fills each cell with its OCR text (`TableMatch`).
 */
import { type Box, iou, joinPieces } from "./geometry.js";

/** Structure tokens: `sos`, the yml dict with `<td></td>` added and `<td>` removed, `eos`. */
export function tableDictionary(ymlDict: string[]): string[] {
    const d = ymlDict.slice();
    if (!d.includes("<td></td>")) d.push("<td></td>");
    const i = d.indexOf("<td>");
    if (i >= 0) d.splice(i, 1);
    return ["sos", ...d, "eos"];
}

const TD_TOKENS = new Set(["<td>", "<td", "<td></td>"]);

export interface TableStructure {
    tokens: string[];
    /** One box per cell, in token order (source pixels). */
    cells: Box[];
    score: number;
}

/**
 * Decode `structure [L, V]` and `loc [L, 8]` into tokens and cell boxes in source pixels.
 * The polygons are normalized to the padded square input (488×488), so pass the source
 * size of that square, `scaleX = scaleY = max(srcW, srcH)` (verified on rendered tables).
 */
export function decodeTable(
    structure: Float32Array,
    loc: Float32Array,
    L: number,
    V: number,
    locDim: number,
    dict: string[],
    scaleX: number,
    scaleY: number,
): TableStructure {
    const end = dict.indexOf("eos");
    const beg = dict.indexOf("sos");
    const tokens: string[] = [];
    const cells: Box[] = [];
    let sum = 0, n = 0;
    for (let t = 0; t < L; t++) {
        let best = 0, bestP = -Infinity;
        for (let v = 0; v < V; v++) {
            const p = structure[t * V + v]!;
            if (p > bestP) {
                bestP = p;
                best = v;
            }
        }
        if (t > 0 && best === end) break;
        if (best === end || best === beg) continue;
        const tok = dict[best]!;
        if (TD_TOKENS.has(tok)) {
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            for (let k = 0; k < locDim; k += 2) {
                const x = loc[t * locDim + k]! * scaleX, y = loc[t * locDim + k + 1]! * scaleY;
                x1 = Math.min(x1, x);
                x2 = Math.max(x2, x);
                y1 = Math.min(y1, y);
                y2 = Math.max(y2, y);
            }
            cells.push({ x1, y1, x2, y2 });
        }
        tokens.push(tok);
        sum += bestP;
        n++;
    }
    return { tokens, cells, score: n ? sum / n : 0 };
}

function distance(a: Box, b: Box): number {
    const d = Math.abs(b.x1 - a.x1) + Math.abs(b.y1 - a.y1) + Math.abs(b.x2 - a.x2) + Math.abs(b.y2 - a.y2);
    const d2 = Math.abs(b.x1 - a.x1) + Math.abs(b.y1 - a.y1);
    const d3 = Math.abs(b.x2 - a.x2) + Math.abs(b.y2 - a.y2);
    return d + Math.min(d2, d3);
}

/** For each cell index, the OCR boxes it receives (best 1−IoU, then distance). */
export function matchCells(textBoxes: Box[], cells: Box[]): Map<number, number[]> {
    const m = new Map<number, number[]>();
    textBoxes.forEach((tb, i) => {
        let best = -1, bestIou = Infinity, bestDist = Infinity;
        cells.forEach((c, j) => {
            const u = 1 - iou(tb, c), d = distance(tb, c);
            if (u < bestIou - 1e-9 || (Math.abs(u - bestIou) <= 1e-9 && d < bestDist)) {
                best = j;
                bestIou = u;
                bestDist = d;
            }
        });
        if (best >= 0) m.set(best, [...(m.get(best) ?? []), i]);
    });
    return m;
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Assemble `<table>…</table>`, writing each cell's text before its `</td>`. */
export function tableHtml(tokens: string[], matched: Map<number, number[]>, texts: string[]): string {
    const out: string[] = [];
    let td = 0;
    for (const tok of tokens) {
        if (tok.includes("</td>")) {
            if (tok === "<td></td>") out.push("<td>");
            const idx = matched.get(td);
            if (idx) out.push(escapeHtml(joinPieces(idx.map((i) => texts[i]!.trim()))));
            out.push("</td>");
            td++;
        } else out.push(tok);
    }
    return `<table>${out.join("")}</table>`;
}
