/**
 * Post-processing of the alternative `detect-objects` models (YOLO26n, RF-DETR nano), both
 * DETR-style set predictors run on onnxruntime-web directly: `logits [Q, C]` + `pred_boxes
 * [Q, 4]` (centre x, centre y, width, height, relative to the image). Pure, unit tested in Node.
 *
 * transformers.js' generic `post_process_object_detection` takes a softmax over the classes and
 * drops the last one as "no object"; neither model has a no-object class (YOLO26's 80 and
 * RF-DETR's 91 are all real), and both are trained with per-class sigmoids. Here: sigmoid
 * scores (unless the export already emits probabilities), the best class per query, every class.
 */
import type { DetectedObject } from "./detect-objects.js";

export interface DetrOutputs {
    logits: Float32Array;
    boxes: Float32Array;
    /** Queries (rows) and classes (columns of `logits`). */
    queries: number;
    classes: number;
}

export interface DecodeOptions {
    /** Class index → COCO name (`config.json` `id2label`); an index without a name is skipped. */
    labels: Record<string, string>;
    /** Source image size: boxes are scaled to it and clipped. */
    width: number;
    height: number;
    threshold: number;
    /** `true` when `logits` are already probabilities (sigmoid inside the graph). */
    probabilities?: boolean;
    /** Keep at most this many (best first). */
    maxDetections?: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** True when every value lies in [0, 1]: the export applied the sigmoid itself. */
export function looksLikeProbabilities(logits: Float32Array): boolean {
    for (let i = 0; i < logits.length; i++) {
        const v = logits[i]!;
        if (v < 0 || v > 1) return false;
    }
    return true;
}

/** One `{label, score, box}` per query whose best class passes `threshold`, best first. Boxes in source pixels. */
export function decodeDetr(out: DetrOutputs, o: DecodeOptions): DetectedObject[] {
    const { logits, boxes, queries, classes } = out;
    const prob = o.probabilities ?? looksLikeProbabilities(logits);
    const found: DetectedObject[] = [];
    for (let q = 0; q < queries; q++) {
        let best = -1;
        let bestV = -Infinity;
        for (let c = 0; c < classes; c++) {
            if (o.labels[String(c)] === undefined) continue;
            const v = logits[q * classes + c]!;
            if (v > bestV) {
                bestV = v;
                best = c;
            }
        }
        if (best < 0) continue;
        const score = prob ? bestV : sigmoid(bestV);
        if (!(score >= o.threshold)) continue;
        const [cx, cy, w, h] = [boxes[q * 4]!, boxes[q * 4 + 1]!, boxes[q * 4 + 2]!, boxes[q * 4 + 3]!];
        const x1 = Math.max(0, Math.round((cx - w / 2) * o.width));
        const y1 = Math.max(0, Math.round((cy - h / 2) * o.height));
        const x2 = Math.min(o.width, Math.round((cx + w / 2) * o.width));
        const y2 = Math.min(o.height, Math.round((cy + h / 2) * o.height));
        if (x2 - x1 < 1 || y2 - y1 < 1) continue;
        found.push({ label: o.labels[String(best)]!, score: Math.round(score * 1000) / 1000, box: [x1, y1, x2, y2] });
    }
    found.sort((a, b) => b.score - a.score);
    return o.maxDetections ? found.slice(0, o.maxDetections) : found;
}

/** `config.json` `id2label` with string keys (RF-DETR skips the COCO-91 ids that have no class). */
export function id2label(config: unknown): Record<string, string> {
    const m = (config as { id2label?: Record<string, unknown> } | null)?.id2label;
    const out: Record<string, string> = {};
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) if (typeof v === "string" && v !== "N/A") out[k] = v;
    return out;
}
