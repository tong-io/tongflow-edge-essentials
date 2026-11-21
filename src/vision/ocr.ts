/**
 * PP-OCRv6 text detection + text-line orientation + recognition on onnxruntime-web,
 * with all pre/post-processing in TS (no OpenCV.js, no DOM): runs in a module worker.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { IMAGENET, type Source, drawToRgba, rgbaToChw, rotate, warpCrop } from "../ml/canvas.js";
import { fetchModelFile, fetchModelText, memo } from "../ml/model-files.js";
import { type LoadedSession, createDeviceSession, pickDevice, run, tensor } from "../ml/ort.js";
import { type Box, type Quad, groupLines, joinPieces, quadBox } from "./geometry.js";
import { DB_DEFAULTS, cropSize, ctcDecode, ctcDictionary, dbPostprocess, detResize, yamlList } from "./ocr-post.js";

/** Manifest model ids of `ocr-image`, default first. */
export const OCR_MODELS = ["pp-ocrv6-small", "pp-ocrv6-tiny"] as const;
export type OcrModel = (typeof OCR_MODELS)[number];

const PARTS: Record<OcrModel, { det: string; rec: string }> = {
    "pp-ocrv6-small": { det: "pp-ocrv6-small-det", rec: "pp-ocrv6-small-rec" },
    "pp-ocrv6-tiny": { det: "pp-ocrv6-tiny-det", rec: "pp-ocrv6-tiny-rec" },
};
const TEXTLINE_ORI = "pp-lcnet-textline-ori";

/** Pick the OCR variant from the node's model (`ctx.model`); unknown or empty → default. */
export function ocrModel(model: string | undefined): OcrModel {
    if (!model) return OCR_MODELS[0];
    const m = model.trim().toLowerCase();
    const hit = OCR_MODELS.find((id) => id === m || m.endsWith(id.replace("pp-ocrv6-", "")));
    if (!hit) throw new EdgeError(`unknown OCR model "${model}" (use ${OCR_MODELS.join(" or ")})`);
    return hit;
}

const sessions = memo<LoadedSession>();
const dicts = memo<string[]>();

function session(ctx: EdgeContext, id: string): Promise<LoadedSession> {
    return pickDevice(ctx).then((device) =>
        sessions(`${id}@${device}`, async () => createDeviceSession(ctx, await fetchModelFile(ctx, id, "inference.onnx"), device)),
    );
}

function dictionary(ctx: EdgeContext, recId: string): Promise<string[]> {
    return dicts(recId, async () => {
        const chars = yamlList(await fetchModelText(ctx, recId, "inference.yml"), "character_dict");
        if (!chars.length) throw new EdgeError(`no character_dict in ${recId} inference.yml`);
        return ctcDictionary(chars);
    });
}

export interface OcrBox {
    quad: Quad;
    box: Box;
    text: string;
    score: number;
}

export interface OcrOptions {
    /** Longest side fed to the detector (PaddleX caps at 4000; smaller is faster). */
    detMaxSide?: number;
    /** Recognition results below this confidence are dropped (PaddleOCR's `drop_score`). */
    dropScore?: number;
    /**
     * Run the text-line orientation classifier (fixes upside-down lines). Off by default:
     * on short crops (table cells such as "+3%") it flips upright text, and whole-page
     * rotation is `image-orient`'s job. `_params.textline_orientation: true` turns it on.
     */
    textlineOrientation?: boolean;
    /** Progress span inside the node (fractions), default 0..1. */
    progress?: [number, number];
}

const REC_H = 48;
const REC_MIN_W = 320;
const REC_MAX_W = 3200;
const REC_BATCH = 8;
const REC_NORM = { mean: [0.5, 0.5, 0.5] as [number, number, number], std: [0.5, 0.5, 0.5] as [number, number, number], bgr: true };

/** Every text box with its recognized text, in detection order (not yet reading order). */
export async function recognizeText(ctx: EdgeContext, src: Source, model: OcrModel, opts: OcrOptions = {}): Promise<OcrBox[]> {
    const parts = PARTS[model];
    const [p0, p1] = opts.progress ?? [0, 1];
    const at = (f: number, message: string) => ctx.onProgress({ fraction: p0 + (p1 - p0) * f, message });
    at(0, "loading OCR models");
    const useCls = opts.textlineOrientation === true;
    const [det, rec, dict, cls] = await Promise.all([
        session(ctx, parts.det),
        session(ctx, parts.rec),
        dictionary(ctx, parts.rec),
        useCls ? session(ctx, TEXTLINE_ORI) : Promise.resolve(undefined),
    ]);
    throwIfAborted(ctx.signal);

    // 1. detection
    at(0.1, "detecting text");
    const W = src.width, H = src.height;
    const size = detResize(W, H, opts.detMaxSide ?? 2048);
    const rgba = drawToRgba(src, size.width, size.height);
    const x = rgbaToChw(rgba, size.width, size.height, { ...IMAGENET, bgr: true });
    const detOut = await run(det, { x: await tensor(ctx, x, [1, 3, size.height, size.width]) });
    const prob = Object.values(detOut)[0]!;
    const [, , ph, pw] = prob.dims as number[];
    const boxes = dbPostprocess(prob.data as Float32Array, pw ?? size.width, ph ?? size.height, W, H, DB_DEFAULTS);
    throwIfAborted(ctx.signal);
    if (!boxes.length) return [];

    // 2. crops (vertical boxes are turned to horizontal, as PaddleOCR does)
    at(0.3, `recognizing ${boxes.length} text boxes`);
    let crops = boxes.map((b) => {
        const { w, h } = cropSize(b.quad);
        const c = warpCrop(src, b.quad[0], b.quad[1], b.quad[3], w, h);
        return h / w >= 1.5 ? rotate(c, 270) : c;
    });

    // 3. text-line orientation (0° / 180°)
    if (cls) {
        for (let i = 0; i < crops.length; i += REC_BATCH) {
            const batch = crops.slice(i, i + REC_BATCH);
            const plane = 3 * 80 * 160;
            const data = new Float32Array(batch.length * plane);
            batch.forEach((c, k) => rgbaToChw(drawToRgba(c, 160, 80), 160, 80, IMAGENET, data.subarray(k * plane, (k + 1) * plane)));
            const out = Object.values(await run(cls, { x: await tensor(ctx, data, [batch.length, 3, 80, 160]) }))[0]!;
            const p = out.data as Float32Array;
            batch.forEach((c, k) => {
                if (p[k * 2 + 1]! > p[k * 2]!) crops[i + k] = rotate(c, 180);
            });
        }
    }

    // 4. recognition, batched by aspect ratio
    const ratios = crops.map((c) => c.width / Math.max(1, c.height));
    const order = ratios.map((_, i) => i).sort((a, b) => ratios[a]! - ratios[b]!);
    const results: { text: string; score: number }[] = new Array(crops.length);
    for (let s = 0; s < order.length; s += REC_BATCH) {
        throwIfAborted(ctx.signal);
        const idx = order.slice(s, s + REC_BATCH);
        const maxRatio = Math.max(REC_MIN_W / REC_H, ...idx.map((i) => ratios[i]!));
        const imgW = Math.min(REC_MAX_W, Math.ceil(REC_H * maxRatio));
        const plane = 3 * REC_H * imgW;
        const data = new Float32Array(idx.length * plane); // zeros = the normalized padding
        idx.forEach((i, k) => {
            const rw = Math.max(1, Math.min(imgW, Math.ceil(REC_H * ratios[i]!)));
            const px = drawToRgba(crops[i]!, rw, REC_H);
            rgbaToChw(px, rw, REC_H, REC_NORM, data.subarray(k * plane, (k + 1) * plane), imgW, REC_H);
        });
        const out = Object.values(await run(rec, { x: await tensor(ctx, data, [idx.length, 3, REC_H, imgW]) }))[0]!;
        const [, T, C] = out.dims as number[];
        const probs = out.data as Float32Array;
        idx.forEach((i, k) => {
            results[i] = ctcDecode(probs, k * T! * C!, T!, C!, dict);
        });
        at(0.3 + 0.7 * Math.min(1, (s + idx.length) / order.length), `recognized ${Math.min(order.length, s + idx.length)}/${order.length}`);
    }
    for (const c of crops) c.width = c.height = 0;
    crops = [];

    const drop = opts.dropScore ?? 0.5;
    const out: OcrBox[] = [];
    boxes.forEach((b, i) => {
        const r = results[i]!;
        if (r.score < drop || !r.text.trim()) return;
        out.push({ quad: b.quad, box: quadBox(b.quad), text: r.text, score: r.score });
    });
    return out;
}

/** Reading-ordered plain text: lines top→bottom, pieces of a line left→right. */
export function ocrText(items: OcrBox[]): string {
    const lines = groupLines(items.map((i) => i.box));
    return lines.map((ln) => joinPieces(ln.map((k) => items[k]!.text.trim()))).join("\n");
}

/** Boxes in the same reading order as {@link ocrText}. */
export function readingOrder(items: OcrBox[]): OcrBox[] {
    return groupLines(items.map((i) => i.box)).flat().map((k) => items[k]!);
}
