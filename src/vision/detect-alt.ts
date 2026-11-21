/**
 * The alternative `detect-objects` implementations, on onnxruntime-web directly (the files come
 * through the model hub: model base, size + SHA-256 checked, Cache API, progress):
 *
 * - `yolo26n`: Ultralytics YOLO26n (COCO 80), the NMS-free end-to-end export by onnx-community,
 *   `onnx/model_fp16.onnx` (5 MB), 640×640 input scaled 0..1.
 * - `rf-detr-nano`: Roboflow RF-DETR nano (COCO), onnx-community's export,
 *   `onnx/model_fp16.onnx` (54 MB; about twice as fast as the int8 export on WASM, same
 *   detections), 384×384 input, ImageNet normalization.
 *
 * Both return DETR-style `logits` + `pred_boxes`; {@link decodeDetr} turns them into the same
 * `objects` JSON as the default D-FINE implementation.
 */
import type { EdgeContext } from "../context.js";
import { IMAGENET, type Normalize, type Source, drawToRgba, rgbaToChw } from "../ml/canvas.js";
import { fetchModelFile, fetchModelText, memo } from "../ml/model-files.js";
import { type LoadedSession, createDeviceSession, pickDevice, run, tensor } from "../ml/ort.js";
import { EdgeError } from "../util/errors.js";
import { type DetectedObject, dedupeObjects } from "./detect-objects.js";
import { decodeDetr, id2label } from "./detect-post.js";

export interface AltDetector {
    /** models.json id (also the manifest model id). */
    id: string;
    name: string;
    file: string;
    size: number;
    norm: Normalize;
    /** Default score threshold (`_params.threshold` overrides). */
    threshold: number;
}

const UNIT: Normalize = { mean: [0, 0, 0], std: [1, 1, 1] };

export const ALT_DETECTORS: Record<string, AltDetector> = {
    yolo26n: { id: "yolo26n", name: "YOLO26n", file: "onnx/model_fp16.onnx", size: 640, norm: UNIT, threshold: 0.35 },
    "rf-detr-nano": { id: "rf-detr-nano", name: "RF-DETR nano", file: "onnx/model_fp16.onnx", size: 384, norm: IMAGENET, threshold: 0.35 },
};

const sessions = memo<LoadedSession>();
const labelSets = memo<Record<string, string>>();

async function load(ctx: EdgeContext, d: AltDetector) {
    const device = await pickDevice(ctx);
    return Promise.all([
        sessions(`${ctx.modelBase}|${d.id}@${device}`, async () => createDeviceSession(ctx, await fetchModelFile(ctx, d.id, d.file), device)),
        labelSets(`${ctx.modelBase}|${d.id}`, async () => id2label(JSON.parse(await fetchModelText(ctx, d.id, "config.json")))),
    ]);
}

/** Run one alternative detector on a decoded image → objects, best first. */
export async function detectAlt(ctx: EdgeContext, id: string, src: Source, threshold?: number): Promise<DetectedObject[]> {
    const d = ALT_DETECTORS[id];
    if (!d) throw new EdgeError(`unknown detection model "${id}"`);
    ctx.onProgress({ fraction: 0, message: `loading ${d.name}` });
    const [s, labels] = await load(ctx, d);
    if (!Object.keys(labels).length) throw new EdgeError(`${d.name}: config.json has no id2label`);
    const S = d.size;
    const x = rgbaToChw(drawToRgba(src, S, S), S, S, d.norm);
    ctx.onProgress({ fraction: 0.5, message: "detecting objects" });
    const out = await run(s, { pixel_values: await tensor(ctx, x, [1, 3, S, S]) });
    const logits = out.logits, boxes = out.pred_boxes;
    if (!logits || !boxes) throw new EdgeError(`${d.name}: unexpected outputs ${Object.keys(out).join(", ")}`);
    const [, queries, classes] = logits.dims as number[];
    return dedupeObjects(
        decodeDetr(
            { logits: logits.data as Float32Array, boxes: boxes.data as Float32Array, queries: queries!, classes: classes! },
            { labels, width: src.width, height: src.height, threshold: threshold ?? d.threshold, maxDetections: 100 },
        ),
    );
}
