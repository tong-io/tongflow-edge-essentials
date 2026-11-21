/**
 * `detect-objects`: D-FINE nano (COCO, int8) through transformers.js's object-detection
 * pipeline, loaded with the plugin's shared transformers.js setup (`ml/transformers.ts`:
 * model files from `<modelBase>onnx-community/dfine_n_coco-ONNX/…`, ort wasm from the
 * plugin's own assets, Cache API, download progress).
 */
import type { EdgeContext } from "../context.js";
import type { EdgeSlotOutput, SlotInput } from "../types.js";
import { readAsset } from "../slots/common.js";
import { decodeImage, drawToRgba, needCanvas } from "../ml/canvas.js";
import { memo, modelEntry, repoOf } from "../ml/model-files.js";
import { mlRuntimeOf, pickDevice } from "../ml/ort.js";
import { downloadReporter, loadTransformers } from "../ml/transformers.js";
import { EdgeError } from "../util/errors.js";
import { type Box, iou } from "./geometry.js";

/** Manifest model ids, default first: the int8 export, or fp16 (2× faster on WASM in our runs, 7.9 MB). */
export const DETECT_MODELS = ["dfine-nano", "dfine-nano-fp16"] as const;
type DetectModel = (typeof DETECT_MODELS)[number];
const DTYPE: Record<DetectModel, string> = { "dfine-nano": "int8", "dfine-nano-fp16": "fp16" };
/** D-FINE nano's sigmoid scores are modest (a clear cat scores ~0.6), so the cut is lower than DETR's usual 0.5. */
export const DETECT_THRESHOLD = 0.35;

export function detectModel(model: string | undefined): DetectModel {
    const m = (model ?? "").trim().toLowerCase();
    if (!m) return DETECT_MODELS[0];
    const hit = DETECT_MODELS.find((id) => id === m);
    if (!hit) throw new EdgeError(`unknown detection model "${model}" (use ${DETECT_MODELS.join(" or ")})`);
    return hit;
}

interface Found {
    score: number;
    label: string;
    box: { xmin: number; ymin: number; xmax: number; ymax: number };
}
type Detector = (image: unknown, opts: { threshold: number; percentage: boolean }) => Promise<Found[]>;

const pipelines = memo<Detector>();

/** Object detector, one per (model base, device). */
async function detector(ctx: EdgeContext, id: DetectModel): Promise<Detector> {
    const rt = mlRuntimeOf(ctx);
    const tf = await loadTransformers(rt);
    const device = await pickDevice(ctx);
    const repo = repoOf(modelEntry(id));
    return pipelines(`${ctx.modelBase}|${id}|${device}`, async () => {
        const make = tf.pipeline as unknown as (task: string, model: string, options: object) => Promise<Detector>;
        const opts = (dev: string) => ({ dtype: DTYPE[id], device: dev, progress_callback: downloadReporter(rt, id, repo) });
        if (device === "webgpu") {
            try {
                return await make("object-detection", repo, opts("webgpu"));
            } catch {
                // fall back to WASM below
            }
        }
        return make("object-detection", repo, opts("wasm"));
    });
}

export interface DetectedObject {
    label: string;
    score: number;
    box: [number, number, number, number];
}

/**
 * D-FINE is NMS-free, but the int8 export sometimes repeats one object with near-identical
 * boxes; keep the best of a same-label group overlapping by IoU ≥ 0.7.
 */
export function dedupeObjects(objs: DetectedObject[], iouThreshold = 0.7): DetectedObject[] {
    const b = (o: DetectedObject): Box => ({ x1: o.box[0], y1: o.box[1], x2: o.box[2], y2: o.box[3] });
    const kept: DetectedObject[] = [];
    for (const o of [...objs].sort((p, q) => q.score - p.score)) {
        if (!kept.some((k) => k.label === o.label && iou(b(k), b(o)) >= iouThreshold)) kept.push(o);
    }
    return kept;
}

export async function detectObjects(input: SlotInput<"detect-objects">, ctx: EdgeContext): Promise<EdgeSlotOutput<"detect-objects">> {
    needCanvas("detect-objects");
    const bytes = readAsset(input.image, "image");
    const bmp = await decodeImage(bytes, input.image.mime);
    try {
        const id = detectModel(ctx.model);
        ctx.onProgress({ fraction: 0, message: "loading D-FINE" });
        const det = await detector(ctx, id);
        const tf = await loadTransformers(mlRuntimeOf(ctx));
        const img = new tf.RawImage(drawToRgba(bmp, bmp.width, bmp.height), bmp.width, bmp.height, 4);
        ctx.onProgress({ fraction: 0.5, message: "detecting objects" });
        const t = Number(ctx.params?.threshold);
        const found = await det(img, { threshold: Number.isFinite(t) && t > 0 ? t : DETECT_THRESHOLD, percentage: false });
        const objects = dedupeObjects(
            found.map((o) => ({
                label: o.label,
                score: Math.round(o.score * 1000) / 1000,
                box: [
                    Math.max(0, Math.round(o.box.xmin)),
                    Math.max(0, Math.round(o.box.ymin)),
                    Math.min(bmp.width, Math.round(o.box.xmax)),
                    Math.min(bmp.height, Math.round(o.box.ymax)),
                ] as [number, number, number, number],
            })),
        );
        ctx.onProgress({ fraction: 1, message: `${objects.length} objects` });
        return { success: true, objects: JSON.stringify(objects) };
    } finally {
        bmp.close();
    }
}
