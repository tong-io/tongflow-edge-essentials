/**
 * `gen-text`: structured key-point extraction with LFM2.5-350M on WebGPU.
 *
 * Input `text` is the document; the optional `userPrompt` narrows what to pull
 * out ("only amounts and dates"). The decoder is constrained to the JSON
 * schema `{"key_points": string[]}` (transformers.js structured output), and
 * the output `text` is that JSON. Long inputs are cut to `max_input_tokens`
 * (advanced param, default 4096).
 *
 * LFM2.5-350M is under the LFM Open License v1.0 (licenses/): commercial use
 * is licensed only while the operator and its affiliates make under USD 10M a
 * year. See the README.
 */

import type { EdgeContext } from "../context.js";
import { LFM25_350M, pickModel, variantFor } from "../ml/catalog.js";
import { generateText } from "../ml/generate.js";
import { KEY_POINTS_SCHEMA, intParam, keyPointMessages, parseKeyPoints } from "../ml/prompts.js";
import { withModel } from "../ml/runtime.js";
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

/** Keep at most `maxTokens` tokens of the document (a cut is marked with "…"). */
export function truncateTokens(tok: Pick<Tok, "encode" | "decode">, text: string, maxTokens: number): { text: string; truncated: boolean } {
    const ids = tok.encode(text, { add_special_tokens: false });
    if (ids.length <= maxTokens) return { text, truncated: false };
    return { text: `${tok.decode(ids.slice(0, maxTokens), { skip_special_tokens: true })}…`, truncated: true };
}

export async function genText(input: SlotInput<"gen-text">, ctx: EdgeContext): Promise<EdgeSlotOutput<"gen-text">> {
    return guard(ctx, async () => {
        const gpu = await requireWebGPU();
        const model = pickModel(ctx.model, [LFM25_350M]);
        const variant = variantFor(model, gpu.f16);
        const source = typeof input.text === "string" ? input.text.trim() : "";
        if (!source) throw new EdgeError("missing text: gen-text needs the text to extract key points from");
        const params = ctx.params ?? {};
        const maxInput = intParam(params.max_input_tokens, 4096, 64, 30000);
        const maxNewTokens = intParam(params.max_new_tokens, 768, 32, 4096);

        return withModel<Loaded, EdgeSlotOutput<"gen-text">>(
            ctx,
            {
                model,
                variant,
                load: async (tf, progress_callback) => {
                    const tokenizer = await tf.AutoTokenizer.from_pretrained(model.repo, { progress_callback });
                    const m = await tf.AutoModelForCausalLM.from_pretrained(model.repo, {
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
                const prompt = tokenizer.apply_chat_template(keyPointMessages(text, input.userPrompt), {
                    add_generation_prompt: true,
                    tokenize: false,
                });
                const inputs = tokenizer(prompt, { add_special_tokens: false });
                const { StructuredOutputProcessor } = await import("@huggingface/transformers-structured-output");
                const constraint = new StructuredOutputProcessor(tokenizer as never, {
                    type: "json_schema",
                    json_schema: KEY_POINTS_SCHEMA as never,
                });
                const out = await generateText(tf, ctx, {
                    model: m,
                    tokenizer,
                    inputs,
                    maxNewTokens,
                    // Greedy, and no repetition penalty: measured on WebGPU, a 1.05 penalty
                    // made LFM2.5 swap repeated CJK characters for wrong ones (万 → 兆).
                    sampling: { do_sample: false },
                    logitsProcessor: constraint,
                    label: "extracting",
                });
                const parsed = parseKeyPoints(out.text);
                if (!parsed.key_points.length) throw new EdgeError("the model found no key points in the text");
                ctx.onProgress({ fraction: 1, message: `${parsed.key_points.length} key points` });
                return { success: true, text: JSON.stringify(parsed) };
            },
        );
    });
}
