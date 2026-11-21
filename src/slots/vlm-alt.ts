/**
 * Alternative implementations of `image-gen-text` / `image-describe`, picked by the node's model
 * (the canvas "换实现" menu); Qwen3.5-0.8B stays the default (`image-gen-text.ts`). All three are
 * WebGPU-only, like Qwen, and fail with the same clear error without it.
 *
 * - `lfm2.5-vl-450m`: LFM2.5-VL-450M (Liquid AI), multilingual; Chinese default prompt. The image
 *   is scaled so the processor does not tile it (≤ 256 image tokens).
 * - `smolvlm2-500m`: SmolVLM2-500M-Video-Instruct (Hugging Face), English-centric; English default
 *   prompt; one 512² view of the image (64 tokens) unless `_params.image_splitting` is true.
 * - `florence-2-base`: Florence-2-base (Microsoft), English only and task-driven: it runs
 *   `<MORE_DETAILED_CAPTION>` (or the task token given as the prompt); no text-only chat.
 *
 * Same output as the default (`{success, text}`), same anti-loop settings as the Qwen fix
 * (repetition penalty 1.1 and a 4-gram ban on the generated tokens, the clause/loop post-filter),
 * greedy decoding and a 128-token default budget.
 */
import type { EdgeContext } from "../context.js";
import { FLORENCE2_BASE, LFM25_VL_450M, SMOLVLM2_500M, type T3Model, variantFor } from "../ml/catalog.js";
import { generateText } from "../ml/generate.js";
import { decodeImage } from "../ml/image.js";
import { intParam, numParam, sampling, stripThinking } from "../ml/prompts.js";
import { generatedRepeatProcessor } from "../ml/repeat.js";
import { type Transformers, modelConfig, withModel } from "../ml/runtime.js";
import { fitWithin } from "../ml/sizing.js";
import { ALT_MAX_NEW_TOKENS, cleanAltDescription, florenceTask, lfmMessages, smolMessages } from "../ml/vlm-alt-text.js";
import { requireWebGPU } from "../ml/webgpu.js";
import type { Asset, EdgeSlotOutput, SlotInput } from "../types.js";
import { EdgeError } from "../util/errors.js";
import { guard, readAsset } from "./common.js";
import type { VisionTextInput } from "./image-gen-text.js";

type Inputs = Record<string, unknown> & { input_ids: { dims: number[]; slice(...a: unknown[]): never } };
type Proc = {
    apply_chat_template(messages: unknown, opts: Record<string, unknown>): string;
    tokenizer: ((text: string, o?: object) => Inputs) & unknown;
    (...args: unknown[]): Promise<Inputs>;
    task_prompts_without_inputs?: Map<string, string>;
};
type Loaded = { processor: Proc; model: { dispose(): unknown } };

/** Model class per alternative (transformers.js 4.3.2 names). */
const CLASS: Record<string, keyof Transformers> = {
    [LFM25_VL_450M.id]: "Lfm2VlForConditionalGeneration",
    [SMOLVLM2_500M.id]: "SmolVLMForConditionalGeneration",
    [FLORENCE2_BASE.id]: "Florence2ForConditionalGeneration",
};

/** Longest image side handed to each processor (it resizes again itself). */
const MAX_SIDE: Record<string, number> = { [LFM25_VL_450M.id]: 640, [SMOLVLM2_500M.id]: 1536, [FLORENCE2_BASE.id]: 1536 };

function promptOf(input: VisionTextInput): string {
    const parts = [input.text, (input as { userPrompt?: string }).userPrompt].filter((s): s is string => !!s?.trim());
    return parts.join("\n\n");
}

export async function imageGenTextAlt(input: VisionTextInput, ctx: EdgeContext, model: T3Model): Promise<EdgeSlotOutput<"image-gen-text">> {
    return guard(ctx, async () => {
        const gpu = await requireWebGPU();
        const variant = variantFor(model, gpu.f16);
        const params = ctx.params ?? {};
        const gen = input as Partial<SlotInput<"image-gen-text">>;
        const image = (input as { image?: Asset }).image;
        if (ctx.nodeSlot === "image-describe" && !image) throw new EdgeError("missing image: expected an Asset with bytesBase64");
        const isFlorence = model.id === FLORENCE2_BASE.id;
        if (isFlorence && !image) throw new EdgeError("florence-2-base only describes images: attach an image, or pick another model for a text-only prompt");
        const bytes = image ? readAsset(image, "image") : undefined;
        const prompt = promptOf(input);
        const maxNewTokens = intParam(gen.max_new_tokens ?? params.max_new_tokens, ALT_MAX_NEW_TOKENS, 1, 1024);
        const repeat = {
            penalty: numParam(params.repetition_penalty, 1.1, 1, 2),
            ngram: intParam(params.no_repeat_ngram_size, 4, 0, 32),
        };
        const samp = sampling(
            {
                temperature: gen.temperature ?? (params.temperature as number | undefined),
                top_p: gen.top_p ?? (params.top_p as number | undefined),
                top_k: gen.top_k ?? (params.top_k as number | undefined),
            },
            // Greedy by default: these small models drift when sampled.
            { temperature: 0, top_p: 0.8, top_k: 20 },
        );

        return withModel<Loaded, EdgeSlotOutput<"image-gen-text">>(
            ctx,
            {
                model,
                variant,
                load: async (tf, progress_callback) => {
                    const processor = await tf.AutoProcessor.from_pretrained(model.repo, { progress_callback });
                    const Cls = tf[CLASS[model.id]!] as unknown as { from_pretrained(repo: string, o: object): Promise<Loaded["model"]> };
                    const m = await Cls.from_pretrained(model.repo, {
                        ...(variant.external === false ? {} : { config: await modelConfig(tf, model, variant, progress_callback) }),
                        dtype: variant.dtype,
                        device: "webgpu",
                        progress_callback,
                    });
                    return { value: { processor: processor as unknown as Proc, model: m }, dispose: () => m.dispose() };
                },
            },
            async ({ processor, model: m }, tf) => {
                const raw = bytes
                    ? (await decodeImage(tf, bytes, image?.mime, (w, h) => fitWithin(w, h, MAX_SIDE[model.id] ?? 1536))).image
                    : undefined;
                let inputs: Inputs;
                let promptTokens: number | undefined;
                let repeatFrom: number;
                if (isFlorence) {
                    const tasks = new Set(processor.task_prompts_without_inputs?.keys() ?? []);
                    const task = florenceTask(prompt, tasks);
                    if (prompt && task !== prompt) ctx.onProgress({ message: `florence-2-base takes no free-form prompt: running ${task}` });
                    inputs = await processor(raw, task);
                    promptTokens = 0; // encoder-decoder: the output holds only decoder ids
                    repeatFrom = 1; // skip the decoder start token
                } else {
                    const messages = (model.id === LFM25_VL_450M.id ? lfmMessages : smolMessages)({ prompt, system: gen.system, hasImage: !!raw });
                    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
                    if (!raw) inputs = processor.tokenizer(text, { add_special_tokens: false });
                    else if (model.id === LFM25_VL_450M.id) inputs = await processor(raw, text, { add_special_tokens: false });
                    else inputs = await processor(text, raw, { do_image_splitting: params.image_splitting === true, add_special_tokens: false });
                    repeatFrom = inputs.input_ids.dims.at(-1) ?? 0;
                }
                const useRepeat = repeat.penalty !== 1 || repeat.ngram > 0;
                const { text, tokens } = await generateText(tf, ctx, {
                    model: m,
                    tokenizer: processor.tokenizer,
                    inputs,
                    maxNewTokens,
                    sampling: samp,
                    ...(promptTokens !== undefined ? { promptTokens } : {}),
                    ...(useRepeat ? { logitsProcessor: [generatedRepeatProcessor(tf, repeatFrom, repeat)] } : {}),
                    label: raw ? "describing" : "generating",
                });
                const out = cleanAltDescription(stripThinking(text), tokens >= maxNewTokens);
                if (!out) throw new EdgeError("the model returned no text");
                ctx.onProgress({ fraction: 1, message: "done" });
                return { success: true, text: out };
            },
        );
    });
}
