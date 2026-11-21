// The four alternatives without model weights: X-ASR's transducer decoding and text rules,
// SenseVoice CTC frames, sentence timestamps, the MuPDF structured-text → Markdown conversion
// (and MuPDF itself, which runs in Node), Qwen's gen-text settings, the streaming SHA-256 and
// the manifest / models.json entries. Real-model runs: audio-models.test.ts (EDGE_MODELS_DIR)
// and test/browser/gen-text-qwen.test.ts, test/browser/mupdf.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SLOT_MODELS } from "../../src/audio/pipeline.js";
import { ctcGreedy, ctcGreedyFrames, senseVoiceText } from "../../src/audio/sensevoice.js";
import { endsSentence, MAX_TOKEN_GAP_S, type RecognizedChunk, sentenceTimestamps } from "../../src/audio/timestamps.js";
import { greedySearch, removeSpaceBetweenCjk, sherpaText, tidyTranscript, TRANSDUCER_FBANK, xAsrText } from "../../src/audio/transducer.js";
import { SPEAKER_FBANK } from "../../src/audio/fbank.js";
import { bodySize, joinLines, type StextPage, stextToMarkdown } from "../../src/formats/stext-markdown.js";
import { impls } from "../../src/index.js";
import { QWEN35_TEXT, T3_MODELS, hostedFiles, pickModel, variantFor } from "../../src/ml/catalog.js";
import { KEY_POINTS_STRICT_SYSTEM, KEY_POINTS_STRICT_SYSTEM_ZH, dropRestatedPoints, keyPointMessages } from "../../src/ml/prompts.js";
import { applyRepeatControl, applyRepeatControlFeasible } from "../../src/ml/repeat.js";
import { verifiedResponse } from "../../src/ml/runtime.js";
import { X_ASR } from "../../src/models/registry.js";
import { GEN_TEXT_MODELS, QWEN_TEXT_MAX_NEW_TOKENS } from "../../src/slots/gen-text.js";
import { PDF_IMPLS } from "../../src/slots/parse-document.js";
import { RENDER_DPI } from "../../src/slots/render-pages.js";
import { Sha256, sha256Hex } from "../../src/util/sha256.js";
import { fixture, nodeCtx } from "../helpers/node-ctx.js";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tongflow.plugin.json", root), "utf8")) as { slots: { nodeSlot: string; method: string; models?: string[] }[] };
const models = JSON.parse(readFileSync(new URL("models.json", root), "utf8")) as {
    id: string;
    source: string;
    files: string[];
    checksums?: Record<string, { size: number; sha256: string }>;
    license: string;
    licenseUrl?: string;
    attribution?: string;
    approxMB: number;
    slots?: string[];
}[];
const slotEntry = (slot: string) => manifest.slots.find((s) => s.nodeSlot === slot);

/* ---------------- X-ASR (transducer) ---------------- */

describe("X-ASR: greedy transducer search as sherpa-onnx runs it", () => {
    // vocab: 0 blank, 1 <sos/eos>, 2 "▁你", 3 "好", 4 "<unk>"
    const V = 5;
    const row = (best: number) => {
        const r = new Float32Array(V).fill(-5);
        r[best] = 5;
        return r;
    };

    it("one symbol per frame, the decoder re-run after each emission, context starting [-1, blank]", async () => {
        // frame → (decoder context → best token)
        const plan: Record<number, number> = { 0: 0, 1: 2, 2: 0, 3: 3, 4: 4, 5: 0 };
        const contexts: number[][] = [];
        const hyp = await greedySearch(
            6,
            2,
            (t) => row(plan[t]!),
            (ctx) => {
                contexts.push(ctx);
                return new Float32Array(4);
            },
            { unk: 4 },
        );
        expect(hyp.tokens).toEqual([2, 3]); // blank and <unk> are not emitted
        expect(hyp.frames).toEqual([1, 3]);
        expect(contexts).toEqual([
            [-1, 0],
            [0, 2],
            [2, 3],
        ]);
    });

    it("joins tokens like sherpa-onnx (▁ → space, no space between CJK or before punctuation), then tidies full-width punctuation", () => {
        const syms = ["<blk>", "<sos/eos>", "▁大", "家", "▁好", "▁，", "▁今", "天", "▁Monday", "▁,", "▁today", "▁。"];
        expect(sherpaText(syms, [2, 3, 4, 5, 6, 7])).toBe("大家好， 今天");
        expect(tidyTranscript("大家好， 今天")).toBe("大家好，今天");
        expect(sherpaText(syms, [6, 7, 8, 9, 10, 11])).toBe("今天 Monday, today。");
        expect(removeSpaceBetweenCjk("한국 어")).toBe("한국 어"); // Hangul keeps its spaces
        expect(xAsrText([" 你", "好", " ，", " 世", "界", " 。"])).toBe("你好，世界。");
        // sherpa-onnx 2.0.2 (Python) on X-ASR's test_wavs/0.wav: '昨天是 Monday, today is 礼拜二， the day after tomorrow 是星期三。'
        expect(tidyTranscript("昨天是 Monday, today is 礼拜二， the day after tomorrow 是星期三。")).toBe(
            "昨天是 Monday, today is 礼拜二，the day after tomorrow 是星期三。",
        );
    });

    it("uses sherpa-onnx's transducer front end (povey, no snip_edges, 20 Hz to Nyquist − 400 Hz, samples in [-1, 1])", () => {
        expect(TRANSDUCER_FBANK).toBe(SPEAKER_FBANK);
        expect(TRANSDUCER_FBANK).toMatchObject({ windowType: "povey", snipEdges: false, lowFreq: 20, highFreq: -400, inputScale: 1, numBins: 80 });
    });

    it("is registered with the sherpa release files, sizes and hashes", () => {
        const e = models.find((m) => m.id === X_ASR.id)!;
        expect(e.source).toBe(`modelscope:${X_ASR.repo}`);
        expect(e.license).toBe("Apache-2.0");
        expect(e.licenseUrl).toMatch(/Gilgamesh-J\/X-ASR/);
        expect(e.attribution).toMatch(/X-ASR.*sherpa-onnx/);
        expect(e.slots).toEqual(["transcribe", "transcribe-timestamp"]);
        expect(Math.round(Object.values(X_ASR.files).reduce((a, f) => a + f.size, 0) / 1e6)).toBe(175);
    });
});

describe("SenseVoice CTC frames", () => {
    it("keeps the output frame of every emitted token (sherpa's timestamps)", () => {
        // 6 frames × 3 classes; argmax: 1 1 0 2 2 1
        const L = Float32Array.from([0, 9, 0, 0, 9, 0, 9, 0, 0, 0, 0, 9, 0, 0, 9, 0, 9, 0]);
        expect(ctcGreedyFrames(L, 6, 3)).toEqual({ tokens: [1, 2, 1], frames: [0, 3, 5] });
        expect(ctcGreedy(L, 6, 3)).toEqual([1, 2, 1]);
        expect(senseVoiceText([" hello", " world", "。"])).toBe("hello world。");
    });
});

/* ---------------- transcribe-timestamp ---------------- */

describe("sentence timestamps", () => {
    const tok = (text: string, time: number) => ({ text, time });
    const join = (t: string[]) => t.join("").trim();

    it("splits at sentence-final punctuation, shifts by the chunk start, stays within the speech spans", () => {
        const chunks: RecognizedChunk[] = [
            { start: 0, end: 10, tokens: [tok("大", 1.0), tok("家", 1.1), tok("好", 1.2), tok("。", 1.3), tok("今", 3.0), tok("天", 3.1), tok("？", 3.2)] },
            { start: 10, end: 20, tokens: [tok("好", 1.0), tok("的", 1.2), tok("。", 1.3)] },
        ];
        const spans = [
            { start: 0.8, end: 1.6 },
            { start: 2.9, end: 3.5 },
            { start: 10.7, end: 11.6 },
        ];
        const ts = sentenceTimestamps(chunks, spans, 20, join);
        expect(ts).toEqual([
            { start: 0.8, end: 1.6, text: "大家好。" },
            { start: 2.9, end: 3.5, text: "今天？" },
            { start: 10.7, end: 11.6, text: "好的。" },
        ]);
    });

    it("splits at a long pause, keeps decimals together, and is monotonic within the duration", () => {
        const chunks: RecognizedChunk[] = [
            {
                start: 0,
                end: 8,
                tokens: [tok("识", 0.2), tok("别", 0.3), tok("率", 0.4), tok("99", 0.5), tok(".", 0.6), tok("2%", 0.7), tok("还", 0.8 + MAX_TOKEN_GAP_S + 0.5), tok("差", 2.6), tok("一", 2.7), tok("点", 7.99)],
            },
        ];
        const ts = sentenceTimestamps(chunks, [], 7.5, join);
        expect(ts.map((s) => s.text)).toEqual(["识别率99.2%", "还差一", "点"]);
        for (let i = 0; i < ts.length; i++) {
            expect(ts[i]!.start).toBeGreaterThanOrEqual(0);
            expect(ts[i]!.end).toBeLessThanOrEqual(7.5);
            expect(ts[i]!.end).toBeGreaterThanOrEqual(ts[i]!.start);
            if (i) expect(ts[i]!.start).toBeGreaterThanOrEqual(ts[i - 1]!.end);
        }
    });

    it("ends a sentence at its last token when that token was emitted after the speech span (transducer delay)", () => {
        // "好" comes 0.3 s after its speech span; the full stop another 0.9 s later (it does not count)
        const chunks: RecognizedChunk[] = [{ start: 0, end: 12, tokens: [tok(" 你", 1.2), tok("好", 1.9), tok(" 。", 2.8), tok(" 好", 7.0), tok("的", 7.2)] }];
        const ts = sentenceTimestamps(chunks, [{ start: 1.0, end: 1.6 }, { start: 6.8, end: 7.5 }], 12, xAsrText);
        expect(ts).toEqual([
            { start: 1, end: 1.9, text: "你好。" },
            { start: 6.8, end: 7.5, text: "好的" },
        ]);
    });

    it("attaches leading punctuation to the previous sentence and drops empty ones", () => {
        expect(endsSentence("。", undefined)).toBe(true);
        expect(endsSentence(".", "3")).toBe(false);
        expect(endsSentence(".", " The")).toBe(true);
        const ts = sentenceTimestamps([{ start: 0, end: 4, tokens: [tok("好", 0.5), tok("？", 0.6), tok("！", 0.7), tok("嗯", 2.0)] }], [], 4, join);
        expect(ts.map((s) => s.text)).toEqual(["好？！", "嗯"]);
        expect(sentenceTimestamps([{ start: 0, end: 1, tokens: [] }], [], 1, join)).toEqual([]);
    });
});

/* ---------------- MuPDF ---------------- */

const line = (text: string, x: number, y: number, size: number, w = text.length * size, weight = "normal") => ({
    bbox: { x, y: y - size, w, h: size * 1.4 },
    font: { name: "SourceHanSansSC-Regular", size, weight },
    x,
    y,
    text,
});
const block = (...lines: ReturnType<typeof line>[]) => ({
    type: "text" as const,
    bbox: { x: lines[0]!.bbox.x, y: lines[0]!.bbox.y, w: 400, h: 20 * lines.length },
    lines,
});

describe("MuPDF structured text → Markdown", () => {
    it("headings by size, paragraphs joined across lines, list items, tables and images", () => {
        const page: StextPage = {
            blocks: [
                block(line("产品白皮书", 200, 80, 19)),
                block(line("一、背景", 60, 120, 12)),
                // a paragraph wrapped over two lines (the first runs to the right edge), then a new one
                block(line("工业园区的用能结构日趋复杂，电价实行分时计价，能耗双控", 60, 140, 10, 460)),
                block(line("考核逐年收紧。", 60, 157, 10, 70)),
                block(line("平台面向产业园区，提供一体化能力。", 60, 177, 10, 170)),
                block(line("1. 全量计量采集。支持 Modbus 与 MQTT 协议，单台网关最多接入 256", 60, 200, 10, 460)),
                block(line("块电表。", 60, 217, 10, 40)),
                block(line("2. 实时监测与告警。", 60, 237, 10, 100)),
                { type: "text", bbox: { x: 60, y: 250, w: 300, h: 14 }, lines: [line("指标", 60, 262, 9, 20), line("标准版", 200, 262, 9, 28)] },
                { type: "text", bbox: { x: 60, y: 272, w: 300, h: 14 }, lines: [line("数据保存期", 60, 284, 9, 45), line("3 年", 200, 284, 9, 17)] },
                { type: "image", bbox: { x: 60, y: 300, w: 200, h: 100 } },
                { type: "structure", contents: [block(line("The quick brown fox jumps over the", 60, 420, 10, 460)), block(line("lazy dog.", 60, 437, 10, 50))] },
            ],
        };
        const md = stextToMarkdown([page], { imageName: (i) => (i === 0 ? "doc-p1-img1.png" : undefined) });
        expect(md).toBe(
            [
                "# 产品白皮书",
                "## 一、背景",
                "工业园区的用能结构日趋复杂，电价实行分时计价，能耗双控考核逐年收紧。",
                "平台面向产业园区，提供一体化能力。",
                "1. 全量计量采集。支持 Modbus 与 MQTT 协议，单台网关最多接入 256块电表。",
                "2. 实时监测与告警。",
                "| 指标 | 标准版 |\n| --- | --- |\n| 数据保存期 | 3 年 |",
                "![](doc-p1-img1.png)",
                "The quick brown fox jumps over the lazy dog.",
            ].join("\n\n"),
        );
    });

    it("joins CJK without a space and Latin with one; finds the body size by characters", () => {
        expect(joinLines("能耗双控", "考核")).toBe("能耗双控考核");
        expect(joinLines("over the", "lazy dog")).toBe("over the lazy dog");
        expect(joinLines("inter-", "national")).toBe("international");
        expect(bodySize([{ kind: "line", size: 19, text: "标题" }, { kind: "line", size: 10, text: "很长的一段正文文字" }])).toBe(10);
    });

    it("parse-document (model mupdf) in Node: headings and paragraphs from a real PDF, pdf.js stays the default", async () => {
        const doc = await fixture("paper.pdf");
        const mu = await impls.parseDocument({ document: doc }, nodeCtx(undefined, { model: "mupdf" }));
        expect(mu.error).toBeUndefined();
        expect(mu.text).toMatch(/^# 二〇二六年第三季度经营分析报告/);
        expect(mu.text).toMatch(/\n## 一、总体情况\n/);
        // the narrow column's wrapped lines are one paragraph
        expect(mu.text).toContain("本季度公司持续推进数字化转型，各业务线保持稳定增长。华东区受益于新渠道拓展");
        expect(mu.text).toContain("| 地区 | 销售额（万元） | 同比 | 占比 |");
        expect(mu.images).toEqual([]);
        const pdfjs = await impls.parseDocument({ document: doc }, nodeCtx());
        expect(pdfjs.text).not.toMatch(/^#/);
        const bad = await impls.parseDocument({ document: doc }, nodeCtx(undefined, { model: "pymupdf" }));
        expect(bad).toMatchObject({ success: false, error: expect.stringMatching(/unknown model "pymupdf" for parse-document; available: pdfjs, mupdf/) });
    });

    it("parse-document (model mupdf): embedded images come back as PNG and are referenced where they sit", async () => {
        // a one-page PDF with a 64×64 image and no text, made with MuPDF itself
        const mupdf = await import("mupdf");
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 64], false);
        pix.clear(128);
        const pdf = new mupdf.PDFDocument();
        const page = pdf.addPage([0, 0, 300, 300], 0, { XObject: { I0: pdf.addImage(new mupdf.Image(pix)) } }, "q 100 0 0 100 50 50 cm /I0 Do Q");
        pdf.insertPage(-1, page);
        const bytes = pdf.saveToBuffer("").asUint8Array();
        const doc = { bytesBase64: Buffer.from(bytes).toString("base64"), filename: "scan.pdf", mime: "application/pdf" };
        const out = await impls.parseDocument({ document: doc }, nodeCtx(undefined, { model: "mupdf" }));
        expect(out.error).toBeUndefined();
        expect(out.text).toBe("![](scan-p1-img1.png)");
        expect(out.images).toHaveLength(1);
        const img = out.images![0] as { bytesBase64: string; mime: string; filename: string };
        expect(img).toMatchObject({ mime: "image/png", filename: "scan-p1-img1.png" });
        const png = Buffer.from(img.bytesBase64, "base64");
        expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
        expect(png.readUInt32BE(16)).toBe(64);
        // `_params.images: false` skips them
        const none = await impls.parseDocument({ document: doc }, nodeCtx(undefined, { model: "mupdf", params: { images: false } }));
        expect(none).toMatchObject({ success: true, text: "", images: [] });
        // a vector-only page: nothing to read, still a success (OCR is the host's call)
        const vector = await impls.parseDocument({ document: await fixture("no-text-layer.pdf") }, nodeCtx(undefined, { model: "mupdf" }));
        expect(vector).toMatchObject({ success: true, text: "", images: [] });
    });

    it("render-pages (model mupdf) runs in Node at the pdf.js path's DPI", async () => {
        const out = await impls.renderPages({ document: await fixture("report.pdf") }, nodeCtx(undefined, { model: "mupdf" }));
        expect(out.error).toBeUndefined();
        expect(out.pages).toHaveLength(1);
        const png = Buffer.from((out.pages![0] as { bytesBase64: string }).bytesBase64, "base64");
        expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
        // A4 at 150 DPI: 595 × 842 pt → 1240 × 1754 px (± rounding)
        const w = png.readUInt32BE(16);
        const h = png.readUInt32BE(20);
        expect(Math.abs(w - Math.round((595 * RENDER_DPI) / 72))).toBeLessThanOrEqual(2);
        expect(Math.abs(h - Math.round((842 * RENDER_DPI) / 72))).toBeLessThanOrEqual(2);
    });
});

/* ---------------- gen-text with Qwen3.5 text ---------------- */

describe("gen-text: Qwen3.5-0.8B text alternative", () => {
    it("is the second gen-text model, Apache-2.0, text-only, ending turns at <|im_end|>", () => {
        expect(GEN_TEXT_MODELS.map((m) => m.id)).toEqual(["lfm2.5-350m", "qwen3.5-0.8b-text"]);
        expect(pickModel(undefined, GEN_TEXT_MODELS).id).toBe("lfm2.5-350m");
        expect(pickModel("qwen3.5-0.8b-text", GEN_TEXT_MODELS)).toBe(QWEN35_TEXT);
        expect(QWEN35_TEXT.license).toBe("Apache-2.0");
        expect(QWEN35_TEXT.eosTokenIds).toEqual([248046, 248044]);
        expect(variantFor(QWEN35_TEXT, true).dtype).toEqual({ model: "q4f16" });
        expect(T3_MODELS).toContain(QWEN35_TEXT);
        expect(QWEN_TEXT_MAX_NEW_TOKENS).toBeLessThan(768);
        const e = models.find((m) => m.id === "qwen3.5-0.8b-text")!;
        // every file the plugin loads has a checksum (verified while it streams)
        for (const f of hostedFiles(QWEN35_TEXT)) expect(e.checksums?.[f], f).toBeDefined();
        const f16 = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "onnx/model_q4f16.onnx", "onnx/model_q4f16.onnx_data"];
        expect(Math.round(f16.reduce((a, f) => a + e.checksums![f]!.size, 0) / 1e6)).toBe(QWEN35_TEXT.f16.approxMB - 1);
    });

    it("uses the stricter no-invention prompt only when asked", () => {
        expect(keyPointMessages("合同金额 100 万元。", undefined, { strict: true })[0]!.content).toBe(KEY_POINTS_STRICT_SYSTEM_ZH);
        expect(keyPointMessages("The fee is USD 5,000.", undefined, { strict: true })[0]!.content).toBe(KEY_POINTS_STRICT_SYSTEM);
        expect(keyPointMessages("合同金额 100 万元。")[0]!.content).not.toBe(KEY_POINTS_STRICT_SYSTEM_ZH);
        expect(KEY_POINTS_STRICT_SYSTEM_ZH).toMatch(/照原文原样抄写/);
        expect(KEY_POINTS_STRICT_SYSTEM_ZH).toMatch(/不得推测/);
    });

    it("drops key points that only restate earlier ones (Qwen's contract run)", () => {
        const points = [
            "合同总金额为人民币 128 万元。",
            "合同分三期支付：签约后 10 个工作日内支付 30%，系统上线验收后支付 50%，质保期满后支付剩余 20%。",
            "质保期为 12 个月。",
            "合同总金额为人民币 128 万元，分三期支付：签约后 10 个工作日内支付 30%，系统上线验收后支付 50%，质保期满后支付剩余 20%。",
            "如乙方延期交付，每延期一日按合同总额的 0.1% 支付违约金。",
        ];
        expect(dropRestatedPoints(points)).toEqual([points[0], points[1], points[2], points[4]]);
        expect(dropRestatedPoints(["签约后30%", "系统上线验收后50%", "质保期满后剩余20%"])).toHaveLength(3);
        expect(dropRestatedPoints(["", "。", "a"])).toEqual(["a"]);
    });

    it("repetition control after the JSON constraint never bans every allowed token", () => {
        // the constraint allows only token 2; generated ids end with ... 7 9 | 7 9 → a 3-gram ban hits 2
        const generated = [7, 9, 2, 7, 9];
        const constrained = Float32Array.from([-Infinity, -Infinity, 1.5, -Infinity]);
        const plain = constrained.slice();
        applyRepeatControl(generated, plain, { penalty: 1, ngram: 3 });
        expect(Array.from(plain).every((v) => v === -Infinity)).toBe(true);
        const safe = constrained.slice();
        applyRepeatControlFeasible(generated, safe, { penalty: 1, ngram: 3 });
        expect(Array.from(safe)).toEqual(Array.from(constrained));
        const free = Float32Array.from([2, 1, 3, 0]);
        applyRepeatControlFeasible([2], free, { penalty: 2, ngram: 0 });
        expect(Array.from(free)).toEqual([2, 1, 1.5, 0]); // generated token 2: 3 / 2
    });
});

/* ---------------- verification ---------------- */

describe("streaming SHA-256 for T3 model files", () => {
    it("matches node:crypto, across chunk boundaries", () => {
        for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 1000, 70_000]) {
            const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
            const ref = createHash("sha256").update(data).digest("hex");
            expect(sha256Hex(data), String(n)).toBe(ref);
            const h = new Sha256();
            for (let i = 0; i < n; i += 37) h.update(data.subarray(i, i + 37));
            expect(h.hex()).toBe(ref);
        }
    });

    it("a mismatching body errors the stream before the consumer gets its end", async () => {
        const body = new TextEncoder().encode("model bytes");
        const good = { size: body.length, sha256: createHash("sha256").update(body).digest("hex") };
        const ok = verifiedResponse(new Response(body), "org/repo/x.onnx", good);
        expect(new Uint8Array(await ok.arrayBuffer())).toEqual(body);
        const bad = verifiedResponse(new Response(body), "org/repo/x.onnx", { ...good, sha256: "0".repeat(64) });
        await expect(bad.arrayBuffer()).rejects.toThrow(/org\/repo\/x\.onnx failed its SHA-256 check/);
        const short = verifiedResponse(new Response(body), "org/repo/x.onnx", { ...good, size: 99 });
        await expect(short.arrayBuffer()).rejects.toThrow(/has 11 bytes, expected 99/);
    });
});

/* ---------------- manifest ---------------- */

describe("manifest: the alternatives sit in their slot's models list, default first", () => {
    it("transcribe / transcribe-timestamp, gen-text, parse-document, render-pages", () => {
        expect(slotEntry("transcribe")?.models).toEqual(["sensevoice-small", "x-asr-zh-en"]);
        expect(slotEntry("transcribe-timestamp")).toEqual({ nodeSlot: "transcribe-timestamp", method: "transcribeTimestamp", models: [...SLOT_MODELS["transcribe-timestamp"]] });
        expect(slotEntry("gen-text")?.models).toEqual(GEN_TEXT_MODELS.map((m) => m.id));
        expect(slotEntry("parse-document")?.models).toEqual([...PDF_IMPLS]);
        expect(slotEntry("render-pages")?.models).toEqual([...PDF_IMPLS]);
        // the scanner rejects a slot declared twice
        const slots = manifest.slots.map((s) => s.nodeSlot);
        expect(new Set(slots).size).toBe(slots.length);
    });

    it("transcribe-timestamp rejects a model it does not have", async () => {
        const r = await impls.transcribeTimestamp(
            { audio: { bytesBase64: Buffer.from(readFileSync(new URL("../fixtures/audio/hello-zh.wav", import.meta.url))).toString("base64"), filename: "a.wav" } },
            nodeCtx(undefined, { model: "whisper" }),
        );
        expect(r).toMatchObject({ success: false, error: expect.stringMatching(/unknown model "whisper" for transcribe-timestamp; available: sensevoice-small, x-asr-zh-en/) });
    });
});
