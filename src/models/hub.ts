/**
 * Model weights: where they come from and how they are kept.
 *
 * - **Base URL.** Files are fetched from `<modelBase>/<org>/<repo>/<path>`, the
 *   ModelScope repo layout, so the hosting side can mirror repos 1:1. The base
 *   is `ctx.modelBase` (resolved by `src/util/model-base.ts`); nothing here
 *   knows HuggingFace, ModelScope or GitHub URLs.
 * - **Cache.** Verified files are stored in the Cache API (`tongflow-edge-models-v1`)
 *   keyed by URL, so a model downloads once per origin.
 * - **Integrity.** Size and SHA-256 from the registry are checked before a
 *   download is cached; a mismatch fails the node instead of caching junk.
 * - **Progress.** Every download reports `{loaded, total, file}` through the
 *   context; a cache hit reports one complete event.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError } from "../util/errors.js";
import type { ModelFile, ModelSpec } from "./registry.js";

const CACHE_NAME = "tongflow-edge-models-v1";

function withSlash(u: string): string {
    return u.endsWith("/") ? u : `${u}/`;
}

export function modelFileUrl(modelBase: string, spec: ModelSpec, file: ModelFile): string {
    return new URL(`${spec.repo}/${file.path}`, withSlash(modelBase)).href;
}

async function openCache(): Promise<Cache | null> {
    try {
        if (typeof caches === "undefined") return null;
        return await caches.open(CACHE_NAME);
    } catch {
        return null; // opaque origins, private mode, Node
    }
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(res: Response, ctx: EdgeContext, label: string, model: string, expected: number): Promise<Uint8Array> {
    const header = Number(res.headers.get("content-length")) || undefined;
    const total = header ?? expected;
    ctx.onDownload({ loaded: 0, total, label, model });
    if (!res.body) {
        const buf = new Uint8Array(await res.arrayBuffer());
        ctx.onDownload({ loaded: buf.byteLength, total: buf.byteLength, label, model });
        return buf;
    }
    const reader = res.body.getReader();
    // Pre-size when the length is known: a 240 MB model is not copied twice.
    let out = new Uint8Array(total);
    let loaded = 0;
    let lastReport = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.byteLength > out.length) {
            const grown = new Uint8Array(Math.max(out.length * 2, loaded + value.byteLength));
            grown.set(out.subarray(0, loaded));
            out = grown;
        }
        out.set(value, loaded);
        loaded += value.byteLength;
        if (loaded - lastReport >= 1 << 20) {
            lastReport = loaded;
            ctx.onDownload({ loaded, total, label, model });
        }
    }
    ctx.onDownload({ loaded, total: loaded, label, model });
    return loaded === out.length ? out : out.slice(0, loaded);
}

const inflight = new Map<string, Promise<Uint8Array>>();

/** The bytes of one model file: cache first, then the model base. */
export function fetchModelFile(ctx: EdgeContext, spec: ModelSpec, file: ModelFile): Promise<Uint8Array> {
    const url = modelFileUrl(ctx.modelBase, spec, file);
    const pending = inflight.get(url);
    if (pending) return pending;
    const p = loadModelFile(ctx, spec, file, url).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
}

async function loadModelFile(ctx: EdgeContext, spec: ModelSpec, file: ModelFile, url: string): Promise<Uint8Array> {
    const label = `${spec.repo}/${file.path}`;
    const cache = await openCache();
    if (cache) {
        try {
            const hit = await cache.match(url);
            if (hit) {
                const bytes = new Uint8Array(await hit.arrayBuffer());
                if (bytes.byteLength === file.size) {
                    ctx.onDownload({ loaded: bytes.byteLength, total: bytes.byteLength, label, model: spec.id });
                    return bytes;
                }
                await cache.delete(url);
            }
        } catch {
            // unreadable entry: download again
        }
    }
    let res: Response;
    try {
        res = await fetch(url, { signal: ctx.signal });
    } catch (e) {
        if (ctx.signal.aborted) throw e;
        throw new EdgeError(`could not download model ${label} from ${url} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) throw new EdgeError(`could not download model ${label} (${res.status} ${res.statusText}) from ${url}`);
    const bytes = await readBody(res, ctx, label, spec.id, file.size);
    if (bytes.byteLength !== file.size) {
        throw new EdgeError(`model file ${label} has ${bytes.byteLength} bytes, expected ${file.size}`);
    }
    const digest = await sha256Hex(bytes);
    if (digest && digest !== file.sha256) {
        throw new EdgeError(`model file ${label} failed its SHA-256 check (got ${digest.slice(0, 12)}…)`);
    }
    if (cache) {
        try {
            await cache.put(
                url,
                new Response(bytes as Uint8Array<ArrayBuffer>, {
                    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
                }),
            );
        } catch {
            // quota exceeded: keep working without the cache
        }
    }
    return bytes;
}
