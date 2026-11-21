/**
 * Text-embedding models of `embed-text` (and of the host-side `embedQuery`).
 * Pure data: importing this module loads no ML runtime.
 */
import { EdgeError } from "../util/errors.js";

export interface EmbedModel {
    /** The id in tongflow.plugin.json `models` and in models.json. */
    id: string;
    /** `<org>/<repo>` under the model base (mirrors ModelScope / Hugging Face). */
    repo: string;
    dims: number;
    /** transformers.js dtype; `q8` loads `onnx/model_quantized.onnx`, `q4` `onnx/model_q4.onnx` (+ `_data`). */
    dtype: "q8" | "q4";
    /**
     * How a text becomes one vector: `cls` = the first token's hidden state (BGE, granite),
     * `model` = the graph's own `sentence_embedding` output (harrier: last-token pooling
     * inside the ONNX graph, which reads the attention mask). Every vector is then L2-normalized.
     */
    pooling: "cls" | "model";
    /**
     * Where it runs. `webgpu`: the model needs WebGPU (documents and queries alike) and fails
     * with the plugin's WebGPU error without it.
     */
    device: "wasm" | "webgpu";
    /** Prefix for queries (never for documents); `embedQuery` adds it. */
    queryInstruction: string;
    /** Longer input is truncated to this many tokens. */
    maxTokens: number;
    /** Texts per inference call. */
    batchSize: number;
}

/**
 * The query instruction BGE zh v1.5 recommends for short query → passage retrieval.
 * Queries get it, documents (chunks) never do.
 */
export const BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

/** harrier-oss-v1's retrieval instruction (model card, `web_search_query`); documents get none. */
export const HARRIER_QUERY_INSTRUCTION = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

export const EMBED_MODELS = {
    "bge-small-zh-v1.5": {
        id: "bge-small-zh-v1.5",
        repo: "Xenova/bge-small-zh-v1.5",
        dims: 512,
        dtype: "q8",
        pooling: "cls",
        device: "wasm",
        queryInstruction: BGE_QUERY_INSTRUCTION,
        maxTokens: 512,
        batchSize: 16,
    },
    "bge-base-zh-v1.5": {
        id: "bge-base-zh-v1.5",
        repo: "Xenova/bge-base-zh-v1.5",
        dims: 768,
        dtype: "q8",
        pooling: "cls",
        device: "wasm",
        queryInstruction: BGE_QUERY_INSTRUCTION,
        maxTokens: 512,
        batchSize: 8,
    },
    // Microsoft harrier-oss-v1-270m (MIT): Gemma 3 text backbone, 640 dims, 32K context.
    // WebGPU only: every quantized export stores the 262k-token embedding table with
    // GatherBlockQuantized, which the plugin's onnxruntime-web wasm build (asyncify) lacks.
    // q4 (not q4f16) on every GPU, so documents and host-side queries use the same file.
    "harrier-oss-v1-270m": {
        id: "harrier-oss-v1-270m",
        repo: "onnx-community/harrier-oss-v1-270m-ONNX",
        dims: 640,
        dtype: "q4",
        pooling: "model",
        device: "webgpu",
        queryInstruction: HARRIER_QUERY_INSTRUCTION,
        maxTokens: 1024,
        batchSize: 4,
    },
    // IBM granite-embedding-97m-multilingual-r2 (Apache-2.0): ModernBERT, 384 dims, CLS pooling, no query prefix.
    "granite-embedding-97m-multilingual-r2": {
        id: "granite-embedding-97m-multilingual-r2",
        repo: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
        dims: 384,
        dtype: "q8",
        pooling: "cls",
        device: "wasm",
        queryInstruction: "",
        maxTokens: 1024,
        batchSize: 8,
    },
} as const satisfies Record<string, EmbedModel>;

/** Short names accepted for {@link resolveEmbedModel} (the KB may record either). */
const EMBED_ALIASES: Record<string, keyof typeof EMBED_MODELS> = {
    "granite-embedding-97m-r2": "granite-embedding-97m-multilingual-r2",
    "harrier-270m": "harrier-oss-v1-270m",
};

export type EmbedModelId = keyof typeof EMBED_MODELS;

/** Default first, as in the manifest. */
export const DEFAULT_EMBED_MODEL: EmbedModelId = "bge-small-zh-v1.5";

/** Model id (or its `<org>/<repo>`, case-insensitive) → model; absent = default. */
export function resolveEmbedModel(id: string | undefined): EmbedModel {
    const key = (id ?? "").trim();
    if (!key) return EMBED_MODELS[DEFAULT_EMBED_MODEL];
    const lower = key.toLowerCase();
    const alias = EMBED_ALIASES[lower];
    if (alias) return EMBED_MODELS[alias];
    for (const m of Object.values(EMBED_MODELS)) {
        if (m.id === lower || m.repo.toLowerCase() === lower) return m;
    }
    throw new EdgeError(`unknown embedding model '${key}' (available: ${Object.keys(EMBED_MODELS).join(", ")})`);
}
