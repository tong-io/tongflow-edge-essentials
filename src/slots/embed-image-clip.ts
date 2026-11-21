/**
 * `embed-image` alternative `chinese-clip-base`: Chinese-CLIP ViT-B/16 (OFA-Sys), on
 * onnxruntime-web directly. WASM by default (`_params.device: "webgpu"` opts in), so unlike the
 * default EmbeddingGemma 2 it needs no GPU.
 *
 * Xenova's export is one joint graph (text tower + vision tower, int8, 191 MB); no vision-only
 * graph is published. The text side gets a two-token `[CLS] [SEP]` input, which costs next to
 * nothing, and the image embedding is the graph's `image_embeds` (the projected vision pooler,
 * 512-d), L2-normalized. Preprocessing is Chinese-CLIP's: 224×224 bicubic resize (no crop), CLIP
 * mean/std. The vector is in Chinese-CLIP's own image-text space (text queries must be embedded by
 * Chinese-CLIP's text tower, not by EmbeddingGemma 2), and has 512 dims instead of 768: a TFV1
 * file carries its dims, and one run uses one model.
 */
import type { EdgeContext } from "../context.js";
import { type Normalize, decodeImage, drawToRgba, needCanvas, rgbaToChw } from "../ml/canvas.js";
import { fetchModelFile, memo } from "../ml/model-files.js";
import { type LoadedSession, createDeviceSession, loadOrt, pickDevice, run } from "../ml/ort.js";
import { packVectors, truncateNormalize } from "../ml/tfv1.js";
import type { EdgeSlotOutput, SlotInput } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { readAsset } from "./common.js";
import { vectorsFilename } from "./embed-image.js";

export const CHINESE_CLIP = { id: "chinese-clip-base", file: "onnx/model_quantized.onnx", size: 224, dims: 512 } as const;
/** `preprocessor_config.json` of the repo. */
export const CLIP_NORM: Normalize = { mean: [0.48145466, 0.4578275, 0.40821073], std: [0.26862954, 0.26130258, 0.27577711] };
/** `[CLS] [SEP]`: the shortest valid text input of the joint graph (BERT vocab of Chinese-CLIP). */
const EMPTY_TEXT = [101n, 102n];

const sessions = memo<LoadedSession>();

/** Chinese-CLIP vectors are 512-d; `_params.dims` may only restate that. */
export function clipDims(v: unknown): number {
    if (v === undefined || v === null || v === CHINESE_CLIP.dims) return CHINESE_CLIP.dims;
    throw new EdgeError(`chinese-clip-base vectors have ${CHINESE_CLIP.dims} dims; dims ${JSON.stringify(v)} is not available (it is EmbeddingGemma 2's option)`);
}

export async function embedImageClip(input: SlotInput<"embed-image">, ctx: EdgeContext): Promise<EdgeSlotOutput<"embed-image">> {
    needCanvas("embed-image");
    clipDims(ctx.params?.dims);
    const bytes = readAsset(input.image, "image");
    const bmp = await decodeImage(bytes, input.image.mime);
    try {
        ctx.onProgress({ fraction: 0, message: "loading Chinese-CLIP (191 MB on first use)" });
        const device = await pickDevice(ctx);
        const s = await sessions(`${ctx.modelBase}|${CHINESE_CLIP.id}@${device}`, async () =>
            createDeviceSession(ctx, await fetchModelFile(ctx, CHINESE_CLIP.id, CHINESE_CLIP.file), device),
        );
        throwIfAborted(ctx.signal);
        const S = CHINESE_CLIP.size;
        const pixels = rgbaToChw(drawToRgba(bmp, S, S), S, S, CLIP_NORM);
        const ort = await loadOrt(ctx);
        ctx.onProgress({ fraction: 0.5, message: "embedding the image" });
        const out = await run(s, {
            input_ids: new ort.Tensor("int64", BigInt64Array.from(EMPTY_TEXT), [1, EMPTY_TEXT.length]),
            attention_mask: new ort.Tensor("int64", BigInt64Array.from(EMPTY_TEXT, () => 1n), [1, EMPTY_TEXT.length]),
            pixel_values: new ort.Tensor("float32", pixels, [1, 3, S, S]),
        });
        const emb = out.image_embeds;
        if (!emb || emb.dims.at(-1) !== CHINESE_CLIP.dims) throw new EdgeError(`Chinese-CLIP: unexpected outputs ${Object.keys(out).join(", ")}`);
        const vector = truncateNormalize(emb.data as Float32Array, CHINESE_CLIP.dims);
        ctx.onProgress({ fraction: 1, message: `1 vector × ${vector.length} dims (Chinese-CLIP)` });
        return {
            success: true,
            vectors: { bytesBase64: encodeBase64(packVectors([vector])), filename: vectorsFilename(input.image.filename), mime: "application/octet-stream" },
        };
    } finally {
        bmp.close();
    }
}
