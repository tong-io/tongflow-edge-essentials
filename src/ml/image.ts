/**
 * Decode an input image for the vision models, worker-safe: ImageBitmap +
 * OffscreenCanvas, no DOM. EXIF orientation is applied by the decoder.
 */

import { EdgeError } from "../util/errors.js";
import type { Transformers } from "./runtime.js";

type RawImage = InstanceType<Transformers["RawImage"]>;

const SNIFF: [number[], string][] = [
    [[0x89, 0x50, 0x4e, 0x47], "image/png"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [[0x47, 0x49, 0x46, 0x38], "image/gif"],
    [[0x42, 0x4d], "image/bmp"],
];

/** The image MIME type from the bytes (WebP / AVIF by their RIFF / ftyp boxes), or `fallback`. */
export function sniffImageMime(bytes: Uint8Array, fallback?: string): string | undefined {
    for (const [magic, mime] of SNIFF) if (magic.every((b, i) => bytes[i] === b)) return mime;
    const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
    if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (bytes.length > 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
    return fallback?.startsWith("image/") ? fallback : undefined;
}

/**
 * Decode `bytes` and resize to `target(width, height)` (high-quality
 * resampling), returning an RGBA `RawImage` for a transformers.js processor.
 */
export async function decodeImage(
    tf: Transformers,
    bytes: Uint8Array,
    mime: string | undefined,
    target: (width: number, height: number) => { width: number; height: number },
): Promise<{ image: RawImage; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
    const type = sniffImageMime(bytes, mime);
    if (!type) throw new EdgeError("the input is not an image this browser can decode (PNG, JPEG, WebP, GIF, BMP or AVIF)");
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
        throw new EdgeError("this environment cannot decode images (needs createImageBitmap and OffscreenCanvas)");
    }
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }), { imageOrientation: "from-image" });
    } catch (e) {
        throw new EdgeError(`could not decode the image (${type}): ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
        const sourceWidth = bitmap.width;
        const sourceHeight = bitmap.height;
        const { width, height } = target(sourceWidth, sourceHeight);
        const canvas = new OffscreenCanvas(width, height);
        const g = canvas.getContext("2d");
        if (!g) throw new EdgeError("OffscreenCanvas 2D context is unavailable");
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        // Transparent pixels become white, as a viewer would show them.
        g.fillStyle = "#fff";
        g.fillRect(0, 0, width, height);
        g.drawImage(bitmap, 0, 0, width, height);
        const data = g.getImageData(0, 0, width, height).data;
        const image = new tf.RawImage(data, width, height, 4).rgb();
        return { image, width, height, sourceWidth, sourceHeight };
    } finally {
        bitmap.close();
    }
}
