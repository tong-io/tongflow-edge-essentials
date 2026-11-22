/**
 * tongflow-edge-essentials: browser edge nodes (T0 zero-model nodes,
 * and the T3 WebGPU nodes: Qwen3.5-0.8B, GLM-OCR, LFM2.5-350M; and the T2 audio nodes:
 * SenseVoiceSmall or X-ASR zh-en, Silero VAD, pyannote + CAM++, CED-tiny, with the alternatives Whisper large-v3-turbo,
 * Cohere Transcribe, Qwen3-ASR-0.6B, Zipformer-CTC and Nemotron-3-Diarization picked by the node's model;
 * and the media nodes on Mediabunny + WebCodecs with ffmpeg.wasm as fallback / selectable implementation).
 *
 * The default export is `defineEdgePlugin({ methods })`: loaded in a dedicated Web
 * Worker it answers the engine's worker protocol; imported anywhere else (the
 * in-process executor, tests) it is just the definition. Method names match the
 * `method` values in tongflow.plugin.json. Each slot's heavy library is a lazy
 * dynamic import, so loading this entry costs only the dispatch code.
 */
import { defineEdgePlugin, edgeMethod, type EdgeMethodContext } from "tongflow/engine/worker";
import { type EdgeContext, toEdgeContext } from "./context.js";
import { audioTag, diarizeSpeakers, transcribe, transcribeTimestamp, vadSegment } from "./slots/audio.js";
import { detectLanguage } from "./slots/detect-language.js";
import type { VisionTextInput } from "./slots/image-gen-text.js";
import { concatVideos, extractAudio, getFirstFrame, getLastFrame, mergeVideoAudio, removeVideoAudio } from "./slots/media.js";
import { parseDocument } from "./slots/parse-document.js";
import { renderPages } from "./slots/render-pages.js";
import { detectObjects, imageOrient, layoutDetect, ocrImage, splitVideo, tableRecognize } from "./slots/vision.js";
import type { EdgeSlotOutput, NodeSlot, SlotImpl, SlotInput } from "./types.js";
import { applyEntryConfig, type EdgeConfig } from "./util/model-base.js";

export type { EdgeContext } from "./context.js";
export { toEdgeContext } from "./context.js";
export type { Asset, EdgeSlotOutput, NodeSlot, SlotImpl, SlotInput, SlotOutput } from "./types.js";
export type { EdgeConfig } from "./util/model-base.js";

// `dist/index.js?modelBase=…`: the host's way to configure the plugin inside the worker.
applyEntryConfig(import.meta.url);
export { T3_MODELS, hostedFiles } from "./ml/catalog.js";

/** `dist/` when bundled: assets are served beside the entry (`dist/assets/…`). */
const ASSET_BASE = new URL("./", import.meta.url);

function bind<S extends NodeSlot>(slot: S, impl: SlotImpl<S>) {
    return edgeMethod(slot, (input: SlotInput<S>, ctx: EdgeMethodContext) =>
        impl(input, toEdgeContext(ctx, ASSET_BASE)),
    );
}

/**
 * Host configuration inside the worker: the host may post
 * `{type: "config", modelBase: "https://…/models/"}` before its first invoke
 * (the engine protocol ignores unknown message types). It lands in
 * `globalThis.__TONGFLOW_EDGE_CONFIG__`, which a host that imports the plugin
 * in-process can also set directly.
 */
const scope = globalThis as unknown as { addEventListener?: (t: string, l: (e: MessageEvent) => void) => void };
if (typeof (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope === "function") {
    scope.addEventListener?.("message", (e: MessageEvent) => {
        const msg = e.data as ({ type?: unknown } & EdgeConfig) | null;
        if (msg?.type !== "config") return;
        const cfg: EdgeConfig = { ...globalThis.__TONGFLOW_EDGE_CONFIG__ };
        if (typeof msg.modelBase === "string" && msg.modelBase) cfg.modelBase = msg.modelBase;
        globalThis.__TONGFLOW_EDGE_CONFIG__ = cfg;
    });
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
    // Media: Mediabunny + WebCodecs, ffmpeg.wasm on unsupported files or model "ffmpeg-wasm".
    extractAudio: bind("extract-audio", extractAudio),
    getFirstFrame: bind("get-first-frame", getFirstFrame),
    getLastFrame: bind("get-last-frame", getLastFrame),
    concatVideos: bind("concat-videos", concatVideos),
    removeVideoAudio: bind("remove-video-audio", removeVideoAudio),
    mergeVideoAudio: bind("merge-video-audio", mergeVideoAudio),
    detectLanguage: bind("detect-language", detectLanguage),
    // T3, WebGPU only.
    imageGenText: bindAny(t3.imageGenText),
    ocrImageGlm: bind("ocr-image", t3.ocrImageGlm),
    genText: bind("gen-text", t3.genText),
    transcribe: bind("transcribe", transcribe),
    transcribeTimestamp: bind("transcribe-timestamp", transcribeTimestamp),
    vadSegment: bind("vad-segment", vadSegment),
    diarizeSpeakers: bind("diarize-speakers", diarizeSpeakers),
    audioTag: bind("audio-tag", audioTag),
    // T1 vision/document. `ocr-image` is PP-OCRv6 (small, tiny) with GLM-OCR behind model "glm-ocr".
    ocrImage: withModelAlternative<"ocr-image">(bind("ocr-image", ocrImage), "glm-ocr", bind("ocr-image", t3.ocrImageGlm)),
    imageOrient: bind("image-orient", imageOrient),
    layoutDetect: bind("layout-detect", layoutDetect),
    tableRecognize: bind("table-recognize", tableRecognize),
    splitVideo: bind("split-video", splitVideo),
    detectObjects: bind("detect-objects", detectObjects),
};

/** Slot → method name, mirroring the manifest (kept in sync by a test). */
export const slots = {
    "parse-document": "parseDocument",
    "render-pages": "renderPages",
    "extract-audio": "extractAudio",
    "get-first-frame": "getFirstFrame",
    "get-last-frame": "getLastFrame",
    "concat-videos": "concatVideos",
    "remove-video-audio": "removeVideoAudio",
    "merge-video-audio": "mergeVideoAudio",
    "detect-language": "detectLanguage",
    "image-gen-text": "imageGenText",
    "image-describe": "imageGenText",
    "gen-text": "genText",
    "ocr-image": "ocrImage",
    transcribe: "transcribe",
    "transcribe-timestamp": "transcribeTimestamp",
    "vad-segment": "vadSegment",
    "diarize-speakers": "diarizeSpeakers",
    "audio-tag": "audioTag",
    "image-orient": "imageOrient",
    "layout-detect": "layoutDetect",
    "table-recognize": "tableRecognize",
    "split-video": "splitVideo",
    "detect-objects": "detectObjects",
} as const satisfies Partial<Record<NodeSlot, keyof typeof methods>>;

/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export const impls = {
    parseDocument,
    renderPages,
    extractAudio,
    getFirstFrame,
    getLastFrame,
    concatVideos,
    removeVideoAudio,
    mergeVideoAudio,
    detectLanguage,
    ...t3,
    transcribe,
    transcribeTimestamp,
    vadSegment,
    diarizeSpeakers,
    audioTag,
    ocrImage,
    imageOrient,
    layoutDetect,
    tableRecognize,
    splitVideo,
    detectObjects,
};

export default defineEdgePlugin({ methods });
