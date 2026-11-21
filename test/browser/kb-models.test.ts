// Real inference: bge-small-zh-v1.5 (q8) through transformers.js + onnxruntime-web, in the
// built plugin's module worker, loaded from a local model base. Runs only when
// EDGE_MODELS_DIR points at a directory holding Xenova/bge-small-zh-v1.5/… (it is served at
// /models/ by vitest.config.ts); nothing is downloaded from the internet here.
import { MemoryAssetStore, runWorkflow } from "tongflow/engine";
import { createWorkerEdgeExecutor } from "tongflow/engine/browser";
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { fromBase64 } from "./harness.js";

declare const __EDGE_MODELS__: string;
declare const __SCANALL_KB__: string;

const HAS_MODELS = Boolean(__EDGE_MODELS__);
if (!HAS_MODELS) {
    console.warn("[kb-models] skipped: set EDGE_MODELS_DIR to a directory with Xenova/bge-small-zh-v1.5 to run real inference");
}

type Msg = { type: string; id?: number; output?: any; message?: string; percent?: number; loaded?: number; total?: number; file?: string; model?: string };

function spawn(): { worker: Worker; ready: Promise<void> } {
    // The model base rides on the entry URL, as a host passes it.
    const worker = new Worker(new URL("/dist/index.js?modelBase=/models/", location.origin), { type: "module" });
    const ready = new Promise<void>((resolve, reject) => {
        worker.addEventListener("message", (e: MessageEvent<Msg>) => e.data?.type === "ready" && resolve());
        worker.addEventListener("error", (e) => reject(new Error(e.message)), { once: true });
    });
    return { worker, ready };
}

let seq = 0;
function invoke(worker: Worker, method: string, nodeSlot: string, input: object, model?: string) {
    const id = ++seq;
    const progress: Msg[] = [];
    const downloads: Msg[] = [];
    return new Promise<{ out: any; progress: Msg[]; downloads: Msg[] }>((resolve, reject) => {
        const on = (e: MessageEvent<Msg>) => {
            const m = e.data;
            if (m.id !== id) return;
            if (m.type === "progress") progress.push(m);
            else if (m.type === "model-download") downloads.push(m);
            else {
                worker.removeEventListener("message", on);
                if (m.type === "error") reject(new Error(m.message));
                else resolve({ out: m.output, progress, downloads });
            }
        };
        worker.addEventListener("message", on);
        worker.postMessage({ type: "invoke", id, method, nodeSlot, input, ...(model ? { model } : {}) });
    });
}

function unpack(bytesBase64: string) {
    const b = fromBase64(bytesBase64);
    const dv = new DataView(b.buffer);
    const dims = dv.getUint32(4, true);
    const count = dv.getUint32(8, true);
    const data = new Float32Array(b.buffer.slice(12));
    return { magic: new TextDecoder().decode(b.subarray(0, 4)), dims, count, row: (i: number) => data.subarray(i * dims, (i + 1) * dims) };
}
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

const DOCS = [
    "甲方应在收到发票后三十日内以银行转账方式支付合同价款。",
    "乙方逾期付款的，每日按未付金额的千分之一支付违约金。",
    "本设备的额定电压为220伏，使用前请确认电源接地良好。",
];

describe.runIf(HAS_MODELS)("embed-text with bge-small-zh-v1.5 q8 (real inference, Chromium)", () => {
    const timings: Record<string, number | string> = {};

    it("embeds in the worker: TFV1, 512 dims, normalized, semantically sensible; downloads reported", async () => {
        const { worker, ready } = spawn();
        await ready;
        const t0 = performance.now();
        const cold = await invoke(worker, "embedText", "embed-text", { texts: DOCS });
        timings.coldMs = Math.round(performance.now() - t0);
        expect(cold.out.error).toBeUndefined();
        expect(cold.out.success).toBe(true);
        expect(cold.out.vectors.filename).toBe("vectors.tfv1");
        const v = unpack(cold.out.vectors.bytesBase64);
        expect([v.magic, v.dims, v.count]).toEqual(["TFV1", 512, 3]);
        for (let i = 0; i < 3; i++) expect(Math.abs(dot(v.row(i), v.row(i)) - 1)).toBeLessThan(1e-3);
        // Two payment clauses are closer to each other than to the voltage note.
        expect(dot(v.row(0), v.row(1))).toBeGreaterThan(dot(v.row(0), v.row(2)));
        // Downloads: the ort wasm and the model files, all through the model base / plugin assets.
        const files = new Set(cold.downloads.map((d) => d.file));
        expect(files.has("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm")).toBe(true);
        expect(files.has("Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx")).toBe(true);
        expect(cold.downloads.filter((d) => d.file?.endsWith(".onnx")).every((d) => d.model === "bge-small-zh-v1.5")).toBe(true);
        expect(cold.progress.at(-1)).toMatchObject({ message: "embedded 3/3", percent: 100 });
        const requested: string[] = await (await fetch("/__model-requests")).json();
        timings.modelFilesRequested = requested.join(", ");

        // Warm: the pipeline stays loaded in the worker.
        const batch = Array.from({ length: 64 }, (_, i) => `${DOCS[i % 3]}（第${i}条）`);
        const t1 = performance.now();
        const warm = await invoke(worker, "embedText", "embed-text", { texts: batch });
        timings.warm64Ms = Math.round(performance.now() - t1);
        expect(unpack(warm.out.vectors.bytesBase64).count).toBe(64);
        expect(warm.progress.map((p) => p.message)).toContain("embedded 16/64");
        expect(warm.downloads).toEqual([]);
        // Realistic chunks: 16 × ≈480 characters (chunk-text's default size).
        const long = Array.from({ length: 16 }, (_, i) => `第${i}条：` + DOCS.join("").repeat(6).slice(0, 475));
        const t2 = performance.now();
        const big = await invoke(worker, "embedText", "embed-text", { texts: long });
        timings.warm16x480charsMs = Math.round(performance.now() - t2);
        expect(unpack(big.out.vectors.bytesBase64).count).toBe(16);
        timings.crossOriginIsolated = String(crossOriginIsolated);
        worker.terminate();
        await commands.writeFile("test-results/kb-timings.json", JSON.stringify(timings, null, 2));
        console.info("[kb-models] timings", JSON.stringify(timings));
    });

    it("embedQuery (dist/embed-query.js) matches the worker's document vectors and ranks the right clause first", async () => {
        const { createQueryEmbedder } = await import(/* @vite-ignore */ new URL("/dist/embed-query.js", location.origin).href);
        const plain = createQueryEmbedder({ instruction: "", modelBase: "/models/" });
        const t0 = performance.now();
        await plain.warmup();
        timings.queryWarmupMs = Math.round(performance.now() - t0);
        const { worker, ready } = spawn();
        await ready;
        const docs = unpack((await invoke(worker, "embedText", "embed-text", { texts: DOCS })).out.vectors.bytesBase64);
        worker.terminate();
        // Same model, same settings: without the instruction the host gets the document vector back.
        // Not bit-identical: q8 is dynamically quantized (activation scales are computed per call
        // over the whole padded batch), so a vector varies slightly with its batch.
        const same = await plain.embed(DOCS[0]!);
        timings.queryVsDocCosine = dot(same, docs.row(0)).toFixed(4);
        expect(dot(same, docs.row(0))).toBeGreaterThan(0.99);

        const q = createQueryEmbedder({ modelBase: "/models/" });
        const t1 = performance.now();
        const qv: Float32Array = await q.embed("合同怎么付款？");
        timings.queryMs = Math.round(performance.now() - t1);
        expect(qv).toHaveLength(512);
        const scores = [0, 1, 2].map((i) => dot(qv, docs.row(i)));
        expect(scores[0]).toBeGreaterThan(scores[2]!);
        await commands.writeFile("test-results/kb-timings.json", JSON.stringify(timings, null, 2));
        console.info("[kb-models] timings", JSON.stringify(timings));
    });

    it.runIf(Boolean(__SCANALL_KB__))("whole ingest: text → chunk-text → embed-text → kb-write, tapped and committed into @scanall/kb", async () => {
        const { tapKbWrite } = await import(/* @vite-ignore */ new URL("/dist/kb-host.js", location.origin).href);
        const { createQueryEmbedder } = await import(/* @vite-ignore */ new URL("/dist/embed-query.js", location.origin).href);
        const { openKb } = await import(/* @vite-ignore */ __SCANALL_KB__);
        const ID = "tongflow-edge-essentials";
        const registry = {
            plugins: {
                [ID]: {
                    localSubdir: ID,
                    entryFile: "dist/index.js",
                    needsDeploy: false,
                    runtime: "browser" as const,
                    methodsByNodeSlot: {
                        "chunk-text": { methodName: "chunkText" },
                        "embed-text": { methodName: "embedText", models: ["bge-small-zh-v1.5", "bge-base-zh-v1.5"] },
                        "kb-write": { methodName: "kbWrite" },
                    },
                },
            },
        };
        const text = [
            "# 采购合同",
            "## 第一条 付款方式",
            DOCS[0]! + DOCS[1]!,
            "## 第二条 设备说明",
            DOCS[2]!,
            "| 型号 | 电压 |\n| --- | --- |\n| A-1 | 220V |",
        ].join("\n\n");
        const handle = (from: string, field: string, shape: "array" | "scalar", h: string) => ({
            kind: "handle",
            sources: [{ fromNodeId: from, fromField: field }],
            targetHandle: `in:${h}`,
            consumerShape: shape,
        });
        const workflow = {
            name: "ingest",
            version: "1.0",
            exportedAt: "2026-11-21T00:00:00.000Z",
            inputs: [],
            outputs: [{ name: "summary", type: "text", nodeId: "summary", field: "texts" }],
            dataNodes: [
                { id: "doc", type: "textNode", dataType: "text", isInput: false, staticData: { texts: [text] }, level: 0 },
                { id: "summary", type: "textNode", dataType: "text", isInput: false, level: 6 },
            ],
            executableNodes: [
                {
                    id: "c", type: "chunkTextNode", feature: "chunk-text", pluginId: ID,
                    bindings: { texts: handle("doc", "texts", "array", "texts"), max_chars: { kind: "config", value: 80 } },
                    outputs: [{ sourceField: "chunks", nodeType: "textNode", dataField: "texts", expandEach: false }],
                    dependencies: ["doc"], level: 1,
                },
                {
                    id: "e", type: "embedTextNode", feature: "embed-text", pluginId: ID,
                    bindings: { texts: handle("c", "chunks", "array", "texts") },
                    outputs: [{ sourceField: "vectors", nodeType: "fileNode", dataField: "fileKeys", expandEach: false, itemValuePath: "file_key" }],
                    dependencies: ["c"], level: 2,
                },
                {
                    id: "w", type: "kbWriteNode", feature: "kb-write", pluginId: ID,
                    bindings: {
                        chunks: handle("c", "chunks", "array", "chunks"),
                        vectors: handle("e", "vectors", "scalar", "vectors"),
                        source: { kind: "config", value: "采购合同.md" },
                    },
                    outputs: [{ sourceField: "text", nodeType: "textNode", dataField: "texts", expandEach: false, downstreamDataNodeId: "summary" }],
                    dependencies: ["c", "e"], level: 3,
                },
            ],
            executionLevels: [["c"], ["e"], ["w"]],
            dataNodeEdges: [],
            originalFlow: { nodes: [], edges: [] },
        };
        globalThis.__TONGFLOW_EDGE_CONFIG__ = undefined;
        const edge = createWorkerEdgeExecutor({
            registry: registry as never,
            resolveModuleUrl: (_id, cfg) => new URL(`/${cfg.entryFile}?modelBase=/models/`, location.origin),
        });
        const tap = tapKbWrite(edge);
        const t0 = performance.now();
        const result = await runWorkflow(workflow as never, { executor: tap.executor, store: new MemoryAssetStore() });
        timings.ingestRunMs = Math.round(performance.now() - t0);
        edge.dispose();
        expect(result.errors).toEqual([]);
        expect(result.status).toBe("success");
        const payload = tap.take();
        expect(payload.embedModel).toBe("bge-small-zh-v1.5");
        expect(payload.chunks.length).toBeGreaterThan(2);
        expect(payload.chunks.some((c: string) => c.includes("| A-1 | 220V |") && c.includes("| 型号 | 电压 |"))).toBe(true);

        // The host's part, as documented in the README.
        const kb = await openKb({ storage: "memory" });
        const tx = kb.beginIngest({ fileName: payload.source, mime: "text/markdown", size: text.length, embedModel: payload.embedModel });
        tx.add(payload.chunks, payload.vectors);
        const info = await tx.commit();
        expect(info).toMatchObject({ fileName: "采购合同.md", chunkCount: payload.chunks.length, dims: 512, embedModel: "bge-small-zh-v1.5" });
        const q = createQueryEmbedder({ model: info.embedModel, modelBase: "/models/" });
        const hits = await kb.search("逾期付款违约金", await q.embed("逾期付款违约金"), { k: 3 });
        expect(hits[0].text).toContain("违约金");
        timings.ingestChunks = payload.chunks.length;
        await commands.writeFile("test-results/kb-timings.json", JSON.stringify(timings, null, 2));
        console.info("[kb-models] timings", JSON.stringify(timings));
    });
});

describe.skipIf(HAS_MODELS)("embed-text real inference", () => {
    it.skip("skipped: EDGE_MODELS_DIR is not set (no models are downloaded in default test runs)", () => {});
});
