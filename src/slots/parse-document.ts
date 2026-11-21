import type { EdgeContext } from "../context.js";
import { detectFormat, extensionOf, type DocFormat } from "../formats/detect.js";
import { type ParseImpl, pickParser } from "../formats/impls.js";
import type { Asset, SlotImpl } from "../types.js";
import { EdgeError } from "../util/errors.js";
import { decodeText, tidyText } from "../util/text.js";
import { guard, readAsset } from "./common.js";

async function parseAs(format: DocFormat, bytes: Uint8Array, mime: string | undefined, filename: string | undefined, ctx: EdgeContext): Promise<string> {
    switch (format) {
        case "pdf":
            return (await import("../formats/pdf.js")).parsePdf(bytes, ctx);
        case "docx":
            return (await import("../formats/docx.js")).parseDocx(bytes);
        case "sheet":
            return (await import("../formats/sheet.js")).parseSheet(bytes);
        case "csv":
            return (await import("../formats/csv.js")).parseCsv(bytes);
        case "pptx":
            return (await import("../formats/pptx.js")).parsePptx(bytes);
        case "eml":
            return (await import("../formats/email.js")).parseEml(bytes);
        case "msg":
            return (await import("../formats/email.js")).parseMsg(bytes);
        case "html":
            return (await import("../formats/html.js")).parseHtml(decodeText(bytes));
        case "epub":
            return (await import("../formats/epub.js")).parseEpub(bytes, ctx);
        case "legacy":
            return (await import("../formats/legacy.js")).parseLegacy(bytes, mime, filename, ctx);
        case "markdown":
        case "text":
            // Markdown is already the output format; plain text passes through.
            return tidyText(decodeText(bytes));
        case "archive":
            throw new EdgeError("archives are not documents: the host unpacks them on upload, then parses each file");
        case "image":
            throw new EdgeError("this is an image, not a document: route it to an OCR node (ocr-image) instead");
        case "media":
            throw new EdgeError("this is an audio/video file, not a document: use transcribe or extract-audio instead");
    }
}

/** An alternative implementation (the node's model) for a format it handles (see `formats/impls.ts`). */
async function parseWith(impl: Exclude<ParseImpl, "builtin" | "mupdf">, bytes: Uint8Array, ext: string, ctx: EdgeContext): Promise<string> {
    switch (impl) {
        case "pdfium":
            return (await import("../formats/pdfium.js")).parsePdfPdfium(bytes, ctx);
        case "pdf2md":
            return (await import("../formats/pdf2md.js")).parsePdfMarkdown(bytes, ctx);
        case "officeparser":
            return (await import("../formats/officeparser.js")).parseWithOfficeparser(bytes, ext, ctx);
        case "readability":
            return (await import("../formats/readability.js")).parseHtmlReadability(decodeText(bytes));
    }
}

/** `render-pages` implementations, as listed in the manifest's `models` (first = default). */
export const PDF_IMPLS = ["pdfjs", "mupdf"] as const;
export type PdfImpl = (typeof PDF_IMPLS)[number];

/** The node's `render-pages` implementation: `pdfjs` (default) or `mupdf`. */
export function pdfImpl(ctx: Pick<EdgeContext, "model">, slot: string): PdfImpl {
    if (!ctx.model) return "pdfjs";
    if ((PDF_IMPLS as readonly string[]).includes(ctx.model)) return ctx.model as PdfImpl;
    throw new EdgeError(`unknown model "${ctx.model}" for ${slot}; available: ${PDF_IMPLS.join(", ")}`);
}

/**
 * `parse-document`: any supported document → Markdown-flavoured text. The node's model picks an
 * alternative parser (`pdfium`, `pdf2md`, `officeparser`, `readability`, `mupdf`); formats it does
 * not read go to the built-in parser, with a progress message saying so. `mupdf` (PDF) also
 * returns the embedded images.
 */
export const parseDocument: SlotImpl<"parse-document"> = (input, ctx) =>
    guard(ctx, async () => {
        const doc = input.document;
        const bytes = readAsset(doc, "document");
        const format = detectFormat(doc.mime, doc.filename, bytes);
        if (!format) {
            const what = [doc.mime, extensionOf(doc.filename) && `.${extensionOf(doc.filename)}`].filter(Boolean).join(", ");
            throw new EdgeError(`unsupported document format${what ? ` (${what})` : ""}`);
        }
        const ext = extensionOf(doc.filename);
        const { impl, note } = pickParser(ctx.model, format, ext);
        if (note) ctx.onProgress({ message: note });
        ctx.onProgress({ message: `parsing ${format}${impl === "builtin" ? "" : ` with ${impl}`}` });
        if (impl === "mupdf") {
            const { parsePdfMupdf } = await import("../formats/mupdf.js");
            const r = await parsePdfMupdf(bytes, ctx, { filename: doc.filename, images: ctx.params?.images !== false });
            ctx.onProgress({ fraction: 1 });
            const images: Asset[] = r.images;
            return { success: true, text: r.text, images };
        }
        const text = impl === "builtin" ? await parseAs(format, bytes, doc.mime, doc.filename, ctx) : await parseWith(impl, bytes, ext || format, ctx);
        ctx.onProgress({ fraction: 1 });
        return { success: true, text, images: [] };
    });
