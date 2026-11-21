import type { EdgeContext } from "../context.js";
import type * as PdfJs from "pdfjs-dist";

type PdfJsModule = typeof PdfJs;
export type PdfDocument = PdfJs.PDFDocumentProxy;

let pdfjsPromise: Promise<PdfJsModule> | undefined;

const isNode =
    typeof process !== "undefined" && typeof (process as { versions?: { node?: string } }).versions?.node === "string";
const hasDom = typeof document !== "undefined";

/**
 * Load pdf.js lazily. Inside the edge worker there is no DOM and we do not want a
 * nested worker, so the pdf.js worker module is loaded into this thread
 * (`globalThis.pdfjsWorker`), which pdf.js picks up as its in-thread "fake worker".
 */
export function loadPdfjs(): Promise<PdfJsModule> {
    pdfjsPromise ??= (async () => {
        const g = globalThis as { pdfjsWorker?: unknown };
        if (!g.pdfjsWorker) {
            g.pdfjsWorker = await import("pdfjs-dist/build/pdf.worker.mjs");
        }
        return import("pdfjs-dist");
    })();
    pdfjsPromise.catch(() => {
        pdfjsPromise = undefined;
    });
    return pdfjsPromise;
}

/** Canvas factory for a DOM-less worker: every scratch canvas is an OffscreenCanvas. */
class OffscreenCanvasFactory {
    constructor(_opts?: unknown) {}
    create(width: number, height: number) {
        if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
    }
    reset(cc: { canvas: OffscreenCanvas | null }, width: number, height: number) {
        if (!cc.canvas) throw new Error("Canvas is not specified");
        if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
        cc.canvas.width = width;
        cc.canvas.height = height;
    }
    destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
        if (!cc.canvas) throw new Error("Canvas is not specified");
        cc.canvas.width = cc.canvas.height = 0;
        cc.canvas = null;
        cc.context = null;
    }
    getNoAlphaContext(canvas: OffscreenCanvas) {
        return canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    }
}

/** SVG filters (transfer maps, high-contrast mode) need a DOM; in a worker they are skipped. */
class NoopFilterFactory {
    constructor(_opts?: unknown) {}
    addFilter() {
        return "none";
    }
    addHCMFilter() {
        return "none";
    }
    addAlphaFilter() {
        return "none";
    }
    addLuminosityFilter() {
        return "none";
    }
    addHighlightHCMFilter() {
        return "none";
    }
    destroy() {}
}

/** In Node (tests, in-process hosts) pdf.js reads binary data with fs: give it a path. */
function forPdfjs(url: string): string {
    if (isNode && url.startsWith("file:")) return decodeURIComponent(new URL(url).pathname);
    return url;
}

export async function openPdf(bytes: Uint8Array, ctx: EdgeContext): Promise<PdfDocument> {
    const pdfjs = await loadPdfjs();
    const workerEnv = !isNode && !hasDom;
    const fonts = (globalThis as { fonts?: unknown }).fonts;
    const params: Record<string, unknown> = {
        // pdf.js may transfer the buffer it is given; keep the caller's bytes intact.
        data: bytes.slice(),
        cMapUrl: forPdfjs(ctx.resolveAsset("assets/pdfjs/cmaps/")),
        cMapPacked: true,
        standardFontDataUrl: forPdfjs(ctx.resolveAsset("assets/pdfjs/standard_fonts/")),
        wasmUrl: forPdfjs(ctx.resolveAsset("assets/pdfjs/wasm/")),
        iccUrl: forPdfjs(ctx.resolveAsset("assets/pdfjs/iccs/")),
        useWorkerFetch: false,
        isEvalSupported: false,
        enableXfa: false,
        verbosity: 0,
    };
    if (workerEnv) {
        params.CanvasFactory = OffscreenCanvasFactory;
        params.FilterFactory = NoopFilterFactory;
        if (fonts) {
            // Workers have a FontFaceSet (`self.fonts`): embedded fonts load as FontFace.
            params.ownerDocument = { fonts };
        } else {
            params.disableFontFace = true;
            params.useSystemFonts = false;
        }
    }
    const task = pdfjs.getDocument(params as unknown as Parameters<PdfJsModule["getDocument"]>[0]);
    const onAbort = () => void task.destroy();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await task.promise;
    } finally {
        ctx.signal.removeEventListener("abort", onAbort);
    }
}
