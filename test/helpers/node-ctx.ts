import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EdgeContext } from "../../src/context.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Same table as scripts/copy-assets.mjs: plugin-relative asset dir → source in node_modules. */
const SOURCES: [string, string][] = [
    ["assets/pdfjs/", "node_modules/pdfjs-dist/"],
    ["assets/xberg/", "node_modules/@xberg-io/xberg-wasm/pkg/web/"],
    ["assets/ort/", "node_modules/onnxruntime-web/dist/"],
];

/** Real-model tests read weights from here (`<org>/<repo>/<path>`); unset = skipped. */
export const EDGE_MODELS_DIR = process.env.EDGE_MODELS_DIR;

export function nodeResolveAsset(rel: string): string {
    for (const [prefix, src] of SOURCES) if (rel.startsWith(prefix)) return root + src + rel.slice(prefix.length);
    throw new Error(`unknown asset ${rel}`);
}

let fetchPatched = false;
/** Node's fetch has no file: scheme; serve absolute paths from disk for the test ctx. */
function patchFetch() {
    if (fetchPatched) return;
    fetchPatched = true;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const s = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (s.startsWith("/") || s.startsWith("file:")) {
            const data = await readFile(s.startsWith("file:") ? fileURLToPath(s) : s);
            return new Response(data, { headers: { "content-length": String(data.byteLength) } });
        }
        return orig(url, init);
    }) as typeof fetch;
}

export interface Recorded {
    progress: { fraction?: number; message?: string }[];
    downloads: { loaded: number; total?: number; label: string }[];
}

export function nodeCtx(
    signal: AbortSignal = new AbortController().signal,
    extra: { model?: string; params?: Record<string, unknown> } = {},
): EdgeContext & { rec: Recorded } {
    patchFetch();
    const rec: Recorded = { progress: [], downloads: [] };
    return {
        signal,
        onProgress: (p) => rec.progress.push(p),
        onDownload: (p) => rec.downloads.push(p),
        resolveAsset: nodeResolveAsset,
        modelBase: EDGE_MODELS_DIR ? `${pathToFileURL(EDGE_MODELS_DIR).href.replace(/\/$/, "")}/` : "file:///nonexistent-models/",
        params: extra.params ?? {},
        ...(extra.model ? { model: extra.model } : {}),
        rec,
    };
}

export async function fixture(name: string, mime?: string) {
    const data = await readFile(root + "test/fixtures/" + name);
    return { bytesBase64: data.toString("base64"), filename: name, ...(mime ? { mime } : {}) };
}
