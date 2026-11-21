// T3 runtime glue with a fake transformers.js: model sharing, download progress,
// cancellation, eviction, streaming generation, and the slots' WebGPU gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
    class InterruptableStoppingCriteria {
        interrupted = false;
        interrupt() {
            this.interrupted = true;
        }
    }
    class TextStreamer {
        constructor(
            public tok: unknown,
            public opts: { callback_function: (s: string) => void; token_callback_function: (ids: bigint[]) => void },
        ) {}
    }
    const env = {
        backends: { onnx: { wasm: {} as Record<string, unknown> } },
        remoteHost: "https://huggingface.co/",
    } as Record<string, any>;
    return { InterruptableStoppingCriteria, TextStreamer, env, LogLevel: { ERROR: 40 }, imports: 0 };
});

vi.mock("@huggingface/transformers", () => {
    fake.imports++;
    return fake;
});

import type { EdgeContext } from "../../src/context.js";
import { LFM25_350M, QWEN35_VL, GLM_OCR, EMBEDDING_GEMMA_2 } from "../../src/ml/catalog.js";
import { generateText } from "../../src/ml/generate.js";
import { CACHE_KEY, MAX_RESIDENT, ORT_WASM, disposeAll, loadRuntime, withModel } from "../../src/ml/runtime.js";
import { WEBGPU_MISSING } from "../../src/ml/webgpu.js";
import { impls, methods } from "../../src/index.js";

function ctx(signal = new AbortController().signal) {
    const rec = { progress: [] as { fraction?: number; message?: string }[], downloads: [] as { loaded: number; total?: number; label: string }[] };
    const c: EdgeContext = {
        signal,
        onProgress: (p) => rec.progress.push(p),
        onDownload: (p) => rec.downloads.push(p),
        resolveAsset: (rel) => `https://scan.example.com/plugins/edge/dist/${rel}`,
        params: {},
        modelBase: "https://scan.example.com/models/",
    };
    return Object.assign(c, { rec });
}

const variant = LFM25_350M.f16;

afterEach(async () => {
    await disposeAll();
});

describe("transformers.js configuration", () => {
    it("fetches only from the model base and the plugin's own ORT wasm, caching in the Cache API", async () => {
        const tf = await loadRuntime(ctx());
        expect(tf.env.allowLocalModels).toBe(false);
        expect(tf.env.allowRemoteModels).toBe(true);
        expect(tf.env.remoteHost).toBe("https://scan.example.com/models/");
        expect(tf.env.remotePathTemplate).toBe("{model}/");
        expect(tf.env.cacheKey).toBe(CACHE_KEY);
        expect(tf.env.backends.onnx.wasm!.wasmPaths).toEqual({
            mjs: `https://scan.example.com/plugins/edge/dist/assets/ort/${ORT_WASM.mjs}`,
            wasm: `https://scan.example.com/plugins/edge/dist/assets/ort/${ORT_WASM.wasm}`,
        });
        // imported once, however many calls
        await loadRuntime(ctx());
        expect(fake.imports).toBe(1);
    });
});

describe("withModel", () => {
    it("loads once for concurrent callers, forwards download progress, and reuses the model", async () => {
        let loads = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const spec = {
            model: LFM25_350M,
            variant,
            load: async (_tf: unknown, progress: (p: any) => void) => {
                loads++;
                progress({ status: "progress", file: "onnx/model_q4f16.onnx_data", loaded: 5, total: 10 });
                await gate;
                progress({ status: "progress_total", loaded: 10, total: 10 });
                return { value: "MODEL", dispose: () => {} };
            },
        };
        const a = ctx();
        const b = ctx();
        const pa = withModel(a, spec, async (v) => `${v}:a`);
        const pb = withModel(b, spec, async (v) => `${v}:b`);
        await vi.waitFor(() => expect(a.rec.downloads.length).toBeGreaterThan(0));
        release();
        expect(await Promise.all([pa, pb])).toEqual(["MODEL:a", "MODEL:b"]);
        expect(loads).toBe(1);
        expect(a.rec.downloads.at(-1)).toEqual({ loaded: 10, total: 10, label: "LFM2.5-350M · onnx/model_q4f16.onnx_data" });
        expect(b.rec.downloads.at(-1)).toMatchObject({ loaded: 10, total: 10 });
        expect(a.rec.progress[0]!.message).toMatch(/^downloading LFM2.5-350M \(~259 MB, first run only/);
        // resident: no second load, no download events
        const c = ctx();
        expect(await withModel(c, spec, async (v) => v)).toBe("MODEL");
        expect(loads).toBe(1);
        expect(c.rec.downloads).toEqual([]);
    });

    it("an aborted caller stops waiting at once; the download is cancelled when nobody waits", async () => {
        const fetched: (AbortSignal | undefined)[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
            const signal = init?.signal ?? undefined;
            fetched.push(signal);
            return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
        }) as typeof fetch;
        try {
            const tf = await loadRuntime(ctx());
            const spec = {
                model: GLM_OCR,
                variant: GLM_OCR.f16,
                load: async () => {
                    // what transformers.js does: fetch a file under the model's repo dir
                    await tf.env.fetch("https://scan.example.com/models/onnx-community/GLM-OCR-ONNX/onnx/vision_encoder_q4f16.onnx_data");
                    return { value: 1, dispose: () => {} };
                },
            };
            const ac1 = new AbortController();
            const ac2 = new AbortController();
            const p1 = withModel(ctx(ac1.signal), spec, async (v) => v);
            const p2 = withModel(ctx(ac2.signal), spec, async (v) => v);
            await vi.waitFor(() => expect(fetched).toHaveLength(1));
            ac1.abort(new DOMException("cancelled", "AbortError"));
            await expect(p1).rejects.toThrow("cancelled");
            expect(fetched[0]!.aborted).toBe(false); // p2 still waits for the same download
            ac2.abort(new DOMException("cancelled too", "AbortError"));
            await expect(p2).rejects.toThrow("cancelled too");
            expect(fetched[0]!.aborted).toBe(true);
            // other URLs are fetched without the model's signal
            void tf.env.fetch("https://scan.example.com/other");
            expect(fetched).toHaveLength(2);
            expect(fetched[1]).toBeUndefined();
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it("wraps load failures with the model and URL", async () => {
        const spec = {
            model: QWEN35_VL,
            variant: QWEN35_VL.f16,
            load: async () => {
                throw new Error("404 Not Found");
            },
        };
        await expect(withModel(ctx(), spec, async () => 0)).rejects.toThrow(
            "could not load Qwen3.5-0.8B from https://scan.example.com/models/onnx-community/Qwen3.5-0.8B-ONNX/: 404 Not Found",
        );
    });

    it(`keeps at most ${MAX_RESIDENT} models on the GPU, disposing the least recently used idle one`, async () => {
        const disposed: string[] = [];
        const spec = (m: typeof LFM25_350M) => ({
            model: m,
            variant: m.f16,
            load: async () => ({ value: m.id, dispose: () => disposed.push(m.id) }),
        });
        await withModel(ctx(), spec(LFM25_350M), async (v) => v);
        await withModel(ctx(), spec(EMBEDDING_GEMMA_2), async (v) => v);
        expect(disposed).toEqual([]);
        await withModel(ctx(), spec(GLM_OCR), async (v) => v);
        expect(disposed).toEqual(["lfm2.5-350m"]);
    });
});

describe("generateText", () => {
    function fakeModel(tokens: string[], opts: { onStep?: (i: number) => void } = {}) {
        return {
            async generate(args: { streamer: any; stopping_criteria: { interrupted: boolean }[]; max_new_tokens: number; [k: string]: unknown }) {
                const seen = { args };
                let n = 0;
                for (const t of tokens) {
                    if (args.stopping_criteria[0]!.interrupted || n >= args.max_new_tokens) break;
                    opts.onStep?.(n);
                    args.streamer.opts.token_callback_function([1n]);
                    args.streamer.opts.callback_function(t);
                    n++;
                    await new Promise((r) => setTimeout(r, 1));
                }
                (fakeModel as any).lastArgs = seen.args;
                return { n, sequences: { slice: () => ({ n }) } };
            },
        };
    }
    const tokenizer = (tokens: string[]) => ({ batch_decode: (s: { n: number }) => [tokens.slice(0, s.n).join("")] });
    const inputs = { input_ids: { dims: [1, 7], slice: () => null as never } };

    it("streams tokens into progress and returns only the new text", async () => {
        const tf = await loadRuntime(ctx());
        const toks = ["这", "是", "一", "张", "图"];
        const c = ctx();
        const r = await generateText(tf, c, {
            model: fakeModel(toks),
            tokenizer: tokenizer(toks),
            inputs: inputs as never,
            maxNewTokens: 64,
            sampling: { do_sample: false },
            label: "describing",
        });
        expect(r).toEqual({ text: "这是一张图", tokens: 5, promptTokens: 7 });
        expect(c.rec.progress[0]).toEqual({ fraction: 0, message: "reading the input (7 tokens)" });
        expect(c.rec.progress.at(-1)!.message).toBe("describing: 5 tokens · …这是一张图");
        const args = (fakeModel as any).lastArgs;
        expect(args.max_new_tokens).toBe(64);
        expect(args.do_sample).toBe(false);
    });

    it("stops at the next token on cancel and rethrows the abort", async () => {
        const tf = await loadRuntime(ctx());
        const ac = new AbortController();
        const toks = Array.from({ length: 100 }, (_, i) => `t${i}`);
        let steps = 0;
        const p = generateText(tf, ctx(ac.signal), {
            model: fakeModel(toks, {
                onStep: (i) => {
                    steps = i + 1;
                    if (i === 3) ac.abort(new DOMException("stop", "AbortError"));
                },
            }),
            tokenizer: tokenizer(toks),
            inputs: inputs as never,
            maxNewTokens: 100,
            sampling: { do_sample: false },
        });
        await expect(p).rejects.toThrow("stop");
        expect(steps).toBe(4);
    });
});

describe("T3 slots without WebGPU (Node has no navigator.gpu)", () => {
    const image = { bytesBase64: "iVBORw0KGgo=", filename: "a.png", mime: "image/png" };
    beforeEach(() => {
        expect((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu).toBeUndefined();
    });

    it.each([
        ["imageGenText", { text: "描述", image }],
        ["ocrImageGlm", { image }],
        ["embedImage", { image }],
        ["genText", { text: "合同金额 100 万元。" }],
    ] as const)("%s fails clearly", async (name, input) => {
        const out = await (impls as Record<string, (i: unknown, c: EdgeContext) => Promise<{ success: boolean; error?: string }>>)[name]!(input, ctx());
        expect(out).toEqual({ success: false, error: WEBGPU_MISSING });
    });

    it("rethrows a cancellation instead of reporting a failure", async () => {
        const ac = new AbortController();
        ac.abort(new DOMException("cancelled", "AbortError"));
        await expect(impls.genText({ text: "x" }, ctx(ac.signal))).rejects.toThrow("cancelled");
    });

    it("the engine methods pass model and params through to the slot", async () => {
        const out = await methods.genText(
            { text: "x" },
            {
                nodeSlot: "gen-text",
                model: "lfm2.5-350m",
                params: { max_new_tokens: 10 },
                signal: new AbortController().signal,
                progress: () => {},
                modelDownload: () => {},
            },
        );
        expect(out).toEqual({ success: false, error: WEBGPU_MISSING });
    });
});
