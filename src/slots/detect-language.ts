import type { SlotImpl } from "../types.js";
import { guard } from "./common.js";

type Detector = { detect(text: string): { language: string } };
let eldPromise: Promise<Detector> | undefined;

/** eld's "medium" n-gram set (60 languages, ≈1.9 MB raw), loaded on first use. */
function loadEld(): Promise<Detector> {
    eldPromise ??= import("eld/medium").then((m) => (m as unknown as { eld: Detector }).eld);
    eldPromise.catch(() => {
        eldPromise = undefined;
    });
    return eldPromise;
}

/** Longer inputs do not change the answer; cap the work. */
const MAX_CHARS = 20_000;

/** BCP 47 "undetermined": the answer for empty text, or text with no letters to go on. */
export const UNDETERMINED = "und";

/**
 * Language from the writing system alone, for text too short for eld's n-grams
 * (「谢谢，辛苦了。」): `ja` when kana is present and CJK makes up at least half the
 * letters, `ko` when Hangul does, `zh` when Han ideographs do; otherwise {@link UNDETERMINED}.
 */
export function scriptLanguage(text: string): string {
    const count = (re: RegExp) => text.match(re)?.length ?? 0;
    const letters = count(/\p{L}/gu);
    if (!letters) return UNDETERMINED;
    const han = count(/\p{Script=Han}/gu);
    const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
    const hangul = count(/\p{Script=Hangul}/gu);
    if (kana && (han + kana) * 2 >= letters) return "ja";
    if (hangul * 2 >= letters) return "ko";
    if (han * 2 >= letters) return "zh";
    return UNDETERMINED;
}

/**
 * `detect-language`: text → ISO 639-1 code (eld). Never fails on content: when eld has no
 * answer (short or letter-free text) the script decides ({@link scriptLanguage}), and empty
 * text is `und`. A node fanned out over VAD segments must not fail on one 「嗯。」.
 */
export const detectLanguage: SlotImpl<"detect-language"> = (input, ctx) =>
    guard(ctx, async () => {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text) return { success: true, language: UNDETERMINED };
        const eld = await loadEld();
        const { language } = eld.detect(text.slice(0, MAX_CHARS));
        return { success: true, language: language || scriptLanguage(text.slice(0, MAX_CHARS)) };
    });
