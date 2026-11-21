/**
 * MuPDF.js (`mupdf`, AGPL-3.0-or-later, Artifex) for PDF: the `mupdf` implementation
 * of `parse-document` (PDF only) and `render-pages`. Lazy chunk: loaded only when a
 * node picks model `mupdf`.
 *
 * The wasm (about 10 MB, 3.6 MB brotli) ships in `dist/assets/mupdf/` and is fetched
 * from the plugin's own origin with download progress, then handed to the module as
 * `wasmBinary` (MuPDF reads its Emscripten options from
 * `globalThis.$libmupdf_wasm_Module` when its module first evaluates). Nothing is
 * fetched from a CDN. It runs in a DOM-less worker and in Node: rendering draws with
 * MuPDF's own rasterizer, so no canvas is needed.
 */
import type { EdgeContext } from "../context.js";
import type { Asset } from "../types.js";
import { fetchAssetBytes } from "../util/assets.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { normalizeRadicals } from "./pdf.js";
import { type StextPage, stextToMarkdown } from "./stext-markdown.js";

type MuPdf = typeof import("mupdf");

export const MUPDF_WASM = "assets/mupdf/mupdf-wasm.wasm";

let mupdfPromise: Promise<MuPdf> | undefined;

/** Load MuPDF once per worker: fetch the wasm from the plugin's assets, then evaluate the module. */
export function loadMupdf(ctx: Pick<EdgeContext, "resolveAsset" | "signal" | "onDownload">): Promise<MuPdf> {
    mupdfPromise ??= (async () => {
        const wasmBinary = await fetchAssetBytes(ctx as EdgeContext, MUPDF_WASM, "MuPDF wasm");
        const g = globalThis as { $libmupdf_wasm_Module?: Record<string, unknown> };
        g.$libmupdf_wasm_Module = { ...g.$libmupdf_wasm_Module, wasmBinary };
        try {
            return (await import("mupdf")) as MuPdf;
        } finally {
            delete g.$libmupdf_wasm_Module;
        }
    })();
    mupdfPromise.catch(() => {
        mupdfPromise = undefined;
    });
    return mupdfPromise;
}

type MuDocument = InstanceType<MuPdf["Document"]>;
type MuPixmap = InstanceType<MuPdf["Pixmap"]>;

/** RGBA (straight alpha) of a gray / gray+alpha / RGB / RGBA pixmap's samples (MuPDF premultiplies alpha). */
export function pixmapRgba(px: ArrayLike<number>, width: number, height: number, stride: number, n: number, alpha: boolean): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    const colors = alpha ? n - 1 : n;
    for (let y = 0; y < height; y++) {
        let i = y * stride;
        let o = y * width * 4;
        for (let x = 0; x < width; x++, i += n, o += 4) {
            const a = alpha ? px[i + n - 1]! : 255;
            const k = a && a < 255 ? 255 / a : 1;
            if (colors >= 3) {
                out[o] = px[i]! * k;
                out[o + 1] = px[i + 1]! * k;
                out[o + 2] = px[i + 2]! * k;
            } else {
                out[o] = out[o + 1] = out[o + 2] = px[i]! * k;
            }
            out[o + 3] = a;
        }
    }
    return out;
}

/**
 * PNG of a pixmap. In a browser the samples go through an OffscreenCanvas and the browser's
 * own PNG encoder: for page-size images that is several times faster than MuPDF's encoder in
 * single-threaded wasm (a 1653×2339 scan: 2 s → a few hundred ms). Elsewhere (Node) MuPDF's.
 */
async function toPng(pix: MuPixmap): Promise<Uint8Array> {
    if (typeof OffscreenCanvas === "undefined" || typeof ImageData === "undefined") return pix.asPNG();
    const width = pix.getWidth();
    const height = pix.getHeight();
    const rgba = pixmapRgba(pix.getPixels(), width, height, pix.getStride(), pix.getNumberOfComponents(), !!pix.getAlpha());
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext("2d");
    if (!g) return pix.asPNG();
    g.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    canvas.width = canvas.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
}

async function open(bytes: Uint8Array, ctx: EdgeContext): Promise<{ mupdf: MuPdf; doc: MuDocument }> {
    const mupdf = await loadMupdf(ctx);
    let doc: MuDocument;
    try {
        doc = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (e) {
        throw new EdgeError(`MuPDF could not open the PDF: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (doc.needsPassword()) {
        doc.destroy();
        throw new EdgeError("the PDF is password-protected");
    }
    return { mupdf, doc };
}

/** Images smaller than this (either side, in pixels) are decoration, not figures. */
const MIN_IMAGE_SIDE = 48;
const MAX_IMAGES = 64;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export interface MupdfParseResult {
    text: string;
    images: Asset[];
}

/**
 * Text of every page in MuPDF's reading order as Markdown (headings, paragraphs,
 * simple tables; see `stext-markdown.ts`), and the embedded images as PNG
 * (`images: false` skips them). A scanned PDF yields its page scans as images.
 */
export async function parsePdfMupdf(bytes: Uint8Array, ctx: EdgeContext, opts: { filename?: string; images?: boolean } = {}): Promise<MupdfParseResult> {
    const { mupdf, doc } = await open(bytes, ctx);
    const stem = fileStem(opts.filename);
    const wantImages = opts.images !== false;
    const pages: StextPage[] = [];
    const names = new Map<number, string>();
    const images: Asset[] = [];
    let imageIndex = 0;
    let imageBytes = 0;
    try {
        const n = doc.countPages();
        for (let i = 0; i < n; i++) {
            throwIfAborted(ctx.signal);
            const page = doc.loadPage(i);
            const st = page.toStructuredText(wantImages ? "preserve-whitespace,preserve-images,dehyphenate" : "preserve-whitespace,dehyphenate");
            try {
                pages.push(JSON.parse(st.asJSON()) as StextPage);
                if (wantImages) {
                    // The walker is synchronous: take the pixmaps now, encode them after.
                    const found: { index: number; pix: MuPixmap }[] = [];
                    st.walk({
                        onImageBlock(_bbox, _transform, image) {
                            const index = imageIndex++;
                            if (images.length + found.length >= MAX_IMAGES) return;
                            if (image.getWidth() < MIN_IMAGE_SIDE || image.getHeight() < MIN_IMAGE_SIDE) return;
                            try {
                                let pix = image.toPixmap();
                                const cs = pix.getColorSpace();
                                if (cs && !cs.isRGB() && !cs.isGray()) {
                                    const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
                                    pix.destroy();
                                    pix = rgb;
                                }
                                found.push({ index, pix });
                            } catch {
                                // an image MuPDF cannot decode is left out; the text is what matters
                            }
                        },
                    });
                    for (const { index, pix } of found) {
                        try {
                            if (imageBytes >= MAX_IMAGE_BYTES) continue;
                            const png = await toPng(pix);
                            imageBytes += png.byteLength;
                            const filename = `${stem}-p${i + 1}-img${images.length + 1}.png`;
                            names.set(index, filename);
                            images.push({ bytesBase64: encodeBase64(png), mime: "image/png", filename });
                        } catch {
                            // left out, as above
                        } finally {
                            pix.destroy();
                        }
                    }
                }
            } finally {
                st.destroy();
                page.destroy();
            }
            ctx.onProgress({ fraction: (i + 1) / n, message: `page ${i + 1}/${n}` });
        }
    } finally {
        doc.destroy();
    }
    const text = normalizeRadicals(stextToMarkdown(pages, { imageName: (i) => names.get(i) }));
    return { text, images };
}

/** Render every page as PNG at `dpi`, the longest side capped at `maxSide` (the pdf.js path's rules). */
export async function renderPagesMupdf(bytes: Uint8Array, ctx: EdgeContext, opts: { filename?: string; dpi: number; maxSide: number }): Promise<Asset[]> {
    const { mupdf, doc } = await open(bytes, ctx);
    const stem = fileStem(opts.filename);
    const out: Asset[] = [];
    try {
        const n = doc.countPages();
        for (let i = 0; i < n; i++) {
            throwIfAborted(ctx.signal);
            const page = doc.loadPage(i);
            try {
                const [x0, y0, x1, y1] = page.getBounds();
                let scale = opts.dpi / 72;
                const longest = Math.max(x1 - x0, y1 - y0) * scale;
                if (longest > opts.maxSide) scale *= opts.maxSide / longest;
                const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
                try {
                    out.push({
                        bytesBase64: encodeBase64(await toPng(pix)),
                        mime: "image/png",
                        filename: `${stem}-p${String(i + 1).padStart(String(n).length, "0")}.png`,
                    });
                } finally {
                    pix.destroy();
                }
            } finally {
                page.destroy();
            }
            ctx.onProgress({ fraction: (i + 1) / n, message: `page ${i + 1}/${n}` });
        }
    } finally {
        doc.destroy();
    }
    return out;
}
