interface EmbedModel {
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
declare const BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";
/** harrier-oss-v1's retrieval instruction (model card, `web_search_query`); documents get none. */
declare const HARRIER_QUERY_INSTRUCTION = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";
declare const EMBED_MODELS: {
  readonly "bge-small-zh-v1.5": {
    readonly id: "bge-small-zh-v1.5";
    readonly repo: "Xenova/bge-small-zh-v1.5";
    readonly dims: 512;
    readonly dtype: "q8";
    readonly pooling: "cls";
    readonly device: "wasm";
    readonly queryInstruction: "为这个句子生成表示以用于检索相关文章：";
    readonly maxTokens: 512;
    readonly batchSize: 16;
  };
  readonly "bge-base-zh-v1.5": {
    readonly id: "bge-base-zh-v1.5";
    readonly repo: "Xenova/bge-base-zh-v1.5";
    readonly dims: 768;
    readonly dtype: "q8";
    readonly pooling: "cls";
    readonly device: "wasm";
    readonly queryInstruction: "为这个句子生成表示以用于检索相关文章：";
    readonly maxTokens: 512;
    readonly batchSize: 8;
  };
  readonly "harrier-oss-v1-270m": {
    readonly id: "harrier-oss-v1-270m";
    readonly repo: "onnx-community/harrier-oss-v1-270m-ONNX";
    readonly dims: 640;
    readonly dtype: "q4";
    readonly pooling: "model";
    readonly device: "webgpu";
    readonly queryInstruction: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";
    readonly maxTokens: 1024;
    readonly batchSize: 4;
  };
  readonly "granite-embedding-97m-multilingual-r2": {
    readonly id: "granite-embedding-97m-multilingual-r2";
    readonly repo: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX";
    readonly dims: 384;
    readonly dtype: "q8";
    readonly pooling: "cls";
    readonly device: "wasm";
    readonly queryInstruction: "";
    readonly maxTokens: 1024;
    readonly batchSize: 8;
  };
};
type EmbedModelId = keyof typeof EMBED_MODELS;
/** Default first, as in the manifest. */
declare const DEFAULT_EMBED_MODEL: EmbedModelId;
export { HARRIER_QUERY_INSTRUCTION as a, EmbedModel as i, DEFAULT_EMBED_MODEL as n, EMBED_MODELS as r, BGE_QUERY_INSTRUCTION as t };