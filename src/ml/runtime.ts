/**
 * The model registry of the T3 nodes, on the shared transformers.js runtime
 * (`ml/transformers.ts`: weights only from the model base, the ORT wasm from
 * the plugin's own `dist/assets/ort/`). It shares one loaded model between
 * nodes, reports downloads, cancels a download nobody waits for any more, and
 * frees GPU memory. transformers.js caches every fetched file in the Cache API
 * under {@link CACHE_KEY} (its default), so a model downloads once per browser
 * profile.
 */

import type { EdgeContext } from "../context.js";
import { EdgeError, errorMessage } from "../util/errors.js";
import { type ModelVariant, type T3Model, onnxFiles, withExternalData } from "./catalog.js";
import { DownloadProgress, type TransformersProgress } from "./progress.js";
import { ORT_ASSET_DIR, loadTransformers } from "./transformers.js";
import { checkQuota, describeQuota, storageEstimate } from "./webgpu.js";

export type Transformers = typeof import("@huggingface/transformers");
export type ModelConfig = Awaited<ReturnType<Transformers["AutoConfig"]["from_pretrained"]>>;

/** The Cache API bucket transformers.js stores model files in (its default). */
export const CACHE_KEY = "transformers-cache";

/** Loaded models kept on the GPU at once; older idle ones are disposed. */
export const MAX_RESIDENT = 2;

interface Loading {
    prefix: string;
    controller: AbortController;
    waiters: number;
    listeners: Set<(p: TransformersProgress) => void>;
    promise: Promise<Resident>;
}

interface Resident {
    key: string;
    value: unknown;
    dispose: () => unknown;
    users: number;
    lastUsed: number;
}

const loading = new Map<string, Loading>();
const resident = new Map<string, Resident>();

/** env.fetch: a model's files are fetched with that load's abort signal. */
function modelFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const l of loading.values()) {
        if (url.startsWith(l.prefix)) return fetch(input, { ...init, signal: l.controller.signal });
    }
    return fetch(input, init);
}

/** `<base><org>/<repo>/` for a repo id such as `onnx-community/GLM-OCR-ONNX`. */
export function repoUrl(base: string, repo: string): string {
    return `${base}${repo.replace(/^\/+|\/+$/g, "")}/`;
}

let fetchHooked = false;

/**
 * The shared transformers.js runtime (`ml/transformers.ts`: model base, the
 * plugin's own ORT wasm, Cache API), plus a fetch hook so a model's files are
 * fetched with that load's abort signal. Other fetches pass through untouched.
 */
export async function loadRuntime(ctx: EdgeContext): Promise<Transformers> {
    let tf: Transformers;
    try {
        tf = await loadTransformers({
            modelBase: ctx.modelBase,
            ortBase: ctx.resolveAsset(ORT_ASSET_DIR),
            signal: ctx.signal,
            onDownload: ctx.onDownload,
        });
    } catch (e) {
        if (ctx.signal.aborted || e instanceof EdgeError) throw e;
        throw new EdgeError(`could not load the ML runtime (transformers.js): ${errorMessage(e)}`);
    }
    if (!fetchHooked) {
        fetchHooked = true;
        tf.env.fetch = modelFetch;
    }
    return tf;
}

/** True when every ONNX file of the variant is already in the Cache API. */
export async function isCached(base: string, model: T3Model, variant: ModelVariant): Promise<boolean> {
    if (typeof caches === "undefined") return false;
    try {
        const cache = await caches.open(CACHE_KEY);
        const dir = repoUrl(base, model.repo);
        for (const f of onnxFiles(variant)) if (!(await cache.match(dir + f))) return false;
        return true;
    } catch {
        return false;
    }
}

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Reject as soon as `signal` aborts, without cancelling `p` itself. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(
            (v) => {
                signal.removeEventListener("abort", onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener("abort", onAbort);
                reject(e);
            },
        );
    });
}

/** Dispose idle models (least recently used first) until `room` more fit. */
async function evictIdle(room: number): Promise<void> {
    const idle = [...resident.values()].filter((r) => r.users === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    while (resident.size + room > MAX_RESIDENT && idle.length) {
        const r = idle.shift()!;
        resident.delete(r.key);
        try {
            await r.dispose();
        } catch {
            /* a failed dispose only leaks GPU memory until the worker ends */
        }
    }
}

export interface LoadSpec<T> {
    model: T3Model;
    variant: ModelVariant;
    /** Loads the model; `progress_callback` must be passed to every `from_pretrained`. */
    load: (tf: Transformers, progress_callback: (p: TransformersProgress) => void) => Promise<{ value: T; dispose: () => unknown }>;
}

/**
 * Run `use` with the loaded model, loading it first if needed. Several nodes
 * share one load; a caller that aborts stops waiting at once, and the download
 * itself is cancelled when no caller waits for it any more.
 */
export async function withModel<T, R>(ctx: EdgeContext, spec: LoadSpec<T>, use: (value: T, tf: Transformers) => Promise<R>): Promise<R> {
    const tf = await loadRuntime(ctx);
    const key = `${spec.model.repo}#${JSON.stringify(spec.variant.dtype)}`;
    let r = resident.get(key);
    if (!r) r = await acquire(tf, ctx, key, spec);
    r.users++;
    r.lastUsed = Date.now();
    try {
        return await use(r.value as T, tf);
    } finally {
        r.users--;
        r.lastUsed = Date.now();
    }
}

async function acquire<T>(tf: Transformers, ctx: EdgeContext, key: string, spec: LoadSpec<T>): Promise<Resident> {
    const { model, variant } = spec;
    let l = loading.get(key);
    if (!l) {
        // Registered synchronously, so concurrent callers share this one load.
        const base = ctx.modelBase;
        const controller = new AbortController();
        const listeners = new Set<(p: TransformersProgress) => void>();
        const entry: Loading = {
            prefix: repoUrl(base, model.repo),
            controller,
            waiters: 0,
            listeners,
            promise: (async () => {
                if (await isCached(base, model, variant)) {
                    ctx.onProgress({ message: `loading ${model.name} from the browser cache` });
                } else {
                    const quota = await storageEstimate();
                    checkQuota(variant.approxMB, quota, model.name);
                    const q = describeQuota(quota);
                    ctx.onProgress({ message: `downloading ${model.name} (~${variant.approxMB} MB, first run only${q ? `; ${q}` : ""})` });
                }
                if (controller.signal.aborted) throw abortError(controller.signal);
                await evictIdle(1);
                const { value, dispose } = await spec.load(tf, (p) => listeners.forEach((fn) => fn(p)));
                const res: Resident = { key, value, dispose, users: 0, lastUsed: Date.now() };
                resident.set(key, res);
                return res;
            })(),
        };
        entry.promise.then(
            () => loading.delete(key),
            () => loading.delete(key),
        );
        loading.set(key, entry);
        l = entry;
    }
    const dl = new DownloadProgress(ctx.onDownload, model.name);
    const listener = (p: TransformersProgress) => dl.handle(p);
    l.listeners.add(listener);
    l.waiters++;
    try {
        return await raceAbort(l.promise, ctx.signal);
    } catch (e) {
        if (ctx.signal.aborted || e instanceof EdgeError) throw e;
        throw new EdgeError(`could not load ${model.name} from ${l.prefix}: ${errorMessage(e)}`);
    } finally {
        l.listeners.delete(listener);
        l.waiters--;
        if (ctx.signal.aborted && l.waiters === 0 && loading.get(key) === l) {
            loading.delete(key);
            l.controller.abort(abortError(ctx.signal));
            l.promise.catch(() => {});
        }
    }
}

/**
 * The model's config with the variant's external-data files declared
 * (`withExternalData`); pass it as `config` to the model's `from_pretrained`.
 */
export async function modelConfig(
    tf: Transformers,
    model: T3Model,
    variant: ModelVariant,
    progress_callback: (p: TransformersProgress) => void,
): Promise<ModelConfig> {
    return withExternalData(await tf.AutoConfig.from_pretrained(model.repo, { progress_callback }), variant);
}

/** Free every loaded model (hosts can call this on memory pressure; tests use it). */
export async function disposeAll(): Promise<void> {
    const all = [...resident.values()];
    resident.clear();
    await Promise.all(all.map(async (r) => r.dispose()));
}
