/**
 * Worker-safe image plumbing: decode with createImageBitmap, draw and read pixels on
 * OffscreenCanvas, encode PNG with convertToBlob. No DOM, no OpenCV.
 */
import { EdgeError } from "../util/errors.js";

export type Source = ImageBitmap | OffscreenCanvas;

export function needCanvas(slot: string): void {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
        throw new EdgeError(`${slot} needs OffscreenCanvas and createImageBitmap (a browser worker)`);
    }
}

/** Decode image bytes (PNG/JPEG/WebP/GIF/BMP/AVIF…); EXIF orientation is applied. */
export async function decodeImage(bytes: Uint8Array, mime?: string): Promise<ImageBitmap> {
    const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : {});
    try {
        return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (e) {
        throw new EdgeError(`could not decode the image (${mime ?? "unknown type"}): ${e instanceof Error ? e.message : String(e)}`);
    }
}

export function context2d(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) throw new EdgeError("could not get a 2D context for OffscreenCanvas");
    return g;
}

/** Draw `src` (or its `sx,sy,sw,sh` part) scaled to `w×h` on a white background and read RGBA. */
export function drawToRgba(
    src: Source,
    w: number,
    h: number,
    part?: { sx: number; sy: number; sw: number; sh: number },
    fill = "#ffffff",
): Uint8ClampedArray {
    const c = new OffscreenCanvas(w, h);
    const g = context2d(c);
    g.fillStyle = fill;
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    if (part) g.drawImage(src, part.sx, part.sy, part.sw, part.sh, 0, 0, w, h);
    else g.drawImage(src, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
}

/**
 * Draw the quadrilateral `tl,tr,bl` (a parallelogram; the 4th corner follows) of `src`
 * onto an axis-aligned `w×h` canvas: the affine crop PaddleOCR does with a perspective warp
 * on its (rectangular) text boxes.
 */
export function warpCrop(
    src: Source,
    tl: [number, number],
    tr: [number, number],
    bl: [number, number],
    w: number,
    h: number,
): OffscreenCanvas {
    const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const g = context2d(c);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    // dst = M·src with M mapping tl→(0,0), tr→(w,0), bl→(0,h). Build M⁻¹ (dst→src) first:
    // src = tl + u·(tr−tl)/w + v·(bl−tl)/h
    const ax = (tr[0] - tl[0]) / w, ay = (tr[1] - tl[1]) / w;
    const bx = (bl[0] - tl[0]) / h, by = (bl[1] - tl[1]) / h;
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-9) return c;
    // inverse of [[ax bx],[ay by]]
    const ia = by / det, ib = -bx / det, ic = -ay / det, id = ax / det;
    const e = -(ia * tl[0] + ib * tl[1]);
    const f = -(ic * tl[0] + id * tl[1]);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.setTransform(ia, ic, ib, id, e, f);
    g.drawImage(src, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return c;
}

/** Rotate `src` clockwise by 0/90/180/270 degrees. */
export function rotate(src: Source, degreesCw: 0 | 90 | 180 | 270): OffscreenCanvas {
    const w = src.width, h = src.height;
    const swap = degreesCw === 90 || degreesCw === 270;
    const c = new OffscreenCanvas(swap ? h : w, swap ? w : h);
    const g = context2d(c);
    g.translate(c.width / 2, c.height / 2);
    g.rotate((degreesCw * Math.PI) / 180);
    g.drawImage(src, -w / 2, -h / 2);
    return c;
}

/** Crop an axis-aligned box (clamped to the image) to a new canvas. */
export function crop(src: Source, x1: number, y1: number, x2: number, y2: number): OffscreenCanvas {
    const sx = Math.max(0, Math.floor(x1)), sy = Math.max(0, Math.floor(y1));
    const ex = Math.min(src.width, Math.ceil(x2)), ey = Math.min(src.height, Math.ceil(y2));
    const w = Math.max(1, ex - sx), h = Math.max(1, ey - sy);
    const c = new OffscreenCanvas(w, h);
    const g = context2d(c);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.drawImage(src, sx, sy, w, h, 0, 0, w, h);
    return c;
}

export async function toPng(c: OffscreenCanvas): Promise<Uint8Array> {
    const blob = await c.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
}

export function toCanvas(src: Source): OffscreenCanvas {
    if (src instanceof OffscreenCanvas) return src;
    const c = new OffscreenCanvas(src.width, src.height);
    context2d(c).drawImage(src, 0, 0);
    return c;
}

export interface Normalize {
    mean: [number, number, number];
    std: [number, number, number];
    /** Feed channels as B,G,R (PaddleOCR models read images with cv2). */
    bgr?: boolean;
}

/**
 * RGBA (w×h) → planar float32 `[3, h, w]`, `(x/255 − mean) / std` per channel, written at
 * `offset` of `out` inside a `[3, outH, outW]` plane layout (for right/bottom padding).
 */
export function rgbaToChw(
    rgba: Uint8ClampedArray | Uint8Array,
    w: number,
    h: number,
    norm: Normalize,
    out?: Float32Array,
    outW = w,
    outH = h,
): Float32Array {
    const plane = outW * outH;
    const dst = out ?? new Float32Array(3 * plane);
    const order = norm.bgr ? [2, 1, 0] : [0, 1, 2];
    for (let c = 0; c < 3; c++) {
        const src = order[c]!;
        const m = norm.mean[c]!, s = norm.std[c]!;
        const base = c * plane;
        for (let y = 0; y < h; y++) {
            const row = y * w * 4;
            const drow = base + y * outW;
            for (let x = 0; x < w; x++) dst[drow + x] = (rgba[row + x * 4 + src]! / 255 - m) / s;
        }
    }
    return dst;
}

export const IMAGENET: Normalize = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
