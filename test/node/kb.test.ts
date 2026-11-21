import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MemoryAssetStore, createInProcessEdgeExecutor, runWorkflow } from "tongflow/engine";
import { describe, expect, it } from "vitest";
import { packVectors, unpackVectors } from "../../src/kb/tfv1.js";
import { tapKbWrite } from "../../src/kb-host.js";
import { DEFAULT_EMBED_MODEL, resolveEmbedModel } from "../../src/ml/models.js";
import { impls } from "../../src/index.js";
import { applyEntryConfig, resolveModelBase } from "../../src/util/model-base.js";
import { nodeCtx } from "../helpers/node-ctx.js";

const root = new URL("../../", import.meta.url);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const vecAsset = (u: Uint8Array) => ({ bytesBase64: b64(u), filename: "vectors.tfv1" });
const unit = (dims: number, hot: number) => Float32Array.from({ length: dims }, (_, i) => (i === hot ? 1 : 0));

/**
 * `@scanall/kb` (the host's knowledge base) lives in the scanall repo. When it is checked
 * out next to us (or SCANALL_KB_DIR points at packages/kb), cross-check the TFV1 copy.
 */
const SCANALL_KB = process.env.SCANALL_KB_DIR ?? new URL("../../../ctsource/scanall/packages/kb/", root).pathname;
const scanallVectors = `${SCANALL_KB.replace(/\/?$/, "/")}src/vectors.ts`;

describe("TFV1 (copy of @scanall/kb/vectors)", () => {
    it("packs the documented layout", () => {
        const bytes = packVectors([Float32Array.of(1, -2), Float32Array.of(0.5, 3)]);
        expect(Buffer.from(bytes.subarray(0, 4)).toString("latin1")).toBe("TFV1");
        const dv = new DataView(bytes.buffer);
        expect([dv.getUint32(4, true), dv.getUint32(8, true), bytes.byteLength]).toEqual([2, 2, 12 + 16]);
        expect(dv.getFloat32(12 + 4, true)).toBe(-2);
        expect(unpackVectors(bytes).vectors.map((v) => Array.from(v))).toEqual([[1, -2], [0.5, 3]]);
    });

    // Skipped (not failed) when the scanall checkout is absent: set SCANALL_KB_DIR to its packages/kb.
    it.runIf(existsSync(scanallVectors))(`is byte-identical to @scanall/kb/vectors (${scanallVectors}), source and output`, async () => {
        expect(readFileSync(new URL("src/kb/tfv1.ts", root))).toEqual(readFileSync(scanallVectors));
        const theirs = (await import(/* @vite-ignore */ scanallVectors)) as typeof import("../../src/kb/tfv1.js");
        const vs = Array.from({ length: 7 }, (_, i) => Float32Array.from({ length: 512 }, (_, j) => Math.sin(i * 512 + j)));
        const ours = packVectors(vs);
        expect(theirs.packVectors(vs)).toEqual(ours);
        expect(theirs.unpackVectors(ours).vectors).toEqual(unpackVectors(ours).vectors);
        expect(theirs.packVectors([], 768)).toEqual(packVectors([], 768));
    });
});

describe("kb-write", () => {
    const chunks = ["第一段。", "第二段。", "第三段。"];
    const vectors = packVectors([unit(4, 0), unit(4, 1), unit(4, 2)]);

    it("validates and returns a JSON summary with the vectors' digest", async () => {
        const out = await impls.kbWrite({ chunks, vectors: vecAsset(vectors), source: " 采购合同.pdf " }, nodeCtx());
        expect(out.success).toBe(true);
        expect(JSON.parse(out.text!)).toEqual({
            source: "采购合同.pdf",
            chunkCount: 3,
            dims: 4,
            vectorsSha256: createHash("sha256").update(vectors).digest("hex"),
        });
    });

    it.each([
        ["count mismatch", { chunks: chunks.slice(0, 2) }, /2 chunks but 3 vectors/],
        ["no chunks", { chunks: [] }, /no chunks/],
        ["an empty chunk", { chunks: ["a", " ", "c"] }, /chunks\[1\] is empty/],
        ["no source", { source: "  " }, /source/],
        ["not TFV1", { vectors: { bytesBase64: b64(new TextEncoder().encode("hello world!!")) } }, /not a TFV1/],
        ["truncated TFV1", { vectors: vecAsset(vectors.subarray(0, vectors.length - 4)) }, /corrupt TFV1/],
        ["NaN", { vectors: vecAsset(packVectors([unit(4, 0), Float32Array.of(0, NaN, 0, 0), unit(4, 2)])) }, /non-finite/],
    ])("fails on %s", async (_name, patch, error) => {
        const out = await impls.kbWrite({ chunks, vectors: vecAsset(vectors), source: "a.pdf", ...patch } as never, nodeCtx());
        expect(out.success).toBe(false);
        expect(out.error).toMatch(error);
    });
});

describe("embed-text (no model needed for these)", () => {
    it("rejects empty input and unknown models before loading anything", async () => {
        expect((await impls.embedText({ texts: [] }, nodeCtx())).error).toMatch(/nothing to embed/);
        const ctx = { ...nodeCtx(), model: "text-embedding-3" };
        expect((await impls.embedText({ texts: ["你好"] }, ctx)).error).toMatch(/unknown embedding model 'text-embedding-3'/);
    });
    it("resolves model ids and repos, default first", () => {
        expect(resolveEmbedModel(undefined).id).toBe(DEFAULT_EMBED_MODEL);
        expect(resolveEmbedModel("Xenova/bge-base-zh-v1.5")).toMatchObject({ id: "bge-base-zh-v1.5", dims: 768 });
        const manifest = JSON.parse(readFileSync(new URL("tongflow.plugin.json", root), "utf8"));
        const slot = manifest.slots.find((s: { nodeSlot: string }) => s.nodeSlot === "embed-text");
        expect(slot.models[0]).toBe(DEFAULT_EMBED_MODEL);
        for (const m of slot.models) expect(resolveEmbedModel(m).id).toBe(m);
        const listed = JSON.parse(readFileSync(new URL("models.json", root), "utf8")) as { id: string; source: string }[];
        for (const m of slot.models) {
            expect(listed.find((x) => x.id === m)?.source).toBe(`modelscope:${resolveEmbedModel(m).repo}`);
        }
    });
});

describe("model base", () => {
    it("ctx, then the global config, then same-origin /models/", () => {
        const from = "https://app.example.com/plugins/edge/dist/";
        delete globalThis.__TONGFLOW_EDGE_CONFIG__;
        expect(resolveModelBase(undefined, from)).toBe("https://app.example.com/models/");
        applyEntryConfig("https://app.example.com/plugins/edge/dist/index.js?modelBase=%2Fweights");
        expect(resolveModelBase(undefined, from)).toBe("https://app.example.com/weights/");
        expect(resolveModelBase("https://oss.example.cn/m", from)).toBe("https://oss.example.cn/m/");
        // An explicit global config is not overridden by the entry URL.
        applyEntryConfig("https://app.example.com/plugins/edge/dist/index.js?modelBase=/other/");
        expect(resolveModelBase(undefined, from)).toBe("https://app.example.com/weights/");
        delete globalThis.__TONGFLOW_EDGE_CONFIG__;
    });
});

// ---- host side: tapKbWrite through the real engine ----

const ID = "tongflow-edge-essentials";
const registry = {
    plugins: {
        [ID]: {
            localSubdir: ID,
            entryFile: "src/index.ts",
            needsDeploy: false,
            runtime: "browser" as const,
            methodsByNodeSlot: {
                "chunk-text": { methodName: "chunkText" },
                "kb-write": { methodName: "kbWrite" },
            },
        },
    },
};

/** text node → chunk-text → kb-write ← file node (TFV1); source from config. */
function ingestWorkflow(texts: string[]) {
    return {
        name: "ingest",
        version: "1.0",
        exportedAt: "2026-11-21T00:00:00.000Z",
        inputs: [],
        outputs: [{ name: "summary", type: "text", nodeId: "summary", field: "texts" }],
        dataNodes: [
            { id: "doc", type: "textNode", dataType: "text", isInput: false, staticData: { texts }, level: 0 },
            { id: "vec", type: "fileNode", dataType: "file", isInput: false, staticData: { fileKeys: ["uploads/v.tfv1"] }, level: 0 },
            { id: "chunks", type: "textNode", dataType: "text", isInput: false, level: 2 },
            { id: "summary", type: "textNode", dataType: "text", isInput: false, level: 4 },
        ],
        executableNodes: [
            {
                id: "c",
                type: "chunkTextNode",
                feature: "chunk-text",
                pluginId: ID,
                bindings: {
                    texts: { kind: "handle", sources: [{ fromNodeId: "doc", fromField: "texts" }], targetHandle: "in:texts", consumerShape: "array" },
                    max_chars: { kind: "config", value: 500 },
                },
                outputs: [{ sourceField: "chunks", nodeType: "textNode", dataField: "texts", expandEach: false, downstreamDataNodeId: "chunks" }],
                dependencies: ["doc"],
                level: 1,
            },
            {
                id: "w",
                type: "kbWriteNode",
                feature: "kb-write",
                pluginId: ID,
                bindings: {
                    chunks: { kind: "handle", sources: [{ fromNodeId: "c", fromField: "chunks" }], targetHandle: "in:chunks", consumerShape: "array" },
                    vectors: { kind: "handle", sources: [{ fromNodeId: "vec", fromField: "fileKeys" }], targetHandle: "in:vectors", consumerShape: "scalar" },
                    source: { kind: "config", value: "报告.docx" },
                },
                outputs: [{ sourceField: "text", nodeType: "textNode", dataField: "texts", expandEach: false, downstreamDataNodeId: "summary" }],
                dependencies: ["c", "vec"],
                level: 3,
            },
        ],
        executionLevels: [["c"], ["w"]],
        dataNodeEdges: [],
        originalFlow: { nodes: [], edges: [] },
    };
}

describe("tapKbWrite (host side of kb-write, through runWorkflow)", () => {
    const inner = () =>
        createInProcessEdgeExecutor({
            registry: registry as never,
            loadPlugin: (_id, cfg) => import(/* @vite-ignore */ new URL(cfg.entryFile as string, root).href),
        });

    it("captures exactly what kb-write validated; the host commits it after a successful run", async () => {
        const vectors = packVectors([unit(8, 3), unit(8, 5)]);
        const tap = tapKbWrite(inner());
        const store = new MemoryAssetStore({ "uploads/v.tfv1": vectors });
        const result = await runWorkflow(ingestWorkflow(["第一部分。", "第二部分。"]) as never, { executor: tap.executor, store });
        // Two short parts make one chunk, but there are two vectors: kb-write refuses, nothing to commit.
        expect(result.status).toBe("failed");
        expect(result.errors.join()).toMatch(/1 chunks but 2 vectors/);
        expect(tap.take()).toBeNull();

        tap.reset();
        const long = Array.from({ length: 30 }, (_, i) => `这是第${i}句话，用来测试中文切块是否按照句子边界进行切分。`).join("");
        const ok = await runWorkflow(ingestWorkflow([long]) as never, {
            executor: tap.executor,
            store: new MemoryAssetStore({ "uploads/v.tfv1": packVectors([unit(8, 0), unit(8, 1)]) }),
        });
        expect(ok.status).toBe("success");
        const payload = tap.take();
        expect(payload).not.toBeNull();
        expect(payload!.source).toBe("报告.docx");
        expect(payload!.chunks).toEqual(ok.outputs.c!.chunks);
        expect(payload!.chunks).toHaveLength(2);
        expect(unpackVectors(payload!.vectors).count).toBe(2);
        expect(payload!.summary).toMatchObject({ source: "报告.docx", chunkCount: 2, dims: 8 });
        expect(payload!.embedModel).toBeUndefined(); // no embed-text in this run
        expect(JSON.parse(ok.outputsByName.summary![0]!)).toEqual(payload!.summary);
    });
});
