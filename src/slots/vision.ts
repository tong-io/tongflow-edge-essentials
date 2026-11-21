/**
 * T1 vision/document slots. Each is a thin wrapper: the bodies (onnxruntime-web,
 * transformers.js, pre/post-processing) are lazy chunks, so the entry stays small.
 * Models are downloaded on first use from the host's model base URL.
 */
import type { SlotImpl } from "../types.js";
import { guard } from "./common.js";

/** `ocr-image`: PP-OCRv6 (small by default, `tiny` via the node's model) → reading-ordered text. */
export const ocrImage: SlotImpl<"ocr-image"> = (input, ctx) =>
    guard(ctx, async () => (await import("../vision/impl.js")).ocrImage(input, ctx));

/** `image-orient`: PP-LCNet doc_ori → the page turned upright, as PNG. */
export const imageOrient: SlotImpl<"image-orient"> = (input, ctx) =>
    guard(ctx, async () => (await import("../vision/impl.js")).imageOrient(input, ctx));

/** `layout-detect`: PP-DocLayout-S (or -M) → `layout` JSON + cropped `regions` in reading order. */
export const layoutDetect: SlotImpl<"layout-detect"> = (input, ctx) =>
    guard(ctx, async () => (await import("../vision/impl.js")).layoutDetect(input, ctx));

/** `table-recognize`: SLANet_plus structure + PP-OCRv6 cell text → `<table>` HTML. */
export const tableRecognize: SlotImpl<"table-recognize"> = (input, ctx) =>
    guard(ctx, async () => (await import("../vision/impl.js")).tableRecognize(input, ctx));

/** `split-video`: TransNetV2 shot boundaries → one video per shot (remuxed where possible). */
export const splitVideo: SlotImpl<"split-video"> = (input, ctx) =>
    guard(ctx, async () => (await import("../vision/split-video.js")).splitVideo(input, ctx));

/** `detect-objects`: D-FINE nano (COCO) via transformers.js → `objects` JSON. */
export const detectObjects: SlotImpl<"detect-objects"> = (input, ctx) =>
    guard(ctx, async () => (await import("../vision/detect-objects.js")).detectObjects(input, ctx));
