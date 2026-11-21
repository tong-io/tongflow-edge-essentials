// T3 (WebGPU) nodes: everything that runs without a GPU or a model.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
    T3_MODELS,
    externalDataFormat,
    hostedFiles,
    onnxFiles,
    pickModel,
    variantFor,
    withExternalData,
    EMBEDDING_GEMMA_2,
    GLM_OCR,
    LFM25_350M,
    QWEN35_VL,
} from "../../src/ml/catalog.js";
import { CHAINS, unpoisonedOrtChains } from "../../tsdown.config.js";
import { repoUrl } from "../../src/ml/runtime.js";
import {
    DESCRIBE_PROMPT_ZH,
    KEY_POINTS_SCHEMA,
    KEY_POINTS_SYSTEM,
    KEY_POINTS_SYSTEM_ZH,
    isMostlyCjk,
    SYSTEM_ZH,
    cleanOcrText,
    intParam,
    keyPointMessages,
    parseKeyPoints,
    sampling,
    stripThinking,
    visionMessages,
} from "../../src/ml/prompts.js";
import { DownloadProgress, TokenProgress } from "../../src/ml/progress.js";
import { GLM_OCR_BUDGET, QWEN_BUDGET, fitWithin, smartResize, visionTokens, withMaxPixels } from "../../src/ml/sizing.js";
import { TFV1_HEADER_BYTES, packVectors, truncateNormalize } from "../../src/ml/tfv1.js";
import { sniffImageMime } from "../../src/ml/image.js";
import {
    WEBGPU_MISSING,
    WEBGPU_NO_ADAPTER,
    checkQuota,
    describeQuota,
    requireWebGPU,
    resetWebGPUProbe,
} from "../../src/ml/webgpu.js";
import { parseDims, vectorsFilename } from "../../src/slots/embed-image.js";
import { truncateTokens } from "../../src/slots/gen-text.js";

const root = new URL("../../", import.meta.url);

describe("model repo layout", () => {
    it("lays repos out as <base><org>/<repo>/", () => {
        expect(repoUrl("https://x/models/", "onnx-community/GLM-OCR-ONNX")).toBe("https://x/models/onnx-community/GLM-OCR-ONNX/");
    });
});

describe("model catalog and models.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("models.json", root), "utf8")) as {
        id: string;
        source: string;
        files: string[];
        approxMB: number;
        license: string;
        attribution?: string;
    }[];

    it("names the ONNX files transformers.js loads for each dtype", () => {
        expect(onnxFiles(QWEN35_VL.f16)).toEqual([
            "onnx/embed_tokens_q4f16.onnx",
            "onnx/embed_tokens_q4f16.onnx_data",
            "onnx/vision_encoder_fp16.onnx",
            "onnx/vision_encoder_fp16.onnx_data",
            "onnx/decoder_model_merged_q4f16.onnx",
            "onnx/decoder_model_merged_q4f16.onnx_data",
        ]);
        expect(onnxFiles({ dtype: { model: "q8" }, approxMB: 1 })).toEqual(["onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"]);
        expect(onnxFiles({ dtype: { model: "fp32" }, approxMB: 1 })).toEqual(["onnx/model.onnx", "onnx/model.onnx_data"]);
    });

    it("declares one external-data file per graph, by its full file name", () => {
        expect(externalDataFormat(GLM_OCR.f16)).toEqual({
            "embed_tokens_q4f16.onnx": 1,
            "vision_encoder_q4f16.onnx": 1,
            "decoder_model_merged_q4f16.onnx": 1,
        });
        expect(externalDataFormat(EMBEDDING_GEMMA_2.fallback)).toEqual({ "model_q4.onnx": 1, "vision_encoder_q4.onnx": 1 });
        // every graph externalDataFormat names has its .onnx_data in onnxFiles (what the host mirrors)
        for (const m of T3_MODELS) {
            for (const v of [m.f16, m.fallback]) {
                for (const g of Object.keys(externalDataFormat(v))) expect(onnxFiles(v)).toContain(`onnx/${g}_data`);
            }
        }
    });

    it("adds the variant's graphs to a config whose map names other files (GLM-OCR's config.json)", () => {
        // GLM-OCR-ONNX/config.json as published: fp32 names only, which transformers.js
        // 4.3.2 matches neither against `embed_tokens_q4f16.onnx` nor against `embed_tokens`.
        const glm = {
            "transformers.js_config": {
                use_external_data_format: { "vision_encoder.onnx": 1, "decoder_model_merged.onnx": 2, "embed_tokens.onnx": 1 },
                kv_cache_dtype: { q4f16: "float16" },
            },
        };
        const out = withExternalData(glm, GLM_OCR.f16);
        expect(out).toBe(glm);
        expect(out["transformers.js_config"]).toEqual({
            use_external_data_format: {
                "vision_encoder.onnx": 1,
                "decoder_model_merged.onnx": 2,
                "embed_tokens.onnx": 1,
                "embed_tokens_q4f16.onnx": 1,
                "vision_encoder_q4f16.onnx": 1,
                "decoder_model_merged_q4f16.onnx": 1,
            },
            kv_cache_dtype: { q4f16: "float16" },
        });
        // no transformers.js_config at all
        expect(withExternalData({} as Record<string, unknown>, LFM25_350M.f16)).toEqual({
            "transformers.js_config": { use_external_data_format: { "model_q4f16.onnx": 1 } },
        });
        // `true` (LFM2.5's config) already covers every graph
        const lfm = { "transformers.js_config": { use_external_data_format: true } };
        expect(withExternalData(lfm, LFM25_350M.f16)["transformers.js_config"].use_external_data_format).toBe(true);
    });

    it.each(T3_MODELS.map((m) => [m.id, m] as const))("models.json lists everything %s needs", (_id, model) => {
        const entry = manifest.find((e) => e.id === model.id);
        expect(entry, `models.json has no entry ${model.id}`).toBeDefined();
        expect(entry!.source).toBe(`modelscope:${model.repo}`);
        for (const f of hostedFiles(model)) expect(entry!.files).toContain(f);
        expect(entry!.approxMB).toBeGreaterThanOrEqual(model.f16.approxMB);
        expect(entry!.license).toBeTruthy();
    });

    it("stays within the T3 budget (250–850 MB per model, first download)", () => {
        for (const m of T3_MODELS) {
            for (const v of [m.f16, m.fallback]) {
                expect(v.approxMB).toBeGreaterThanOrEqual(250);
                expect(v.approxMB).toBeLessThanOrEqual(850);
            }
        }
    });

    it("picks the slot default, a listed model, or fails clearly", () => {
        expect(pickModel(undefined, [GLM_OCR]).id).toBe("glm-ocr");
        expect(pickModel("glm-ocr", [GLM_OCR]).id).toBe("glm-ocr");
        expect(() => pickModel("pp-ocrv6", [GLM_OCR])).toThrow(/unknown model "pp-ocrv6"; this node supports glm-ocr/);
        expect(variantFor(LFM25_350M, true).dtype).toEqual({ model: "q4f16" });
        expect(variantFor(LFM25_350M, false).dtype).toEqual({ model: "q4" });
    });

    it("ships the LFM Open License full text and states the revenue threshold in the README", () => {
        const lic = readFileSync(new URL("licenses/LFM-Open-License-v1.0.txt", root), "utf8");
        expect(lic).toMatch(/^LFM Open License v1\.0/);
        expect(lic).toMatch(/"Threshold" shall mean annual revenue of 10 million United States dollars/);
        expect(lic).toMatch(/END OF TERMS AND CONDITIONS/);
        const readme = readFileSync(new URL("README.md", root), "utf8");
        expect(readme).toMatch(/LFM Open License/);
        expect(readme).toMatch(/USD 10 million/);
        expect(readme).toMatch(/1000 万美元/);
        const lfm = manifest.find((e) => e.id === "lfm2.5-350m")!;
        expect(lfm.license).toMatch(/LFM Open License v1\.0/);
    });
});

describe("TFV1 vectors", () => {
    it("packs magic, dims, count and little-endian float32 rows", () => {
        const bytes = packVectors([[1, 2, 3], [4, 5, 6]]);
        expect(bytes.byteLength).toBe(TFV1_HEADER_BYTES + 4 * 3 * 2);
        expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("TFV1");
        const v = new DataView(bytes.buffer);
        expect(v.getUint32(4, true)).toBe(3);
        expect(v.getUint32(8, true)).toBe(2);
        expect([0, 1, 2, 3, 4, 5].map((i) => v.getFloat32(12 + 4 * i, true))).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("rejects ragged input and needs dims for an empty set", () => {
        expect(() => packVectors([[1, 2], [1]])).toThrow(/vector 1 has length 1/);
        expect(() => packVectors([])).toThrow(/dims is required/);
        expect(packVectors([], 768).byteLength).toBe(TFV1_HEADER_BYTES);
    });

    it("truncates Matryoshka-style and renormalizes", () => {
        const v = truncateNormalize([3, 4, 12], 2);
        expect(Array.from(v)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
        expect(() => truncateNormalize([1, 2], 3)).toThrow(RangeError);
    });

    it("validates dims and names the output after the input", () => {
        expect(parseDims(undefined)).toBe(768);
        expect(parseDims(256)).toBe(256);
        expect(() => parseDims(300)).toThrow(/dims must be one of 768, 512, 256, 128/);
        expect(vectorsFilename("scans/page-3.png")).toBe("page-3.tfv1");
        expect(vectorsFilename(undefined)).toBe("image.tfv1");
    });
});

describe("image sizing (smart_resize)", () => {
    it("keeps both sides multiples of the factor and the area inside the budget", () => {
        for (const [w, h] of [
            [4032, 3024],
            [1080, 2400],
            [640, 480],
            [100, 60],
            [3000, 200],
        ] as const) {
            for (const b of [QWEN_BUDGET, GLM_OCR_BUDGET]) {
                const s = smartResize(w, h, b);
                expect(s.width % b.factor).toBe(0);
                expect(s.height % b.factor).toBe(0);
                expect(s.width * s.height).toBeLessThanOrEqual(b.maxPixels);
                expect(s.width * s.height).toBeGreaterThanOrEqual(b.minPixels);
                // aspect ratio kept within one factor step
                expect(Math.abs(s.width / s.height - w / h) / (w / h)).toBeLessThan(0.25);
            }
        }
    });

    it("gives a 12 MP photo 192 Qwen vision tokens", () => {
        const s = smartResize(4032, 3024, QWEN_BUDGET);
        expect(s).toEqual({ width: 512, height: 384 });
        expect(visionTokens(s, 32)).toBe(192);
    });

    it("rejects degenerate sizes", () => {
        expect(() => smartResize(0, 10, QWEN_BUDGET)).toThrow(RangeError);
        expect(() => smartResize(10000, 20, QWEN_BUDGET)).toThrow(/aspect ratio/);
    });

    it("lets a node param raise or lower max_pixels within limits", () => {
        expect(withMaxPixels(QWEN_BUDGET, 1024 * 1024).maxPixels).toBe(1024 * 1024);
        expect(withMaxPixels(QWEN_BUDGET, 10).maxPixels).toBe(QWEN_BUDGET.minPixels);
        expect(withMaxPixels(QWEN_BUDGET, "big")).toBe(QWEN_BUDGET);
        expect(fitWithin(4000, 2000, 1536)).toEqual({ width: 1536, height: 768 });
        expect(fitWithin(800, 600, 1536)).toEqual({ width: 800, height: 600 });
    });

    it("sniffs image types from the bytes", () => {
        expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
        expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
        const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
        expect(sniffImageMime(webp)).toBe("image/webp");
        expect(sniffImageMime(new Uint8Array([1, 2, 3]), "image/heic")).toBe("image/heic");
        expect(sniffImageMime(new Uint8Array([1, 2, 3]), "application/pdf")).toBeUndefined();
    });
});

describe("prompts and output clean-up", () => {
    it("describes an image in Chinese by default", () => {
        const m = visionMessages({ prompt: "  ", hasImage: true });
        expect(m[0]).toEqual({ role: "system", content: SYSTEM_ZH });
        expect(m[1]).toEqual({ role: "user", content: [{ type: "image" }, { type: "text", text: DESCRIBE_PROMPT_ZH }] });
        expect(DESCRIBE_PROMPT_ZH).toMatch(/简体中文/);
    });

    it("uses the node's prompt and system, and works without an image", () => {
        const m = visionMessages({ prompt: "图里有几个人？", system: "Answer briefly.", hasImage: false });
        expect(m).toEqual([
            { role: "system", content: "Answer briefly." },
            { role: "user", content: [{ type: "text", text: "图里有几个人？" }] },
        ]);
        expect(() => visionMessages({ prompt: "", hasImage: false })).toThrow(/prompt is empty/);
    });

    it("strips reasoning blocks", () => {
        expect(stripThinking("<think>\nhmm\n</think>\n\n答案")).toBe("答案");
        expect(stripThinking("hmm…</think>答案")).toBe("答案");
        expect(stripThinking("答案<think>never closed")).toBe("答案");
        expect(stripThinking("纯文本")).toBe("纯文本");
    });

    it("unwraps OCR code fences and collapses blank runs", () => {
        expect(cleanOcrText("```markdown\n# 标题\n\n\n\n正文\n```")).toBe("# 标题\n\n正文");
        expect(cleanOcrText("  第一行\r\n第二行  ")).toBe("第一行\n第二行");
        expect(cleanOcrText("")).toBe("");
    });

    it("builds the key-point prompt in the document's language, with an optional focus", () => {
        const zh = keyPointMessages("合同金额 100 万元。", "只要金额");
        expect(zh[0]).toEqual({ role: "system", content: KEY_POINTS_SYSTEM_ZH });
        expect(zh[1]!.content).toBe("要求：只要金额\n\n原文：\n合同金额 100 万元。");
        const en = keyPointMessages("The contract is worth 1.2M USD.", "amounts only");
        expect(en[0]).toEqual({ role: "system", content: KEY_POINTS_SYSTEM });
        expect(en[1]!.content).toBe("Instructions: amounts only\n\nText:\nThe contract is worth 1.2M USD.");
        expect(keyPointMessages("x")[1]!.content).toBe("Text:\nx");
        expect(KEY_POINTS_SCHEMA.required).toEqual(["key_points"]);
        expect(isMostlyCjk("本合同 (Contract No. ABC-123) 由双方签订")).toBe(true);
        expect(isMostlyCjk("Meeting notes: 张三 will send the deck to the whole team on Friday morning")).toBe(false);
    });

    it("parses key points: valid JSON, truncated JSON, or bullet lines", () => {
        expect(parseKeyPoints('{"key_points": ["合同金额 100 万元", "签订于 2026-03-01", "合同金额 100 万元"]}')).toEqual({
            key_points: ["合同金额 100 万元", "签订于 2026-03-01"],
        });
        expect(parseKeyPoints('{"key_points": ["第一点", "第二\\"点\\"", "第三')).toEqual({ key_points: ["第一点", '第二"点"'] });
        expect(parseKeyPoints("- 第一点\n2. 第二点\n（3）第三点")).toEqual({ key_points: ["第一点", "第二点", "第三点"] });
        expect(parseKeyPoints("")).toEqual({ key_points: [] });
    });

    it("maps sampling inputs, temperature 0 meaning greedy", () => {
        const d = { temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 };
        expect(sampling({}, d)).toEqual({ do_sample: true, temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 });
        expect(sampling({ temperature: 0 }, d)).toEqual({ do_sample: false, repetition_penalty: 1.05 });
        expect(sampling({ temperature: 9, top_p: 3, top_k: 0 }, d)).toMatchObject({ temperature: 2, top_p: 1, top_k: 1 });
        expect(intParam(5000, 512, 1, 2048)).toBe(2048);
        expect(intParam("x", 512, 1, 2048)).toBe(512);
    });

    it("truncates long documents by tokens", () => {
        const tok = {
            encode: (t: string) => Array.from(t).map((c) => c.codePointAt(0)!),
            decode: (ids: number[]) => String.fromCodePoint(...ids),
        };
        expect(truncateTokens(tok, "短文", 10)).toEqual({ text: "短文", truncated: false });
        expect(truncateTokens(tok, "一二三四五", 3)).toEqual({ text: "一二三…", truncated: true });
    });
});

describe("progress plumbing", () => {
    it("streams token counts and the text tail, throttled", () => {
        let t = 0;
        const seen: { fraction?: number; message?: string }[] = [];
        const p = new TokenProgress((x) => seen.push(x), 100, "describing", 200, () => t);
        p.token();
        p.append("这是");
        t = 50;
        p.token();
        p.append("一张");
        t = 300;
        p.token();
        p.append("照片");
        p.flush(true);
        expect(p.count).toBe(3);
        expect(seen.map((s) => s.message)).toEqual([
            "describing: 1 token",
            "describing: 3 tokens · …这是一张",
            "describing: 3 tokens · …这是一张照片",
        ]);
        expect(seen[1]!.fraction).toBeCloseTo(0.03);
    });

    it("reports model downloads from transformers.js events, preferring the aggregate", () => {
        let t = 0;
        const got: { loaded: number; total?: number; label: string }[] = [];
        const d = new DownloadProgress((x) => got.push(x), "LFM2.5-350M", 250, () => t);
        d.handle({ status: "initiate", file: "config.json" });
        d.handle({ status: "progress", file: "tokenizer.json", loaded: 10, total: 100 });
        t = 1000;
        d.handle({ status: "progress", file: "onnx/model_q4f16.onnx_data", loaded: 5, total: 50 });
        d.handle({ status: "progress_total", loaded: 100, total: 1000 });
        t = 1100;
        d.handle({ status: "progress_total", loaded: 200, total: 1000 }); // throttled
        d.handle({ status: "progress", file: "x", loaded: 1, total: 2 }); // ignored once an aggregate exists
        d.handle({ status: "progress_total", loaded: 1000, total: 1000 }); // final always reported
        d.handle({ status: "done", file: "x" });
        expect(got).toEqual([
            { loaded: 10, total: 100, label: "LFM2.5-350M · tokenizer.json" },
            { loaded: 5, total: 50, label: "LFM2.5-350M · onnx/model_q4f16.onnx_data" },
            { loaded: 1000, total: 1000, label: "LFM2.5-350M · x" },
        ]);
    });
});

describe("WebGPU and storage checks", () => {
    afterEach(() => resetWebGPUProbe());

    it("fails clearly without navigator.gpu", async () => {
        await expect(requireWebGPU({ navigator: {} })).rejects.toThrow(WEBGPU_MISSING);
        await expect(requireWebGPU({})).rejects.toThrow(/needs WebGPU/);
    });

    it("fails clearly without an adapter, and retries the probe next time", async () => {
        let adapter: unknown = null;
        const scope = { navigator: { gpu: { requestAdapter: async () => adapter } } };
        await expect(requireWebGPU(scope)).rejects.toThrow(WEBGPU_NO_ADAPTER);
        adapter = { features: new Set(["shader-f16"]), info: { vendor: "apple", architecture: "metal-3" } };
        await expect(requireWebGPU(scope)).resolves.toEqual({ f16: true, vendor: "apple", architecture: "metal-3" });
    });

    it("refuses a download the storage quota cannot hold", () => {
        expect(() => checkQuota(800, { quota: 500e6, usage: 100e6 }, "Qwen3.5-0.8B")).toThrow(
            /Qwen3.5-0.8B needs about 800 MB of browser storage, but only 400 MB of this site's 500 MB quota is free/,
        );
        expect(() => checkQuota(800, { quota: 10e9, usage: 1e9 }, "x")).not.toThrow();
        expect(() => checkQuota(800, {}, "x")).not.toThrow();
        expect(describeQuota({ quota: 2e9, usage: 5e8 })).toBe("1500 MB free of 2000 MB storage");
        expect(describeQuota({})).toBe("");
    });
});

describe("bundle patch: transformers.js session chains", () => {
    const src = readFileSync(new URL("node_modules/@huggingface/transformers/dist/transformers.web.js", root), "utf8");
    const id = "/x/node_modules/@huggingface/transformers/dist/transformers.web.js";
    const transform = unpoisonedOrtChains.transform.bind(unpoisonedOrtChains);

    it("rewrites both chains of the pinned transformers.js so a rejected link does not poison the next", () => {
        const out = transform(src, id)!;
        for (const [from, to] of CHAINS) {
            expect(src).toContain(from);
            expect(out).not.toContain(from);
            expect(out).toContain(to);
        }
    });

    it("fails the build when the pattern is gone (another transformers.js version)", () => {
        expect(() => transform("var webInitChain = Promise.resolve();", id)).toThrow(/not found/);
        expect(transform("x", "/x/node_modules/other/index.js")).toBeNull();
    });

    it("the patched chain runs the next link after a rejected one", async () => {
        let chain: Promise<unknown> = Promise.resolve();
        const link = (fn: () => Promise<unknown>) => (chain = chain.catch(() => {}).then(fn));
        const first = link(() => Promise.reject(new Error("first model failed")));
        const second = link(() => Promise.resolve("second model loaded"));
        await expect(first).rejects.toThrow("first model failed");
        await expect(second).resolves.toBe("second model loaded");
    });
});
