/**
 * `tongflow-edge-essentials/embed-query` (`dist/embed-query.js`): host-side query
 * embedding with exactly the model and settings `embed-text` used for the documents
 * (same repo, q8, CLS pooling, L2 normalization), plus the BGE query instruction.
 *
 * Import it in the host's own Web Worker (recommended: inference blocks the thread it
 * runs on for tens of milliseconds) or on the main thread. It shares `dist/chunks/`
 * and `dist/assets/ort/` with the plugin entry, and the Cache API entries with the
 * plugin's worker on the same origin, so the model is downloaded once for both.
 */
import { getExtractor, embedTexts } from "./ml/bge.js";
import { BGE_QUERY_INSTRUCTION, DEFAULT_EMBED_MODEL, EMBED_MODELS, resolveEmbedModel, type EmbedModel } from "./ml/models.js";
import { ORT_ASSET_DIR, type MlRuntime } from "./ml/transformers.js";
import { resolveModelBase } from "./util/model-base.js";

export { BGE_QUERY_INSTRUCTION, DEFAULT_EMBED_MODEL, EMBED_MODELS };
export type { EmbedModel };

export interface QueryEmbedderOptions {
    /**
     * The `embed-text` model the knowledge base was built with (`KbInfo.embedModel`):
     * `bge-small-zh-v1.5` (default) or `bge-base-zh-v1.5`, or its `<org>/<repo>`.
     */
    model?: string;
    /** Model base URL; default `globalThis.__TONGFLOW_EDGE_CONFIG__.modelBase`, then same-origin `/models/`. */
    modelBase?: string;
    /** Where `dist/` is served; default: next to this module (`import.meta.url`). */
    pluginBase?: string | URL;
    /** Prefix for queries. Default: the BGE zh query instruction. `""` turns it off. */
    instruction?: string;
    /** Model / wasm download progress (first use only; later loads hit the Cache API). */
    onDownload?(p: { loaded: number; total?: number; label: string; model?: string }): void;
}

export interface QueryEmbedder {
    readonly model: EmbedModel;
    /** Load the runtime and the model now (otherwise the first `embed` does). */
    warmup(): Promise<void>;
    /** One L2-normalized `Float32Array(model.dims)` for the query. */
    embed(query: string, signal?: AbortSignal): Promise<Float32Array>;
}

export function createQueryEmbedder(options: QueryEmbedderOptions = {}): QueryEmbedder {
    const model = resolveEmbedModel(options.model);
    const pluginBase = new URL("./", options.pluginBase ?? import.meta.url);
    const instruction = options.instruction ?? BGE_QUERY_INSTRUCTION;
    const runtime = (signal?: AbortSignal): MlRuntime => ({
        modelBase: resolveModelBase(options.modelBase, pluginBase),
        ortBase: new URL(ORT_ASSET_DIR, pluginBase).href,
        ...(signal ? { signal } : {}),
        ...(options.onDownload ? { onDownload: options.onDownload } : {}),
    });
    return {
        model,
        async warmup() {
            await getExtractor(model, runtime());
        },
        async embed(query, signal) {
            const text = (query ?? "").trim();
            if (!text) throw new Error("embedQuery: the query is empty");
            const { data } = await embedTexts([instruction + text], model, runtime(signal));
            return data;
        },
    };
}

const embedders = new Map<string, QueryEmbedder>();

/** One-shot form of {@link createQueryEmbedder} (the embedder is cached per model and model base). */
export function embedQuery(query: string, options: QueryEmbedderOptions = {}): Promise<Float32Array> {
    const key = `${resolveEmbedModel(options.model).id}|${options.modelBase ?? ""}|${options.instruction ?? ""}`;
    let e = embedders.get(key);
    if (!e) embedders.set(key, (e = createQueryEmbedder(options)));
    return e.embed(query);
}
