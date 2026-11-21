// T2 audio slots in Chromium. Decoding (WebCodecs) and the worker's model-base
// handling always run; real inference runs only when EDGE_MODELS_DIR is set
// (served as /models/, the plugin's default model base, by vitest.config.ts).
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { decodeAudio } from "../../src/audio/decode.js";
import { encodeWav } from "../../src/audio/wav.js";
import { call, fixture, fromBase64, startWorker, toBase64 } from "./harness.js";

const FORMATS = [
    ["hello-zh.wav", "audio/wav"],
    ["hello-zh.mp3", "audio/mpeg"],
    ["hello-zh.ogg", "audio/ogg"],
    ["hello-zh.webm", "audio/webm"],
    ["hello-zh.flac", "audio/flac"],
    ["dialog-zh.m4a", "audio/mp4"],
] as const;

async function bytes(name: string): Promise<Uint8Array> {
    const res = await fetch(`/test/fixtures/audio/${name}`);
    return new Uint8Array(await res.arrayBuffer());
}

/** AAC needs a proprietary-codec Chromium build; Playwright's may lack it. */
let aacDecodes = true;

describe("audio decoding to 16 kHz mono (Mediabunny + WebCodecs)", () => {
    for (const [name] of FORMATS) {
        it(name, async () => {
            const signal = new AbortController().signal;
            let a;
            try {
                a = await decodeAudio(await bytes(name), { signal });
            } catch (e) {
                if (name.endsWith(".m4a") && /cannot decode/.test(String(e))) {
                    aacDecodes = false;
                    console.warn("AAC decode unavailable in this Chromium:", String(e));
                    return;
                }
                throw e;
            }
            expect(a.sampleRate).toBe(16000);
            const expected = name.startsWith("dialog") ? 21.05 : 1.49;
            expect(Math.abs(a.duration - expected)).toBeLessThan(0.1);
            let peak = 0;
            for (const s of a.samples) peak = Math.max(peak, Math.abs(s));
            expect(peak).toBeGreaterThan(0.05);
        });
    }
});

describe("audio slots in the worker without hosted weights", () => {
    it("decode, then fail with the model URL from ?modelBase=", async () => {
        const w = startWorker(`/dist/index.js?modelBase=${encodeURIComponent("/no-models-here/")}`);
        for (const [name, mime] of FORMATS.filter(([n]) => aacDecodes || !n.endsWith(".m4a"))) {
            const r = await call("audioTag", { audio: await fixture(`audio/${name}`, mime) }, { worker: w });
            expect(r.out.success, name).toBe(false);
            expect(r.out.error).toContain(`${location.origin}/no-models-here/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/model.int8.onnx`);
        }
        w.worker.terminate();
    });

    it("a {type: 'config'} message sets the model base", async () => {
        const w = startWorker("/dist/index.js");
        await w.ready;
        w.worker.postMessage({ type: "config", modelBase: "https://weights.invalid/m/" });
        const r = await call("vadSegment", { audio: await fixture("audio/hello-zh.wav", "audio/wav") }, { worker: w });
        expect(r.out.success).toBe(false);
        expect(r.out.error).toContain("https://weights.invalid/m/pengzhendong/silero-vad/v5/silero_vad.onnx");
        w.worker.terminate();
    });
});

declare const __EDGE_MODELS__: string;
const haveModels = Boolean(__EDGE_MODELS__);
if (!haveModels) console.warn("[audio] EDGE_MODELS_DIR is not set: skipping the real-model audio tests");

describe.skipIf(!haveModels)("real models from EDGE_MODELS_DIR (served at /models/), in the plugin worker", () => {
    const dialog = () => (aacDecodes ? fixture("audio/dialog-zh.m4a", "audio/mp4") : fixture("audio/dialog-zh.wav", "audio/wav"));
    const time = async <T>(label: string, f: () => Promise<T>) => {
        const t = performance.now();
        const v = await f();
        console.warn(`[audio] ${label}: ${Math.round(performance.now() - t)} ms`);
        return v;
    };

    it("transcribe: SenseVoiceSmall, Chinese with punctuation; downloads reported, then cached", async () => {
        const audio = await dialog();
        const first = await time(`transcribe, first call (21 s ${audio.filename})`, () => call("transcribe", { audio }));
        expect(first.out.error).toBeUndefined();
        expect(first.out.text).toContain("大家好，今天我们讨论一下下个季度的产品计划。");
        expect(first.out.text).toContain("第三是售后服务。");
        const files = new Set(first.downloads.map((d) => d.file));
        expect(files).toContain("pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/model.int8.onnx");
        expect(files).toContain("pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/tokens.txt");
        const done = first.downloads.filter((d) => d.file?.endsWith("model.int8.onnx")).at(-1)!;
        expect(done.loaded).toBe(239233841);
        const again = await time("transcribe, second call (model loaded)", () => call("transcribe", { audio }));
        expect(again.out.text).toBe(first.out.text);
        await commands.writeFile("test-results/transcribe.txt", first.out.text);
    }, 900_000);

    it("transcribe: audio over 30 s is cut at pauses (VAD) and joined", async () => {
        const a = await decodeAudio(await bytes("dialog-zh.wav"), { signal: new AbortController().signal });
        const long = new Float32Array(a.samples.length * 3);
        for (let i = 0; i < 3; i++) long.set(a.samples, i * a.samples.length);
        const audio = { bytesBase64: toBase64(encodeWav(long, 16000)), filename: "dialog-x3.wav", mime: "audio/wav" };
        const r = await time("transcribe 63 s (VAD chunks)", () => call("transcribe", { audio }));
        expect(r.out.error).toBeUndefined();
        expect(r.out.text.split("大家好").length - 1).toBe(3);
        expect(r.progress.some((p) => /^transcribing \d+\/\d+$/.test(p.message))).toBe(true);
    }, 900_000);

    it("transcribe: cancelling mid-run rejects with AbortError", async () => {
        const a = await decodeAudio(await bytes("dialog-zh.wav"), { signal: new AbortController().signal });
        const long = new Float32Array(a.samples.length * 3);
        for (let i = 0; i < 3; i++) long.set(a.samples, i * a.samples.length);
        const audio = { bytesBase64: toBase64(encodeWav(long, 16000)), filename: "dialog-x3.wav", mime: "audio/wav" };
        await expect(call("transcribe", { audio }, { cancelOn: (m) => m.type === "progress" && /^transcribing 1\//.test(m.message ?? "") })).rejects.toMatchObject({
            name: "AbortError",
        });
    }, 900_000);

    it("transcribe (x-asr-zh-en): X-ASR, Chinese with punctuation, from the model base", async () => {
        const audio = await dialog();
        const r = await time(`transcribe x-asr, first call (21 s ${audio.filename})`, () => call("transcribe", { audio }, { model: "x-asr-zh-en" }));
        expect(r.out.error).toBeUndefined();
        expect(r.out.text).toContain("大家好，今天我们讨论一下下个季度的产品计划。");
        expect(r.out.text).toContain("第三是售后服务。");
        const files = new Set(r.downloads.map((d) => d.file));
        for (const f of ["encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.int8.onnx", "tokens.txt"]) {
            expect(files).toContain(`mogenle/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03/${f}`);
        }
        const again = await time("transcribe x-asr, second call (model loaded)", () => call("transcribe", { audio }, { model: "x-asr-zh-en" }));
        expect(again.out.text).toBe(r.out.text);
    }, 900_000);

    it("transcribe-timestamp: sentence segments in order and inside the audio (SenseVoice and X-ASR)", async () => {
        const audio = await dialog();
        for (const model of ["sensevoice-small", "x-asr-zh-en"]) {
            const r = await time(`transcribe-timestamp ${model} 21 s`, () => call("transcribeTimestamp", { audio }, { model }));
            expect(r.out.error).toBeUndefined();
            const ts = r.out.time_stamps as { start: number; end: number; text: string }[];
            console.warn(`[audio] ${model}`, JSON.stringify(ts));
            expect(ts.length).toBeGreaterThanOrEqual(4);
            expect(ts.map((s) => s.text).join("")).toBe(r.out.text);
            ts.forEach((s, i) => {
                expect(Object.keys(s).sort()).toEqual(["end", "start", "text"]);
                expect(s.start).toBeGreaterThanOrEqual(i ? ts[i - 1]!.end : 0);
                expect(s.end).toBeGreaterThan(s.start);
                expect(s.end).toBeLessThanOrEqual(21.1);
            });
            expect(ts[0]!.start).toBeGreaterThan(0.6);
            expect(ts[0]!.start).toBeLessThan(1.3);
        }
    }, 900_000);

    it("vad-segment: 4 utterances → 4 WAV AudioRefs (16 kHz mono)", async () => {
        const r = await time("vad-segment 21 s", async () => call("vadSegment", { audio: await dialog() }));
        expect(r.out.error).toBeUndefined();
        expect(r.out.segments).toHaveLength(4);
        const seg = r.out.segments[0];
        expect(seg.mime).toBe("audio/wav");
        expect(seg.filename).toMatch(/^dialog-zh-001-\d+\.\d+s-\d+\.\d+s\.wav$/);
        const wav = fromBase64(seg.bytesBase64);
        const v = new DataView(wav.buffer);
        expect(v.getUint32(24, true)).toBe(16000);
        expect(v.getUint16(22, true)).toBe(1);
    }, 600_000);

    it("diarize-speakers: two alternating voices", async () => {
        const r = await time("diarize-speakers 21 s", async () => call("diarizeSpeakers", { audio: await dialog() }));
        expect(r.out.error).toBeUndefined();
        const segs = JSON.parse(r.out.segments) as { speaker: number; start: number; end: number }[];
        expect(segs.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
        expect(Math.abs(segs[0]!.start - 0.976)).toBeLessThan(0.1);
        const files = new Set(r.downloads.map((d) => d.file));
        expect(files).toContain("pengzhendong/sherpa-onnx-pyannote-segmentation-3-0/model.onnx");
        expect(files).toContain("lihuoo/3dspeaker-recognition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx");
    }, 600_000);

    it("audio-tag: CED-tiny labels speech", async () => {
        const r = await time("audio-tag 1.5 s", async () => call("audioTag", { audio: await fixture("audio/hello-zh.mp3", "audio/mpeg") }));
        expect(r.out.error).toBeUndefined();
        const tags = JSON.parse(r.out.tags) as { label: string; score: number }[];
        expect(tags[0]!.label).toBe("Speech");
        expect(tags[0]!.score).toBeGreaterThan(0.5);
    }, 600_000);
});
