// End to end through the real TongFlow engine: the *built* plugin (dist/index.js,
// default export = defineEdgePlugin) run by createInProcessEdgeExecutor + runWorkflow,
// with the uploaded file materialized from a MemoryAssetStore.
import { existsSync, readFileSync } from "node:fs";
import { MemoryAssetStore, createInProcessEdgeExecutor, runWorkflow, type EngineEvent } from "tongflow/engine";
import { describe, expect, it } from "vitest";

const ID = "tongflow-edge-essentials";
const root = new URL("../../", import.meta.url);
const distEntry = new URL("dist/index.js", root);
const manifest = JSON.parse(readFileSync(new URL("tongflow.plugin.json", root), "utf8")) as {
    entry: string;
    slots: { nodeSlot: string; method: string }[];
};

/** The registry entry the scanner builds from tongflow.plugin.json. */
const registry = {
    plugins: {
        [ID]: {
            localSubdir: ID,
            entryFile: manifest.entry,
            needsDeploy: false,
            runtime: "browser" as const,
            methodsByNodeSlot: Object.fromEntries(manifest.slots.map((s) => [s.nodeSlot, { methodName: s.method }])),
        },
    },
};

/** file node (uploads/<name>) → parse-document → text node. */
function parseWorkflow(fileKey: string) {
    return {
        name: "parse",
        version: "1.0",
        exportedAt: "2026-11-21T00:00:00.000Z",
        inputs: [],
        outputs: [{ name: "output_text", type: "text", nodeId: "text", field: "texts" }],
        dataNodes: [
            { id: "doc", type: "fileNode", dataType: "file", isInput: false, staticData: { fileKeys: [fileKey] }, level: 0 },
            { id: "text", type: "textNode", dataType: "text", isInput: false, level: 2 },
        ],
        executableNodes: [
            {
                id: "p",
                type: "parseDocumentNode",
                feature: "parse-document",
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
                    { sourceField: "text", nodeType: "textNode", dataField: "texts", expandEach: false, downstreamDataNodeId: "text" },
                ],
                dependencies: ["doc"],
                level: 1,
            },
        ],
        executionLevels: [["p"]],
        dataNodeEdges: [
            { source: "doc", target: "p" },
            { source: "p", target: "text" },
        ],
        originalFlow: { nodes: [], edges: [] },
    };
}

describe.runIf(existsSync(distEntry))("TongFlow engine (in-process executor) running the built plugin", () => {
    it("parse-document on a .docx: file node → parse-document → text node", async () => {
        let loads = 0;
        const executor = createInProcessEdgeExecutor({
            registry: registry as never,
            loadPlugin: async (pluginId, cfg) => {
                loads++;
                expect(pluginId).toBe(ID);
                return import(/* @vite-ignore */ new URL(cfg.entryFile as string, root).href);
            },
        });
        const store = new MemoryAssetStore({
            "uploads/report.docx": new Uint8Array(readFileSync(new URL("test/fixtures/report.docx", root))),
        });
        const events: EngineEvent[] = [];
        const result = await runWorkflow(parseWorkflow("uploads/report.docx") as never, {
            executor,
            store,
            onEvent: (e) => events.push(e),
        });
        expect(result.errors).toEqual([]);
        expect(result.status).toBe("success");
        const text = result.outputsByName.output_text?.[0] ?? "";
        expect(text).toMatch(/^# 季度报告 Quarterly Report/m);
        expect(text).toMatch(/\| 华东 \| 1200 \|/);
        expect(result.outputs.p?.success).toBe(true);
        expect(loads).toBe(1);
        // Our progress reaches the engine as plugin_progress events.
        expect(events.some((e) => e.type === "plugin_progress")).toBe(true);
    });

    it("an unsupported file fails only that node, with the plugin's error", async () => {
        const executor = createInProcessEdgeExecutor({
            registry: registry as never,
            loadPlugin: (_id, cfg) => import(/* @vite-ignore */ new URL(cfg.entryFile as string, root).href),
        });
        const store = new MemoryAssetStore({ "uploads/blob.bin": new Uint8Array([0, 1, 2, 3, 250, 251, 0, 0, 7]) });
        const result = await runWorkflow(parseWorkflow("uploads/blob.bin") as never, { executor, store });
        expect(result.status).toBe("failed");
        expect(result.errors.join("\n")).toMatch(/unsupported document format/);
    });
});
