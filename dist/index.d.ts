import { a as SlotImpl, c as EdgeContext, i as NodeSlot, l as toEdgeContext, n as Asset, o as SlotInput, r as EdgeSlotOutput, s as SlotOutput, t as KbWriteSummary } from "./chunks/kb-write-COu0Ml-F.js";
import { n as DEFAULT_EMBED_MODEL, r as EMBED_MODELS } from "./chunks/models-tOLu1qTX.js";
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
interface EdgeConfig {
  /** Absolute or same-origin-relative URL of the model base; a trailing `/` is added. */
  modelBase?: string;
}
declare global {
  var __TONGFLOW_EDGE_CONFIG__: EdgeConfig | undefined;
}
/** Method name (as in tongflow.plugin.json `slots[].method`) → engine method. */
export declare const methods: {
  parseDocument: import("tongflow/engine/worker").EdgeMethod<"parse-document">;
  renderPages: import("tongflow/engine/worker").EdgeMethod<"render-pages">;
  extractAudio: import("tongflow/engine/worker").EdgeMethod<"extract-audio">;
  getFirstFrame: import("tongflow/engine/worker").EdgeMethod<"get-first-frame">;
  detectLanguage: import("tongflow/engine/worker").EdgeMethod<"detect-language">;
  chunkText: import("tongflow/engine/worker").EdgeMethod<"chunk-text">;
  embedText: import("tongflow/engine/worker").EdgeMethod<"embed-text">;
  kbWrite: import("tongflow/engine/worker").EdgeMethod<"kb-write">;
};
/** Slot → method name, mirroring the manifest (kept in sync by a test). */
export declare const slots: {
  readonly "parse-document": "parseDocument";
  readonly "render-pages": "renderPages";
  readonly "extract-audio": "extractAudio";
  readonly "get-first-frame": "getFirstFrame";
  readonly "detect-language": "detectLanguage";
  readonly "chunk-text": "chunkText";
  readonly "embed-text": "embedText";
  readonly "kb-write": "kbWrite";
};
/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export declare const impls: {
  parseDocument: SlotImpl<"parse-document">;
  renderPages: SlotImpl<"render-pages">;
  extractAudio: SlotImpl<"extract-audio">;
  getFirstFrame: SlotImpl<"get-first-frame">;
  detectLanguage: SlotImpl<"detect-language">;
  chunkText: SlotImpl<"chunk-text">;
  embedText: SlotImpl<"embed-text">;
  kbWrite: SlotImpl<"kb-write">;
};
declare const _default: {
  methods: {
    parseDocument: import("tongflow/engine/worker").EdgeMethod<"parse-document">;
    renderPages: import("tongflow/engine/worker").EdgeMethod<"render-pages">;
    extractAudio: import("tongflow/engine/worker").EdgeMethod<"extract-audio">;
    getFirstFrame: import("tongflow/engine/worker").EdgeMethod<"get-first-frame">;
    detectLanguage: import("tongflow/engine/worker").EdgeMethod<"detect-language">;
    chunkText: import("tongflow/engine/worker").EdgeMethod<"chunk-text">;
    embedText: import("tongflow/engine/worker").EdgeMethod<"embed-text">;
    kbWrite: import("tongflow/engine/worker").EdgeMethod<"kb-write">;
  };
};
export { type Asset, DEFAULT_EMBED_MODEL, EMBED_MODELS, type EdgeConfig, type EdgeContext, type EdgeSlotOutput, type KbWriteSummary, type NodeSlot, type SlotImpl, type SlotInput, type SlotOutput, _default as default, toEdgeContext };