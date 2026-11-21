/**
 * Prompts and output clean-up for the T3 text generators. Pure string logic,
 * unit tested in Node.
 */

/**
 * Default instruction when an image arrives without a usable prompt. Strict on purpose: a
 * 0.8B model asked for a "detailed" description of a scanned page padded it with invented
 * names and amounts (「某某公司」「总金额为6%」) and looped 「背景为纯白色，内容清晰」.
 */
export const DESCRIBE_PROMPT_ZH =
    "用 1 到 3 句简体中文描述这张图片：画面里有什么、是什么场景，能看清的文字照原样写出。" +
    "只写确实看得见的内容，不要猜测，不要编造名称、人名、公司名、数字、金额或日期；看不清的地方写「无法辨认」。不要重复。";

/** Default system prompt: answer in Simplified Chinese unless the user asks otherwise; no invention. */
export const SYSTEM_ZH =
    "你是一个严谨的视觉助手。除非用户明确要求使用其他语言，否则始终使用简体中文回答。" +
    "只描述图片中确实可见的内容，不编造名称、数字或金额；不确定时说「无法辨认」。回答简洁，不重复。";

/** GLM-OCR's own task prompt for plain text recognition. */
export const GLM_OCR_PROMPT = "Text Recognition:";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string | ({ type: "image" } | { type: "text"; text: string })[];
}

/**
 * Messages for `image-gen-text` / `image-describe`.
 * `prompt` is the node's text (may be blank), `hasImage` whether an image is attached.
 */
export function visionMessages(opts: { prompt?: string; system?: string; hasImage: boolean }): ChatMessage[] {
    const prompt = opts.prompt?.trim() || (opts.hasImage ? DESCRIBE_PROMPT_ZH : "");
    if (!prompt) throw new Error("nothing to do: the prompt is empty and no image is attached");
    const system = opts.system?.trim() || SYSTEM_ZH;
    const user: ChatMessage = opts.hasImage
        ? { role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }
        : { role: "user", content: [{ type: "text", text: prompt }] };
    return [{ role: "system", content: system }, user];
}

/** Drop a reasoning block (`<think>…</think>`), including an unterminated one at the end. */
export function stripThinking(s: string): string {
    let out = s.replace(/<think>[\s\S]*?<\/think>/g, "");
    // The chat template may open <think> in the prompt, so only the closing tag shows up.
    const close = out.indexOf("</think>");
    if (close >= 0) out = out.slice(close + "</think>".length);
    const open = out.indexOf("<think>");
    if (open >= 0) out = out.slice(0, open);
    return out.trim();
}

/** OCR output clean-up: GLM-OCR may wrap the page in a Markdown code fence. */
export function cleanOcrText(s: string): string {
    let t = stripThinking(s).replace(/\r\n/g, "\n");
    const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(t.trim());
    if (fence) t = fence[1]!;
    return t.replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- gen-text: structured key-point extraction ---------- */

export const MAX_KEY_POINTS = 12;

/** The JSON schema the decoder is constrained to (transformers.js structured output). */
export const KEY_POINTS_SCHEMA = {
    type: "object",
    properties: {
        key_points: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            minItems: 1,
            maxItems: MAX_KEY_POINTS,
        },
    },
    required: ["key_points"],
    additionalProperties: false,
} as const;

export const KEY_POINTS_SYSTEM =
    "You extract the key points of a document. Return JSON only, shaped as " +
    '{"key_points": ["...", "..."]}. Each key point is one short, self-contained sentence ' +
    "stating a fact, number, date, name, decision or conclusion from the text. Do not invent anything. " +
    "Write the key points in the same language as the text. " +
    `Give at most ${MAX_KEY_POINTS} key points, most important first.`;

/** The Chinese prompt: a 350M model follows an instruction in the document's own language far better. */
export const KEY_POINTS_SYSTEM_ZH =
    '你负责提取文档要点。只输出 JSON，格式为 {"key_points": ["...", "..."]}。' +
    "每条要点是一句简短、完整的话，写明文中的事实、数字、日期、名称、决定或结论，不得编造。" +
    `要点使用简体中文。最多 ${MAX_KEY_POINTS} 条，按重要性排序。`;

/** True when CJK ideographs make up a noticeable share of the letters. */
export function isMostlyCjk(text: string): boolean {
    const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
    const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
    // One ideograph carries about a word; Latin letters about a fifth of one.
    return cjk > 0 && cjk >= latin / 5;
}

/** Messages for `gen-text`: `userPrompt` (optional) narrows what to extract. */
export function keyPointMessages(text: string, userPrompt?: string): ChatMessage[] {
    const focus = userPrompt?.trim();
    const zh = isMostlyCjk(text);
    const user = zh
        ? focus
            ? `要求：${focus}\n\n原文：\n${text}`
            : `原文：\n${text}`
        : focus
          ? `Instructions: ${focus}\n\nText:\n${text}`
          : `Text:\n${text}`;
    return [
        { role: "system", content: zh ? KEY_POINTS_SYSTEM_ZH : KEY_POINTS_SYSTEM },
        { role: "user", content: user },
    ];
}

/**
 * Normalize the model's answer to `{"key_points": string[]}`. Constrained
 * decoding makes it valid JSON, but generation can still stop at
 * `max_new_tokens`; then the complete items are salvaged. Without any JSON the
 * answer's bullet or numbered lines are used.
 */
export function parseKeyPoints(raw: string): { key_points: string[] } {
    const text = stripThinking(raw);
    const tidy = (xs: unknown[]) =>
        [...new Set(xs.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))].slice(0, MAX_KEY_POINTS);
    const start = text.indexOf("{");
    if (start >= 0) {
        const json = text.slice(start);
        try {
            const v = JSON.parse(json.slice(0, json.lastIndexOf("}") + 1)) as { key_points?: unknown };
            if (Array.isArray(v.key_points)) return { key_points: tidy(v.key_points) };
        } catch {
            // truncated: keep every complete string inside the array
        }
        const arr = json.indexOf("[");
        if (arr >= 0) {
            const items: string[] = [];
            const re = /"((?:[^"\\]|\\.)*)"/g;
            let m: RegExpExecArray | null;
            const body = json.slice(arr + 1);
            while ((m = re.exec(body))) {
                try {
                    items.push(JSON.parse(`"${m[1]}"`) as string);
                } catch {
                    /* skip a broken escape */
                }
            }
            if (items.length) return { key_points: tidy(items) };
        }
    }
    const lines = text
        .split("\n")
        .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)、]|[（(]?\d+[）)])\s*/, "").trim())
        .filter(Boolean);
    return { key_points: tidy(lines) };
}

/* ---------- parameters ---------- */

/** An integer param in [min, max], or `fallback` when absent / not a number. */
export function intParam(v: unknown, fallback: number, min: number, max: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.round(v)));
}

/** A float param in [min, max], or `fallback`. */
export function numParam(v: unknown, fallback: number, min: number, max: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

export interface SamplingOptions {
    do_sample: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
}

/**
 * Sampling settings: `temperature` 0 (or below 0.01) means greedy decoding.
 * Defaults follow the model card (Qwen3.5 non-thinking: 0.7 / 0.8 / 20).
 */
export function sampling(
    input: { temperature?: number; top_p?: number; top_k?: number },
    defaults: { temperature: number; top_p: number; top_k: number; repetition_penalty?: number },
): SamplingOptions {
    const temperature = numParam(input.temperature, defaults.temperature, 0, 2);
    const rp = defaults.repetition_penalty ? { repetition_penalty: defaults.repetition_penalty } : {};
    if (temperature < 0.01) return { do_sample: false, ...rp };
    return {
        do_sample: true,
        temperature,
        top_p: numParam(input.top_p, defaults.top_p, 0.01, 1),
        top_k: intParam(input.top_k, defaults.top_k, 1, 1000),
        ...rp,
    };
}
