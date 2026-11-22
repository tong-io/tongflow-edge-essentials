// Alternative implementations of existing slots (ticket 30, section A: vision and documents):
// the pure post-processing of every alternative, the manifest / models.json bookkeeping, and the
// parse-document alternatives on real libraries (they run in Node too).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { impls } from "../../src/index.js";
import { ALT_MODELS, FLORENCE2_BASE, LFM25_VL_450M, SMOLVLM2_500M, VISION_TEXT_MODELS, hostedFiles, onnxFiles, withExternalData } from "../../src/ml/catalog.js";
import { ALT_MAX_NEW_TOKENS, DESCRIBE_PROMPT_EN, FLORENCE_DESCRIBE_TASK, cleanAltDescription, dedupeSentences, florenceTask, lfmMessages, smolMessages } from "../../src/ml/vlm-alt-text.js";
import { checksumFor, checksumIndex, verifiedFetch, verifyingBody } from "../../src/ml/verified-fetch.js";
import { Sha256 } from "../../src/util/sha256.js";
import { decodeDetr, id2label, looksLikeProbabilities } from "../../src/vision/detect-post.js";
import { ALT_DETECTORS } from "../../src/vision/detect-alt.js";
import { DETECT_MODELS, detectModel } from "../../src/vision/detect-objects.js";
import { DOCLAYOUT_V3_LABELS, layoutRegions, regionFilename, regionLabelOf } from "../../src/vision/layout-post.js";
import { LAYOUT_MODELS, layoutModel } from "../../src/vision/impl.js";
import { MANIFEST_MODELS } from "../../src/vision/catalog.js";
import { PARSE_IMPLS, implSupports, parseImpl, pickParser } from "../../src/formats/impls.js";
import { cleanPdfiumText } from "../../src/formats/pdfium.js";
import { tidyPdf2md } from "../../src/formats/pdf2md.js";
import { stripFrontMatter, tidyOfficeMarkdown } from "../../src/formats/officeparser.js";
import { fixture, nodeCtx } from "../helpers/node-ctx.js";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tongflow.plugin.json", root), "utf8")) as { slots: { nodeSlot: string; method: string; models?: string[] }[] };
type Entry = { id: string; source: string; files: string[]; checksums?: Record<string, { size: number; sha256: string }>; approxMB: number; license: string; licenseUrl?: string; attribution?: string; slots?: string[] };
const models = JSON.parse(readFileSync(new URL("models.json", root), "utf8")) as Entry[];
const slotModels = (slot: string) => manifest.slots.find((s) => s.nodeSlot === slot)!.models!;

describe("incremental SHA-256", () => {
    it("matches node:crypto for every padding case and any chunking", () => {
        for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 70_001]) {
            const data = randomBytes(n);
            const want = createHash("sha256").update(data).digest("hex");
            expect(new Sha256().update(data).hex(), `n=${n}`).toBe(want);
            const h = new Sha256();
            for (let i = 0; i < n; ) {
                const k = 1 + ((i * 7919) % 97);
                h.update(data.subarray(i, i + k));
                i += k;
            }
            expect(h.hex(), `chunked n=${n}`).toBe(want);
        }
        expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
});

describe("verified fetch for transformers.js downloads", () => {
    const idx = checksumIndex([{ source: "modelscope:org/repo", checksums: { "onnx/m.onnx": { size: 3, sha256: createHash("sha256").update("abc").digest("hex") } } }]);

    it("finds a file's checksum under any model base", () => {
        expect(checksumFor("https://cdn.example/models/org/repo/onnx/m.onnx", idx)?.size).toBe(3);
        expect(checksumFor("/models/org/repo/onnx/m.onnx?x=1", idx)?.key).toBe("org/repo/onnx/m.onnx");
        expect(checksumFor("/models/org/repo/onnx/other.onnx", idx)).toBeUndefined();
        // The real models.json: every alternative's transformers.js file is covered.
        for (const m of ALT_MODELS) for (const f of hostedFiles(m)) expect(checksumFor(`/models/${m.repo}/${f}`), `${m.id}/${f}`).toBeDefined();
    });

    const body = (s: string) => new Response(new TextEncoder().encode(s), { status: 200 });
    it("passes a good body through and errors at the end of a bad one", async () => {
        const want = idx.get("org/repo/onnx/m.onnx")!;
        expect(await verifyingBody(body("abc"), want, "m").text()).toBe("abc");
        await expect(verifyingBody(body("abd"), want, "m").text()).rejects.toThrow(/failed its SHA-256 check/);
        await expect(verifyingBody(body("abcd"), want, "m").text()).rejects.toThrow(/has 4 bytes, expected 3/);
    });

    it("leaves range probes and unlisted files alone", async () => {
        const orig = globalThis.fetch;
        globalThis.fetch = (async () => new Response("junk", { status: 200 })) as typeof fetch;
        try {
            const url = `/models/${LFM25_VL_450M.repo}/config.json`;
            await expect((await verifiedFetch(url)).text()).rejects.toThrow(/expected 2637/);
            expect(await (await verifiedFetch(url, { headers: { Range: "bytes=0-0" } })).text()).toBe("junk");
            expect(await (await verifiedFetch("/models/unlisted/repo/x.json")).text()).toBe("junk");
        } finally {
            globalThis.fetch = orig;
        }
    });
});

describe("detect-objects alternatives: DETR-style decoding", () => {
    const labels = { "0": "person", "1": "cat", "3": "dog" };
    const logit = (p: number) => Math.log(p / (1 - p));

    it("sigmoid scores, best class per query, boxes scaled and clipped, best first", () => {
        // 3 queries × 4 classes; class 2 has no name (COCO-91 gap) and is never picked.
        const L = new Float32Array([
            logit(0.2), logit(0.9), logit(0.99), logit(0.1),
            logit(0.6), logit(0.1), logit(0.1), logit(0.1),
            logit(0.1), logit(0.1), logit(0.1), logit(0.2),
        ]);
        const B = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.1, 0.2, 0.4, 0.2, 0.5, 0.5, 1, 1]);
        const out = decodeDetr({ logits: L, boxes: B, queries: 3, classes: 4 }, { labels, width: 200, height: 100, threshold: 0.35 });
        expect(out).toEqual([
            { label: "cat", score: 0.9, box: [50, 25, 150, 75] },
            { label: "person", score: 0.6, box: [0, 10, 60, 30] },
        ]);
    });

    it("an export that already emits probabilities is not squashed twice", () => {
        const P = new Float32Array([0.05, 0.8, 0.0, 0.1]);
        expect(looksLikeProbabilities(P)).toBe(true);
        expect(looksLikeProbabilities(new Float32Array([-3, 2]))).toBe(false);
        const out = decodeDetr({ logits: P, boxes: new Float32Array([0.5, 0.5, 0.2, 0.2]), queries: 1, classes: 4 }, { labels, width: 10, height: 10, threshold: 0.5 });
        expect(out).toEqual([{ label: "cat", score: 0.8, box: [4, 4, 6, 6] }]);
    });

    it("id2label keeps named classes only; the model ids are wired, default first", () => {
        expect(id2label({ id2label: { "0": "N/A", "1": "person", "3": "car" } })).toEqual({ "1": "person", "3": "car" });
        expect(id2label(null)).toEqual({});
        expect(slotModels("detect-objects")).toEqual([...DETECT_MODELS]);
        expect(detectModel(undefined)).toBe("dfine-nano-fp16");
        expect(detectModel("yolo26n")).toBe("yolo26n");
        expect(() => detectModel("yolov8")).toThrow(/unknown detection model/);
        expect(ALT_DETECTORS.yolo26n!.size).toBe(640);
        expect(ALT_DETECTORS["rf-detr-nano"]!.norm.mean[0]).toBeCloseTo(0.485);
        for (const id of ["yolo26n", "rf-detr-nano"]) {
            const e = models.find((m) => m.id === id)!;
            expect(e.files).toContain(ALT_DETECTORS[id]!.file);
            expect(e.files).toContain("config.json");
        }
    });
});

describe("layout-detect alternative: PP-DocLayoutV3", () => {
    it("rows of 7 use the model's reading order and the V3 labels", () => {
        const L = DOCLAYOUT_V3_LABELS;
        const c = (name: string) => L.indexOf(name);
        // [class, score, x1, y1, x2, y2, order]: listed out of order on purpose.
        const rows = new Float32Array([
            c("text"), 0.9, 620, 200, 1100, 600, 3,
            c("doc_title"), 0.95, 100, 50, 1100, 120, 0,
            c("text"), 0.88, 100, 200, 580, 600, 1,
            c("display_formula"), 0.7, 100, 620, 580, 700, 2,
            c("table"), 0.3, 100, 800, 580, 900, 4, // below the threshold
        ]);
        const out = layoutRegions(rows, 5, L, 1200, 1700, 0.5, { stride: 7, modelOrder: true });
        expect(out.map((r) => r.label)).toEqual(["doc_title", "text", "display_formula", "text"]);
        expect(out[1]!.box).toEqual([100, 200, 580, 600]);
        // Without modelOrder the 7-wide rows still parse (column order instead).
        expect(layoutRegions(rows, 5, L, 1200, 1700, 0.5, { stride: 7 })).toHaveLength(4);
    });

    it("region filenames with V3-only labels keep table filtering working", () => {
        expect(regionLabelOf(regionFilename("page1", 2, 12, "display_formula"))).toBe("display_formula");
        expect(regionLabelOf("page1-r07-vertical_text.png")).toBe("vertical_text");
        expect(regionLabelOf("page1-r03-table.png")).toBe("table");
        expect(regionLabelOf("page1-r03-unknown_label.png")).toBeUndefined();
    });

    it("table-recognize skips a V3 non-table region without a model", async () => {
        const ctx = nodeCtx();
        const out = await impls.tableRecognize({ image: { bytesBase64: "AAAA", mime: "image/png", filename: "scan-r2-inline_formula.png" } }, ctx);
        expect(out).toEqual({ success: true, html: "" });
    });

    it("model ids", () => {
        expect(slotModels("layout-detect")).toEqual([...LAYOUT_MODELS]);
        expect(layoutModel("pp-doclayoutv3")).toBe("pp-doclayoutv3");
        expect(layoutModel("pp-doclayout-m")).toBe("pp-doclayout-m");
        const v3 = models.find((m) => m.id === "pp-doclayoutv3")!;
        expect(v3.source).toBe("modelscope:PaddlePaddle/PP-DocLayoutV3_onnx");
        expect(v3.checksums!["inference.onnx"]!.size).toBe(130502049);
    });
});

describe("image-gen-text / image-describe alternatives", () => {
    it("Florence-2 runs a task: a known task token as the prompt, else <MORE_DETAILED_CAPTION>", () => {
        const tasks = new Set(["<CAPTION>", "<OCR>", "<MORE_DETAILED_CAPTION>"]);
        expect(florenceTask(undefined, tasks)).toBe(FLORENCE_DESCRIBE_TASK);
        expect(florenceTask("  <OCR> ", tasks)).toBe("<OCR>");
        expect(florenceTask("描述这张图片", tasks)).toBe(FLORENCE_DESCRIBE_TASK);
    });

    it("LFM2.5-VL gets Qwen's Chinese defaults; SmolVLM2 an English prompt with list-shaped content", () => {
        const lfm = lfmMessages({ hasImage: true });
        expect(lfm[0]!.role).toBe("system");
        expect(JSON.stringify(lfm[1]!.content)).toContain("简体中文");
        const smol = smolMessages({ hasImage: true });
        expect(smol).toEqual([{ role: "user", content: [{ type: "image" }, { type: "text", text: DESCRIBE_PROMPT_EN }] }]);
        const sys = smolMessages({ hasImage: false, prompt: "hi", system: "Be brief." });
        expect(sys[0]).toEqual({ role: "system", content: [{ type: "text", text: "Be brief." }] });
        expect(() => smolMessages({ hasImage: false })).toThrow(/nothing to do/);
    });

    it("cuts repeated sentences, loops and a dangling sentence", () => {
        expect(dedupeSentences("A cat sits on a mat. The mat is red. A cat sits on a mat. The mat is red.")).toBe("A cat sits on a mat. The mat is red.");
        expect(cleanAltDescription("<s>The image shows a cat on a sofa. The cat is orange. The cat is orange. The cat is orange.</s>")).toBe(
            "The image shows a cat on a sofa. The cat is orange.",
        );
        expect(cleanAltDescription("A white page with text. It reads Quarterly Report and a table of", true)).toBe("A white page with text.");
        expect(cleanAltDescription("一只橘猫趴在沙发上，一只橘猫趴在沙发上，一只橘猫趴在沙发上，")).toBe("一只橘猫趴在沙发上。");
        expect(ALT_MAX_NEW_TOKENS).toBeLessThan(192);
    });

    it("catalog, manifest and models.json agree (default first, every file checksummed)", () => {
        for (const slot of ["image-gen-text", "image-describe"]) expect(slotModels(slot)).toEqual(VISION_TEXT_MODELS.map((m) => m.id));
        for (const m of ALT_MODELS) {
            const e = models.find((x) => x.id === m.id)!;
            expect(e, m.id).toBeDefined();
            expect(e.source).toBe(`modelscope:${m.repo}`);
            for (const f of hostedFiles(m)) {
                expect(e.files, `${m.id}/${f}`).toContain(f);
                expect(e.checksums?.[f]?.sha256, `${m.id}/${f}`).toMatch(/^[0-9a-f]{64}$/);
            }
            expect(Math.abs(e.approxMB - m.f16.approxMB)).toBeLessThan(1.5);
            expect(e.license && e.licenseUrl && e.attribution).toBeTruthy();
        }
        // Single-file graphs: no .onnx_data, no external-data config.
        expect(onnxFiles(SMOLVLM2_500M.f16)).toEqual(["onnx/embed_tokens_q4f16.onnx", "onnx/vision_encoder_q4f16.onnx", "onnx/decoder_model_merged_q4f16.onnx"]);
        expect(onnxFiles(FLORENCE2_BASE.fallback)).toContain("onnx/embed_tokens_quantized.onnx");
        const cfg = {};
        expect(withExternalData(cfg, FLORENCE2_BASE.f16)).toEqual({});
        expect(onnxFiles(LFM25_VL_450M.f16)).toContain("onnx/decoder_model_merged_q4f16.onnx_data");
        expect(models.find((m) => m.id === "lfm2.5-vl-450m")!.license).toBe("LFM Open License v1.0");
    });

    it("without WebGPU every alternative fails with the clear WebGPU error, downloading nothing", async () => {
        for (const id of ["lfm2.5-vl-450m", "smolvlm2-500m", "florence-2-base"]) {
            const ctx = nodeCtx(undefined, { model: id });
            const out = await impls.imageGenText({ text: "", image: await fixture("cat.jpg", "image/jpeg") } as never, ctx);
            expect(out.success, id).toBe(false);
            expect(out.error).toMatch(/needs WebGPU/);
            expect(ctx.rec.downloads).toEqual([]);
        }
        const bad = await impls.imageGenText({ text: "x" } as never, nodeCtx(undefined, { model: "llava" }));
        expect(bad.error).toMatch(/needs WebGPU|unknown model "llava"/);
    });
});

describe("parse-document alternatives", () => {
    it("each implementation is offered only for the formats it reads", () => {
        expect(slotModels("parse-document")).toEqual([...PARSE_IMPLS]);
        expect(parseImpl(undefined)).toBe("builtin");
        expect(parseImpl("mupdf")).toBe("mupdf");
        expect(implSupports("mupdf", "pdf", "pdf")).toBe(true);
        expect(implSupports("mupdf", "docx", "docx")).toBe(false);
        expect(() => parseImpl("pymupdf")).toThrow(/unknown parse-document implementation/);
        expect(implSupports("pdfium", "pdf", "pdf")).toBe(true);
        expect(implSupports("pdf2md", "docx", "docx")).toBe(false);
        expect(implSupports("readability", "html", "htm")).toBe(true);
        expect(implSupports("officeparser", "legacy", "odt")).toBe(true);
        expect(implSupports("officeparser", "legacy", "doc")).toBe(false);
        expect(implSupports("officeparser", "sheet", "xls")).toBe(false);
        expect(pickParser("readability", "pdf", "pdf")).toEqual({
            impl: "builtin",
            note: "Readability (@mozilla/readability) does not read .pdf files: using the built-in parser",
        });
        expect(pickParser("pdfium", "pdf", "pdf")).toEqual({ impl: "pdfium" });
    });

    it("clean-up of PDFium text and pdf2md page breaks", () => {
        expect(cleanPdfiumText("第一行\r\nsecond\u0000 line\r\nhy­\nphen")).toBe("第一行\nsecond line\nhyphen");
        expect(tidyPdf2md("# A\n<!-- PAGE_BREAK -->\n## B ⼆〇⼆六年\n")).toBe("# A\n\n## B 二〇二六年");
        expect(stripFrontMatter('---\nauthor: "x"\ncreated: 2013\n---\n# Title\n')).toBe("# Title\n");
        expect(stripFrontMatter("# No front matter\n---\n")).toBe("# No front matter\n---\n");
        expect(stripFrontMatter("---\n\n| a |\n| --- |\n\n---\n\n| b |")).toBe("---\n\n| a |\n| --- |\n\n---\n\n| b |");
        expect(tidyOfficeMarkdown("---\n\n# 季度报告 Report {#季度报告-report}\n\n## 结论 {#结论}\n\n| a |\n\n---\n\n| b |")).toBe(
            "# 季度报告 Report\n\n## 结论\n\n| a |\n\n---\n\n| b |",
        );
    });

    async function parseWith(model: string, name: string, mime?: string) {
        const ctx = nodeCtx(undefined, { model });
        const t0 = performance.now();
        const out = await impls.parseDocument({ document: await fixture(name, mime) }, ctx);
        return { out, ctx, ms: Math.round(performance.now() - t0) };
    }

    it("pdfium: the text layer of report.pdf and paper.pdf", async () => {
        const { out, ctx, ms } = await parseWith("pdfium", "report.pdf");
        expect(out.error).toBeUndefined();
        expect(out.text).toContain("季度报告");
        expect(out.text).toContain("华东区销售额增长百分之十二");
        expect(ctx.rec.downloads.some((d) => d.label === "pdfium-wasm")).toBe(true);
        const paper = await parseWith("pdfium", "paper.pdf");
        expect(paper.out.text).toMatch(/华东/);
        expect((await parseWith("pdfium", "no-text-layer.pdf")).out).toMatchObject({ success: true, text: "" });
        console.warn(`[timing] parse-document pdfium report.pdf (cold, incl. wasm): ${ms} ms; paper.pdf warm: ${paper.ms} ms`);
    });

    it("pdf2md: Markdown with headings from font sizes", async () => {
        const { out, ms } = await parseWith("pdf2md", "report.pdf");
        expect(out.error).toBeUndefined();
        expect(out.text).toContain("季度报告");
        expect(out.text).toMatch(/^#+ /m);
        console.warn(`[timing] parse-document pdf2md report.pdf: ${ms} ms\n${out.text?.slice(0, 300)}`);
    });

    it("officeparser: docx / xlsx / pptx / odt to Markdown", async () => {
        for (const [f, want] of [
            ["report.docx", "华东区销售额增长百分之十二"],
            ["sales.xlsx", "苹果"],
            ["launch.pptx", ""],
            ["report.odt", ""],
        ] as const) {
            const { out, ms } = await parseWith("officeparser", f);
            expect(out.error, f).toBeUndefined();
            expect(out.text!.length, f).toBeGreaterThan(10);
            if (want) expect(out.text, f).toContain(want);
            expect(out.text, f).not.toMatch(/^---\n\w+:/);
            expect(out.text, f).not.toMatch(/\{#[^}]*\}/);
            console.warn(`[timing] parse-document officeparser ${f}: ${ms} ms`);
        }
        // .xls is not OOXML: the built-in SheetJS parser runs, and the node says so.
        const xls = await parseWith("officeparser", "sales.xls");
        expect(xls.out.text).toContain("## 销售");
        expect(xls.ctx.rec.progress.some((p) => p.message?.includes("does not read .xls files"))).toBe(true);
    });

    it("readability: the article of a saved web page", async () => {
        const { out, ms } = await parseWith("readability", "article.html");
        expect(out.error).toBeUndefined();
        expect(out.text).toMatch(/^# 城市更新的十年\n/);
        expect(out.text).toContain("老旧小区加装电梯");
        expect(out.text).toMatch(/^## 典型案例/m);
        expect(out.text).not.toContain("关于我们");
        expect(out.text).not.toContain("版权所有");
        console.warn(`[timing] parse-document readability article.html: ${ms} ms\n${out.text?.slice(0, 300)}`);
    });
});
