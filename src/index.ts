/**
 * tongflow-edge-essentials: browser edge nodes (T0 zero-model nodes, knowledge-base nodes).
 *
 * The default export is `defineEdgePlugin({ methods })`: loaded in a dedicated Web
 * Worker it answers the engine's worker protocol; imported anywhere else (the
 * in-process executor, tests) it is just the definition. Method names match the
 * `method` values in tongflow.plugin.json. Each slot's heavy library is a lazy
 * dynamic import, so loading this entry costs only the dispatch code.
 */
import { defineEdgePlugin, edgeMethod, type EdgeMethodContext } from "tongflow/engine/worker";
import { toEdgeContext } from "./context.js";
import { chunkText } from "./slots/chunk-text.js";
import { detectLanguage } from "./slots/detect-language.js";
import { embedText } from "./slots/embed-text.js";
import { kbWrite } from "./slots/kb-write.js";
import { extractAudio, getFirstFrame } from "./slots/media.js";
import { parseDocument } from "./slots/parse-document.js";
import { renderPages } from "./slots/render-pages.js";
import type { NodeSlot, SlotImpl, SlotInput } from "./types.js";
import { applyEntryConfig } from "./util/model-base.js";

export type { EdgeContext } from "./context.js";
export { toEdgeContext } from "./context.js";
export type { Asset, EdgeSlotOutput, NodeSlot, SlotImpl, SlotInput, SlotOutput } from "./types.js";
export type { KbWriteSummary } from "./slots/kb-write.js";
export type { EdgeConfig } from "./util/model-base.js";
export { DEFAULT_EMBED_MODEL, EMBED_MODELS } from "./ml/models.js";

// `dist/index.js?modelBase=…`: the host's way to configure the plugin inside the worker.
applyEntryConfig(import.meta.url);

/** `dist/` when bundled: assets are served beside the entry (`dist/assets/…`). */
const ASSET_BASE = new URL("./", import.meta.url);

function bind<S extends NodeSlot>(slot: S, impl: SlotImpl<S>) {
    return edgeMethod(slot, (input: SlotInput<S>, ctx: EdgeMethodContext) => impl(input, toEdgeContext(ctx, ASSET_BASE)));
}

/** Method name (as in tongflow.plugin.json `slots[].method`) → engine method. */
export const methods = {
    parseDocument: bind("parse-document", parseDocument),
    renderPages: bind("render-pages", renderPages),
    extractAudio: bind("extract-audio", extractAudio),
    getFirstFrame: bind("get-first-frame", getFirstFrame),
    detectLanguage: bind("detect-language", detectLanguage),
    chunkText: bind("chunk-text", chunkText),
    embedText: bind("embed-text", embedText),
    kbWrite: bind("kb-write", kbWrite),
};

/** Slot → method name, mirroring the manifest (kept in sync by a test). */
export const slots = {
    "parse-document": "parseDocument",
    "render-pages": "renderPages",
    "extract-audio": "extractAudio",
    "get-first-frame": "getFirstFrame",
    "detect-language": "detectLanguage",
    "chunk-text": "chunkText",
    "embed-text": "embedText",
    "kb-write": "kbWrite",
} as const satisfies Partial<Record<NodeSlot, keyof typeof methods>>;

/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export const impls = { parseDocument, renderPages, extractAudio, getFirstFrame, detectLanguage, chunkText, embedText, kbWrite };

export default defineEdgePlugin({ methods });
