import { toArrayBuffer } from "../util/base64.js";
import { htmlToMarkdown } from "./html.js";

/** .docx → semantic HTML (mammoth) → Markdown (headings, lists, tables kept). */
export async function parseDocx(bytes: Uint8Array): Promise<string> {
    const mod = await import("mammoth");
    const mammoth = (mod as unknown as { default?: typeof mod }).default ?? mod;
    const { value: html } = await mammoth.convertToHtml(
        // `arrayBuffer` is what the browser build reads, `buffer` what the Node build reads.
        { arrayBuffer: toArrayBuffer(bytes), buffer: bytes } as unknown as { arrayBuffer: ArrayBuffer },
        {
            // Inline images would become multi-megabyte data: URIs in the text.
            convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
        },
    );
    const { markdown } = await htmlToMarkdown(html, "document");
    return markdown;
}
