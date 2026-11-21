/**
 * PP-OCR pre/post-processing in plain TypeScript (no OpenCV): det resize, DB
 * post-processing, CTC decoding and the character dictionary from `inference.yml`.
 * Mirrors PaddleOCR / PaddleX (`DetResizeForTest`, `DBPostProcess`, `CTCLabelDecode`).
 */
import { type Pt, type Quad, inConvex, minAreaRect, quadBox, rectCorners } from "./geometry.js";

export interface DetResize {
    width: number;
    height: number;
}

/**
 * PaddleX 3 text detection resize (`limit_type: min`, `limit_side_len: 64`,
 * `max_side_limit`): scale up so the short side is at least 64, scale down so the
 * long side is at most `maxSide`, then round each side to a multiple of 32.
 */
export function detResize(w: number, h: number, maxSide = 2048, minSide = 64): DetResize {
    let ratio = 1;
    if (Math.min(w, h) < minSide) ratio = minSide / Math.min(w, h);
    if (Math.max(w, h) * ratio > maxSide) ratio = maxSide / Math.max(w, h);
    const r32 = (v: number) => Math.max(32, Math.round((v * ratio) / 32) * 32);
    return { width: r32(w), height: r32(h) };
}

export interface DbOptions {
    thresh: number;
    boxThresh: number;
    unclipRatio: number;
    maxCandidates: number;
    minSize: number;
}

/** Values from the PP-OCRv6 det `inference.yml`. */
export const DB_DEFAULTS: DbOptions = { thresh: 0.2, boxThresh: 0.45, unclipRatio: 1.4, maxCandidates: 3000, minSize: 3 };

export interface TextBox {
    quad: Quad;
    score: number;
}

/** Mean probability inside the quad (PaddleOCR `box_score_fast`). */
function boxScore(pred: Float32Array, w: number, h: number, q: Quad): number {
    const b = quadBox(q);
    const x0 = Math.max(0, Math.floor(b.x1)), x1 = Math.min(w - 1, Math.ceil(b.x2));
    const y0 = Math.max(0, Math.floor(b.y1)), y1 = Math.min(h - 1, Math.ceil(b.y2));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (inConvex(q, x, y)) {
                sum += pred[y * w + x]!;
                n++;
            }
        }
    }
    return n ? sum / n : 0;
}

/**
 * DB post-processing: threshold the probability map, take each 8-connected region,
 * fit its minimum-area rectangle, score it, expand it by `area·ratio/perimeter` (the
 * Vatti offset of a rectangle) and map it back to source pixels.
 */
export function dbPostprocess(
    pred: Float32Array,
    w: number,
    h: number,
    srcW: number,
    srcH: number,
    opts: DbOptions = DB_DEFAULTS,
): TextBox[] {
    const n = w * h;
    const label = new Int32Array(n); // 0 = unvisited/background, >0 component id
    const on = (i: number) => pred[i]! > opts.thresh;
    const out: TextBox[] = [];
    const stack: number[] = [];
    let comp = 0;
    for (let start = 0; start < n; start++) {
        if (label[start] !== 0 || !on(start)) continue;
        comp++;
        if (comp > opts.maxCandidates) break;
        const border: Pt[] = [];
        label[start] = comp;
        stack.push(start);
        while (stack.length) {
            const i = stack.pop()!;
            const x = i % w, y = (i - x) / w;
            let edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    const j = yy * w + xx;
                    if (on(j)) {
                        if (label[j] === 0) {
                            label[j] = comp;
                            stack.push(j);
                        }
                    } else if (!dx || !dy) edge = true;
                }
            }
            if (edge) border.push([x, y]);
        }
        if (border.length < 3) continue;
        const r = minAreaRect(border);
        if (Math.min(r.w, r.h) < opts.minSize) continue;
        const quad = rectCorners(r);
        const score = boxScore(pred, w, h, quad);
        if (score < opts.boxThresh) continue;
        const d = (r.w * r.h * opts.unclipRatio) / (2 * (r.w + r.h));
        const big = { ...r, w: r.w + 2 * d, h: r.h + 2 * d };
        if (Math.min(big.w, big.h) < opts.minSize + 2) continue;
        const sx = srcW / w, sy = srcH / h;
        const q = rectCorners(big).map(([x, y]) => [
            Math.min(srcW, Math.max(0, Math.round(x * sx))),
            Math.min(srcH, Math.max(0, Math.round(y * sy))),
        ]) as Quad;
        const qb = quadBox(q);
        if (qb.x2 - qb.x1 <= 3 || qb.y2 - qb.y1 <= 3) continue;
        out.push({ quad: q, score });
    }
    return out;
}

/** Crop size of a text quad (PaddleOCR `get_rotate_crop_image`). */
export function cropSize(q: Quad): { w: number; h: number } {
    const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    return {
        w: Math.max(1, Math.round(Math.max(d(q[0], q[1]), d(q[3], q[2])))),
        h: Math.max(1, Math.round(Math.max(d(q[0], q[3]), d(q[1], q[2])))),
    };
}

/**
 * Greedy CTC decode of `[T, C]` probabilities: argmax per step, collapse repeats,
 * drop blank (index 0). `dict[k]` is the character of class `k` (dict[0] = blank).
 */
export function ctcDecode(probs: Float32Array, offset: number, T: number, C: number, dict: string[]): { text: string; score: number } {
    let text = "";
    let sum = 0, cnt = 0;
    let prev = -1;
    for (let t = 0; t < T; t++) {
        const base = offset + t * C;
        let best = 0, bestP = -Infinity;
        for (let c = 0; c < C; c++) {
            const p = probs[base + c]!;
            if (p > bestP) {
                bestP = p;
                best = c;
            }
        }
        if (best !== 0 && best !== prev) {
            text += dict[best] ?? "";
            sum += bestP;
            cnt++;
        }
        prev = best;
    }
    return { text, score: cnt ? sum / cnt : 0 };
}

function unquote(raw: string): string {
    const s = raw.trim();
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try {
            return JSON.parse(s.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")) as string;
        } catch {
            return s.slice(1, -1);
        }
    }
    return s;
}

/**
 * Read the block list under `key:` from a PaddleX `inference.yml` (e.g. the
 * `character_dict` of a recognizer, the `label_list` of a detector). Only this one
 * shape of YAML is needed, so no YAML library is bundled.
 */
export function yamlList(yml: string, key: string): string[] {
    const lines = yml.split(/\r?\n/);
    const keyRe = new RegExp(`^(\\s*)${key}:\\s*$`);
    let i = lines.findIndex((l) => keyRe.test(l));
    if (i < 0) return [];
    const indent = keyRe.exec(lines[i]!)![1]!.length;
    const out: string[] = [];
    for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        const m = /^(\s*)- ?(.*)$/.exec(l);
        if (!m || m[1]!.length < indent) break;
        out.push(unquote(m[2]!));
    }
    return out;
}

/** The CTC class table: blank, the dictionary, then the space PaddleOCR appends. */
export function ctcDictionary(characters: string[]): string[] {
    return ["", ...characters, " "];
}
