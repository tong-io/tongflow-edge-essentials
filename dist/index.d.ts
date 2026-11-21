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
  /** Byte progress while a lazily loaded asset (wasm, data) is downloaded. */
  onDownload(p: {
    loaded: number;
    total?: number;
    label: string;
  }): void;
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
export declare function toEdgeContext(ctx: EdgeMethodContext, assetBase: string | URL): EdgeContext;
/**
 * A slot implementation against the plugin's internal {@link EdgeContext}.
 * `EdgeSlotOutput<S>` is `SlotOutput<S>` with ref fields allowed to carry an inline
 * `Asset` (`bytesBase64`), which the engine stores and turns into a file ref.
 */
type SlotImpl<S extends NodeSlot> = (input: SlotInput<S>, ctx: EdgeContext) => Promise<EdgeSlotOutput<S>>;
/** Method name (as in tongflow.plugin.json `slots[].method`) → engine method. */
export declare const methods: {
  parseDocument: import("tongflow/engine/worker").EdgeMethod<"parse-document">;
  renderPages: import("tongflow/engine/worker").EdgeMethod<"render-pages">;
  extractAudio: import("tongflow/engine/worker").EdgeMethod<"extract-audio">;
  getFirstFrame: import("tongflow/engine/worker").EdgeMethod<"get-first-frame">;
  detectLanguage: import("tongflow/engine/worker").EdgeMethod<"detect-language">;
};
/** Slot → method name, mirroring the manifest (kept in sync by a test). */
export declare const slots: {
  readonly "parse-document": "parseDocument";
  readonly "render-pages": "renderPages";
  readonly "extract-audio": "extractAudio";
  readonly "get-first-frame": "getFirstFrame";
  readonly "detect-language": "detectLanguage";
};
/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export declare const impls: {
  parseDocument: SlotImpl<"parse-document">;
  renderPages: SlotImpl<"render-pages">;
  extractAudio: SlotImpl<"extract-audio">;
  getFirstFrame: SlotImpl<"get-first-frame">;
  detectLanguage: SlotImpl<"detect-language">;
};
declare const _default: {
  methods: {
    parseDocument: import("tongflow/engine/worker").EdgeMethod<"parse-document">;
    renderPages: import("tongflow/engine/worker").EdgeMethod<"render-pages">;
    extractAudio: import("tongflow/engine/worker").EdgeMethod<"extract-audio">;
    getFirstFrame: import("tongflow/engine/worker").EdgeMethod<"get-first-frame">;
    detectLanguage: import("tongflow/engine/worker").EdgeMethod<"detect-language">;
  };
};
export { type Asset, type EdgeContext, type EdgeSlotOutput, type NodeSlot, type SlotImpl, type SlotInput, type SlotOutput, _default as default };