/**
 * Text embeddings with transformers.js, on the wasm EP. Shared by the `embed-text`
 * slot (documents, no instruction) and the host-side `embedQuery` (queries, with the
 * model's query instruction). Pooling per model (`EmbedModel.pooling`):
 *  - `cls`: the first token's hidden state, then L2 normalization, as the BGE and
 *    granite authors prescribe (not mean pooling);
 *  - `model`: the ONNX graph's own `sentence_embedding` (harrier: last non-padding
 *    token, read from the attention mask), then L2 normalization.
 */
import { throwIfAborted } from "../util/errors.js";
import type { EmbedModel } from "./models.js";
import { downloadReporter, loadTransformers, type MlRuntime } from "./transformers.js";
import { requireWebGPU } from "./webgpu.js";

interface Tensor {
    dims: number[];
    data: Float32Array;
    dispose?(): void;
}
type Tokenizer = (texts: string[], options: { padding: true; truncation: true; max_length?: number }) => Record<string, unknown>;
type Extractor = ((texts: string[], options: { pooling: "cls"; normalize: true }) => Promise<Tensor>) & {
    dispose?(): Promise<void>;
    tokenizer: Tokenizer;
    model: (inputs: Record<string, unknown>) => Promise<Record<string, Tensor>>;
};

/** L2-normalize every row of a row-major matrix in place. */
export function normalizeRowsL2(data: Float32Array, dims: number): Float32Array {
    for (let r = 0; r < data.length / dims; r++) {
        let s = 0;
        for (let i = r * dims; i < (r + 1) * dims; i++) s += data[i]! * data[i]!;
        const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
        for (let i = r * dims; i < (r + 1) * dims; i++) data[i] = data[i]! * inv;
    }
    return data;
}

/** One batch → `[n × dims]` L2-normalized rows, with the model's pooling. */
async function embedBatch(extractor: Extractor, model: EmbedModel, texts: string[]): Promise<Tensor> {
    if (model.pooling === "cls") return extractor(texts, { pooling: "cls", normalize: true });
    const inputs = extractor.tokenizer(texts, { padding: true, truncation: true, max_length: model.maxTokens });
    const out = await extractor.model(inputs);
    for (const [k, t] of Object.entries(out)) if (k !== "sentence_embedding") t.dispose?.();
    const e = out.sentence_embedding;
    if (!e) throw new Error(`${model.id}: the ONNX graph has no sentence_embedding output`);
    normalizeRowsL2(e.data, e.dims[e.dims.length - 1]!);
    return e;
}

const extractors = new Map<string, Promise<Extractor>>();

/** One warm pipeline per (model base, model), kept for the worker's lifetime. */
export function getExtractor(model: EmbedModel, rt: MlRuntime): Promise<Extractor> {
    const key = `${rt.modelBase}|${model.id}`;
    let p = extractors.get(key);
    if (!p) {
        p = (async () => {
            if (model.device === "webgpu") await requireWebGPU();
            const tf = await loadTransformers(rt);
            const make = tf.pipeline as unknown as (task: string, model: string, options: object) => Promise<Extractor>;
            return make("feature-extraction", model.repo, {
                dtype: model.dtype,
                device: model.device,
                progress_callback: downloadReporter(rt, model.id, model.repo),
            });
        })();
        extractors.set(key, p);
        p.catch(() => extractors.delete(key));
    }
    return p;
}

export interface EmbedResult {
    dims: number;
    count: number;
    /** Row-major, `count × dims`, every row L2-normalized. */
    data: Float32Array;
}

/**
 * Embed `texts` in batches, in input order. Texts are batched by length (less padding),
 * and `onBatch(done, total)` reports after every batch. Cancellation is checked between batches.
 */
export async function embedTexts(
    texts: readonly string[],
    model: EmbedModel,
    rt: MlRuntime,
    onBatch?: (done: number, total: number) => void,
): Promise<EmbedResult> {
    const extractor = await getExtractor(model, rt);
    const n = texts.length;
    const order = texts.map((_, i) => i).sort((a, b) => texts[a]!.length - texts[b]!.length);
    let dims = model.dims;
    let data = new Float32Array(n * dims);
    for (let start = 0; start < n; start += model.batchSize) {
        if (rt.signal) throwIfAborted(rt.signal);
        const idx = order.slice(start, start + model.batchSize);
        const out = await embedBatch(
            extractor,
            model,
            idx.map((i) => texts[i]!),
        );
        const d = out.dims[out.dims.length - 1]!;
        if (d !== dims) {
            // The model's real width wins over the table (a re-exported repo, say).
            if (start > 0) throw new Error(`embedding width changed mid-run (${dims} → ${d})`);
            dims = d;
            data = new Float32Array(n * dims);
        }
        idx.forEach((orig, row) => data.set(out.data.subarray(row * dims, (row + 1) * dims), orig * dims));
        out.dispose?.();
        onBatch?.(Math.min(start + model.batchSize, n), n);
    }
    return { dims, count: n, data };
}

/** Rows of a row-major matrix as views (no copy). */
export function rows(data: Float32Array, dims: number): Float32Array[] {
    const out: Float32Array[] = [];
    for (let i = 0; i < data.length / dims; i++) out.push(data.subarray(i * dims, (i + 1) * dims));
    return out;
}
