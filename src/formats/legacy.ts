import type { EdgeContext } from "../context.js";
import { fetchAssetBytes } from "../util/assets.js";
import { EdgeError } from "../util/errors.js";
import { extensionOf } from "./detect.js";

/** Plugin-relative path of the xberg wasm (≈41 MB, ≈17 MB gzip), copied by the build. */
export const XBERG_WASM = "assets/xberg/xberg_wasm_bg.wasm";

type Xberg = typeof import("@xberg-io/xberg-wasm");
let xbergPromise: Promise<Xberg> | undefined;

async function loadXberg(ctx: EdgeContext): Promise<Xberg> {
    xbergPromise ??= (async () => {
        const mod = await import("@xberg-io/xberg-wasm");
        const wasm = await fetchAssetBytes(ctx, XBERG_WASM, "xberg-wasm");
        await mod.default({ module_or_path: wasm });
        return mod;
    })();
    xbergPromise.catch(() => {
        xbergPromise = undefined;
    });
    return xbergPromise;
}

const MIME_BY_EXT: Record<string, string> = {
    doc: "application/msword",
    dot: "application/msword",
    wps: "application/vnd.ms-works",
    ppt: "application/vnd.ms-powerpoint",
    pps: "application/vnd.ms-powerpoint",
    pot: "application/vnd.ms-powerpoint",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    ott: "application/vnd.oasis.opendocument.text-template",
    odp: "application/vnd.oasis.opendocument.presentation",
    otp: "application/vnd.oasis.opendocument.presentation-template",
    pages: "application/vnd.apple.pages",
    key: "application/vnd.apple.keynote",
    numbers: "application/vnd.apple.numbers",
    hwp: "application/x-hwp",
    hwpx: "application/hwp+zip",
    pst: "application/vnd.ms-outlook-pst",
    fb2: "application/x-fictionbook+xml",
    rst: "text/x-rst",
    org: "text/x-org",
    adoc: "text/asciidoc",
    asciidoc: "text/asciidoc",
    tex: "application/x-latex",
    latex: "application/x-latex",
    typ: "text/x-typst",
    ipynb: "application/x-ipynb+json",
    bib: "application/x-bibtex",
    ris: "application/x-research-info-systems",
    opml: "text/x-opml",
    dbf: "application/x-dbf",
};

/**
 * Long-tail and legacy binary formats (.doc/.ppt/.rtf/.odt/…) via xberg-wasm, loaded
 * on first use. OCR is off: image-only content is left for the host to route to OCR.
 */
export async function parseLegacy(
    bytes: Uint8Array,
    mime: string | undefined,
    filename: string | undefined,
    ctx: EdgeContext,
): Promise<string> {
    ctx.onProgress({ message: "loading legacy-format parser" });
    const xb = await loadXberg(ctx);
    ctx.onProgress({ message: "extracting text" });
    const ext = extensionOf(filename);
    const type = MIME_BY_EXT[ext] ?? (mime && mime !== "application/octet-stream" ? mime : "application/octet-stream");
    const config = xb.WasmExtractionConfig.default();
    config.outputFormat = "markdown";
    config.disableOcr = true;
    const input = xb.WasmExtractInput.fromBytes(bytes, type, filename ?? (ext ? `document.${ext}` : null));
    const result = await xb.extract(input, config);
    try {
        const docs = result.results;
        const errs = result.errors;
        if (!docs.length) {
            const why = errs.map((e) => e.message ?? String(e)).join("; ");
            throw new EdgeError(`xberg could not read this ${ext || type} file${why ? `: ${why}` : ""}`);
        }
        return docs
            .map((d) => d.content ?? "")
            .join("\n\n")
            .trim();
    } finally {
        result.free();
    }
}
