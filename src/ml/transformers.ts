/**
 * transformers.js + onnxruntime-web, configured for the edge contract:
 *  - model files come only from the model base (`<modelBase><org>/<repo>/<path>`),
 *    never from huggingface.co (`allowLocalModels = false`, `remoteHost`, `remotePathTemplate`);
 *  - the onnxruntime-web wasm comes from the plugin's own `dist/assets/ort/`, never from
 *    jsDelivr (transformers.js' default);
 *  - model files are cached by transformers.js in the Cache API (`transformers-cache`),
 *    the ort wasm by us in `tongflow-edge-assets`; every download is reported.
 *
 * The library is a lazy dynamic import: nothing here costs anything until an ML node runs.
 */
import { EdgeError } from "../util/errors.js";

type Transformers = typeof import("@huggingface/transformers");

/** The single onnxruntime-web build transformers.js imports (`onnxruntime-web/webgpu`) loads this wasm. */
export const ORT_WASM_FILE = "ort-wasm-simd-threaded.asyncify.wasm";
/** Plugin-relative directory the build copies the ort wasm into. */
export const ORT_ASSET_DIR = "assets/ort/";
const ASSET_CACHE = "tongflow-edge-assets";

export interface MlRuntime {
    /** Absolute model base URL ending in `/`. */
    modelBase: string;
    /** Absolute URL of the plugin's `assets/ort/` directory (ending in `/`). */
    ortBase: string;
    signal?: AbortSignal;
    onDownload?(p: { loaded: number; total?: number; label: string; model?: string }): void;
}

let tfPromise: Promise<Transformers> | undefined;
let wasmPromise: Promise<void> | undefined;
let configuredOrtBase: string | undefined;

async function openCache(): Promise<Cache | undefined> {
    try {
        return typeof caches === "undefined" ? undefined : await caches.open(ASSET_CACHE);
    } catch {
        return undefined; // opaque origins, private mode: just do not cache
    }
}

/** The `env.wasm` flags object of onnxruntime-web (shared by transformers.js and direct ort users). */
type OrtWasmEnv = { wasmBinary?: ArrayBufferLike | Uint8Array };

/**
 * Fetch the ort wasm once per worker (Cache API first), with progress, and hand it to
 * onnxruntime-web. Shared by transformers.js and the nodes that run onnxruntime-web
 * directly (the audio models), so the 29 MB binary is fetched and instantiated once.
 */
export function ensureOrtWasm(wasm: OrtWasmEnv, rt: MlRuntime): Promise<void> {
    wasmPromise ??= loadOrtWasm(wasm, rt);
    wasmPromise.catch(() => {
        wasmPromise = undefined;
    });
    return wasmPromise;
}

async function loadOrtWasm(wasm: OrtWasmEnv, rt: MlRuntime): Promise<void> {
    const url = rt.ortBase + ORT_WASM_FILE;
    const label = `onnxruntime-web/${ORT_WASM_FILE}`;
    const cache = await openCache();
    let res = await cache?.match(url);
    let bytes: ArrayBuffer;
    if (res) {
        bytes = await res.arrayBuffer();
    } else {
        res = await fetch(url, rt.signal ? { signal: rt.signal } : {});
        if (!res.ok) throw new EdgeError(`could not load ${label} (${res.status} ${res.statusText}) from ${url}`);
        const total = Number(res.headers.get("content-length")) || undefined;
        const parts: Uint8Array[] = [];
        let loaded = 0;
        let last = 0;
        rt.onDownload?.({ loaded: 0, total, label });
        const reader = res.body!.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            loaded += value.byteLength;
            if (loaded - last >= 512 * 1024) {
                last = loaded;
                rt.onDownload?.({ loaded, total, label });
            }
        }
        rt.onDownload?.({ loaded, total: total ?? loaded, label });
        const buf = new Uint8Array(loaded);
        let off = 0;
        for (const p of parts) {
            buf.set(p, off);
            off += p.byteLength;
        }
        bytes = buf.buffer;
        try {
            await cache?.put(url, new Response(buf, { headers: { "content-type": "application/wasm" } }));
        } catch {
            // quota: run without caching
        }
    }
    wasm.wasmBinary = bytes;
}

/**
 * The configured transformers.js module. Safe to call concurrently and repeatedly;
 * a later call with another model base switches where new models are fetched from.
 */
export async function loadTransformers(rt: MlRuntime): Promise<Transformers> {
    tfPromise ??= import("@huggingface/transformers");
    let tf: Transformers;
    try {
        tf = await tfPromise;
    } catch (e) {
        tfPromise = undefined;
        throw e;
    }
    const env = tf.env;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = rt.modelBase;
    env.remotePathTemplate = "{model}/";
    const wasm = env.backends.onnx.wasm!;
    if (configuredOrtBase !== rt.ortBase) {
        // A prefix (not {mjs, wasm}): transformers.js then leaves the wasm to us and to ort,
        // and ort never falls back to its CDN default.
        wasm.wasmPaths = rt.ortBase;
        configuredOrtBase = rt.ortBase;
    }
    // Without cross-origin isolation there is no SharedArrayBuffer: ort runs single-threaded.
    if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) wasm.numThreads = 1;
    await ensureOrtWasm(wasm, rt);
    return tf;
}

/** transformers.js `progress_callback` → our download reports (one label per file). */
export function downloadReporter(rt: MlRuntime, model: string, repo: string) {
    return (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status !== "progress" || !info.file) return;
        const loaded = info.loaded ?? 0;
        rt.onDownload?.({
            loaded,
            ...(info.total ? { total: info.total } : {}),
            label: `${repo}/${info.file}`,
            model,
        });
    };
}
