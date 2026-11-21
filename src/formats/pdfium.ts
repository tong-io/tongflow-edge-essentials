/**
 * `parse-document` alternative `pdfium`: PDF text through PDFium (Chrome's PDF engine) compiled to
 * WebAssembly by @embedpdf/pdfium. The 4.6 MB wasm ships in `dist/assets/pdfium/` and is fetched
 * on first use (reported as a download). Page text in PDFium's own reading order, pages separated
 * by a blank line; a page without a text layer contributes nothing (like the default parser, a
 * scanned PDF returns success with empty text).
 */
import type { EdgeContext } from "../context.js";
import { fetchAssetBytes } from "../util/assets.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { tidyText } from "../util/text.js";

export const PDFIUM_WASM = "assets/pdfium/pdfium.wasm";

type Pdfium = import("@embedpdf/pdfium").WrappedPdfiumModule;
let pdfiumPromise: Promise<Pdfium> | undefined;

function loadPdfium(ctx: EdgeContext): Promise<Pdfium> {
    pdfiumPromise ??= (async () => {
        const [{ init }, wasm] = await Promise.all([import("@embedpdf/pdfium"), fetchAssetBytes(ctx, PDFIUM_WASM, "pdfium-wasm")]);
        const p = await init({ wasmBinary: wasm.buffer as ArrayBuffer });
        p.PDFiumExt_Init();
        return p;
    })();
    pdfiumPromise.catch(() => {
        pdfiumPromise = undefined;
    });
    return pdfiumPromise;
}

/** FPDF_GetLastError codes. */
const ERRORS: Record<number, string> = {
    2: "the file is not a PDF or is damaged",
    3: "the PDF is damaged",
    4: "the PDF is password-protected",
    5: "the PDF uses an unsupported security handler",
    6: "a page of the PDF is damaged",
};

/** PDFium's page text: CRLF line ends, NUL padding, soft hyphens, and form feeds. */
export function cleanPdfiumText(s: string): string {
    return tidyText(s.replace(/\r\n?/g, "\n").replace(/[\u0000\u000c]/g, "").replace(/\u00ad\n?/g, ""));
}

export async function parsePdfPdfium(bytes: Uint8Array, ctx: EdgeContext): Promise<string> {
    ctx.onProgress({ message: "loading PDFium" });
    const p = await loadPdfium(ctx);
    const mod = p.pdfium as typeof p.pdfium & { HEAPU8: Uint8Array };
    const { wasmExports, UTF16ToString } = mod;
    const src = wasmExports.malloc(bytes.length);
    if (!src) throw new EdgeError("PDFium could not allocate memory for this PDF");
    // Read HEAPU8 after malloc: growing the memory replaces the view.
    mod.HEAPU8.set(bytes, src);
    const doc = p.FPDF_LoadMemDocument(src, bytes.length, "");
    try {
        if (!doc) {
            const code = p.FPDF_GetLastError();
            throw new EdgeError(`PDFium could not open the document: ${ERRORS[code] ?? `error ${code}`}`);
        }
        const n = p.FPDF_GetPageCount(doc);
        const pages: string[] = [];
        for (let i = 0; i < n; i++) {
            throwIfAborted(ctx.signal);
            const page = p.FPDF_LoadPage(doc, i);
            if (!page) continue;
            const tp = p.FPDFText_LoadPage(page);
            try {
                const count = tp ? p.FPDFText_CountChars(tp) : 0;
                if (count > 0) {
                    const buf = wasmExports.malloc((count + 1) * 2);
                    try {
                        p.FPDFText_GetText(tp, 0, count, buf);
                        pages.push(cleanPdfiumText(UTF16ToString(buf)));
                    } finally {
                        wasmExports.free(buf);
                    }
                }
            } finally {
                if (tp) p.FPDFText_ClosePage(tp);
                p.FPDF_ClosePage(page);
            }
            ctx.onProgress({ fraction: (i + 1) / n, message: `page ${i + 1}/${n}` });
        }
        return pages.filter(Boolean).join("\n\n");
    } finally {
        if (doc) p.FPDF_CloseDocument(doc);
        wasmExports.free(src);
    }
}
