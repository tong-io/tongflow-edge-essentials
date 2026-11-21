import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { call, fixture, fromBase64, imageSize, meanColor, pluginWorker } from "./harness.js";

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("built plugin as a DOM-less module worker, over the engine protocol (Chromium)", () => {
    it("announces protocol v1 and the manifest's methods", async () => {
        const ready = await pluginWorker().ready;
        expect(ready.protocol).toBe(1);
        expect(ready.methods?.sort()).toEqual([
            "audioTag",
            "chunkText",
            "detectLanguage",
            "detectObjects",
            "diarizeSpeakers",
            "embedImage",
            "embedText",
            "extractAudio",
            "genText",
            "getFirstFrame",
            "imageGenText",
            "imageOrient",
            "kbWrite",
            "layoutDetect",
            "ocrImage",
            "ocrImageGlm",
            "parseDocument",
            "renderPages",
            "splitVideo",
            "tableRecognize",
            "transcribe",
            "vadSegment",
        ]);
    });

    it("detect-language", async () => {
        const r = await call("detectLanguage", { text: "这是一段中文文本，用来测试语言识别。" });
        expect(r.out).toEqual({ success: true, language: "zh" });
    });

    it("render-pages: PDF → one PNG per page at 150 DPI", async () => {
        const r = await call("renderPages", { document: await fixture("report.pdf", "application/pdf") });
        expect(r.out.error).toBeUndefined();
        expect(r.out.success).toBe(true);
        expect(r.out.pages).toHaveLength(1);
        const page = r.out.pages[0];
        expect(page.mime).toBe("image/png");
        expect(page.filename).toBe("report-p1.png");
        const png = fromBase64(page.bytesBase64);
        expect(Array.from(png.subarray(0, 4))).toEqual(PNG);
        // A4 ≈ 595×842 pt → ≈1240×1754 px at 150 DPI.
        const size = await imageSize(png, "image/png");
        expect(Math.abs(size.width - 1240)).toBeLessThanOrEqual(4);
        expect(Math.abs(size.height - 1754)).toBeLessThanOrEqual(4);
        // Kept for eyeballing: test-results/ is gitignored.
        await commands.writeFile("test-results/report-p1.png.b64", page.bytesBase64);
        // White background with some dark glyphs on it (text actually drew).
        const c = await meanColor(png, "image/png");
        expect(c.r).toBeGreaterThan(200);
        expect(c.darkFraction).toBeGreaterThan(0.002);
        expect(r.progress.some((p) => p.message === "page 1/1" && p.percent === 100)).toBe(true);
    });

    it("render-pages: a vector-only page renders its drawing", async () => {
        const r = await call("renderPages", { document: await fixture("no-text-layer.pdf") });
        expect(r.out.success).toBe(true);
        const png = fromBase64(r.out.pages[0].bytesBase64);
        const c = await meanColor(png, "image/png");
        expect(c.b).toBeGreaterThan(c.r); // the blue rectangle
    });

    it("render-pages rejects non-PDF input", async () => {
        const r = await call("renderPages", { document: await fixture("report.docx") });
        expect(r.out.success).toBe(false);
        expect(r.out.error).toMatch(/PDF only/);
    });

    it("get-first-frame: VP9 WebM → PNG via WebCodecs", async () => {
        const r = await call("getFirstFrame", { video: await fixture("clip.webm", "video/webm") });
        expect(r.out.error).toBeUndefined();
        expect(r.out.image.mime).toBe("image/png");
        expect(r.out.image.filename).toBe("clip-first.png");
        const png = fromBase64(r.out.image.bytesBase64);
        expect(await imageSize(png, "image/png")).toEqual({ width: 160, height: 120 });
        const c = await meanColor(png, "image/png");
        expect(c.r + c.g + c.b).toBeGreaterThan(60); // not a black frame
    });

    it("get-first-frame: H.264 MP4 (when this Chromium can decode H.264)", async () => {
        const r = await call("getFirstFrame", { video: await fixture("clip.mp4", "video/mp4") });
        if (!r.out.success) {
            // Open-source Chromium builds may ship without H.264; the error must say so.
            expect(r.out.error).toMatch(/cannot decode/);
            console.warn("H.264 decode unavailable in this Chromium:", r.out.error);
            return;
        }
        console.warn("H.264 first frame decoded");
        const png = fromBase64(r.out.image.bytesBase64);
        expect(await imageSize(png, "image/png")).toEqual({ width: 160, height: 120 });
    });

    it("extract-audio: WebM → audio-only WebM, MP4 → M4A", async () => {
        const a = await call("extractAudio", { video: await fixture("clip.webm", "video/webm") });
        expect(a.out.error).toBeUndefined();
        expect(a.out.audio.mime).toBe("audio/webm");
        const b = await call("extractAudio", { video: await fixture("clip.mp4", "video/mp4") });
        expect(b.out.error).toBeUndefined();
        expect(b.out.audio.mime).toBe("audio/mp4");
        // The browser can decode what we produced.
        const ac = new OfflineAudioContext(1, 48000, 48000);
        const buf = await ac.decodeAudioData(fromBase64(b.out.audio.bytesBase64).buffer as ArrayBuffer);
        expect(buf.duration).toBeGreaterThan(0.5);
    });

    it.each([
        ["report.pdf", "华东区销售额增长百分之十二"],
        ["report.docx", "# 季度报告 Quarterly Report"],
        ["sales.xlsx", "| 苹果 | 12 | 3.5 |"],
        ["sales.xls", "| 苹果 | 12 | 3.5 |"],
        ["cities-gbk.csv", "| 上海 | 2487 | 直辖市, 东部 |"],
        ["launch.pptx", "> Notes: 演讲者备注：先介绍团队"],
        ["meeting.eml", "项目于下周一正式启动"],
        ["hello-cjk.msg", "你好"],
        ["article.html", "## 典型案例"],
        ["book.epub", "# 第一章 出发"],
        ["notes.md", "# 读书笔记"],
    ])("parse-document %s in the worker", async (name, expected) => {
        const r = await call("parseDocument", { document: await fixture(name) });
        expect(r.out.error).toBeUndefined();
        expect(r.out.success).toBe(true);
        expect(r.out.text).toContain(expected);
    });

    it("parse-document legacy .doc via xberg-wasm (asset fetched same-origin with progress)", async () => {
        const r = await call("parseDocument", { document: await fixture("report.doc") });
        expect(r.out.error).toBeUndefined();
        expect(r.out.text).toContain("华东区销售额增长百分之十二");
        const last = r.downloads.at(-1)!;
        expect(last.file).toBe("xberg-wasm");
        expect(last.loaded).toBeGreaterThan(10_000_000);
    });
});
