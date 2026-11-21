import type { SlotImpl } from "../types.js";
import { EdgeError } from "../util/errors.js";
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

/** `detect-language`: text → ISO 639-1 code (eld). */
export const detectLanguage: SlotImpl<"detect-language"> = (input, ctx) =>
    guard(ctx, async () => {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text) throw new EdgeError("text is empty");
        const eld = await loadEld();
        const { language } = eld.detect(text.slice(0, MAX_CHARS));
        if (!language) throw new EdgeError("could not determine the language of this text (too short or no letters)");
        return { success: true, language };
    });
