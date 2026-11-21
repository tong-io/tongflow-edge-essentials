import type { EdgeContext } from "../context.js";
import { detectFormat, extensionOf, type DocFormat } from "../formats/detect.js";
import type { SlotImpl } from "../types.js";
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

/** `parse-document`: any supported document → Markdown-flavoured text. */
export const parseDocument: SlotImpl<"parse-document"> = (input, ctx) =>
    guard(ctx, async () => {
        const doc = input.document;
        const bytes = readAsset(doc, "document");
        const format = detectFormat(doc.mime, doc.filename, bytes);
        if (!format) {
            const what = [doc.mime, extensionOf(doc.filename) && `.${extensionOf(doc.filename)}`].filter(Boolean).join(", ");
            throw new EdgeError(`unsupported document format${what ? ` (${what})` : ""}`);
        }
        ctx.onProgress({ message: `parsing ${format}` });
        const text = await parseAs(format, bytes, doc.mime, doc.filename, ctx);
        ctx.onProgress({ fraction: 1 });
        return { success: true, text, images: [] };
    });
