/**
 * Where model weights are fetched from: the **model base URL**. Files live under
 * `<modelBase>/<org>/<repo>/<path>`, mirroring the ModelScope / Hugging Face repo
 * layout, so a host can mirror repos 1:1. Nothing here ever points at a third-party
 * host; the default is the same-origin `/models/`.
 *
 * Resolution order:
 *  1. `ctx.modelBase`, if the engine's method ctx ever carries one;
 *  2. `globalThis.__TONGFLOW_EDGE_CONFIG__.modelBase` (set by the host on the main
 *     thread for in-process use, or by the plugin entry from its `?modelBase=` query
 *     parameter inside the worker; see {@link applyEntryConfig});
 *  3. `/models/` on the origin the plugin was loaded from.
 */

export interface EdgeConfig {
    /** Absolute or same-origin-relative URL of the model base; a trailing `/` is added. */
    modelBase?: string;
}

declare global {
    // eslint-disable-next-line no-var
    var __TONGFLOW_EDGE_CONFIG__: EdgeConfig | undefined;
}

function withSlash(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Called by the entry module with its own `import.meta.url`: a host that cannot run
 * code in the worker before the plugin loads (the engine's worker executor creates
 * the worker) passes the config as query parameters of the entry URL, e.g.
 * `/plugins/tongflow-edge-essentials/dist/index.js?modelBase=https%3A%2F%2Fcdn.example.com%2Fmodels%2F`.
 * A config already set on `globalThis` wins.
 */
export function applyEntryConfig(entryUrl: string): void {
    let params: URLSearchParams;
    try {
        params = new URL(entryUrl).searchParams;
    } catch {
        return;
    }
    const modelBase = params.get("modelBase");
    if (!modelBase) return;
    const cfg = (globalThis.__TONGFLOW_EDGE_CONFIG__ ??= {});
    cfg.modelBase ??= new URL(modelBase, entryUrl).href;
}

/** The model base as an absolute URL ending in `/`. `fallbackFrom` is the plugin's own URL. */
export function resolveModelBase(ctxModelBase: string | undefined, fallbackFrom: string | URL): string {
    const fromCtx = typeof ctxModelBase === "string" && ctxModelBase.trim() ? ctxModelBase.trim() : undefined;
    const fromGlobal = globalThis.__TONGFLOW_EDGE_CONFIG__?.modelBase?.trim() || undefined;
    const base = fromCtx ?? fromGlobal ?? "/models/";
    return withSlash(new URL(base, fallbackFrom).href);
}
