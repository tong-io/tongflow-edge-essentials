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

/** The ONNX files (graph + external data) a variant loads. */
export function onnxFiles(variant: ModelVariant): string[] {
    const out: string[] = [];
    for (const [session, dtype] of Object.entries(variant.dtype)) {
        const stem = dtype === "fp32" ? session : `${session}_${dtype === "q8" ? "quantized" : dtype}`;
        out.push(`onnx/${stem}.onnx`, `onnx/${stem}.onnx_data`);
    }
    return out;
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
