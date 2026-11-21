interface EmbedModel {
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
declare const EMBED_MODELS: {
  readonly "bge-small-zh-v1.5": {
    readonly id: "bge-small-zh-v1.5";
    readonly repo: "Xenova/bge-small-zh-v1.5";
    readonly dims: 512;
    readonly dtype: "q8";
    readonly maxTokens: 512;
    readonly batchSize: 16;
  };
  readonly "bge-base-zh-v1.5": {
    readonly id: "bge-base-zh-v1.5";
    readonly repo: "Xenova/bge-base-zh-v1.5";
    readonly dims: 768;
    readonly dtype: "q8";
    readonly maxTokens: 512;
    readonly batchSize: 8;
  };
};
type EmbedModelId = keyof typeof EMBED_MODELS;
/** Default first, as in the manifest. */
declare const DEFAULT_EMBED_MODEL: EmbedModelId;
/**
 * The query instruction BGE zh v1.5 recommends for short query → passage retrieval.
 * Queries get it, documents (chunks) never do.
 */
declare const BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";
export { EmbedModel as i, DEFAULT_EMBED_MODEL as n, EMBED_MODELS as r, BGE_QUERY_INSTRUCTION as t };