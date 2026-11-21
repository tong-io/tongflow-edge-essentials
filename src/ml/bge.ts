/**
 * BGE zh v1.5 text embeddings with transformers.js: CLS pooling + L2 normalization,
 * as the BGE authors prescribe (not mean pooling). Shared by the `embed-text` slot
 * (documents, no instruction) and the host-side `embedQuery` (queries, with the
 * BGE query instruction).
 */
import { throwIfAborted } from "../util/errors.js";
import type { EmbedModel } from "./models.js";
import { downloadReporter, loadTransformers, type MlRuntime } from "./transformers.js";

interface Tensor {
    dims: number[];
    data: Float32Array;
    dispose?(): void;
}
type Extractor = ((texts: string[], options: { pooling: "cls"; normalize: true }) => Promise<Tensor>) & {
    dispose?(): Promise<void>;
};

const extractors = new Map<string, Promise<Extractor>>();

/** One warm pipeline per (model base, model), kept for the worker's lifetime. */
export function getExtractor(model: EmbedModel, rt: MlRuntime): Promise<Extractor> {
    const key = `${rt.modelBase}|${model.id}`;
    let p = extractors.get(key);
    if (!p) {
        p = (async () => {
            const tf = await loadTransformers(rt);
            const make = tf.pipeline as unknown as (task: string, model: string, options: object) => Promise<Extractor>;
            return make("feature-extraction", model.repo, {
                dtype: model.dtype,
                device: "wasm",
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
        const out = await extractor(
            idx.map((i) => texts[i]!),
            { pooling: "cls", normalize: true },
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
