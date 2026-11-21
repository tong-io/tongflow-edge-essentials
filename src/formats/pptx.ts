import { toArrayBuffer } from "../util/base64.js";
import { toMarkdownTable } from "../util/markdown.js";
import { htmlFragmentToText, tidyText } from "../util/text.js";

type Parse = (typeof import("pptxtojson"))["parse"];

interface El {
    type: string;
    top?: number;
    left?: number;
    content?: string;
    text?: string;
    latex?: string;
    data?: unknown;
    textList?: string[];
    elements?: El[];
}

function elementText(el: El): string {
    switch (el.type) {
        case "text":
        case "shape":
            return el.content ? htmlFragmentToText(el.content) : "";
        case "table": {
            const rows = Array.isArray(el.data) ? (el.data as { text?: string }[][]) : [];
            return toMarkdownTable(rows.map((r) => r.map((c) => htmlFragmentToText(c?.text ?? ""))));
        }
        case "math":
            if (el.text) return htmlFragmentToText(el.text);
            return el.latex ? "$" + el.latex + "$" : "";
        case "diagram": {
            const list = (el.textList ?? []).map((t) => t.trim()).filter(Boolean);
            return list.length ? list.map((t) => "- " + t).join("\n") : elementsText(el.elements ?? []);
        }
        case "group":
            return elementsText(el.elements ?? []);
        default:
            return "";
    }
}

/** Reading order: top to bottom, then left to right (boxes within ~8pt count as one row). */
function elementsText(els: El[]): string {
    const sorted = [...els].sort((a, b) => {
        const dy = (a.top ?? 0) - (b.top ?? 0);
        return Math.abs(dy) > 8 ? dy : (a.left ?? 0) - (b.left ?? 0);
    });
    return sorted
        .map(elementText)
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n\n");
}

/** .pptx (pptxtojson) → one `## Slide N` section per slide: text, tables, speaker notes. */
export async function parsePptx(bytes: Uint8Array): Promise<string> {
    const mod = (await import("pptxtojson")) as unknown as { parse?: Parse; default?: { parse?: Parse } };
    // ESM build exports `parse`; the UMD build (picked by some resolvers) only a default.
    const parse = mod.parse ?? mod.default?.parse;
    if (!parse) throw new Error("pptxtojson failed to load");
    const json = await parse(toArrayBuffer(bytes), { imageMode: "none", videoMode: "none", audioMode: "none" });
    const out: string[] = [];
    json.slides.forEach((slide, i) => {
        const body = elementsText(slide.elements as unknown as El[]);
        const note = slide.note ? tidyText(htmlFragmentToText(slide.note)) : "";
        let s = `## Slide ${i + 1}`;
        if (body) s += "\n\n" + body;
        if (note) s += "\n\n> Notes: " + note.replace(/\n/g, "\n> ");
        out.push(s);
    });
    return out.join("\n\n");
}
