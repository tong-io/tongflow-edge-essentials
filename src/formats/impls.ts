/**
 * `parse-document` implementations, picked by the node's model (the canvas "换实现" menu). The
 * manifest `models` list is per slot, not per format, so each alternative names the formats it
 * handles; a document of any other format runs the built-in parser, and the node's progress
 * says so. Pure, unit tested in Node.
 */
import type { DocFormat } from "./detect.js";

/** Model ids of `parse-document`, default first (as in the manifest). */
export const PARSE_IMPLS = ["builtin", "pdfium", "pdf2md", "officeparser", "readability"] as const;
export type ParseImpl = (typeof PARSE_IMPLS)[number];

export const PARSE_IMPL_NAMES: Record<ParseImpl, string> = {
    builtin: "the built-in parsers",
    pdfium: "PDFium (@embedpdf/pdfium)",
    pdf2md: "pdf2md (@opendocsg/pdf2md)",
    officeparser: "officeparser",
    readability: "Readability (@mozilla/readability)",
};

/** Extensions officeparser reads (of the formats this slot routes elsewhere by default). */
const OFFICEPARSER_EXT = new Set(["docx", "docm", "dotx", "xlsx", "xlsm", "pptx", "ppsx", "pptm", "potx", "odt", "ott", "odp", "otp", "ods", "rtf"]);

/** The formats (and, for `officeparser`, extensions) each alternative handles. */
export function implSupports(impl: ParseImpl, format: DocFormat, ext: string): boolean {
    switch (impl) {
        case "builtin":
            return true;
        case "pdfium":
        case "pdf2md":
            return format === "pdf";
        case "readability":
            return format === "html";
        case "officeparser":
            if (format === "docx" || format === "pptx") return true;
            // .xls/.xlsb are not OOXML; .odt/.odp/.rtf come in as "legacy", which also covers .doc/.ppt.
            if (format === "sheet" || format === "legacy") return OFFICEPARSER_EXT.has(ext);
            return false;
    }
}

/** A model id → implementation; absent = the default. Unknown ids throw (listing the valid ones). */
export function parseImpl(model: string | undefined): ParseImpl {
    const m = (model ?? "").trim().toLowerCase();
    if (!m) return "builtin";
    const hit = PARSE_IMPLS.find((id) => id === m);
    if (!hit) throw new Error(`unknown parse-document implementation "${model}" (use ${PARSE_IMPLS.join(", ")})`);
    return hit;
}

/**
 * The implementation that runs: the chosen one when it handles the format, else `builtin`
 * with the message the node shows as progress.
 */
export function pickParser(model: string | undefined, format: DocFormat, ext: string): { impl: ParseImpl; note?: string } {
    const impl = parseImpl(model);
    if (implSupports(impl, format, ext)) return { impl };
    const what = ext ? `.${ext}` : format;
    return { impl: "builtin", note: `${PARSE_IMPL_NAMES[impl]} does not read ${what} files: using the built-in parser` };
}
