// The whole browser path: TongFlow's worker edge executor loads dist/index.js in a
// module Worker, runWorkflow schedules file → render-pages → (x-expand-each) pages,
// and the page PNGs land in the asset store as file refs.
import { MemoryAssetStore, runWorkflow } from "tongflow/engine";
import { createWorkerEdgeExecutor } from "tongflow/engine/browser";
import { describe, expect, it } from "vitest";
import { imageSize } from "./harness.js";

const ID = "tongflow-edge-essentials";
const registry = {
    plugins: {
        [ID]: {
            localSubdir: ID,
            entryFile: "dist/index.js",
            needsDeploy: false,
            runtime: "browser" as const,
            methodsByNodeSlot: {
                "parse-document": { methodName: "parseDocument" },
                "render-pages": { methodName: "renderPages" },
            },
        },
    },
};

const workflow = {
    name: "render",
    version: "1.0",
    exportedAt: "2026-11-21T00:00:00.000Z",
    inputs: [],
    outputs: [{ name: "pages", type: "image", nodeId: "pages", field: "fileKeys" }],
    dataNodes: [
        { id: "doc", type: "fileNode", dataType: "file", isInput: false, staticData: { fileKeys: ["uploads/report.pdf"] }, level: 0 },
        { id: "pages", type: "imageNode", dataType: "image", isInput: false, level: 2 },
    ],
    executableNodes: [
        {
            id: "r",
            type: "renderPagesNode",
            feature: "render-pages",
            pluginId: ID,
            bindings: {
                document: {
                    kind: "handle",
                    sources: [{ fromNodeId: "doc", fromField: "fileKeys" }],
                    targetHandle: "in:document",
                    consumerShape: "scalar",
                },
            },
            batchField: "document",
            outputs: [
                {
                    sourceField: "pages",
                    nodeType: "imageNode",
                    dataField: "fileKeys",
                    expandEach: true,
                    itemValuePath: "file_key",
                    downstreamDataNodeId: "pages",
                },
            ],
            dependencies: ["doc"],
            level: 1,
        },
    ],
    executionLevels: [["r"]],
    dataNodeEdges: [
        { source: "doc", target: "r" },
        { source: "r", target: "pages" },
    ],
    originalFlow: { nodes: [], edges: [] },
};

describe("TongFlow engine + worker edge executor (Chromium)", () => {
    it("render-pages: uploaded PDF → stored PNG page refs", async () => {
        const pdf = new Uint8Array(await (await fetch("/test/fixtures/report.pdf")).arrayBuffer());
        const store = new MemoryAssetStore({ "uploads/report.pdf": pdf });
        const executor = createWorkerEdgeExecutor({
            registry: registry as never,
            resolveModuleUrl: (_id, cfg) => new URL(`/${cfg.entryFile}`, location.origin),
        });
        try {
            const result = await runWorkflow(workflow as never, { executor, store });
            expect(result.errors).toEqual([]);
            expect(result.status).toBe("success");
            const keys = result.outputsByName.pages ?? [];
            expect(keys).toHaveLength(1);
            const png = await store.get(keys[0]!);
            expect(png).not.toBeNull();
            const size = await imageSize(png!, "image/png");
            expect(Math.abs(size.width - 1240)).toBeLessThanOrEqual(4);
            // The plugin returned bytesBase64; the engine kept only a ref.
            const page = (result.outputs.r?.pages as { file_key: string }[])[0]!;
            expect(page.file_key).toBe(keys[0]);
        } finally {
            executor.dispose();
        }
    });
});
