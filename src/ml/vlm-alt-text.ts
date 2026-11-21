/**
 * Prompts and answer clean-up for the alternative `image-gen-text` / `image-describe` models
 * (LFM2.5-VL-450M, SmolVLM2-500M, Florence-2-base). Pure string logic, unit tested in Node.
 *
 * The anti-loop settings are Qwen's (`repeat.ts`: 1.1 penalty and a 4-gram ban on the
 * generated tokens, then {@link cleanDescription}), with a shorter default answer. SmolVLM2 and
 * Florence-2 answer in English, so the clean-up also knows Latin sentence ends.
 */
import { DESCRIBE_PROMPT_ZH, SYSTEM_ZH, type ChatMessage } from "./prompts.js";
import { cleanDescription } from "./repeat.js";

/** Default answer budget of the alternatives: 1–3 sentences. */
export const ALT_MAX_NEW_TOKENS = 128;

/** SmolVLM2's default instruction (it follows English far better than Chinese). */
export const DESCRIBE_PROMPT_EN =
    "Describe this image in one to three sentences: what is in it and what kind of scene it is. " +
    "Copy any clearly readable text exactly. Describe only what is visible; do not guess names, numbers or dates. Do not repeat yourself.";

/** Florence-2 has no free-form prompt; its task for a description. */
export const FLORENCE_DESCRIBE_TASK = "<MORE_DETAILED_CAPTION>";

/**
 * The Florence-2 task for a node prompt: the prompt itself when it is one of the model's task
 * tokens (`<CAPTION>`, `<OCR>`, … as listed in its processor config), otherwise
 * {@link FLORENCE_DESCRIBE_TASK}. Florence-2 cannot follow instructions, so free text is ignored.
 */
export function florenceTask(prompt: string | undefined, tasks: ReadonlySet<string>): string {
    const p = prompt?.trim() ?? "";
    return tasks.has(p) ? p : FLORENCE_DESCRIBE_TASK;
}

/** Messages for LFM2.5-VL: Qwen's Chinese defaults (it is multilingual). */
export function lfmMessages(opts: { prompt?: string; system?: string; hasImage: boolean }): ChatMessage[] {
    const prompt = opts.prompt?.trim() || (opts.hasImage ? DESCRIBE_PROMPT_ZH : "");
    if (!prompt) throw new Error("nothing to do: the prompt is empty and no image is attached");
    const user: ChatMessage = opts.hasImage
        ? { role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }
        : { role: "user", content: [{ type: "text", text: prompt }] };
    return [{ role: "system", content: opts.system?.trim() || SYSTEM_ZH }, user];
}

/**
 * Messages for SmolVLM2. Its chat template walks `content` as a list for every role, so the
 * system message is a list too (a plain string would be dropped); no system message by default.
 */
export function smolMessages(opts: { prompt?: string; system?: string; hasImage: boolean }): ChatMessage[] {
    const prompt = opts.prompt?.trim() || (opts.hasImage ? DESCRIBE_PROMPT_EN : "");
    if (!prompt) throw new Error("nothing to do: the prompt is empty and no image is attached");
    const out: ChatMessage[] = [];
    const system = opts.system?.trim();
    if (system) out.push({ role: "system", content: [{ type: "text", text: system }] });
    out.push({
        role: "user",
        content: opts.hasImage ? [{ type: "image" }, { type: "text", text: prompt }] : [{ type: "text", text: prompt }],
    });
    return out;
}

const LATIN_END = /[.!?。！？]["')\]]?$/;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Drop everything from the first sentence that repeats an earlier one (12+ letters/digits). */
export function dedupeSentences(text: string): string {
    const parts = text.split(/(?<=[.!?。！？])\s+/);
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const p of parts) {
        const key = norm(p);
        if (key.length >= 12 && seen.has(key)) break;
        if (key.length >= 12) seen.add(key);
        kept.push(p);
    }
    return kept.join(" ").trim();
}

/**
 * The answer of an alternative model: {@link cleanDescription} (loops, repeated clauses, a cut-off
 * last sentence), then repeated whole sentences dropped; for a truncated answer a dangling Latin
 * sentence after a finished one is removed as well.
 */
export function cleanAltDescription(text: string, truncated = false): string {
    let t = dedupeSentences(cleanDescription(text.replace(/<\/?s>/g, ""), truncated));
    // cleanDescription ends a cut answer with 「。」; after Latin text that is a full stop.
    t = t.replace(/(?<=[\p{Script=Latin}\d)"'\]])。$/u, ".");
    if (truncated && !LATIN_END.test(t)) {
        const m = /^[\s\S]*[.!?。！？]["')\]]?(?=\s|$)/.exec(t);
        if (m && m[0].trim()) t = m[0].trim();
    }
    return t.trim();
}
