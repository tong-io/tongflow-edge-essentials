/**
 * Repetition control for Qwen3.5's image descriptions: a repetition penalty and a
 * no-repeat n-gram ban that look at the GENERATED tokens only, plus a post-filter that
 * cuts a description where it starts repeating itself.
 *
 * transformers.js 4.3.2 has `repetition_penalty` / `no_repeat_ngram_size`, but both read
 * the whole sequence, prompt included: the system prompt, the instruction and every image
 * token. That pushes the answer away from the instruction's own words (「无法辨认」) and
 * from text the user quoted. These processors skip the first `promptTokens` ids.
 *
 * Also used for Qwen3.5 text (`gen-text` model `qwen3.5-0.8b-text`), there after the JSON-schema
 * constraint and never leaving a step without an allowed token. Not used for LFM2.5 (`gen-text`
 * default): a 1.05 penalty made it swap repeated CJK characters for wrong ones (万 → 兆).
 * Pure logic, unit tested in Node.
 */

export interface RepeatControl {
    /** >1 divides a seen token's positive logit (multiplies a negative one); 1 = off. */
    penalty: number;
    /** Ban the token that would complete an n-gram already generated; 0 = off. */
    ngram: number;
}

/** Apply {@link RepeatControl} to one row of logits, given the ids generated so far. */
export function applyRepeatControl(generated: ArrayLike<bigint | number>, logits: Float32Array, rc: RepeatControl): void {
    const n = generated.length;
    if (!n) return;
    if (rc.penalty !== 1) {
        const seen = new Set<number>();
        for (let i = 0; i < n; i++) seen.add(Number(generated[i]));
        for (const t of seen) {
            const v = logits[t];
            if (v === undefined) continue;
            logits[t] = v < 0 ? v * rc.penalty : v / rc.penalty;
        }
    }
    const k = rc.ngram;
    if (k > 0 && n >= k) {
        // The last k-1 ids; every earlier position followed by the same k-1 ids bans its next id.
        const tail = Array.from({ length: k - 1 }, (_, j) => Number(generated[n - k + 1 + j]));
        for (let s = 0; s + k <= n; s++) {
            let same = true;
            for (let j = 0; j < k - 1 && same; j++) same = Number(generated[s + j]) === tail[j];
            if (same) {
                const ban = Number(generated[s + k - 1]);
                if (ban < logits.length) logits[ban] = -Infinity;
            }
        }
    }
}

type Callable = new () => { _call(ids: bigint[][], logits: unknown): unknown };

/**
 * {@link applyRepeatControl}, but a row it would leave without any finite logit (the n-gram ban
 * hit the only token a grammar constraint still allows) keeps its logits unchanged.
 */
export function applyRepeatControlFeasible(generated: ArrayLike<bigint | number>, logits: Float32Array, rc: RepeatControl): void {
    const before = logits.slice();
    applyRepeatControl(generated, logits, rc);
    for (let i = 0; i < logits.length; i++) if (logits[i]! > -Infinity) return;
    logits.set(before);
}

/**
 * A transformers.js logits processor applying {@link applyRepeatControl} to the ids after the
 * prompt. `tf` is the lazily loaded transformers.js module (its `LogitsProcessor` base class).
 * `feasible`: run after a constraint, never ban every allowed token ({@link applyRepeatControlFeasible}).
 */
export function generatedRepeatProcessor(tf: { LogitsProcessor: unknown }, promptTokens: number, rc: RepeatControl, opts: { feasible?: boolean } = {}): unknown {
    const Base = tf.LogitsProcessor as Callable;
    const apply = opts.feasible ? applyRepeatControlFeasible : applyRepeatControl;
    class GeneratedRepeatProcessor extends Base {
        override _call(ids: bigint[][], logits: unknown) {
            const rows = logits as { data: Float32Array }[];
            for (let i = 0; i < ids.length; i++) apply(ids[i]!.slice(promptTokens), rows[i]!.data, rc);
            return logits;
        }
    }
    return new GeneratedRepeatProcessor();
}

/* ---------- post-filter ---------- */

const SENTENCE_END = /[。！？!?；;\n]/;
/** A clause: text up to and including one of these marks. */
const CLAUSE = /[^。！？!?；;，,、\n]+[。！？!?；;，,、\n]*|[。！？!?；;，,、\n]+/g;
/** Clauses shorter than this (letters/digits only) may repeat legitimately (「红色，」「1.」). */
const MIN_CLAUSE = 4;

const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");

/**
 * Cut a generated description where it starts repeating itself:
 * 1. a run of 4..40 characters (with at least two letters or digits) repeated back to back
 *    three or more times keeps one copy;
 * 2. the text ends before the first clause (split at 。！？；，、 and newlines) that repeats an
 *    earlier one (at least {@link MIN_CLAUSE} letters or digits, punctuation ignored);
 * 3. otherwise, with `truncated` (generation hit `max_new_tokens`), an unfinished last
 *    sentence is dropped when a finished one precedes it.
 * Text cut by 1 or 2 ends in 「。」.
 */
export function trimRepetition(text: string, truncated = false): string {
    let t = text.trim();
    let cut = false;
    for (const m of t.matchAll(/([\s\S]{4,40}?)\1{2,}/gu)) {
        if (norm(m[1]!).length < 2) continue;
        t = t.slice(0, m.index + m[1]!.length);
        cut = true;
        break;
    }
    const seen = new Set<string>();
    for (const m of t.matchAll(CLAUSE)) {
        const key = norm(m[0]);
        if (key.length < MIN_CLAUSE) continue;
        if (seen.has(key)) {
            t = t.slice(0, m.index);
            cut = true;
            break;
        }
        seen.add(key);
    }
    t = t.trim();
    if (cut) {
        t = t.replace(/[，,、；;：:\s]+$/u, "");
        if (t && !SENTENCE_END.test(t.at(-1)!)) t += "。";
    } else if (truncated && !SENTENCE_END.test(t.at(-1) ?? "")) {
        for (let i = t.length - 1; i >= 0; i--) {
            if (SENTENCE_END.test(t[i]!)) {
                t = t.slice(0, i + 1);
                break;
            }
        }
    }
    return t.trim();
}

/**
 * The answer for `image-gen-text`: {@link trimRepetition}, then a trailing line that only says
 * 「无法辨认」 after a real description is dropped (the strict prompt makes Qwen append it as filler).
 */
export function cleanDescription(text: string, truncated = false): string {
    const t = trimRepetition(text, truncated);
    const lines = t.split("\n");
    while (lines.length > 1 && /^\s*无法辨认\s*[。.]?\s*$/u.test(lines.at(-1)!)) lines.pop();
    return lines.join("\n").trim();
}
