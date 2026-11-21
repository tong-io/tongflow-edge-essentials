/** Small computational-geometry kit for detector post-processing (pure, worker-safe). */

export type Pt = [number, number];
/** Four corners, clockwise from top-left: tl, tr, br, bl. */
export type Quad = [Pt, Pt, Pt, Pt];
export interface Box {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise in a y-up frame. */
export function convexHull(points: Pt[]): Pt[] {
    if (points.length <= 2) return points.slice();
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower: Pt[] = [];
    for (const q of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
        lower.push(q);
    }
    const upper: Pt[] = [];
    for (let i = p.length - 1; i >= 0; i--) {
        const q = p[i]!;
        while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
        upper.push(q);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

export interface RotatedRect {
    cx: number;
    cy: number;
    /** Side lengths along the rect's own axes. */
    w: number;
    h: number;
    /** Unit vector of the `w` side. */
    ux: number;
    uy: number;
}

/** Minimum-area enclosing rectangle (rotating calipers over the hull edges). */
export function minAreaRect(points: Pt[]): RotatedRect {
    const hull = convexHull(points);
    if (hull.length === 0) return { cx: 0, cy: 0, w: 0, h: 0, ux: 1, uy: 0 };
    if (hull.length === 1) return { cx: hull[0]![0], cy: hull[0]![1], w: 0, h: 0, ux: 1, uy: 0 };
    let best: RotatedRect | undefined;
    let bestArea = Infinity;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i]!, b = hull[(i + 1) % hull.length]!;
        let ux = b[0] - a[0], uy = b[1] - a[1];
        const len = Math.hypot(ux, uy);
        if (len === 0) continue;
        ux /= len;
        uy /= len;
        const vx = -uy, vy = ux;
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const q of hull) {
            const u = q[0] * ux + q[1] * uy;
            const v = q[0] * vx + q[1] * vy;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        const w = maxU - minU, h = maxV - minV;
        const area = w * h;
        if (area < bestArea - 1e-9) {
            bestArea = area;
            const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
            best = { cx: cu * ux + cv * vx, cy: cu * uy + cv * vy, w, h, ux, uy };
        }
    }
    return best ?? { cx: hull[0]![0], cy: hull[0]![1], w: 0, h: 0, ux: 1, uy: 0 };
}

/** Corners of a rotated rect, ordered tl, tr, br, bl (image coordinates, y down). */
export function rectCorners(r: RotatedRect): Quad {
    const hw = r.w / 2, hh = r.h / 2;
    const vx = -r.uy, vy = r.ux;
    const pts: Pt[] = [
        [r.cx - r.ux * hw - vx * hh, r.cy - r.uy * hw - vy * hh],
        [r.cx + r.ux * hw - vx * hh, r.cy + r.uy * hw - vy * hh],
        [r.cx + r.ux * hw + vx * hh, r.cy + r.uy * hw + vy * hh],
        [r.cx - r.ux * hw + vx * hh, r.cy - r.uy * hw + vy * hh],
    ];
    return orderQuad(pts);
}

/**
 * PaddleOCR's `get_mini_boxes` ordering: sort by x; of the two leftmost the upper is tl,
 * the lower bl; of the two rightmost the upper is tr, the lower br.
 */
export function orderQuad(pts: Pt[]): Quad {
    const s = pts.slice().sort((a, b) => a[0] - b[0]);
    const [l0, l1, r0, r1] = s as [Pt, Pt, Pt, Pt];
    const [tl, bl] = l0[1] <= l1[1] ? [l0, l1] : [l1, l0];
    const [tr, br] = r0[1] <= r1[1] ? [r0, r1] : [r1, r0];
    return [tl, tr, br, bl];
}

export function polygonArea(p: Pt[]): number {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
        const [x1, y1] = p[i]!, [x2, y2] = p[(i + 1) % p.length]!;
        a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
}

export function polygonPerimeter(p: Pt[]): number {
    let s = 0;
    for (let i = 0; i < p.length; i++) {
        const a = p[i]!, b = p[(i + 1) % p.length]!;
        s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return s;
}

/** Point in a convex polygon (any winding). */
export function inConvex(p: Pt[], x: number, y: number): boolean {
    let sign = 0;
    for (let i = 0; i < p.length; i++) {
        const c = cross(p[i]!, p[(i + 1) % p.length]!, [x, y]);
        if (c === 0) continue;
        const s = c > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
    }
    return true;
}

export function quadBox(q: Pt[]): Box {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y] of q) {
        if (x < x1) x1 = x;
        if (y < y1) y1 = y;
        if (x > x2) x2 = x;
        if (y > y2) y2 = y;
    }
    return { x1, y1, x2, y2 };
}

export function iou(a: Box, b: Box): number {
    const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const inter = ix * iy;
    const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return ua > 0 ? inter / ua : 0;
}

/** Fraction of `a` covered by `b`. */
export function coverage(a: Box, b: Box): number {
    const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const area = (a.x2 - a.x1) * (a.y2 - a.y1);
    return area > 0 ? (ix * iy) / area : 0;
}

/** Merge overlapping 1-D intervals; returns groups of item indices, in order. */
function projectGroups(items: number[], lo: (i: number) => number, hi: (i: number) => number): { groups: number[][]; maxGap: number } {
    const sorted = items.slice().sort((a, b) => lo(a) - lo(b));
    const groups: number[][] = [];
    let cur: number[] = [];
    let end = -Infinity;
    let maxGap = 0;
    for (const i of sorted) {
        if (cur.length && lo(i) > end) {
            maxGap = Math.max(maxGap, lo(i) - end);
            groups.push(cur);
            cur = [];
        }
        cur.push(i);
        end = Math.max(end, hi(i));
    }
    if (cur.length) groups.push(cur);
    return { groups, maxGap };
}

/**
 * Reading order of page regions by recursive XY-cut: at each level cut along the
 * projection with the widest whitespace gap (rows top→bottom, columns left→right), so a
 * full-width title comes first and a two-column body is read column by column. Leaves
 * that cannot be cut are read top→bottom, left→right.
 */
export function xyCutOrder(boxes: Box[]): number[] {
    const out: number[] = [];
    const rec = (items: number[]) => {
        if (items.length <= 1) {
            out.push(...items);
            return;
        }
        const ys = projectGroups(items, (i) => boxes[i]!.y1, (i) => boxes[i]!.y2);
        const xs = projectGroups(items, (i) => boxes[i]!.x1, (i) => boxes[i]!.x2);
        const canY = ys.groups.length > 1, canX = xs.groups.length > 1;
        if (canY && (!canX || ys.maxGap >= xs.maxGap)) ys.groups.forEach(rec);
        else if (canX) xs.groups.forEach(rec);
        else {
            // Overlapping boxes: plain top-left order.
            out.push(...items.slice().sort((a, b) => boxes[a]!.y1 - boxes[b]!.y1 || boxes[a]!.x1 - boxes[b]!.x1));
        }
    };
    rec(boxes.map((_, i) => i));
    return out;
}

/**
 * Reading order of layout regions on a page that may have columns. Boxes wider than
 * `wide` of the content width (titles, abstracts, full-width figures) split the page into
 * horizontal bands; inside a band, columns are read left→right and each column
 * top→bottom (columns before rows, so a paragraph gap that happens to line up across
 * both columns does not interleave them). `last` marks page furniture (page numbers,
 * footers) that is read after everything else; `first` (running headers) before.
 */
export function columnOrder(boxes: Box[], first: boolean[] = [], last: boolean[] = [], wide = 0.55): number[] {
    const all = boxes.map((_, i) => i);
    const head = all.filter((i) => first[i]).sort((a, b) => boxes[a]!.y1 - boxes[b]!.y1 || boxes[a]!.x1 - boxes[b]!.x1);
    const tail = all.filter((i) => last[i] && !first[i]).sort((a, b) => boxes[a]!.y1 - boxes[b]!.y1 || boxes[a]!.x1 - boxes[b]!.x1);
    const main = all.filter((i) => !first[i] && !last[i]);
    if (!main.length) return [...head, ...tail];
    const minX = Math.min(...main.map((i) => boxes[i]!.x1)), maxX = Math.max(...main.map((i) => boxes[i]!.x2));
    const W = Math.max(1, maxX - minX);
    const isWide = (i: number) => boxes[i]!.x2 - boxes[i]!.x1 > wide * W;
    const out: number[] = [...head];
    const rec = (items: number[], columnsFirst: boolean) => {
        if (items.length <= 1) {
            out.push(...items);
            return;
        }
        const xs = projectGroups(items, (i) => boxes[i]!.x1, (i) => boxes[i]!.x2);
        const ys = projectGroups(items, (i) => boxes[i]!.y1, (i) => boxes[i]!.y2);
        if (columnsFirst && xs.groups.length > 1) xs.groups.forEach((g) => rec(g, false));
        else if (ys.groups.length > 1) ys.groups.forEach((g) => rec(g, true));
        else if (xs.groups.length > 1) xs.groups.forEach((g) => rec(g, false));
        else out.push(...items.slice().sort((a, b) => boxes[a]!.y1 - boxes[b]!.y1 || boxes[a]!.x1 - boxes[b]!.x1));
    };
    // Bands between wide boxes (in vertical order).
    const sorted = main.slice().sort((a, b) => boxes[a]!.y1 - boxes[b]!.y1);
    let band: number[] = [];
    for (const i of sorted) {
        if (isWide(i)) {
            rec(band, true);
            band = [];
            out.push(i);
        } else band.push(i);
    }
    rec(band, true);
    out.push(...tail);
    return out;
}

/**
 * Group text boxes into lines (row-major, as PaddleOCR prints them): a box joins a line
 * when its vertical extent overlaps the line by at least half of the smaller height.
 * Returns lines top→bottom, each a list of indices left→right.
 */
export function groupLines(boxes: Box[]): number[][] {
    const order = boxes.map((_, i) => i).sort((a, b) => (boxes[a]!.y1 + boxes[a]!.y2) - (boxes[b]!.y1 + boxes[b]!.y2));
    const lines: { y1: number; y2: number; items: number[] }[] = [];
    for (const i of order) {
        const b = boxes[i]!;
        const h = b.y2 - b.y1;
        let best: (typeof lines)[number] | undefined;
        let bestOv = 0;
        for (const ln of lines) {
            const ov = Math.min(ln.y2, b.y2) - Math.max(ln.y1, b.y1);
            const minH = Math.min(h, ln.y2 - ln.y1);
            if (minH > 0 && ov >= 0.5 * minH && ov > bestOv) {
                bestOv = ov;
                best = ln;
            }
        }
        if (best) {
            best.items.push(i);
            // Keep the band of the line's first box so a tall neighbour does not swallow the next row.
        } else lines.push({ y1: b.y1, y2: b.y2, items: [i] });
    }
    lines.sort((a, b) => a.y1 + a.y2 - (b.y1 + b.y2));
    return lines.map((ln) => ln.items.sort((a, b) => boxes[a]!.x1 - boxes[b]!.x1));
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** Join two text pieces of one line: no space between CJK characters, a space otherwise. */
export function joinPieces(parts: string[]): string {
    let s = "";
    for (const p of parts) {
        if (!p) continue;
        if (!s) s = p;
        else s += CJK.test(s[s.length - 1]!) || CJK.test(p[0]!) ? p : ` ${p}`;
    }
    return s;
}
