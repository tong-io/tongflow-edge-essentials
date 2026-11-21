/**
 * Streaming, cancellable `generate()` for the T3 text generators.
 */

import type { EdgeContext } from "../context.js";
import { throwIfAborted } from "../util/errors.js";
import type { SamplingOptions } from "./prompts.js";
import { TokenProgress } from "./progress.js";
import type { Transformers } from "./runtime.js";

type Tensor = { dims: number[]; slice(...args: unknown[]): Tensor };
type Tokenizer = {
    batch_decode(t: Tensor, opts: { skip_special_tokens: boolean }): string[];
};
type Generator = { generate(opts: Record<string, unknown>): Promise<unknown> };

export interface GenerateArgs {
    model: unknown;
    tokenizer: unknown;
    /** Processor / tokenizer output; must contain `input_ids`. */
    inputs: Record<string, unknown> & { input_ids: Tensor };
    maxNewTokens: number;
    sampling: SamplingOptions;
    /** Extra logits processors (structured output). */
    logitsProcessor?: unknown;
    label?: string;
}

/**
 * Generate with token streaming into `ctx.onProgress` and cancellation through
 * `ctx.signal` (generation stops at the next token; the call then rethrows the
 * abort). Returns only the new text, special tokens removed.
 */
export async function generateText(
    tf: Transformers,
    ctx: EdgeContext,
    args: GenerateArgs,
): Promise<{ text: string; tokens: number; promptTokens: number }> {
    throwIfAborted(ctx.signal);
    const promptTokens = args.inputs.input_ids.dims.at(-1) ?? 0;
    const progress = new TokenProgress(ctx.onProgress, args.maxNewTokens, args.label ?? "generating");
    const stop = new tf.InterruptableStoppingCriteria();
    const onAbort = () => stop.interrupt();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const streamer = new tf.TextStreamer(args.tokenizer as never, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (piece: string) => progress.append(piece),
        token_callback_function: (ids: bigint[]) => progress.token(ids.length),
    });
    ctx.onProgress({ fraction: 0, message: `reading the input (${promptTokens} tokens)` });
    try {
        const out = await (args.model as Generator).generate({
            ...args.inputs,
            max_new_tokens: args.maxNewTokens,
            ...args.sampling,
            streamer,
            stopping_criteria: [stop],
            ...(args.logitsProcessor ? { logits_processor: args.logitsProcessor } : {}),
        });
        throwIfAborted(ctx.signal);
        const sequences = (out && typeof out === "object" && "sequences" in out ? (out as { sequences: Tensor }).sequences : out) as Tensor;
        const text = (args.tokenizer as Tokenizer).batch_decode(sequences.slice(null, [promptTokens, null]), {
            skip_special_tokens: true,
        })[0] ?? "";
        progress.flush(true);
        return { text, tokens: progress.count, promptTokens };
    } finally {
        ctx.signal.removeEventListener("abort", onAbort);
    }
}
