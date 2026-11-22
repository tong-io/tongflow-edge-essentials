// Alternative implementations (ticket 30, section A) against each slot's default, in the built
// worker over the engine protocol, on the plugin fixtures and the scanall demo samples.
//
// - parse-document alternatives are libraries bundled in dist/: they always run.
// - Model-backed alternatives need EDGE_MODELS_DIR (served at /models/, the default model base);
//   a model whose files are missing there is skipped. The WebGPU ones (image-gen-text) also
//   need the GPU flags vitest.config.ts passes with EDGE_MODELS_DIR.
// Run one file at a time: EDGE_MODELS_DIR=… npx vitest run --project browser test/browser/alternatives.test.ts
// Every measurement is collected and printed as one comparison table at the end.
import { afterAll, describe, expect, it } from "vitest";
import { call, fixture, fromBase64, startWorker, toBase64 } from "./harness.js";

declare const __EDGE_MODELS__: string;
declare const __EDGE_WEBGPU__: boolean;
declare const __DEMO_SAMPLES__: string;
const MODELS = Boolean(__EDGE_MODELS__);
const LONG = 600_000;

type Row = { slot: string; impl: string; input: string; cold?: number; warm?: number; result: string };
const rows: Row[] = [];
function record(r: Row) {
    rows.push(r);
    console.warn(`[alt] ${r.slot} · ${r.impl} · ${r.input}: cold ${r.cold ?? "-"} ms, warm ${r.warm ?? "-"} ms · ${r.result}`);
}

async function sample(name: string, mime?: string) {
    if (!__DEMO_SAMPLES__) return undefined;
    const res = await fetch(__DEMO_SAMPLES__ + encodeURIComponent(name));
    if (!res.ok) return undefined;
    return { bytesBase64: toBase64(new Uint8Array(await res.arrayBuffer())), filename: name, ...(mime ? { mime } : {}) };
}

async function hasModel(repo: string, file: string): Promise<boolean> {
    if (!MODELS) return false;
    const r = await fetch(`/models/${repo}/${file}`, { headers: { Range: "bytes=0-0" } });
    return r.ok;
}

/** cold = first call in a fresh worker (session creation, cache/download), warm = the same call again. */
async function coldWarm(method: string, input: Record<string, unknown>, model?: string, params?: Record<string, unknown>, warmInput?: Record<string, unknown>) {
    const w = startWorker("/dist/index.js");
    try {
        let t = performance.now();
        const cold = await call(method, input, { worker: w, ...(model ? { model } : {}), ...(params ? { params } : {}) });
        const coldMs = Math.round(performance.now() - t);
        t = performance.now();
        const warm = await call(method, warmInput ?? input, { worker: w, ...(model ? { model } : {}), ...(params ? { params } : {}) });
        const warmMs = Math.round(performance.now() - t);
        return { cold, warm, coldMs, warmMs };
    } finally {
        w.worker.terminate();
    }
}

afterAll(() => {
    const head = "| Slot | Implementation | Input | Cold ms | Warm ms | Result |\n|---|---|---|---|---|---|";
    const body = rows.map((r) => `| ${r.slot} | ${r.impl} | ${r.input} | ${r.cold ?? ""} | ${r.warm ?? ""} | ${r.result.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
    console.warn(`[alt] comparison\n${head}\n${body.join("\n")}`);
});

/* ------------------------------------------------------------- parse-document */

describe("parse-document alternatives vs the built-in parsers", () => {
    const cases: { file: string; impls: string[]; want: RegExp; demo?: boolean }[] = [
        { file: "产品白皮书.pdf", impls: ["builtin", "pdfium", "pdf2md"], want: /园区能源管理/, demo: true },
        { file: "paper.pdf", impls: ["builtin", "pdfium", "pdf2md"], want: /华东/ },
        { file: "采购合同-扫描件.pdf", impls: ["builtin", "pdfium", "pdf2md"], want: /^$/, demo: true },
        { file: "项目周例会纪要.docx", impls: ["builtin", "officeparser"], want: /试运行/, demo: true },
        { file: "月度销售.xlsx", impls: ["builtin", "officeparser"], want: /区域汇总|华北/, demo: true },
        { file: "方案汇报.pptx", impls: ["builtin", "officeparser"], want: /回收期/, demo: true },
        { file: "report.odt", impls: ["builtin", "officeparser"], want: /季度报告/ },
        { file: "article.html", impls: ["builtin", "readability"], want: /城市更新的十年/ },
    ];
    for (const c of cases) {
        it(`${c.file}: ${c.impls.join(" / ")}`, async (ctx) => {
            const doc = c.demo ? await sample(c.file) : await fixture(c.file);
            if (!doc) return ctx.skip(`${c.file}: scanall demo samples not found`);
            for (const impl of c.impls) {
                const r = await coldWarm("parseDocument", { document: doc }, impl === "builtin" ? undefined : impl);
                expect(r.cold.out.error, `${impl} ${c.file}`).toBeUndefined();
                const text: string = r.cold.out.text;
                expect(text, `${impl} ${c.file}`).toMatch(c.want);
                const headings = (text.match(/^#+ /gm) ?? []).length;
                const tables = (text.match(/^\|.*\|$/gm) ?? []).length;
                record({
                    slot: "parse-document",
                    impl,
                    input: c.file,
                    cold: r.coldMs,
                    warm: r.warmMs,
                    result: `${text.length} chars, ${headings} headings, ${tables} table rows; starts "${text.slice(0, 40).replace(/\s+/g, " ")}"`,
                });
                // The alternative ran (no fallback note) for the formats it reads.
                if (impl !== "builtin") expect(r.cold.progress.some((p) => p.message.includes("using the built-in parser"))).toBe(false);
            }
        });
    }

    it("an alternative given a format it does not read falls back, saying so", async () => {
        const r = await call("parseDocument", { document: await fixture("report.docx") }, { model: "pdfium" });
        expect(r.out.success).toBe(true);
        expect(r.out.text).toContain("季度报告");
        expect(r.progress.some((p) => p.message === "PDFium (@embedpdf/pdfium) does not read .docx files: using the built-in parser")).toBe(true);
    });
});

/* ------------------------------------------------------------- detect-objects */

describe.runIf(MODELS)("detect-objects: D-FINE nano (default) vs YOLO26n vs RF-DETR nano (WASM)", () => {
    const impls: [string | undefined, string, string][] = [
        [undefined, "onnx-community/dfine_n_coco-ONNX", "onnx/model_fp16.onnx"],
        ["yolo26n", "onnx-community/yolo26n-ONNX", "onnx/model_fp16.onnx"],
        ["rf-detr-nano", "onnx-community/rfdetr_nano-ONNX", "onnx/model_fp16.onnx"],
    ];
    for (const [model, repo, file] of impls) {
        it(`${model ?? "dfine-nano-fp16 (default)"}`, async (ctx) => {
            if (!(await hasModel(repo, file))) return ctx.skip(`${repo} not in EDGE_MODELS_DIR`);
            const cat = await fixture("cat.jpg", "image/jpeg");
            const astro = await fixture("astronaut.jpg", "image/jpeg");
            const wb = await fixture("whiteboard.jpg", "image/jpeg");
            const r = await coldWarm("detectObjects", { image: cat }, model, undefined, { image: astro });
            expect(r.cold.out.error).toBeUndefined();
            const catObjs = JSON.parse(r.cold.out.objects) as { label: string; score: number; box: number[] }[];
            const astroObjs = JSON.parse(r.warm.out.objects) as { label: string; score: number }[];
            expect(catObjs[0]!.label).toBe("cat");
            expect(catObjs[0]!.box[2]! - catObjs[0]!.box[0]!).toBeGreaterThan(150);
            expect(astroObjs.map((o) => o.label)).toContain("person");
            const show = (os: { label: string; score: number }[]) => os.slice(0, 4).map((o) => `${o.label} ${o.score}`).join(", ") || "none";
            record({ slot: "detect-objects", impl: model ?? "dfine-nano-fp16", input: "cat.jpg (cold) / astronaut.jpg (warm)", cold: r.coldMs, warm: r.warmMs, result: `cat: ${show(catObjs)}; astronaut: ${show(astroObjs)}` });
            const w = await call("detectObjects", { image: wb }, model ? { model } : {});
            const wbObjs = JSON.parse(w.out.objects) as { label: string; score: number }[];
            record({ slot: "detect-objects", impl: model ?? "dfine-nano-fp16", input: "whiteboard.jpg (demo)", result: show(wbObjs) });
            // Same ABI shape as the default: [{label, score, box:[x1,y1,x2,y2]}], best first.
            for (const o of catObjs) {
                expect(Object.keys(o).sort()).toEqual(["box", "label", "score"]);
                expect(o.box).toHaveLength(4);
            }
            expect([...catObjs].sort((a, b) => b.score - a.score)).toEqual(catObjs);
        }, LONG);
    }
});

/* -------------------------------------------------------------- layout-detect */

describe.runIf(MODELS)("layout-detect: PP-DocLayout-S (default) vs PP-DocLayoutV3", () => {
    it("paper.pdf page 1 and the scanned contract: regions, labels, filenames, table chaining", async (ctx) => {
        if (!(await hasModel("PaddlePaddle/PP-DocLayoutV3_onnx", "inference.onnx"))) return ctx.skip("PP-DocLayoutV3 not in EDGE_MODELS_DIR");
        const paper = (await call("renderPages", { document: await fixture("paper.pdf", "application/pdf") })).out.pages[0];
        const scanDoc = await sample("采购合同-扫描件.pdf", "application/pdf");
        const scan = scanDoc ? (await call("renderPages", { document: scanDoc })).out.pages[0] : undefined;
        for (const model of [undefined, "pp-doclayoutv3"]) {
            const r = await coldWarm("layoutDetect", { image: paper }, model, undefined, scan ? { image: scan } : undefined);
            expect(r.cold.out.error).toBeUndefined();
            const layout = JSON.parse(r.cold.out.layout) as { label: string; score: number; box: number[] }[];
            expect(r.cold.out.regions).toHaveLength(layout.length);
            expect(layout.map((l) => l.label)).toContain("table");
            layout.forEach((l, i) => expect(r.cold.out.regions[i].filename).toMatch(new RegExp(`-r\\d+-${l.label}\\.png$`)));
            const labels = layout.map((l) => l.label);
            record({ slot: "layout-detect", impl: model ?? "pp-doclayout-s", input: "paper.pdf p1 (cold)", cold: r.coldMs, result: `${layout.length} regions: ${labels.join(" ")}` });
            if (scan) {
                const s = JSON.parse(r.warm.out.layout) as { label: string; score: number }[];
                record({ slot: "layout-detect", impl: model ?? "pp-doclayout-s", input: "采购合同-扫描件.pdf p1 (warm, demo)", warm: r.warmMs, result: `${s.length} regions: ${s.map((l) => l.label).join(" ")}` });
            }
            // Table chaining: the table region recognizes; every other region is skipped without a model.
            const ti = labels.indexOf("table");
            const t = await call("tableRecognize", { image: r.cold.out.regions[ti] });
            expect(t.out.html).toContain("华东");
            const other = labels.findIndex((l) => l !== "table");
            const skip = await call("tableRecognize", { image: r.cold.out.regions[other] });
            expect(skip.out).toEqual({ success: true, html: "" });
        }
    }, LONG);
});

/* -------------------------------------------------------------- image-gen-text */

describe.runIf(MODELS && __EDGE_WEBGPU__)("image-gen-text: Qwen3.5-0.8B (default) vs LFM2.5-VL-450M vs SmolVLM2-500M vs Florence-2-base (WebGPU)", () => {
    const impls: [string | undefined, string, string][] = [
        [undefined, "onnx-community/Qwen3.5-0.8B-ONNX", "onnx/decoder_model_merged_q4f16.onnx"],
        ["lfm2.5-vl-450m", "onnx-community/LFM2.5-VL-450M-ONNX", "onnx/decoder_model_merged_q4f16.onnx"],
        ["smolvlm2-500m", "HuggingFaceTB/SmolVLM2-500M-Video-Instruct", "onnx/decoder_model_merged_q4f16.onnx"],
        ["florence-2-base", "onnx-community/Florence-2-base", "onnx/decoder_model_merged_q4.onnx"],
    ];
    for (const [model, repo, file] of impls) {
        it(model ?? "qwen3.5-0.8b (default)", async (ctx) => {
            if (!(await hasModel(repo, file))) return ctx.skip(`${repo} not in EDGE_MODELS_DIR`);
            const cat = await fixture("cat.jpg", "image/jpeg");
            const wb = await fixture("whiteboard.jpg", "image/jpeg");
            const r = await coldWarm("imageGenText", { text: "", image: cat }, model, undefined, { text: "", image: wb });
            for (const [name, out] of [["cat.jpg", r.cold.out], ["whiteboard.jpg", r.warm.out]] as const) {
                expect(out.error, `${model} ${name}`).toBeUndefined();
                const text: string = out.text;
                expect(text.length).toBeGreaterThan(5);
                expect(text.length).toBeLessThan(700);
                const clauses = text.split(/[。！？；，、\n.!?;]/).map((c) => c.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase()).filter((c) => c.length >= 6);
                expect(new Set(clauses).size, text).toBe(clauses.length);
            }
            expect(r.cold.out.text).toMatch(/cat|kitten|猫/i);
            record({ slot: "image-gen-text", impl: model ?? "qwen3.5-0.8b", input: "cat.jpg (cold)", cold: r.coldMs, result: r.cold.out.text });
            record({ slot: "image-gen-text", impl: model ?? "qwen3.5-0.8b", input: "whiteboard.jpg (warm, demo)", warm: r.warmMs, result: r.warm.out.text });
        }, LONG);
    }
});
