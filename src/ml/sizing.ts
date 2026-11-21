/**
 * Image sizing for the vision-language models. Pure arithmetic, so it is unit
 * tested in Node; the decoding itself (ImageBitmap / OffscreenCanvas) is in
 * `image.ts`.
 *
 * Qwen3.5 and GLM-OCR cut the image into `patch × merge` squares and give the
 * language model one token per square, so the pixel count decides the prompt
 * length, and on WebGPU the prompt length decides the latency (Qwen3.5 prefill
 * costs ~136 ms per token on a desktop GPU). The budgets below are per model.
 */

export interface PixelBudget {
    /** Side lengths are rounded to a multiple of this (patch_size × merge_size). */
    factor: number;
    minPixels: number;
    maxPixels: number;
}

/** Qwen3.5: 16 px patches merged 2×2 → one token per 32×32 px. ~448² keeps ~200 vision tokens. */
export const QWEN_BUDGET: PixelBudget = { factor: 32, minPixels: 256 * 256, maxPixels: 448 * 448 };
/** GLM-OCR: 14 px patches merged 2×2 → one token per 28×28 px. OCR needs more pixels than a description. */
export const GLM_OCR_BUDGET: PixelBudget = { factor: 28, minPixels: 112 * 112, maxPixels: 1024 * 1024 };

/**
 * The `smart_resize` rule of the Qwen2-VL family image processors (also used by
 * GLM-4.6V / GLM-OCR): keep the aspect ratio, make both sides multiples of
 * `factor`, and bring the area into [minPixels, maxPixels].
 */
export function smartResize(width: number, height: number, budget: PixelBudget): { width: number; height: number } {
    const { factor, minPixels, maxPixels } = budget;
    if (!(width > 0 && height > 0)) throw new RangeError(`invalid image size ${width}×${height}`);
    if (Math.max(width, height) / Math.min(width, height) > 200) {
        throw new RangeError(`image aspect ratio ${width}×${height} is too extreme (over 200:1)`);
    }
    let h = Math.max(factor, Math.round(height / factor) * factor);
    let w = Math.max(factor, Math.round(width / factor) * factor);
    if (w * h > maxPixels) {
        const beta = Math.sqrt((width * height) / maxPixels);
        h = Math.max(factor, Math.floor(height / beta / factor) * factor);
        w = Math.max(factor, Math.floor(width / beta / factor) * factor);
    } else if (w * h < minPixels) {
        const beta = Math.sqrt(minPixels / (width * height));
        h = Math.ceil((height * beta) / factor) * factor;
        w = Math.ceil((width * beta) / factor) * factor;
    }
    return { width: w, height: h };
}

/** Number of vision tokens the language model sees for a resized image. */
export function visionTokens(size: { width: number; height: number }, factor: number): number {
    return (size.width / factor) * (size.height / factor);
}

/** Override a budget's maxPixels from a node param (clamped to a sane range). */
export function withMaxPixels(budget: PixelBudget, maxPixels: unknown): PixelBudget {
    if (typeof maxPixels !== "number" || !Number.isFinite(maxPixels)) return budget;
    const clamped = Math.min(4096 * 4096, Math.max(budget.minPixels, Math.round(maxPixels)));
    return { ...budget, maxPixels: clamped };
}

/** Fit inside `maxSide` keeping the aspect ratio (never upscales). For models whose processor resizes itself. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
