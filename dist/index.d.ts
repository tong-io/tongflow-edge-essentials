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
import { EdgeMethodContext, EdgeSlotOutput } from "tongflow/engine/worker";
import { Asset, NodeSlot, SlotInput, SlotOutput } from "tongflow";
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
export declare function toEdgeContext(ctx: EdgeMethodContext, assetBase: string | URL): EdgeContext;
/**
 * A slot implementation against the plugin's internal {@link EdgeContext}.
 * `EdgeSlotOutput<S>` is `SlotOutput<S>` with ref fields allowed to carry an inline
 * `Asset` (`bytesBase64`), which the engine stores and turns into a file ref.
 */
type SlotImpl<S extends NodeSlot> = (input: SlotInput<S>, ctx: EdgeContext) => Promise<EdgeSlotOutput<S>>;
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
  /** `false`: every graph is one self-contained `.onnx` file (no `.onnx_data` beside it). */
  external?: boolean;
}
interface T3Model {
  /** Generation stops at any of these token ids (overrides the repo's `generation_config.json`). */
  eosTokenIds?: number[];
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
  imageGenText: (input: VisionTextInput, ctx: EdgeMethodContext) => Promise<EdgeSlotOutput<"image-gen-text">>;
  ocrImageGlm: import("tongflow/engine/worker").EdgeMethod<"ocr-image">;
  genText: import("tongflow/engine/worker").EdgeMethod<"gen-text">;
  transcribe: import("tongflow/engine/worker").EdgeMethod<"transcribe">;
  transcribeTimestamp: import("tongflow/engine/worker").EdgeMethod<"transcribe-timestamp">;
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
  readonly "image-gen-text": "imageGenText";
  readonly "image-describe": "imageGenText";
  readonly "gen-text": "genText";
  readonly "ocr-image": "ocrImage";
  readonly transcribe: "transcribe";
  readonly "transcribe-timestamp": "transcribeTimestamp";
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
  transcribeTimestamp: SlotImpl<"transcribe-timestamp">;
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
    imageGenText: (input: VisionTextInput, ctx: EdgeMethodContext) => Promise<EdgeSlotOutput<"image-gen-text">>;
    ocrImageGlm: import("tongflow/engine/worker").EdgeMethod<"ocr-image">;
    genText: import("tongflow/engine/worker").EdgeMethod<"gen-text">;
    transcribe: import("tongflow/engine/worker").EdgeMethod<"transcribe">;
    transcribeTimestamp: import("tongflow/engine/worker").EdgeMethod<"transcribe-timestamp">;
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
export { type Asset, type EdgeConfig, type EdgeContext, type EdgeSlotOutput, type NodeSlot, type SlotImpl, type SlotInput, type SlotOutput, _default as default };