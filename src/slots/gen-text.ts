/**
 * `gen-text`: structured key-point extraction on WebGPU, with LFM2.5-350M (default,
 * `lfm2.5-350m`) or Qwen3.5-0.8B text-only (`qwen3.5-0.8b-text`, Apache-2.0).
 *
 * Input `text` is the document; the optional `userPrompt` narrows what to pull
 * out ("only amounts and dates"). The decoder is constrained to the JSON
 * schema `{"key_points": string[]}` (transformers.js structured output), and
 * the output `text` is that JSON. Long inputs are cut to `max_input_tokens`
 * (advanced param, default 4096).
 *
 * LFM2.5-350M is under the LFM Open License v1.0 (licenses/): commercial use
 * is licensed only while the operator and its affiliates make under USD 10M a
 * year. See the README. Qwen3.5-0.8B is Apache-2.0: picking it runs `gen-text`
 * entirely under Apache-licensed weights.
 *
 * Qwen gets the same task, schema and output, with these differences, measured on a
 * contract paragraph and the demo meeting transcript (greedy, WebGPU): the stricter
 * no-invention prompt (`KEY_POINTS_STRICT_SYSTEM`); repetition control on the generated
 * tokens only, a {@link QWEN_TEXT_REPETITION_PENALTY} penalty and a
 * {@link QWEN_TEXT_NO_REPEAT_NGRAM}-gram ban (`_params.repetition_penalty` /
 * `_params.no_repeat_ngram_size`, 1 / 0 turn them off); a shorter default `max_new_tokens`
 * ({@link QWEN_TEXT_MAX_NEW_TOKENS}); and {@link dropRestatedPoints} on the answer.
 * Alternatives that did worse: no penalty with the 8-gram ban kept going after the facts
 * and invented dates; a 1.1 penalty padded the list with remarks about the task itself; a
 * 4-gram ban (the image-description setting) changed numbers (3 月 31 日 → 29 日,
 * 128 万 → 12.8 万, 12 月 1 日 → 2 日).
 */

import type { EdgeContext } from "../context.js";
import { LFM25_350M, QWEN35_TEXT, pickModel, variantFor } from "../ml/catalog.js";
import { generateText } from "../ml/generate.js";
import { KEY_POINTS_SCHEMA, dropRestatedPoints, intParam, keyPointMessages, numParam, parseKeyPoints } from "../ml/prompts.js";
import { generatedRepeatProcessor } from "../ml/repeat.js";
import { modelConfig, withModel } from "../ml/runtime.js";
import { requireWebGPU } from "../ml/webgpu.js";
import type { EdgeSlotOutput, SlotInput } from "../types.js";
import { EdgeError } from "../util/errors.js";
import { guard } from "./common.js";

type Tok = {
    (text: string, opts?: Record<string, unknown>): { input_ids: { dims: number[]; slice(...a: unknown[]): never } } & Record<string, unknown>;
    encode(text: string, opts?: Record<string, unknown>): number[];
    decode(ids: number[], opts?: Record<string, unknown>): string;
    apply_chat_template(messages: unknown, opts: Record<string, unknown>): string;
};
type Loaded = { tokenizer: Tok; model: unknown };

/** `gen-text` models, default first (manifest `models`). */
export const GEN_TEXT_MODELS = [LFM25_350M, QWEN35_TEXT] as const;
/** Qwen's default answer budget: 12 short key points fit; a looping answer stops early. */
export const QWEN_TEXT_MAX_NEW_TOKENS = 384;
export const QWEN_TEXT_REPETITION_PENALTY = 1.05;
export const QWEN_TEXT_NO_REPEAT_NGRAM = 8;

/** Keep at most `maxTokens` tokens of the document (a cut is marked with "…"). */
export function truncateTokens(tok: Pick<Tok, "encode" | "decode">, text: string, maxTokens: number): { text: string; truncated: boolean } {
    const ids = tok.encode(text, { add_special_tokens: false });
    if (ids.length <= maxTokens) return { text, truncated: false };
    return { text: `${tok.decode(ids.slice(0, maxTokens), { skip_special_tokens: true })}…`, truncated: true };
}

export async function genText(input: SlotInput<"gen-text">, ctx: EdgeContext): Promise<EdgeSlotOutput<"gen-text">> {
    return guard(ctx, async () => {
        const gpu = await requireWebGPU();
        const model = pickModel(ctx.model, GEN_TEXT_MODELS);
        const qwen = model === QWEN35_TEXT;
        const variant = variantFor(model, gpu.f16);
        const source = typeof input.text === "string" ? input.text.trim() : "";
        if (!source) throw new EdgeError("missing text: gen-text needs the text to extract key points from");
        const params = ctx.params ?? {};
        const maxInput = intParam(params.max_input_tokens, 4096, 64, 30000);
        const maxNewTokens = intParam(params.max_new_tokens, qwen ? QWEN_TEXT_MAX_NEW_TOKENS : 768, 32, 4096);
        const repeat = {
            penalty: numParam(params.repetition_penalty, QWEN_TEXT_REPETITION_PENALTY, 1, 2),
            ngram: intParam(params.no_repeat_ngram_size, QWEN_TEXT_NO_REPEAT_NGRAM, 0, 32),
        };

        return withModel<Loaded, EdgeSlotOutput<"gen-text">>(
            ctx,
            {
                model,
                variant,
                load: async (tf, progress_callback) => {
                    const tokenizer = await tf.AutoTokenizer.from_pretrained(model.repo, { progress_callback });
                    const m = await tf.AutoModelForCausalLM.from_pretrained(model.repo, {
                        config: await modelConfig(tf, model, variant, progress_callback),
                        dtype: variant.dtype,
                        device: "webgpu",
                        progress_callback,
                    });
                    return { value: { tokenizer: tokenizer as unknown as Tok, model: m }, dispose: () => m.dispose() };
                },
            },
            async ({ tokenizer, model: m }, tf) => {
                const { text, truncated } = truncateTokens(tokenizer, source, maxInput);
                if (truncated) ctx.onProgress({ message: `the text is long: using its first ${maxInput} tokens` });
                const prompt = tokenizer.apply_chat_template(keyPointMessages(text, input.userPrompt, { strict: qwen }), {
                    add_generation_prompt: true,
                    tokenize: false,
                    // Qwen3.5: answer directly, no <think> block (ignored by LFM's template).
                    enable_thinking: false,
                });
                const inputs = tokenizer(prompt, { add_special_tokens: false });
                const { StructuredOutputProcessor } = await import("@huggingface/transformers-structured-output");
                const constraint = new StructuredOutputProcessor(tokenizer as never, {
                    type: "json_schema",
                    json_schema: KEY_POINTS_SCHEMA as never,
                });
                const promptTokens = inputs.input_ids.dims.at(-1) ?? 0;
                const useRepeat = qwen && (repeat.penalty !== 1 || repeat.ngram > 0);
                const out = await generateText(tf, ctx, {
                    model: m,
                    tokenizer,
                    inputs,
                    maxNewTokens,
                    // Greedy. LFM2.5: no repetition penalty (measured on WebGPU, 1.05 made it swap
                    // repeated CJK characters for wrong ones: 万 → 兆). Qwen: generated tokens only,
                    // applied after the JSON constraint and never banning every allowed token.
                    sampling: { do_sample: false },
                    logitsProcessor: useRepeat ? [constraint, generatedRepeatProcessor(tf, promptTokens, repeat, { feasible: true })] : constraint,
                    ...(model.eosTokenIds ? { generation: { eos_token_id: model.eosTokenIds } } : {}),
                    label: "extracting",
                });
                const parsed = parseKeyPoints(out.text);
                if (qwen) parsed.key_points = dropRestatedPoints(parsed.key_points);
                if (!parsed.key_points.length) throw new EdgeError("the model found no key points in the text");
                ctx.onProgress({ fraction: 1, message: `${parsed.key_points.length} key points` });
                return { success: true, text: JSON.stringify(parsed) };
            },
        );
    });
}
