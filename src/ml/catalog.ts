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

export type Dtype = "q4f16" | "q4" | "fp16" | "fp32" | "q8";

export interface ModelVariant {
    /** transformers.js `dtype`, per session name. */
    dtype: Record<string, Dtype>;
    /** Approximate first-run download in MB. */
    approxMB: number;
    /** `false`: every graph is one self-contained `.onnx` file (no `.onnx_data` beside it). */
    external?: boolean;
}

export interface T3Model {
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

const TEXT_FILES = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja"];
const VLM_FILES = [...TEXT_FILES, "preprocessor_config.json", "processor_config.json"];

export const QWEN35_VL: T3Model = {
    id: "qwen3.5-0.8b",
    name: "Qwen3.5-0.8B",
    repo: "onnx-community/Qwen3.5-0.8B-ONNX",
    license: "Apache-2.0",
    licenseUrl: "https://www.modelscope.cn/models/Qwen/Qwen3.5-0.8B/file/view/master/LICENSE",
    attribution: "Qwen3.5-0.8B by the Qwen team, Alibaba Cloud",
    files: VLM_FILES,
    // The vision tower stays fp16 (as in the model card's own example): q4 hurts fine detail.
    f16: { dtype: { embed_tokens: "q4f16", vision_encoder: "fp16", decoder_model_merged: "q4f16" }, approxMB: 810 },
    fallback: { dtype: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" }, approxMB: 740 },
};

export const GLM_OCR: T3Model = {
    id: "glm-ocr",
    name: "GLM-OCR",
    repo: "onnx-community/GLM-OCR-ONNX",
    license: "MIT",
    licenseUrl: "https://www.modelscope.cn/models/ZhipuAI/GLM-OCR",
    attribution: "GLM-OCR by Zhipu AI (Z.ai)",
    files: VLM_FILES,
    f16: { dtype: { embed_tokens: "q4f16", vision_encoder: "q4f16", decoder_model_merged: "q4f16" }, approxMB: 660 },
    fallback: { dtype: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" }, approxMB: 745 },
};

export const EMBEDDING_GEMMA_2: T3Model = {
    id: "embeddinggemma-2",
    name: "EmbeddingGemma 2 (text + vision)",
    repo: "onnx-community/embeddinggemma-2-ONNX",
    license: "Apache-2.0 (Gemma 4 license); deployments must follow the Gemma Prohibited Use Policy",
    licenseUrl: "https://ai.google.dev/gemma/docs/gemma_4_license",
    attribution: "EmbeddingGemma 2 by Google DeepMind",
    // The audio encoder is never loaded (its config is dropped before loading).
    files: ["config.json", "config_sentence_transformers.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "preprocessor_config.json", "processor_config.json"],
    // `model` is the text backbone + embedder head; image embeddings go through it too.
    f16: { dtype: { model: "q4f16", vision_encoder: "q4f16" }, approxMB: 290 },
    fallback: { dtype: { model: "q4", vision_encoder: "q4" }, approxMB: 316 },
};

export const LFM25_350M: T3Model = {
    id: "lfm2.5-350m",
    name: "LFM2.5-350M",
    repo: "LiquidAI/LFM2.5-350M-ONNX",
    license: "LFM Open License v1.0",
    licenseUrl: "licenses/LFM-Open-License-v1.0.txt",
    attribution: "LFM2.5-350M by Liquid AI, Inc., licensed under the LFM Open License v1.0",
    files: [...TEXT_FILES, "LICENSE"],
    f16: { dtype: { model: "q4f16" }, approxMB: 259 },
    fallback: { dtype: { model: "q4" }, approxMB: 297 },
};

export const T3_MODELS = [QWEN35_VL, GLM_OCR, EMBEDDING_GEMMA_2, LFM25_350M] as const;

/* ---------- alternative implementations (picked in the canvas "换实现" menu) ---------- */

/** `image-gen-text` / `image-describe` alternative: LFM2.5-VL-450M (WebGPU). Multilingual, weak at fine OCR. */
export const LFM25_VL_450M: T3Model = {
    id: "lfm2.5-vl-450m",
    name: "LFM2.5-VL-450M",
    repo: "onnx-community/LFM2.5-VL-450M-ONNX",
    license: "LFM Open License v1.0",
    licenseUrl: "licenses/LFM-Open-License-v1.0.txt",
    attribution: "LFM2.5-VL-450M by Liquid AI, Inc., licensed under the LFM Open License v1.0; ONNX conversion by onnx-community",
    files: VLM_FILES,
    f16: { dtype: { embed_tokens: "q4f16", vision_encoder: "q4f16", decoder_model_merged: "q4f16" }, approxMB: 319 },
    fallback: { dtype: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" }, approxMB: 368 },
};

/** `image-gen-text` / `image-describe` alternative: SmolVLM2-500M-Video-Instruct (WebGPU). English-centric. */
export const SMOLVLM2_500M: T3Model = {
    id: "smolvlm2-500m",
    name: "SmolVLM2-500M",
    repo: "HuggingFaceTB/SmolVLM2-500M-Video-Instruct",
    license: "Apache-2.0",
    licenseUrl: "https://www.modelscope.cn/models/HuggingFaceTB/SmolVLM2-500M-Video-Instruct",
    attribution: "SmolVLM2-500M-Video-Instruct by Hugging Face (HuggingFaceTB), Apache-2.0",
    files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.json", "special_tokens_map.json", "preprocessor_config.json", "processor_config.json"],
    // Single-file graphs. Without shader-f16 the token embeddings load as int8 (47 MB) instead of the 189 MB q4 (= fp32) table.
    f16: { dtype: { embed_tokens: "q4f16", vision_encoder: "q4f16", decoder_model_merged: "q4f16" }, approxMB: 361, external: false },
    fallback: { dtype: { embed_tokens: "q8", vision_encoder: "q4", decoder_model_merged: "q4" }, approxMB: 347, external: false },
};

/** `image-gen-text` / `image-describe` alternative: Florence-2-base, task `<MORE_DETAILED_CAPTION>` (WebGPU). English only. */
export const FLORENCE2_BASE: T3Model = {
    id: "florence-2-base",
    name: "Florence-2-base",
    repo: "onnx-community/Florence-2-base",
    license: "MIT",
    licenseUrl: "https://www.modelscope.cn/models/microsoft/Florence-2-base",
    attribution: "Florence-2-base by Microsoft, MIT License; ONNX conversion by onnx-community",
    files: ["config.json", "generation_config.json", "preprocessor_config.json", "processor_config.json", "tokenizer.json", "tokenizer_config.json"],
    // One set for every GPU: the q4f16 merged decoder of this export does not load in onnxruntime-web 1.31.1
    // ("Subgraph output (logits) is an outer scope value being returned directly"); the q4 one does.
    f16: { dtype: { embed_tokens: "q8", vision_encoder: "q4", encoder_model: "q4", decoder_model_merged: "q4" }, approxMB: 218, external: false },
    fallback: { dtype: { embed_tokens: "q8", vision_encoder: "q4", encoder_model: "q4", decoder_model_merged: "q4" }, approxMB: 218, external: false },
};

/** The alternative VLMs above (each also has a models.json entry with checksums). */
export const ALT_MODELS = [LFM25_VL_450M, SMOLVLM2_500M, FLORENCE2_BASE] as const;
/** `image-gen-text` / `image-describe` models, default first (as in the manifest). */
export const VISION_TEXT_MODELS = [QWEN35_VL, LFM25_VL_450M, SMOLVLM2_500M, FLORENCE2_BASE] as const;

/** `<session><suffix>.onnx`, the graph file name transformers.js loads for a dtype. */
function graphName(session: string, dtype: Dtype): string {
    return `${dtype === "fp32" ? session : `${session}_${dtype === "q8" ? "quantized" : dtype}`}.onnx`;
}

/** The ONNX files (graph + external data) a variant loads. */
export function onnxFiles(variant: ModelVariant): string[] {
    const out: string[] = [];
    for (const [session, dtype] of Object.entries(variant.dtype)) {
        const name = graphName(session, dtype);
        out.push(`onnx/${name}`);
        if (variant.external !== false) out.push(`onnx/${name}_data`);
    }
    return out;
}

/**
 * transformers.js `use_external_data_format` for a variant: every graph we load has
 * exactly one `.onnx_data` file next to it (what {@link onnxFiles} lists and the host mirrors).
 *
 * transformers.js only fetches (and hands onnxruntime-web) a graph's external data when
 * `use_external_data_format` names that graph by its full file name
 * (`embed_tokens_q4f16.onnx`) or by its session name (`embed_tokens`). The repos' own
 * `config.json` cannot be relied on for that: GLM-OCR's lists `embed_tokens.onnx`,
 * `vision_encoder.onnx`, … (the fp32 names), which match neither for q4/q4f16, so the
 * session was created without its weights and onnxruntime-web failed with
 * "Module.MountedFiles is not available". The catalog is the source of truth instead.
 */
export function externalDataFormat(variant: ModelVariant): Record<string, number> {
    const out: Record<string, number> = {};
    if (variant.external === false) return out;
    for (const [session, dtype] of Object.entries(variant.dtype)) out[graphName(session, dtype)] = 1;
    return out;
}

/**
 * A model config (`AutoConfig`) whose `transformers.js_config.use_external_data_format`
 * covers the variant's graphs ({@link externalDataFormat}). Passed as `config` to
 * `from_pretrained`, both the session loader and transformers.js' download-size probe
 * see it. Entries already in the config are kept.
 */
export function withExternalData<C extends object>(config: C, variant: ModelVariant): C {
    if (variant.external === false) return config;
    const c = config as { "transformers.js_config"?: { use_external_data_format?: unknown } };
    const js = (c["transformers.js_config"] ??= {});
    const prev = js.use_external_data_format;
    // `true` / a number applies to every graph: already right for one data file each.
    if (prev === true || (typeof prev === "number" && prev > 0)) return config;
    js.use_external_data_format = { ...(prev && typeof prev === "object" ? prev : {}), ...externalDataFormat(variant) };
    return config;
}

/** Every file a model needs under its repo dir, for both variants (what the host must mirror). */
export function hostedFiles(model: T3Model): string[] {
    return [...new Set([...model.files, ...onnxFiles(model.f16), ...onnxFiles(model.fallback)])];
}

/** Pick the variant for this GPU. */
export function variantFor(model: T3Model, f16: boolean): ModelVariant {
    return f16 ? model.f16 : model.fallback;
}

/**
 * Validate the node's model choice against the slot's model list.
 * `undefined` means the slot default (the first entry).
 */
export function pickModel<M extends { id: string }>(choice: string | undefined, allowed: readonly M[]): M {
    if (!choice) return allowed[0]!;
    const hit = allowed.find((m) => m.id === choice);
    if (!hit) {
        throw new Error(`unknown model ${JSON.stringify(choice)}; this node supports ${allowed.map((m) => m.id).join(", ")}`);
    }
    return hit;
}
