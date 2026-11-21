/**
 * `image-gen-text` (and `image-describe`): Qwen3.5-0.8B on WebGPU.
 *
 * `image-gen-text` is what the canvas `imageGenTextNode` runs: a text prompt
 * (required, may be blank) plus an optional image, with optional `system`,
 * `max_new_tokens`, `enable_thinking`, `temperature`, `top_p`, `top_k`.
 * `image-describe` (image required, optional `text` / `userPrompt`) is served
 * by the same method. Without a prompt the model describes the image in 1–3
 * Simplified Chinese sentences; the default system prompt keeps answers in Chinese.
 *
 * Repetition: a 1.1 repetition penalty and a 4-gram ban on the generated tokens only
 * (`_params.repetition_penalty`, `_params.no_repeat_ngram_size`; 1 / 0 turn them off), a
 * default `max_new_tokens` of 192, and {@link cleanDescription} on the answer. Without them
 * Qwen3.5-0.8B looped a clause up to the token limit on a scanned page.
 *
 * Alternatives (the node's model): `lfm2.5-vl-450m`, `smolvlm2-500m`, `florence-2-base`, in
 * `vlm-alt.ts`, loaded only when picked.
 */

import type { EdgeContext } from "../context.js";
import { QWEN35_VL, VISION_TEXT_MODELS, pickModel, variantFor } from "../ml/catalog.js";
import { generateText } from "../ml/generate.js";
import { decodeImage } from "../ml/image.js";
import { intParam, numParam, sampling, stripThinking, visionMessages } from "../ml/prompts.js";
import { cleanDescription, generatedRepeatProcessor } from "../ml/repeat.js";
import { modelConfig, withModel } from "../ml/runtime.js";
import { QWEN_BUDGET, smartResize, withMaxPixels } from "../ml/sizing.js";
import { requireWebGPU } from "../ml/webgpu.js";
import type { Asset, EdgeSlotOutput, SlotInput } from "../types.js";
import { EdgeError } from "../util/errors.js";
import { guard, readAsset } from "./common.js";

/** Default answer budget: 1–3 Chinese sentences fit in well under 192 tokens. */
export const QWEN_MAX_NEW_TOKENS = 192;
/** Applied to generated tokens only; LFM2.5 (`gen-text`) keeps none. */
export const QWEN_REPETITION_PENALTY = 1.1;
/** No 4-token sequence twice in the answer (about 4–8 Chinese characters). */
export const QWEN_NO_REPEAT_NGRAM = 4;

export type VisionTextInput = SlotInput<"image-gen-text"> | SlotInput<"image-describe">;

type Loaded = {
    processor: {
        apply_chat_template(messages: unknown, opts: Record<string, unknown>): string;
        tokenizer: unknown;
        (text: string, image?: unknown): Promise<Record<string, unknown> & { input_ids: { dims: number[]; slice(...a: unknown[]): never } }>;
    };
    model: unknown;
};

/** The node's prompt: `text` and (image-describe) `userPrompt`, joined. */
function promptOf(input: VisionTextInput): string {
    const parts = [input.text, (input as { userPrompt?: string }).userPrompt].filter((s): s is string => !!s?.trim());
    return parts.join("\n\n");
}

export async function imageGenText(input: VisionTextInput, ctx: EdgeContext): Promise<EdgeSlotOutput<"image-gen-text">> {
    const alt = VISION_TEXT_MODELS.find((m) => m !== QWEN35_VL && m.id === ctx.model);
    if (alt) return (await import("./vlm-alt.js")).imageGenTextAlt(input, ctx, alt);
    return guard(ctx, async () => {
        const gpu = await requireWebGPU();
        const model = pickModel(ctx.model, VISION_TEXT_MODELS);
        const variant = variantFor(model, gpu.f16);
        const params = ctx.params ?? {};
        const gen = input as Partial<SlotInput<"image-gen-text">>;
        const image = (input as { image?: Asset }).image;
        if (ctx.nodeSlot === "image-describe" && !image) throw new EdgeError("missing image: expected an Asset with bytesBase64");
        const bytes = image ? readAsset(image, "image") : undefined;
        const messages = visionMessages({ prompt: promptOf(input), system: gen.system, hasImage: !!bytes });
        const maxNewTokens = intParam(gen.max_new_tokens ?? params.max_new_tokens, QWEN_MAX_NEW_TOKENS, 1, 2048);
        const repeat = {
            penalty: numParam(params.repetition_penalty, QWEN_REPETITION_PENALTY, 1, 2),
            ngram: intParam(params.no_repeat_ngram_size, QWEN_NO_REPEAT_NGRAM, 0, 32),
        };
        const samp = sampling(
            {
                temperature: gen.temperature ?? (params.temperature as number | undefined),
                top_p: gen.top_p ?? (params.top_p as number | undefined),
                top_k: gen.top_k ?? (params.top_k as number | undefined),
            },
            // Qwen3.5 model card, non-thinking mode. Repetition is handled by `repeat` below,
            // on the generated tokens only (transformers.js's own penalty also hits the prompt).
            { temperature: 0.7, top_p: 0.8, top_k: 20 },
        );
        const budget = withMaxPixels(QWEN_BUDGET, params.max_pixels);

        return withModel<Loaded, EdgeSlotOutput<"image-gen-text">>(
            ctx,
            {
                model,
                variant,
                load: async (tf, progress_callback) => {
                    const processor = await tf.AutoProcessor.from_pretrained(model.repo, { progress_callback });
                    const m = await tf.Qwen3_5ForConditionalGeneration.from_pretrained(model.repo, {
                        config: await modelConfig(tf, model, variant, progress_callback),
                        dtype: variant.dtype,
                        device: "webgpu",
                        progress_callback,
                    });
                    return { value: { processor: processor as unknown as Loaded["processor"], model: m }, dispose: () => m.dispose() };
                },
            },
            async ({ processor, model: m }, tf) => {
                const prompt = processor.apply_chat_template(messages, {
                    add_generation_prompt: true,
                    enable_thinking: gen.enable_thinking === true,
                });
                let inputs;
                if (bytes) {
                    const { image: raw } = await decodeImage(tf, bytes, image?.mime, (w, h) => smartResize(w, h, budget));
                    inputs = await processor(prompt, raw);
                } else {
                    inputs = await processor(prompt);
                }
                const promptTokens = inputs.input_ids.dims.at(-1) ?? 0;
                const useRepeat = repeat.penalty !== 1 || repeat.ngram > 0;
                const { text, tokens } = await generateText(tf, ctx, {
                    model: m,
                    tokenizer: processor.tokenizer,
                    inputs,
                    maxNewTokens,
                    sampling: samp,
                    ...(useRepeat ? { logitsProcessor: [generatedRepeatProcessor(tf, promptTokens, repeat)] } : {}),
                    label: bytes ? "describing" : "generating",
                });
                const out = cleanDescription(stripThinking(text), tokens >= maxNewTokens);
                if (!out) throw new EdgeError("the model returned no text");
                ctx.onProgress({ fraction: 1, message: "done" });
                return { success: true, text: out };
            },
        );
    });
}
