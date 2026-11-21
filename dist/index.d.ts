/**
 * tongflow-edge-essentials: browser edge nodes (T0 zero-model nodes, knowledge-base nodes,
 * and the T3 WebGPU nodes: Qwen3.5-0.8B, GLM-OCR, EmbeddingGemma 2, LFM2.5-350M; and the T2 audio nodes:
 * SenseVoiceSmall, Silero VAD, pyannote + CAM++, CED-tiny; and the media nodes on
 * Mediabunny + WebCodecs with ffmpeg.wasm as fallback / selectable implementation).
 *
 * The default export is `defineEdgePlugin({ methods })`: loaded in a dedicated Web
 * Worker it answers the engine's worker protocol; imported anywhere else (the
 * in-process executor, tests) it is just the definition. Method names match the
 * `method` values in tongflow.plugin.json. Each slot's heavy library is a lazy
 * dynamic import, so loading this entry costs only the dispatch code.
 */
import { EdgeMethodContext } from "tongflow/engine/worker";
import { a as SlotImpl, c as EdgeContext, i as NodeSlot, l as toEdgeContext, n as Asset, o as SlotInput, r as EdgeSlotOutput, s as SlotOutput, t as KbWriteSummary } from "./chunks/kb-write-CbYzFC87.js";
import { n as DEFAULT_EMBED_MODEL, r as EMBED_MODELS } from "./chunks/models-tOLu1qTX.js";
type VisionTextInput = SlotInput<"image-gen-text"> | SlotInput<"image-describe">;
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
/**
 * The T3 (WebGPU-only) models: which repo, which ONNX precision per component,
 * and roughly how much a first run downloads. Pure data, shared by the slots,
 * the `models.json` consistency test and hosts that want to show the download
 * size before running a node.
 *
 * Two precision sets per model: `f16` when the GPU adapter has `shader-f16`
 * (q4 weights with fp16 activations, smaller and faster), `fallback` otherwise.
 * Sizes are the ModelScope file sizes (MB = 10^6 bytes) of the ONNX graphs plus
 * their external data and the tokenizer.
 */
type Dtype = "q4f16" | "q4" | "fp16" | "fp32" | "q8";
interface ModelVariant {
  /** transformers.js `dtype`, per session name. */
  dtype: Record<string, Dtype>;
  /** Approximate first-run download in MB. */
  approxMB: number;
}
interface T3Model {
  /** The id hosts pick in the node's model dropdown (manifest `models`). */
  id: string;
  /** Display name. */
  name: string;
  /** `<org>/<repo>` under the model base, mirroring ModelScope / HF. */
  repo: string;
  license: string;
  licenseUrl: string;
  attribution?: string;
  /** Config/tokenizer files every variant needs (besides the ONNX files). */
  files: string[];
  f16: ModelVariant;
  fallback: ModelVariant;
}
export declare const T3_MODELS: readonly [T3Model, T3Model, T3Model, T3Model];
/** Every file a model needs under its repo dir, for both variants (what the host must mirror). */
export declare function hostedFiles(model: T3Model): string[];
/**
 * An alternative implementation of a slot, picked by the node's model:
 * calls `impl` for `ctx.model === modelId` and `fallback` for anything else.
 * Used to put GLM-OCR (`glm-ocr`) behind the `ocr-image` slot's default method.
 */
export declare function withModelAlternative<S extends NodeSlot>(fallback: (input: SlotInput<S>, ctx: EdgeMethodContext) => unknown, modelId: string, impl: (input: SlotInput<S>, ctx: EdgeMethodContext) => unknown): (input: SlotInput<S>, ctx: EdgeMethodContext) => unknown;
/** Method name (as in tongflow.plugin.json `slots[].method`) → engine method. */
export declare const methods: {
  parseDocument: import("tongflow/engine/worker").EdgeMethod<"parse-document">;
  renderPages: import("tongflow/engine/worker").EdgeMethod<"render-pages">;
  extractAudio: import("tongflow/engine/worker").EdgeMethod<"extract-audio">;
  getFirstFrame: import("tongflow/engine/worker").EdgeMethod<"get-first-frame">;
  getLastFrame: import("tongflow/engine/worker").EdgeMethod<"get-last-frame">;
  concatVideos: import("tongflow/engine/worker").EdgeMethod<"concat-videos">;
  removeVideoAudio: import("tongflow/engine/worker").EdgeMethod<"remove-video-audio">;
  mergeVideoAudio: import("tongflow/engine/worker").EdgeMethod<"merge-video-audio">;
  detectLanguage: import("tongflow/engine/worker").EdgeMethod<"detect-language">;
  chunkText: import("tongflow/engine/worker").EdgeMethod<"chunk-text">;
  embedText: import("tongflow/engine/worker").EdgeMethod<"embed-text">;
  kbWrite: import("tongflow/engine/worker").EdgeMethod<"kb-write">;
  imageGenText: (input: VisionTextInput, ctx: EdgeMethodContext) => Promise<EdgeSlotOutput<"image-gen-text">>;
  ocrImageGlm: import("tongflow/engine/worker").EdgeMethod<"ocr-image">;
  embedImage: import("tongflow/engine/worker").EdgeMethod<"embed-image">;
  genText: import("tongflow/engine/worker").EdgeMethod<"gen-text">;
  transcribe: import("tongflow/engine/worker").EdgeMethod<"transcribe">;
  vadSegment: import("tongflow/engine/worker").EdgeMethod<"vad-segment">;
  diarizeSpeakers: import("tongflow/engine/worker").EdgeMethod<"diarize-speakers">;
  audioTag: import("tongflow/engine/worker").EdgeMethod<"audio-tag">;
  ocrImage: (input: {
    image: {
      filename?: string | undefined;
      mime?: string | undefined;
      bytesBase64: string;
    };
  }, ctx: EdgeMethodContext) => unknown;
  imageOrient: import("tongflow/engine/worker").EdgeMethod<"image-orient">;
  layoutDetect: import("tongflow/engine/worker").EdgeMethod<"layout-detect">;
  tableRecognize: import("tongflow/engine/worker").EdgeMethod<"table-recognize">;
  splitVideo: import("tongflow/engine/worker").EdgeMethod<"split-video">;
  detectObjects: import("tongflow/engine/worker").EdgeMethod<"detect-objects">;
};
/** Slot → method name, mirroring the manifest (kept in sync by a test). */
export declare const slots: {
  readonly "parse-document": "parseDocument";
  readonly "render-pages": "renderPages";
  readonly "extract-audio": "extractAudio";
  readonly "get-first-frame": "getFirstFrame";
  readonly "get-last-frame": "getLastFrame";
  readonly "concat-videos": "concatVideos";
  readonly "remove-video-audio": "removeVideoAudio";
  readonly "merge-video-audio": "mergeVideoAudio";
  readonly "detect-language": "detectLanguage";
  readonly "chunk-text": "chunkText";
  readonly "embed-text": "embedText";
  readonly "kb-write": "kbWrite";
  readonly "image-gen-text": "imageGenText";
  readonly "image-describe": "imageGenText";
  readonly "embed-image": "embedImage";
  readonly "gen-text": "genText";
  readonly "ocr-image": "ocrImage";
  readonly transcribe: "transcribe";
  readonly "vad-segment": "vadSegment";
  readonly "diarize-speakers": "diarizeSpeakers";
  readonly "audio-tag": "audioTag";
  readonly "image-orient": "imageOrient";
  readonly "layout-detect": "layoutDetect";
  readonly "table-recognize": "tableRecognize";
  readonly "split-video": "splitVideo";
  readonly "detect-objects": "detectObjects";
};
/** The slot implementations against the internal context (for hosts and tests that bring their own). */
export declare const impls: {
  transcribe: SlotImpl<"transcribe">;
  vadSegment: SlotImpl<"vad-segment">;
  diarizeSpeakers: SlotImpl<"diarize-speakers">;
  audioTag: SlotImpl<"audio-tag">;
  ocrImage: SlotImpl<"ocr-image">;
  imageOrient: SlotImpl<"image-orient">;
  layoutDetect: SlotImpl<"layout-detect">;
  tableRecognize: SlotImpl<"table-recognize">;
  splitVideo: SlotImpl<"split-video">;
  detectObjects: SlotImpl<"detect-objects">;
  imageGenText: (input: VisionTextInput, ctx: EdgeContext) => Promise<EdgeSlotOutput<"image-gen-text">>;
  ocrImageGlm: (input: SlotInput<"ocr-image">, ctx: EdgeContext) => Promise<EdgeSlotOutput<"ocr-image">>;
  embedImage: (input: SlotInput<"embed-image">, ctx: EdgeContext) => Promise<EdgeSlotOutput<"embed-image">>;
  genText: (input: SlotInput<"gen-text">, ctx: EdgeContext) => Promise<EdgeSlotOutput<"gen-text">>;
  parseDocument: SlotImpl<"parse-document">;
  renderPages: SlotImpl<"render-pages">;
  extractAudio: SlotImpl<"extract-audio">;
  getFirstFrame: SlotImpl<"get-first-frame">;
  getLastFrame: SlotImpl<"get-last-frame">;
  concatVideos: SlotImpl<"concat-videos">;
  removeVideoAudio: SlotImpl<"remove-video-audio">;
  mergeVideoAudio: SlotImpl<"merge-video-audio">;
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
    getLastFrame: import("tongflow/engine/worker").EdgeMethod<"get-last-frame">;
    concatVideos: import("tongflow/engine/worker").EdgeMethod<"concat-videos">;
    removeVideoAudio: import("tongflow/engine/worker").EdgeMethod<"remove-video-audio">;
    mergeVideoAudio: import("tongflow/engine/worker").EdgeMethod<"merge-video-audio">;
    detectLanguage: import("tongflow/engine/worker").EdgeMethod<"detect-language">;
    chunkText: import("tongflow/engine/worker").EdgeMethod<"chunk-text">;
    embedText: import("tongflow/engine/worker").EdgeMethod<"embed-text">;
    kbWrite: import("tongflow/engine/worker").EdgeMethod<"kb-write">;
    imageGenText: (input: VisionTextInput, ctx: EdgeMethodContext) => Promise<EdgeSlotOutput<"image-gen-text">>;
    ocrImageGlm: import("tongflow/engine/worker").EdgeMethod<"ocr-image">;
    embedImage: import("tongflow/engine/worker").EdgeMethod<"embed-image">;
    genText: import("tongflow/engine/worker").EdgeMethod<"gen-text">;
    transcribe: import("tongflow/engine/worker").EdgeMethod<"transcribe">;
    vadSegment: import("tongflow/engine/worker").EdgeMethod<"vad-segment">;
    diarizeSpeakers: import("tongflow/engine/worker").EdgeMethod<"diarize-speakers">;
    audioTag: import("tongflow/engine/worker").EdgeMethod<"audio-tag">;
    ocrImage: (input: {
      image: {
        filename?: string | undefined;
        mime?: string | undefined;
        bytesBase64: string;
      };
    }, ctx: EdgeMethodContext) => unknown;
    imageOrient: import("tongflow/engine/worker").EdgeMethod<"image-orient">;
    layoutDetect: import("tongflow/engine/worker").EdgeMethod<"layout-detect">;
    tableRecognize: import("tongflow/engine/worker").EdgeMethod<"table-recognize">;
    splitVideo: import("tongflow/engine/worker").EdgeMethod<"split-video">;
    detectObjects: import("tongflow/engine/worker").EdgeMethod<"detect-objects">;
  };
};
export { type Asset, DEFAULT_EMBED_MODEL, EMBED_MODELS, type EdgeConfig, type EdgeContext, type EdgeSlotOutput, type KbWriteSummary, type NodeSlot, type SlotImpl, type SlotInput, type SlotOutput, _default as default, toEdgeContext };