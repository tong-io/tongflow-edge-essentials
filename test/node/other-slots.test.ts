import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { impls, methods, slots } from "../../src/index.js";

const { detectLanguage, extractAudio, renderPages } = impls;
import { fixture, nodeCtx } from "../helpers/node-ctx.js";

describe("detect-language (eld)", () => {
    it.each([
        ["今天天气很好，我们一起去公园散步吧。", "zh"],
        ["The quick brown fox jumps over the lazy dog near the river bank.", "en"],
        ["Le renard brun rapide saute par-dessus le chien paresseux.", "fr"],
        ["今日はとても良い天気ですね。散歩に行きましょう。", "ja"],
    ])("%s → %s", async (text, lang) => {
        const out = await detectLanguage({ text }, nodeCtx());
        expect(out).toEqual({ success: true, language: lang });
    });

    it("fails clearly on text without letters", async () => {
        const out = await detectLanguage({ text: "12345 !!! ---" }, nodeCtx());
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/could not determine/);
    });
});

describe("extract-audio (Mediabunny, remux path runs without WebCodecs)", () => {
    it("H.264/AAC MP4 → AAC in .m4a", async () => {
        const out = await extractAudio({ video: await fixture("clip.mp4", "video/mp4") }, nodeCtx());
        expect(out.error).toBeUndefined();
        expect(out.success).toBe(true);
        expect(out.audio?.mime).toBe("audio/mp4");
        expect(out.audio?.filename).toBe("clip.m4a");
        const bytes = Buffer.from((out.audio as { bytesBase64: string }).bytesBase64, "base64");
        expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
        expect(bytes.includes(Buffer.from("mp4a"))).toBe(true);
        expect(bytes.includes(Buffer.from("avc1"))).toBe(false);
    });

    it("VP9/Opus WebM → Opus in audio-only .webm", async () => {
        const out = await extractAudio({ video: await fixture("clip.webm", "video/webm") }, nodeCtx());
        expect(out.error).toBeUndefined();
        expect(out.audio?.mime).toBe("audio/webm");
        expect(out.audio?.filename).toBe("clip.webm");
        const bytes = Buffer.from((out.audio as { bytesBase64: string }).bytesBase64, "base64");
        expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // EBML
        expect(bytes.includes(Buffer.from("A_OPUS"))).toBe(true);
        expect(bytes.includes(Buffer.from("V_VP9"))).toBe(false);
    });

    it("a video without audio fails clearly", async () => {
        const out = await extractAudio({ video: await fixture("silent.webm", "video/webm") }, nodeCtx());
        expect(out).toEqual({ success: false, error: "this file has no audio track" });
    });
});

describe("browser-only slots outside a browser", () => {
    it("render-pages reports that it needs OffscreenCanvas", async () => {
        const out = await renderPages({ document: await fixture("report.pdf") }, nodeCtx());
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/OffscreenCanvas/);
    });
});

describe("manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../tongflow.plugin.json", import.meta.url), "utf8"));
    it("declares runtime browser, the dist entry and exactly the exported methods", () => {
        expect(manifest.runtime).toBe("browser");
        expect(manifest.entry).toBe("dist/index.js");
        const declared = Object.fromEntries(manifest.slots.map((s: { nodeSlot: string; method: string }) => [s.nodeSlot, s.method]));
        expect(declared).toEqual(slots);
        for (const m of Object.values(declared)) expect(typeof (methods as Record<string, unknown>)[m as string]).toBe("function");
    });
});
