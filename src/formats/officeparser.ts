/**
 * `parse-document` alternative `officeparser`: officeparser 8.9 (MIT) parses OOXML and
 * OpenDocument files (.docx .xlsx .pptx .odt .ods .odp) and .rtf into its document AST, and its
 * Markdown generator writes the text. The browser "slim" build is used: no Tesseract (OCR off)
 * and no CDN addresses; it is a lazy 6 MB chunk loaded only when this implementation runs.
 * Remote assets are refused (`allowRemoteAssets: false`), attachments are not extracted.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError } from "../util/errors.js";
import { tidyText } from "../util/text.js";

type OP = typeof import("officeparser/slim");
let mod: Promise<OP> | undefined;

function load(): Promise<OP> {
    mod ??= import("officeparser/slim");
    mod.catch(() => {
        mod = undefined;
    });
    return mod;
}

export async function parseWithOfficeparser(bytes: Uint8Array, ext: string, ctx: EdgeContext): Promise<string> {
    ctx.onProgress({ message: "loading officeparser" });
    const { OfficeParser, OfficeGenerator } = await load();
    ctx.onProgress({ message: `officeparser: reading .${ext}` });
    const config = {
        ocr: false,
        extractAttachments: false,
        allowRemoteAssets: false,
        outputErrorToConsole: false,
    } as Record<string, unknown>;
    let ast;
    try {
        ast = await OfficeParser.parseOffice(bytes.slice(), config as never);
    } catch (e) {
        throw new EdgeError(`officeparser could not read this .${ext} file: ${e instanceof Error ? e.message : String(e)}`);
    }
    // GitHub-flavoured Markdown: no `{#heading-id}` attributes or `==highlight==` marks (officeparser's
    // default "extended" dialect), and tables stay plain GFM grids.
    const md = await OfficeGenerator.generate(ast as never, "md" as never, { mdConfig: { dialect: { extends: "github", attributeLists: "none", highlight: "none" }, fallbackToHtml: false } } as never);
    const value = (md as { value?: unknown }).value;
    const text = typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
    return tidyOfficeMarkdown(text);
}

/**
 * officeparser's Markdown, tidied: the metadata front matter dropped, heading anchors
 * (`## 主要结论 {#主要结论}`) removed, and the `---` rule it puts before the first sheet or slide.
 */
export function tidyOfficeMarkdown(md: string): string {
    return tidyText(
        stripFrontMatter(md)
            .replace(/^(#{1,6} .*?)\s*\{#[^}\n]*\}[ \t]*$/gm, "$1")
            .replace(/^\s*---[ \t]*\r?\n/, ""),
    );
}

/** officeparser opens its Markdown with a YAML front-matter block of file metadata (author, dates, generator): dropped. */
export function stripFrontMatter(md: string): string {
    // Only `key: value` lines (and indented continuations) between the fences: a leading `---`
    // can also be a horizontal rule (officeparser separates sheets and slides with one).
    return md.replace(/^\uFEFF?---\r?\n(?:(?:[A-Za-z_][\w.-]*:[^\n]*|[ \t]+[^\n]*)\r?\n)+---[ \t]*(?:\r?\n|$)/, "");
}
