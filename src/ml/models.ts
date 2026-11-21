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
    /** transformers.js dtype; `q8` loads `onnx/model_quantized.onnx`. */
    dtype: "q8";
    /** bge reads at most 512 tokens (longer input is truncated). */
    maxTokens: number;
    /** Texts per inference call. */
    batchSize: number;
}

export const EMBED_MODELS = {
    "bge-small-zh-v1.5": {
        id: "bge-small-zh-v1.5",
        repo: "Xenova/bge-small-zh-v1.5",
        dims: 512,
        dtype: "q8",
        maxTokens: 512,
        batchSize: 16,
    },
    "bge-base-zh-v1.5": {
        id: "bge-base-zh-v1.5",
        repo: "Xenova/bge-base-zh-v1.5",
        dims: 768,
        dtype: "q8",
        maxTokens: 512,
        batchSize: 8,
    },
} as const satisfies Record<string, EmbedModel>;

export type EmbedModelId = keyof typeof EMBED_MODELS;

/** Default first, as in the manifest. */
export const DEFAULT_EMBED_MODEL: EmbedModelId = "bge-small-zh-v1.5";

/**
 * The query instruction BGE zh v1.5 recommends for short query → passage retrieval.
 * Queries get it, documents (chunks) never do.
 */
export const BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

/** Model id (or its `<org>/<repo>`, case-insensitive) → model; absent = default. */
export function resolveEmbedModel(id: string | undefined): EmbedModel {
    const key = (id ?? "").trim();
    if (!key) return EMBED_MODELS[DEFAULT_EMBED_MODEL];
    const lower = key.toLowerCase();
    for (const m of Object.values(EMBED_MODELS)) {
        if (m.id === lower || m.repo.toLowerCase() === lower) return m;
    }
    throw new EdgeError(`unknown embedding model '${key}' (available: ${Object.keys(EMBED_MODELS).join(", ")})`);
}
