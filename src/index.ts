/**
 * tongflow-edge-essentials: browser edge nodes (T0 zero-model nodes, knowledge-base nodes,
 * and the T3 WebGPU nodes: Qwen3.5-0.8B, GLM-OCR, EmbeddingGemma 2, LFM2.5-350M).
 *
 * The default export is `defineEdgePlugin({ methods })`: loaded in a dedicated Web
 * Worker it answers the engine's worker protocol; imported anywhere else (the
 * in-process executor, tests) it is just the definition. Method names match the
 * `method` values in tongflow.plugin.json. Each slot's heavy library is a lazy
 * dynamic import, so loading this entry costs only the dispatch code.
 */
import { defineEdgePlugin, edgeMethod, type EdgeMethodContext } from "tongflow/engine/worker";
import { type EdgeContext, toEdgeContext } from "./context.js";
import { chunkText } from "./slots/chunk-text.js";
import { detectLanguage } from "./slots/detect-language.js";
import { embedText } from "./slots/embed-text.js";
import type { VisionTextInput } from "./slots/image-gen-text.js";
import { kbWrite } from "./slots/kb-write.js";
import { extractAudio, getFirstFrame } from "./slots/media.js";
import { parseDocument } from "./slots/parse-document.js";
import { renderPages } from "./slots/render-pages.js";
import type { EdgeSlotOutput, NodeSlot, SlotImpl, SlotInput } from "./types.js";
import { applyEntryConfig } from "./util/model-base.js";

export type { EdgeContext } from "./context.js";
export { toEdgeContext } from "./context.js";
export type { Asset, EdgeSlotOutput, NodeSlot, SlotImpl, SlotInput, SlotOutput } from "./types.js";
export type { KbWriteSummary } from "./slots/kb-write.js";
export type { EdgeConfig } from "./util/model-base.js";
export { DEFAULT_EMBED_MODEL, EMBED_MODELS } from "./ml/models.js";

// `dist/index.js?modelBase=…`: the host's way to configure the plugin inside the worker.
applyEntryConfig(import.meta.url);
export { T3_MODELS, hostedFiles } from "./ml/catalog.js";

/** `dist/` when bundled: assets are served beside the entry (`dist/assets/…`). */
const ASSET_BASE = new URL("./", import.meta.url);


function bind<S extends NodeSlot>(slot: S, impl: SlotImpl<S>) {
    return edgeMethod(slot, (input: SlotInput<S>, ctx: EdgeMethodContext) => impl(input, toEdgeContext(ctx, ASSET_BASE)));
}

/**
 * The T3 (WebGPU) slots are loaded on first call, so the entry stays small.
 * `imageGenText` serves both `image-gen-text` and `image-describe`, whose
 * inputs differ; `ctx.nodeSlot` tells them apart.
 */
const t3 = {
    imageGenText: (input: VisionTextInput, ctx: EdgeContext): Promise<EdgeSlotOutput<"image-gen-text">> =>
        import("./slots/image-gen-text.js").then((m) => m.imageGenText(input, ctx)),
    ocrImageGlm: (input: SlotInput<"ocr-image">, ctx: EdgeContext): Promise<EdgeSlotOutput<"ocr-image">> =>
        import("./slots/ocr-image-glm.js").then((m) => m.ocrImageGlm(input, ctx)),
    embedImage: (input: SlotInput<"embed-image">, ctx: EdgeContext): Promise<EdgeSlotOutput<"embed-image">> =>
        import("./slots/embed-image.js").then((m) => m.embedImage(input, ctx)),
    genText: (input: SlotInput<"gen-text">, ctx: EdgeContext): Promise<EdgeSlotOutput<"gen-text">> =>
        import("./slots/gen-text.js").then((m) => m.genText(input, ctx)),
};

function bindAny<I, O>(impl: (input: I, ctx: EdgeContext) => Promise<O>) {
    return (input: I, ctx: EdgeMethodContext) => impl(input, toEdgeContext(ctx, ASSET_BASE));
}

/**
 * An alternative implementation of a slot, picked by the node's model:
 * calls `impl` for `ctx.model === modelId` and `fallback` for anything else.
 * Used to put GLM-OCR (`glm-ocr`) behind the `ocr-image` slot's default method.
 */
export function withModelAlternative<S extends NodeSlot>(
    fallback: (input: SlotInput<S>, ctx: EdgeMethodContext) => unknown,
    modelId: string,
    impl: (input: SlotInput<S>, ctx: EdgeMethodContext) => unknown,
) {
    return (input: SlotInput<S>, ctx: EdgeMethodContext) => (ctx.model === modelId ? impl(input, ctx) : fallback(input, ctx));
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
    // T3, WebGPU only.
    imageGenText: bindAny(t3.imageGenText),
    ocrImageGlm: bind("ocr-image", t3.ocrImageGlm),
    embedImage: bind("embed-image", t3.embedImage),
    genText: bind("gen-text", t3.genText),
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
    "image-gen-text": "imageGenText",
    "image-describe": "imageGenText",
    "embed-image": "embedImage",
    "gen-text": "genText",
    "ocr-image": "ocrImageGlm",
} as const satisfies Partial<Record<NodeSlot, keyof typeof methods>>;

/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export const impls = { parseDocument, renderPages, extractAudio, getFirstFrame, detectLanguage, chunkText, embedText, kbWrite, ...t3 };

export default defineEdgePlugin({ methods });
