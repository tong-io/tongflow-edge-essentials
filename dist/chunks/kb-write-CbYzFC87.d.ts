import { Asset, NodeSlot, SlotInput, SlotOutput } from "tongflow";
import { EdgeMethodContext, EdgeSlotOutput } from "tongflow/engine/worker";
/**
 * The plugin's internal context, built from the engine's {@link EdgeMethodContext}
 * by {@link toEdgeContext}. Slot implementations only see this, so the engine
 * protocol can change in one place.
 */
interface EdgeContext {
  /** Aborted when the run is cancelled or the node is skipped. */
  signal: AbortSignal;
  /** Live status for the node: a 0..1 fraction and/or a short message. */
  onProgress(p: {
    fraction?: number;
    message?: string;
  }): void;
  /** Byte progress while a lazily loaded asset (wasm, data, model weights) is downloaded. */
  onDownload(p: {
    loaded: number;
    total?: number;
    label: string;
    model?: string;
  }): void;
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
declare function toEdgeContext(ctx: EdgeMethodContext, assetBase: string | URL): EdgeContext;
/**
 * A slot implementation against the plugin's internal {@link EdgeContext}.
 * `EdgeSlotOutput<S>` is `SlotOutput<S>` with ref fields allowed to carry an inline
 * `Asset` (`bytesBase64`), which the engine stores and turns into a file ref.
 */
type SlotImpl<S extends NodeSlot> = (input: SlotInput<S>, ctx: EdgeContext) => Promise<EdgeSlotOutput<S>>;
/** The JSON in kb-write's `text` output. The host checks it against what it commits. */
interface KbWriteSummary {
  source: string;
  chunkCount: number;
  dims: number;
  /** Hex SHA-256 of the TFV1 bytes kb-write validated. */
  vectorsSha256: string;
}
export { SlotImpl as a, EdgeContext as c, NodeSlot as i, toEdgeContext as l, Asset as n, SlotInput as o, EdgeSlotOutput as r, SlotOutput as s, KbWriteSummary as t };