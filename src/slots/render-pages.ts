import { detectFormat } from "../formats/detect.js";
import type { Asset, SlotImpl } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { guard, readAsset } from "./common.js";
import { pdfImpl } from "./parse-document.js";

/** 150 DPI: legible for OCR (PP-OCR's sweet spot is ~150–200) at a moderate PNG size. */
export const RENDER_DPI = 150;
/** Longest side cap, so a poster-size page does not allocate a gigapixel canvas. */
export const RENDER_MAX_SIDE = 4096;

/**
 * `render-pages`: PDF → one PNG per page. Default pdf.js + OffscreenCanvas (browser only);
 * model `mupdf` renders with MuPDF.js's own rasterizer (also in Node), same DPI rules.
 */
export const renderPages: SlotImpl<"render-pages"> = (input, ctx) =>
    guard(ctx, async () => {
        const impl = pdfImpl(ctx, "render-pages");
        const doc = input.document;
        const bytes = readAsset(doc, "document");
        const format = detectFormat(doc.mime, doc.filename, bytes);
        if (format !== "pdf") throw new EdgeError(`render-pages renders PDF only (got ${format ?? doc.mime ?? "unknown format"})`);
        if (impl === "mupdf") {
            const { renderPagesMupdf } = await import("../formats/mupdf.js");
            const pages = await renderPagesMupdf(bytes, ctx, { filename: doc.filename, dpi: RENDER_DPI, maxSide: RENDER_MAX_SIDE });
            return { success: true, pages };
        }
        if (typeof OffscreenCanvas === "undefined") {
            throw new EdgeError("render-pages needs OffscreenCanvas (a browser); it is not available here");
        }
        const { openPdf } = await import("../formats/pdfjs.js");
        const pdf = await openPdf(bytes, ctx);
        const stem = fileStem(doc.filename);
        const pages: Asset[] = [];
        try {
            const n = pdf.numPages;
            for (let i = 1; i <= n; i++) {
                throwIfAborted(ctx.signal);
                const page = await pdf.getPage(i);
                const base = page.getViewport({ scale: 1 });
                let scale = RENDER_DPI / 72;
                const longest = Math.max(base.width, base.height) * scale;
                if (longest > RENDER_MAX_SIDE) scale *= RENDER_MAX_SIDE / longest;
                const viewport = page.getViewport({ scale });
                const width = Math.max(1, Math.floor(viewport.width));
                const height = Math.max(1, Math.floor(viewport.height));
                const canvas = new OffscreenCanvas(width, height);
                const c2d = canvas.getContext("2d", { alpha: false });
                if (!c2d) throw new EdgeError("could not get a 2D context for OffscreenCanvas");
                const task = page.render({
                    canvas: canvas as unknown as HTMLCanvasElement,
                    canvasContext: c2d as unknown as CanvasRenderingContext2D,
                    viewport,
                    background: "#ffffff",
                });
                const cancel = () => task.cancel();
                ctx.signal.addEventListener("abort", cancel, { once: true });
                try {
                    await task.promise;
                } finally {
                    ctx.signal.removeEventListener("abort", cancel);
                }
                const blob = await canvas.convertToBlob({ type: "image/png" });
                const png = new Uint8Array(await blob.arrayBuffer());
                pages.push({
                    bytesBase64: encodeBase64(png),
                    mime: "image/png",
                    filename: `${stem}-p${String(i).padStart(String(n).length, "0")}.png`,
                });
                canvas.width = canvas.height = 0;
                page.cleanup();
                ctx.onProgress({ fraction: i / n, message: `page ${i}/${n}` });
            }
        } finally {
            await pdf.loadingTask.destroy();
        }
        return { success: true, pages };
    });
