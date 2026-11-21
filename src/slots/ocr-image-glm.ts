/**
 * `ocr-image`, tier-3 implementation: GLM-OCR on WebGPU (method `ocrImageGlm`,
 * model id `glm-ocr`). The slot's default implementation is PP-OCR
 * (`src/slots/ocr-image*`); this one is chosen by picking the `glm-ocr` model
 * on the node. It reads whole pages well (tables come back as Markdown/HTML),
 * at the cost of a ~660 MB first download.
 *
 * Advanced params: `max_pixels` (default 1024², the page is resized to fit),
 * `max_new_tokens` (default 2048).
 */

import type { EdgeContext } from "../context.js";
import { GLM_OCR, pickModel, variantFor } from "../ml/catalog.js";
import { generateText } from "../ml/generate.js";
import { decodeImage } from "../ml/image.js";
import { GLM_OCR_PROMPT, cleanOcrText, intParam } from "../ml/prompts.js";
import { modelConfig, withModel } from "../ml/runtime.js";
import { GLM_OCR_BUDGET, smartResize, withMaxPixels } from "../ml/sizing.js";
import { requireWebGPU } from "../ml/webgpu.js";
import type { EdgeSlotOutput, SlotInput } from "../types.js";
import { guard, readAsset } from "./common.js";

type Loaded = {
    processor: {
        apply_chat_template(messages: unknown, opts: Record<string, unknown>): string;
        tokenizer: unknown;
        (text: string, image: unknown): Promise<Record<string, unknown> & { input_ids: { dims: number[]; slice(...a: unknown[]): never } }>;
    };
    model: unknown;
};

export const GLM_OCR_MODEL_ID = GLM_OCR.id;

export async function ocrImageGlm(input: SlotInput<"ocr-image">, ctx: EdgeContext): Promise<EdgeSlotOutput<"ocr-image">> {
    return guard(ctx, async () => {
        const gpu = await requireWebGPU();
        const model = pickModel(ctx.model, [GLM_OCR]);
        const variant = variantFor(model, gpu.f16);
        const bytes = readAsset(input.image, "image");
        const params = ctx.params ?? {};
        const budget = withMaxPixels(GLM_OCR_BUDGET, params.max_pixels);
        const maxNewTokens = intParam(params.max_new_tokens, 2048, 16, 8192);

        return withModel<Loaded, EdgeSlotOutput<"ocr-image">>(
            ctx,
            {
                model,
                variant,
                load: async (tf, progress_callback) => {
                    const processor = await tf.AutoProcessor.from_pretrained(model.repo, { progress_callback });
                    const m = await tf.GlmOcrForConditionalGeneration.from_pretrained(model.repo, {
                        config: await modelConfig(tf, model, variant, progress_callback),
                        dtype: variant.dtype,
                        device: "webgpu",
                        progress_callback,
                    });
                    return { value: { processor: processor as unknown as Loaded["processor"], model: m }, dispose: () => m.dispose() };
                },
            },
            async ({ processor, model: m }, tf) => {
                const { image } = await decodeImage(tf, bytes, input.image.mime, (w, h) => smartResize(w, h, budget));
                const prompt = processor.apply_chat_template(
                    [{ role: "user", content: [{ type: "image" }, { type: "text", text: GLM_OCR_PROMPT }] }],
                    { add_generation_prompt: true },
                );
                const inputs = await processor(prompt, image);
                // GLM-OCR is trained for greedy decoding (generation_config: do_sample false).
                const { text } = await generateText(tf, ctx, {
                    model: m,
                    tokenizer: processor.tokenizer,
                    inputs,
                    maxNewTokens,
                    // No repetition penalty: a page repeats characters legitimately.
                    sampling: { do_sample: false },
                    label: "recognizing",
                });
                ctx.onProgress({ fraction: 1, message: "done" });
                // A page without text is a valid result, not a failure.
                return { success: true, text: cleanOcrText(text) };
            },
        );
    });
}
