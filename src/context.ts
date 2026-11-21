import type { EdgeMethodContext } from "tongflow/engine/worker";

/**
 * The plugin's internal context, built from the engine's {@link EdgeMethodContext}
 * by {@link toEdgeContext}. Slot implementations only see this, so the engine
 * protocol can change in one place.
 */
export interface EdgeContext {
    /** Aborted when the run is cancelled or the node is skipped. */
    signal: AbortSignal;
    /** Live status for the node: a 0..1 fraction and/or a short message. */
    onProgress(p: { fraction?: number; message?: string }): void;
    /** Byte progress while a lazily loaded asset (wasm, data) is downloaded. */
    onDownload(p: { loaded: number; total?: number; label: string }): void;
    /**
     * Map a plugin-relative asset path (for example `assets/xberg/xberg_wasm_bg.wasm`)
     * to a same-origin URL the worker can fetch. Directory paths end with `/`.
     */
    resolveAsset(relPath: string): string;
}

/**
 * Adapt the engine's ctx. The engine has no asset resolver: assets live next to the
 * entry module (`dist/assets/…` beside `dist/index.js`), so URLs are resolved against
 * the entry's `import.meta.url`, which is the same origin the host loaded the plugin from.
 */
export function toEdgeContext(ctx: EdgeMethodContext, assetBase: string | URL): EdgeContext {
    let lastMessage = "";
    return {
        signal: ctx.signal,
        onProgress({ fraction, message }) {
            if (message) lastMessage = message;
            const percent = fraction === undefined ? undefined : Math.max(0, Math.min(100, Math.round(fraction * 100)));
            ctx.progress(message ?? lastMessage, percent);
        },
        onDownload({ loaded, total, label }) {
            ctx.modelDownload({ loaded, ...(total !== undefined ? { total } : {}), file: label });
        },
        resolveAsset: (relPath) => new URL(relPath, assetBase).href,
    };
}
