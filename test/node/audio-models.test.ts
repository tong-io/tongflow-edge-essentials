// Real-model inference in Node (onnxruntime-web's wasm build), only when
// EDGE_MODELS_DIR holds the weights in the model-base layout (<org>/<repo>/<path>).
// Expected values come from sherpa-onnx 2.0.2 (Python) on the same files and models.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { impls } from "../../src/index.js";
import { EDGE_MODELS_DIR, nodeCtx } from "../helpers/node-ctx.js";

if (!EDGE_MODELS_DIR) console.warn("[audio-models] skipped: set EDGE_MODELS_DIR to the model cache to run real audio inference");

const wav = (name: string) => ({
    bytesBase64: readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url)).toString("base64"),
    filename: name,
    mime: "audio/wav",
});

async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
    const t = performance.now();
    const v = await f();
    console.warn(`[audio-models] ${label}: ${Math.round(performance.now() - t)} ms`);
    return v;
}

describe.skipIf(!EDGE_MODELS_DIR)("audio models (Node, onnxruntime-web wasm)", () => {
    it("transcribe = sherpa-onnx's SenseVoice output, with punctuation", async () => {
        const ctx = nodeCtx();
        const r = await timed("transcribe 21 s", () => impls.transcribe({ audio: wav("dialog-zh.wav") }, ctx));
        expect(r.error).toBeUndefined();
        // sherpa-onnx 2.0.2, same int8 model, use_itn=True.
        expect(r.text).toBe(
            "大家好，今天我们讨论一下下个季度的产品计划。好的，我先介绍一下市场度的调研结果，请重点说明用户最关心的三个问题。第一是价格，第二是信航。第三是售后服务。",
        );
        expect(ctx.rec.downloads.some((d) => d.label.endsWith("sherpa-onnx-sense-voice-zh-en-ja-ko-yue/model.int8.onnx"))).toBe(true);
    }, 300_000);

    it("vad-segment: four utterances as 16 kHz mono WAV", async () => {
        const r = await timed("vad-segment 21 s", () => impls.vadSegment({ audio: wav("dialog-zh.wav") }, nodeCtx()));
        expect(r.error).toBeUndefined();
        expect(r.segments).toHaveLength(4);
        // sherpa-onnx's VAD: 1.09–5.68, 6.81–10.03, 11.52–14.99, 16.09–19.63 (no padding); ours pads 0.2 s.
        const spans = r.segments!.map((s) => (s as { filename: string }).filename.match(/-(\d+\.\d+)s-(\d+\.\d+)s\.wav$/)!.slice(1).map(Number));
        const ref = [
            [1.09, 5.68],
            [6.81, 10.03],
            [11.52, 14.99],
            [16.09, 19.63],
        ];
        spans.forEach(([a, b], i) => {
            expect(Math.abs(a! - ref[i]![0]!)).toBeLessThan(0.35);
            expect(Math.abs(b! - ref[i]![1]!)).toBeLessThan(0.35);
        });
        const first = Buffer.from((r.segments![0] as { bytesBase64: string }).bytesBase64, "base64");
        expect(first.toString("ascii", 0, 4)).toBe("RIFF");
        expect(first.readUInt32LE(24)).toBe(16000);
        expect(first.readUInt16LE(22)).toBe(1);
    }, 300_000);

    it("diarize-speakers: two alternating voices, as sherpa-onnx finds them", async () => {
        const r = await timed("diarize 21 s", () => impls.diarizeSpeakers({ audio: wav("dialog-zh.wav") }, nodeCtx()));
        expect(r.error).toBeUndefined();
        const segs = JSON.parse(r.segments!) as { speaker: number; start: number; end: number }[];
        // sherpa-onnx: (0.976, 5.735, 1) (6.815, 10.072, 0) (11.422, 14.965, 1) (16.079, 19.572, 0)
        expect(segs.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
        const ref = [0.976, 6.815, 11.422, 16.079];
        segs.forEach((s, i) => expect(Math.abs(s.start - ref[i]!)).toBeLessThan(0.1));
        const one = await impls.diarizeSpeakers({ audio: wav("dialog-zh.wav") }, nodeCtx(undefined, { params: { num_speakers: 1 } }));
        expect(new Set((JSON.parse(one.segments!) as { speaker: number }[]).map((s) => s.speaker))).toEqual(new Set([0]));
    }, 300_000);

    it("audio-tag: CED-tiny on sherpa's test clip (a cat) and on speech", async () => {
        const cat = {
            bytesBase64: readFileSync(`${EDGE_MODELS_DIR}/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/test_wavs/1.wav`).toString("base64"),
            filename: "1.wav",
        };
        const r = await timed("audio-tag 10 s", () => impls.audioTag({ audio: cat }, nodeCtx()));
        expect(r.error).toBeUndefined();
        const tags = JSON.parse(r.tags!) as { label: string; score: number }[];
        // sherpa-onnx: Cat 0.9069, Animal 0.9042, Domestic animals, pets 0.8688, Meow 0.5071
        const byLabel = Object.fromEntries(tags.map((t) => [t.label, t.score]));
        expect(Math.abs(byLabel.Cat! - 0.9069)).toBeLessThan(0.02);
        expect(Math.abs(byLabel.Meow! - 0.5071)).toBeLessThan(0.03);
        const speech = await impls.audioTag({ audio: wav("hello-zh.wav") }, nodeCtx());
        expect(JSON.parse(speech.tags!)[0].label).toBe("Speech");
    }, 300_000);
});
