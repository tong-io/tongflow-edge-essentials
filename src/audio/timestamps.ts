/**
 * Sentence-level timestamps for `transcribe-timestamp`, from the recognizer's
 * token times and the VAD's speech spans. Pure logic, unit tested in Node.
 *
 * - Each recognized chunk (a pause-bounded piece of the audio, as `transcribe`
 *   cuts it) gives tokens with times relative to the chunk; they are shifted to
 *   the whole audio.
 * - A sentence ends after sentence-final punctuation (。！？；!?; and a `.` that
 *   is not a decimal point), at a chunk boundary, or at a pause of
 *   {@link MAX_TOKEN_GAP_S} between two tokens.
 * - Token times are spikes (CTC) or emission frames (transducer), so a sentence's
 *   `start` is pulled back to where its speech span starts (at most
 *   {@link LEAD_S} before the first token) and its `end` pushed out to where the
 *   span ends (at most {@link TAIL_S} after the last token; a token emitted in the
 *   pause after the span ends the sentence itself), never past the neighbouring
 *   sentences.
 * - The result is monotonic (`start ≤ end ≤ next.start`) and within [0, duration].
 */

export interface TimedToken {
    /** Token text, a leading `▁` already turned into a space. */
    text: string;
    /** Seconds from the start of the chunk it was recognized in. */
    time: number;
}

export interface RecognizedChunk {
    /** Chunk bounds in seconds within the whole audio. */
    start: number;
    end: number;
    tokens: TimedToken[];
}

export interface SpanS {
    start: number;
    end: number;
}

export interface TimeStamp {
    start: number;
    end: number;
    text: string;
}

/** A pause this long between two tokens ends a sentence even without punctuation. */
export const MAX_TOKEN_GAP_S = 1.2;
/** How far before its first token a sentence may start (to the start of its speech span). */
export const LEAD_S = 0.6;
/** How far after its last token a sentence may end (to the end of its speech span). */
export const TAIL_S = 0.8;
/** A sentence lasts at least this long (a lone token still gets a visible span). */
const MIN_DUR_S = 0.1;

const STRONG_END = /[。！？!?；;…]$/;

/** True when `tok` ends a sentence (`next` is the following token's text, if any). */
export function endsSentence(tok: string, next: string | undefined): boolean {
    const t = tok.trim();
    if (!t) return false;
    if (STRONG_END.test(t)) return true;
    // "." ends a sentence unless it is a decimal point (2.3) or inside an abbreviation-like run (e.g.).
    if (/\.$/.test(t)) return next === undefined || !/^\d/.test(next.trim()) || /^\s/.test(next);
    return false;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** The last speech span that started by `t` (the one `t` falls in, or the one just before a pause `t` falls in). */
function spanBefore(spans: readonly SpanS[], t: number): SpanS | undefined {
    let hit: SpanS | undefined;
    for (const s of spans) if (s.start <= t + 0.05) hit = s;
    return hit;
}

/**
 * Sentence segments from recognized chunks. `join` turns a sentence's token texts
 * into its text (the recognizer's own rules: spaces, CJK); empty sentences are dropped.
 */
export function sentenceTimestamps(
    chunks: readonly RecognizedChunk[],
    spans: readonly SpanS[],
    duration: number,
    join: (tokens: string[]) => string,
): TimeStamp[] {
    interface Raw {
        first: number;
        /** Time of the last token (any), for pause detection. */
        last: number;
        /** Time of the last token with a letter or digit: punctuation is often emitted late. */
        spoken: number;
        tokens: string[];
        chunk: RecognizedChunk;
    }
    const raw: Raw[] = [];
    for (const chunk of chunks) {
        let cur: Raw | null = null;
        const toks = chunk.tokens;
        for (let i = 0; i < toks.length; i++) {
            const tok = toks[i]!;
            const time = Math.min(chunk.end, Math.max(chunk.start, chunk.start + tok.time));
            if (cur && time - cur.last > MAX_TOKEN_GAP_S) {
                raw.push(cur);
                cur = null;
            }
            if (!cur) {
                // punctuation alone does not open a sentence: attach it to the previous one
                if (!/[\p{L}\p{N}]/u.test(tok.text) && raw.length && raw.at(-1)!.chunk === chunk) {
                    raw.at(-1)!.tokens.push(tok.text);
                    continue;
                }
                cur = { first: time, last: time, spoken: time, tokens: [], chunk };
            }
            cur.tokens.push(tok.text);
            cur.last = time;
            if (/[\p{L}\p{N}]/u.test(tok.text)) cur.spoken = time;
            if (endsSentence(tok.text, toks[i + 1]?.text)) {
                raw.push(cur);
                cur = null;
            }
        }
        if (cur) raw.push(cur);
    }

    const out: TimeStamp[] = [];
    for (let i = 0; i < raw.length; i++) {
        const r = raw[i]!;
        const text = join(r.tokens).trim();
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        const firstSpan = spanBefore(spans, r.first);
        const lastSpan = spanBefore(spans, r.spoken);
        // Start no earlier than the speech the first token belongs to; end where that speech ends,
        // or at the last token when it was emitted in the pause after it (transducers emit late).
        let start = Math.max(r.first - LEAD_S, firstSpan ? firstSpan.start : r.chunk.start, r.chunk.start);
        let end = Math.min(r.spoken + TAIL_S, lastSpan ? Math.max(lastSpan.end, r.spoken) : r.chunk.end, r.chunk.end);
        const next = raw[i + 1];
        if (next) end = Math.min(end, next.first);
        const prev = out.at(-1);
        if (prev) start = Math.max(start, prev.end);
        start = Math.max(0, Math.min(start, r.first, duration));
        end = Math.min(duration, Math.max(end, r.spoken, start + MIN_DUR_S));
        if (prev && start < prev.end) start = prev.end;
        if (end < start) end = start;
        out.push({ start: round(start), end: round(end), text });
    }
    // Rounding can only shift by 0.5 ms; keep the order strict anyway.
    for (let i = 1; i < out.length; i++) {
        if (out[i]!.start < out[i - 1]!.end) out[i]!.start = out[i - 1]!.end;
        if (out[i]!.end < out[i]!.start) out[i]!.end = out[i]!.start;
    }
    return out;
}
