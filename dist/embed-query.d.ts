import { a as HARRIER_QUERY_INSTRUCTION, i as EmbedModel, n as DEFAULT_EMBED_MODEL, r as EMBED_MODELS, t as BGE_QUERY_INSTRUCTION } from "./chunks/models-kIFyc-Fb.js";
export interface QueryEmbedderOptions {
  /**
   * The `embed-text` model the knowledge base was built with (`KbInfo.embedModel`):
   * `bge-small-zh-v1.5` (default), `bge-base-zh-v1.5`, `harrier-oss-v1-270m` or
   * `granite-embedding-97m-multilingual-r2`, or its `<org>/<repo>`.
   */
  model?: string;
  /** Model base URL; default `globalThis.__TONGFLOW_EDGE_CONFIG__.modelBase`, then same-origin `/models/`. */
  modelBase?: string;
  /** Where `dist/` is served; default: next to this module (`import.meta.url`). */
  pluginBase?: string | URL;
  /** Prefix for queries. Default: the model's own (`EmbedModel.queryInstruction`). `""` turns it off. */
  instruction?: string;
  /** Model / wasm download progress (first use only; later loads hit the Cache API). */
  onDownload?(p: {
    loaded: number;
    total?: number;
    label: string;
    model?: string;
  }): void;
}
export interface QueryEmbedder {
  readonly model: EmbedModel;
  /** Load the runtime and the model now (otherwise the first `embed` does). */
  warmup(): Promise<void>;
  /** One L2-normalized `Float32Array(model.dims)` for the query. */
  embed(query: string, signal?: AbortSignal): Promise<Float32Array>;
}
export declare function createQueryEmbedder(options?: QueryEmbedderOptions): QueryEmbedder;
/** One-shot form of {@link createQueryEmbedder} (the embedder is cached per model and model base). */
export declare function embedQuery(query: string, options?: QueryEmbedderOptions): Promise<Float32Array>;
export { BGE_QUERY_INSTRUCTION, DEFAULT_EMBED_MODEL, EMBED_MODELS, type EmbedModel, HARRIER_QUERY_INSTRUCTION };