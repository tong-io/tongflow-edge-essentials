/**
 * `parse-document` alternative `pdf2md`: PDF → Markdown by @opendocsg/pdf2md, a pdf.js-based
 * heuristic converter (headings from font sizes, lists, bold/italic, page numbers and repeated
 * headers/footers removed). It reaches pdf.js through unpdf; unpdf is pointed at the plugin's
 * own pdf.js (the default parser's, same assets and CJK CMaps), so no second copy of pdf.js is
 * loaded and unpdf's serverless build is never bundled (see `tsdown.config.ts`).
 */
import type { EdgeContext } from "../context.js";
import { throwIfAborted } from "../util/errors.js";
import { tidyText } from "../util/text.js";
import { normalizeRadicals } from "./pdf.js";
import { loadPdfjs, pdfjsParams } from "./pdfjs.js";

type Pdf2md = (pdf: Uint8Array, callbacks?: { pageParsed?: (pages: unknown[]) => void }) => Promise<string>;

let ready: Promise<Pdf2md> | undefined;

function load(ctx: EdgeContext): Promise<Pdf2md> {
    ready ??= (async () => {
        const [pdfjs, unpdf, mod] = await Promise.all([loadPdfjs(), import("unpdf"), import("@opendocsg/pdf2md")]);
        const params = pdfjsParams(ctx);
        await unpdf.definePDFJSModule(async () => ({
            ...pdfjs,
            // unpdf's own defaults (`useSystemFonts`) yield to the plugin's worker-safe settings.
            getDocument: (src: Record<string, unknown>) => pdfjs.getDocument({ ...src, ...params } as never),
        }));
        const fn = (mod as unknown as { default?: Pdf2md }).default ?? (mod as unknown as Pdf2md);
        return fn;
    })();
    ready.catch(() => {
        ready = undefined;
    });
    return ready;
}

/** pdf2md's page separator. */
const PAGE_BREAK = /\n?<!-- PAGE_BREAK -->\n?/g;

/**
 * pdf2md's Markdown with page-break comments turned into blank lines, and the look-alike CJK
 * radicals some fonts map ideographs to (⼆ → 二) folded back, as the default PDF parser does.
 */
export function tidyPdf2md(md: string): string {
    return tidyText(normalizeRadicals(md.replace(PAGE_BREAK, "\n\n")));
}

export async function parsePdfMarkdown(bytes: Uint8Array, ctx: EdgeContext): Promise<string> {
    ctx.onProgress({ message: "loading pdf2md" });
    const pdf2md = await load(ctx);
    let total = 0;
    const md = await pdf2md(bytes.slice(), {
        pageParsed: (pages) => {
            throwIfAborted(ctx.signal);
            total = pages.length;
            const done = (pages as { items?: unknown[] }[]).filter((p) => p.items?.length).length;
            ctx.onProgress({ fraction: total ? Math.min(0.95, done / total) : undefined, message: `pages read: ${done}/${total}` });
        },
    });
    throwIfAborted(ctx.signal);
    return tidyPdf2md(md);
}
