/**
 * `embed-image`: EmbeddingGemma 2 (text backbone + vision tower) on WebGPU.
 * One image in, one L2-normalized 768-d vector out, as a TFV1 `vectors` file
 * (`src/ml/tfv1.ts`). The vector lives in the same space as EmbeddingGemma 2
 * text embeddings, so text queries (prefixed `task: search result | query: `)
 * can search images. The audio encoder is never loaded.
 *
 * Advanced param: `dims` (768 default; 512 / 256 / 128 use the model's
 * Matryoshka truncation, renormalized).
 */

import type { EdgeContext } from "../context.js";
import { EMBEDDING_GEMMA_2, pickModel, variantFor } from "../ml/catalog.js";
import { decodeImage } from "../ml/image.js";
import { modelConfig, withModel } from "../ml/runtime.js";
import { fitWithin } from "../ml/sizing.js";
import { packVectors, truncateNormalize } from "../ml/tfv1.js";
import { requireWebGPU } from "../ml/webgpu.js";
import type { EdgeSlotOutput, SlotInput } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { guard, readAsset } from "./common.js";

export const EMBED_DIMS = [768, 512, 256, 128] as const;

/** Larger inputs are scaled down before the processor (which resizes to ~280 soft tokens anyway). */
const MAX_SIDE = 1536;

type Loaded = {
    processor: (text: null, images: unknown) => Promise<Record<string, unknown>>;
    model: (inputs: Record<string, unknown>) => Promise<{ sentence_embedding: { dims: number[]; data: Float32Array } }>;
};

/** Output file name: `<input stem>.tfv1`. */
export function vectorsFilename(input?: string): string {
    const stem = (input ?? "image").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "image";
    return `${stem}.tfv1`;
}

export function parseDims(v: unknown): number {
    if (v === undefined || v === null) return 768;
    if (typeof v === "number" && (EMBED_DIMS as readonly number[]).includes(v)) return v;
    throw new EdgeError(`dims must be one of ${EMBED_DIMS.join(", ")}, got ${JSON.stringify(v)}`);
}

export async function embedImage(input: SlotInput<"embed-image">, ctx: EdgeContext): Promise<EdgeSlotOutput<"embed-image">> {
    return guard(ctx, async () => {
        const gpu = await requireWebGPU();
        const model = pickModel(ctx.model, [EMBEDDING_GEMMA_2]);
        const variant = variantFor(model, gpu.f16);
        const bytes = readAsset(input.image, "image");
        const dims = parseDims(ctx.params?.dims);

        return withModel<Loaded, EdgeSlotOutput<"embed-image">>(
            ctx,
            {
                model,
                variant,
                load: async (tf, progress_callback) => {
                    const config = await modelConfig(tf, model, variant, progress_callback);
                    // Load only the text + vision parts (README: "Selective Encoder Loading").
                    (config as { audio_config?: unknown }).audio_config = null;
                    const processor = await tf.AutoProcessor.from_pretrained(model.repo, { progress_callback });
                    const m = await tf.AutoModel.from_pretrained(model.repo, {
                        config,
                        dtype: variant.dtype,
                        device: "webgpu",
                        progress_callback,
                    });
                    return {
                        value: { processor: processor as unknown as Loaded["processor"], model: m as unknown as Loaded["model"] },
                        dispose: () => m.dispose(),
                    };
                },
            },
            async ({ processor, model: m }, tf) => {
                const { image } = await decodeImage(tf, bytes, input.image.mime, (w, h) => fitWithin(w, h, MAX_SIDE));
                ctx.onProgress({ fraction: 0.3, message: "embedding the image" });
                const inputs = await processor(null, image);
                throwIfAborted(ctx.signal);
                const { sentence_embedding } = await m(inputs);
                throwIfAborted(ctx.signal);
                const full = sentence_embedding.data;
                const width = sentence_embedding.dims.at(-1) ?? full.length;
                if (full.length !== width) throw new EdgeError(`expected one embedding, got shape [${sentence_embedding.dims.join(", ")}]`);
                const vector = truncateNormalize(full, Math.min(dims, width));
                ctx.onProgress({ fraction: 1, message: `1 vector × ${vector.length} dims` });
                return {
                    success: true,
                    vectors: {
                        bytesBase64: encodeBase64(packVectors([vector])),
                        filename: vectorsFilename(input.image.filename),
                        mime: "application/octet-stream",
                    },
                };
            },
        );
    });
}
