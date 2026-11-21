// Real-model inference of the alternative audio models in Node (onnxruntime-web's wasm
// build), only when EDGE_MODELS_DIR holds the weights in the model-base layout.
// Expected values: sherpa-onnx 2.0.2 (Python) for Zipformer-CTC; for Nemotron, the
// transformers offline algorithm run with onnxruntime (Python) on the same q4 graph.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { impls } from "../../src/index.js";
import { EDGE_MODELS_DIR, nodeCtx } from "../helpers/node-ctx.js";

if (!EDGE_MODELS_DIR) console.warn("[alt-audio-models] skipped: set EDGE_MODELS_DIR to the model cache to run real inference");

const wav = (name: string) => ({
    bytesBase64: readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url)).toString("base64"),
    filename: name,
    mime: "audio/wav",
});

async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
    const t = performance.now();
    const v = await f();
    console.warn(`[alt-audio-models] ${label}: ${Math.round(performance.now() - t)} ms`);
    return v;
}

describe.skipIf(!EDGE_MODELS_DIR)("alternative audio models (Node, onnxruntime-web wasm)", () => {
    it("transcribe with zipformer-ctc-small-zh = sherpa-onnx's text (no punctuation)", async () => {
        const ctx = nodeCtx(undefined, { model: "zipformer-ctc-small-zh" });
        const r = await timed("zipformer 21 s", () => impls.transcribe({ audio: wav("dialog-zh.wav") }, ctx));
        expect(r.error).toBeUndefined();
        expect(r.text).toBe(
            "大家好今天我们讨论一下下个季度的产品计划好的我先介绍一下市场度的调研结果请重点说明用户最关心的三个问题第一是价格第二是续航第三是售后服务",
        );
        expect(ctx.rec.downloads.some((d) => d.label.endsWith("sherpa-onnx-zipformer-ctc-small-zh-int8-2025-07-16/model.int8.onnx"))).toBe(true);
        const hello = await impls.transcribe({ audio: wav("hello-zh.wav") }, nodeCtx(undefined, { model: "zipformer-ctc-small-zh" }));
        expect(hello.error).toBeUndefined();
        expect(hello.text).toBe("你好世界");
    }, 300_000);

    it("transcribe-timestamp with zipformer-ctc-small-zh: sentence times from CTC frames", async () => {
        const r = await impls.transcribeTimestamp({ audio: wav("dialog-zh.wav") }, nodeCtx(undefined, { model: "zipformer-ctc-small-zh" }));
        expect(r.error).toBeUndefined();
        const ts = r.time_stamps as { start: number; end: number; text: string }[];
        console.warn(JSON.stringify(ts));
        expect(ts.length).toBeGreaterThanOrEqual(3);
        expect(ts.map((t) => t.text).join("")).toBe(r.text);
        // Speech starts at 0.98 s; CTC spikes lead it and the sentence start is pulled back up to 0.6 s.
        expect(ts[0]!.start).toBeGreaterThanOrEqual(0);
        expect(ts[0]!.start).toBeLessThan(1.1);
        expect(ts.map((t) => t.text)).toEqual(["大家好今天我们讨论一下下个季度的产品计划", "好的我先介绍一下市场度的调研结果", "请重点说明用户最关心的三个问题", "第一是价格第二是续航第三是售后服务"]);
        for (let i = 1; i < ts.length; i++) expect(ts[i]!.start).toBeGreaterThanOrEqual(ts[i - 1]!.end);
    }, 300_000);

    it("transcribe with qwen3-asr-0.6b = sherpa-onnx's text (with punctuation)", async () => {
        const ctx = nodeCtx(undefined, { model: "qwen3-asr-0.6b" });
        const r = await timed("qwen3-asr 1.5 s", () => impls.transcribe({ audio: wav("hello-zh.wav") }, ctx));
        expect(r.error).toBeUndefined();
        // sherpa-onnx 2.0.2 (Python), same int8 export.
        expect(r.text).toBe("你好，世界。");
        const zh = await timed("qwen3-asr 1.5 s, language zh", () =>
            impls.transcribe({ audio: wav("hello-zh.wav"), language: "zh" }, nodeCtx(undefined, { model: "qwen3-asr-0.6b" })),
        );
        expect(zh.text).toBe("你好，世界。");
    }, 1_800_000);

    it("diarize-speakers with nemotron-3-diarization: two alternating voices", async () => {
        const ctx = nodeCtx(undefined, { model: "nemotron-3-diarization" });
        const r = await timed("nemotron 21 s", () => impls.diarizeSpeakers({ audio: wav("dialog-zh.wav") }, ctx));
        expect(r.error).toBeUndefined();
        const segs = JSON.parse(r.segments!) as { speaker: number; start: number; end: number }[];
        console.warn(JSON.stringify(segs));
        expect(segs.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
        expect(Math.abs(segs[0]!.start - 0.98)).toBeLessThan(0.05);
    }, 300_000);
});
