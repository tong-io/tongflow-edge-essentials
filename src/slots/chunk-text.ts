import type { SlotImpl } from "../types.js";
import { EdgeError } from "../util/errors.js";
import { guard } from "./common.js";

/** Collected `texts` as an array of strings (a lone string is tolerated). */
export function textList(value: unknown, field: string): string[] {
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list)) throw new EdgeError(`${field} must be an array of strings`);
    list.forEach((t, i) => {
        if (typeof t !== "string") throw new EdgeError(`${field}[${i}] is not a string`);
    });
    return list as string[];
}

/**
 * `chunk-text`: the collected texts → chunks of at most `max_chars` (default 500,
 * clamped to 50..8000), paragraph → sentence → hard cut, ≈80 characters of overlap,
 * Markdown tables kept whole when they fit. Empty chunks are dropped; no text at all fails.
 */
export const chunkText: SlotImpl<"chunk-text"> = (input, ctx) =>
    guard(ctx, async () => {
        const texts = textList(input.texts, "texts");
        const raw = input.max_chars;
        if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1)) {
            throw new EdgeError("max_chars must be a positive integer");
        }
        const { DEFAULT_MAX_CHARS, MAX_MAX_CHARS, MIN_MAX_CHARS, chunkText: chunk } = await import("../kb/chunk.js");
        const maxChars = Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(raw ?? DEFAULT_MAX_CHARS)));
        const chunks = chunk(texts, { maxChars });
        if (!chunks.length) throw new EdgeError("no text to chunk (all inputs are empty)");
        ctx.onProgress({ fraction: 1, message: `${chunks.length} chunks` });
        return { success: true, chunks };
    });
