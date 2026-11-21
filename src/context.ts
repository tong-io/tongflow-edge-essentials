import type { EdgeMethodContext } from "tongflow/engine/worker";
import { resolveModelBase } from "./util/model-base.js";

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
    /** Byte progress while a lazily loaded asset (wasm, data, model weights) is downloaded. */
    onDownload(p: { loaded: number; total?: number; label: string; model?: string }): void;
    /** The node's chosen model (manifest `models`), when the host set one; absent = the slot's default. */
    model?: string;
    /**
     * Absolute URL (ending in `/`) that model files are fetched from:
     * `<modelBase><org>/<repo>/<path>`. See `util/model-base.ts`.
     */
    modelBase: string;
    /**
     * Map a plugin-relative asset path (for example `assets/xberg/xberg_wasm_bg.wasm`)
     * to a same-origin URL the worker can fetch. Directory paths end with `/`.
     */
    resolveAsset(relPath: string): string;
    /** The slot this call runs for (one method may serve several slots). */
    nodeSlot?: string;
    /** Advanced params from the node (`_params`); `{}` when none. */
    params?: Record<string, unknown>;
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
        onDownload({ loaded, total, label, model }) {
            ctx.modelDownload({ loaded, ...(total !== undefined ? { total } : {}), file: label, ...(model ? { model } : {}) });
        },
        ...(ctx.model ? { model: ctx.model } : {}),
        modelBase: resolveModelBase((ctx as { modelBase?: string }).modelBase, assetBase),
        resolveAsset: (relPath) => new URL(relPath, assetBase).href,
        nodeSlot: ctx.nodeSlot,
        params: ctx.params ?? {},
    };
}
