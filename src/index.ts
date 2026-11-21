/**
 * tongflow-edge-essentials: T0 (zero-model) edge nodes.
 *
 * The default export is `defineEdgePlugin({ methods })`: loaded in a dedicated Web
 * Worker it answers the engine's worker protocol; imported anywhere else (the
 * in-process executor, tests) it is just the definition. Method names match the
 * `method` values in tongflow.plugin.json. Each slot's heavy library is a lazy
 * dynamic import, so loading this entry costs only the dispatch code.
 */
import { defineEdgePlugin, edgeMethod, type EdgeMethodContext } from "tongflow/engine/worker";
import { toEdgeContext } from "./context.js";
import { detectLanguage } from "./slots/detect-language.js";
import { extractAudio, getFirstFrame } from "./slots/media.js";
import { parseDocument } from "./slots/parse-document.js";
import { renderPages } from "./slots/render-pages.js";
import type { NodeSlot, SlotImpl, SlotInput } from "./types.js";

export type { EdgeContext } from "./context.js";
export { toEdgeContext } from "./context.js";
export type { Asset, EdgeSlotOutput, NodeSlot, SlotImpl, SlotInput, SlotOutput } from "./types.js";

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
};

/** Slot → method name, mirroring the manifest (kept in sync by a test). */
export const slots = {
    "parse-document": "parseDocument",
    "render-pages": "renderPages",
    "extract-audio": "extractAudio",
    "get-first-frame": "getFirstFrame",
    "detect-language": "detectLanguage",
} as const satisfies Partial<Record<NodeSlot, keyof typeof methods>>;

/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export const impls = { parseDocument, renderPages, extractAudio, getFirstFrame, detectLanguage };

export default defineEdgePlugin({ methods });
