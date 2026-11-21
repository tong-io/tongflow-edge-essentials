// Audio slots without model weights: the DSP ports against kaldi-native-fbank,
// the resampler, decoding through Mediabunny's PCM path, the VAD/diarization/
// clustering logic on synthetic inputs, the model manifest, and the slots'
// failure modes. Real-model inference is in audio-models.test.ts (EDGE_MODELS_DIR).
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { clusterEmbeddings } from "../../src/audio/cluster.js";
import { decodeAudio } from "../../src/audio/decode.js";
import { powersetMapping } from "../../src/audio/diarize.js";
import { CED_FBANK, Fbank, type FbankOptions, SENSEVOICE_FBANK, SPEAKER_FBANK } from "../../src/audio/fbank.js";
import { joinTranscript, SLOT_MODELS } from "../../src/audio/pipeline.js";
import { Resampler, resample } from "../../src/audio/resample.js";
import { applyLfr, ctcGreedy, parseTokens, senseVoiceLanguage } from "../../src/audio/sensevoice.js";
import { amplitudeToDb, parseLabels, tagWindows } from "../../src/audio/tagging.js";
import { mergeSpans, speechSpans, VAD_DEFAULTS, VAD_WINDOW } from "../../src/audio/vad.js";
import { encodeWav } from "../../src/audio/wav.js";
import { impls } from "../../src/index.js";
import { metaFloats, metaInt, readOnnxMetadata } from "../../src/ml/onnx-meta.js";
import { modelFileUrl } from "../../src/models/hub.js";
import { AUDIO_MODELS } from "../../src/models/registry.js";
import { nodeCtx } from "../helpers/node-ctx.js";

const audioFixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url)));
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** The synthetic signal fbank-golden.json was computed on (kaldi-native-fbank 1.x, Python). */
function goldenSignal(n: number): Float32Array {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        x[i] =
            0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000) +
            0.25 * Math.sin((2 * Math.PI * 3000 * i) / 16000 + 0.3) +
            0.1 * Math.sin(2 * Math.PI * (100 + (20000 * i) / 16000) * (i / 16000));
    }
    return x;
}

describe("Kaldi fbank port matches kaldi-native-fbank", () => {
    const golden = JSON.parse(readFileSync(new URL("../fixtures/audio/fbank-golden.json", import.meta.url), "utf8"));
    const signal = goldenSignal(golden.n);
    const cases: [string, FbankOptions, number, boolean][] = [
        ["sensevoice", SENSEVOICE_FBANK, 2e-3, true],
        ["speaker", SPEAKER_FBANK, 2e-3, true],
        ["ced", CED_FBANK, 1e-3, false],
    ];
    for (const [name, opts, tol, isLog] of cases) {
        it(`${name}: frame count and values`, () => {
            const fb = new Fbank(opts);
            const { data, frames } = fb.compute(signal);
            const g = golden[name];
            expect(frames).toBe(g.frames);
            for (const [row, ref] of Object.entries(g.rows) as [string, number[]][]) {
                const r = Number(row);
                for (let b = 0; b < ref.length; b++) {
                    const got = data[r * fb.dim + b]!;
                    const want = ref[b]!;
                    if (isLog) expect(Math.abs(got - want)).toBeLessThan(tol);
                    else expect(Math.abs(got - want)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(want)));
                }
            }
        });
    }
});

describe("resampler", () => {
    const sine = (rate: number, n: number, hz: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

    it("44.1 kHz → 16 kHz keeps a 1 kHz tone and the duration", () => {
        const x = sine(44100, 44100, 1000);
        const y = resample(x, 44100, 16000);
        expect(Math.abs(y.length - 16000)).toBeLessThanOrEqual(2);
        // Steady-state amplitude ≈ 1, phase follows the tone.
        let maxErr = 0;
        for (let i = 200; i < y.length - 200; i++) maxErr = Math.max(maxErr, Math.abs(y[i]! - Math.sin((2 * Math.PI * 1000 * i) / 16000)));
        expect(maxErr).toBeLessThan(0.01);
    });

    it("removes content above the new Nyquist (12 kHz at 48 kHz → 16 kHz)", () => {
        const y = resample(sine(48000, 48000, 12000), 48000, 16000);
        let rms = 0;
        for (let i = 200; i < y.length - 200; i++) rms += y[i]! ** 2;
        expect(Math.sqrt(rms / (y.length - 400))).toBeLessThan(0.01);
    });

    it("streaming in odd-sized blocks equals one shot", () => {
        const x = sine(22050, 22050, 440);
        const whole = resample(x, 22050, 16000);
        const r = new Resampler(22050, 16000);
        const parts: Float32Array[] = [];
        for (let i = 0; i < x.length; i += 1237) parts.push(r.process(x.subarray(i, i + 1237)));
        parts.push(r.process(new Float32Array(0), true));
        const joined = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
        let off = 0;
        for (const p of parts) {
            joined.set(p, off);
            off += p.length;
        }
        expect(joined.length).toBe(whole.length);
        for (let i = 0; i < whole.length; i++) expect(Math.abs(joined[i]! - whole[i]!)).toBeLessThan(1e-5);
    });
});

describe("decoding to 16 kHz mono", () => {
    it("WAV (22.05 kHz) through Mediabunny's PCM path", async () => {
        const a = await decodeAudio(audioFixture("hello-zh.wav"), nodeCtx());
        expect(a.sampleRate).toBe(16000);
        expect(a.duration).toBeGreaterThan(1.4);
        expect(a.duration).toBeLessThan(1.6);
        expect(a.codec).toBe("pcm-s16");
        let peak = 0;
        for (const s of a.samples) peak = Math.max(peak, Math.abs(s));
        expect(peak).toBeGreaterThan(0.05);
        expect(peak).toBeLessThanOrEqual(1);
    });

    it("refuses non-audio and honours cancellation", async () => {
        await expect(decodeAudio(new TextEncoder().encode("not audio at all"), nodeCtx())).rejects.toThrow(/unsupported|no audio/);
        const ac = new AbortController();
        ac.abort();
        await expect(decodeAudio(audioFixture("dialog-zh.wav"), nodeCtx(ac.signal))).rejects.toThrow();
    });

    it("WAV encoder round-trips", async () => {
        const x = Float32Array.from({ length: 1600 }, (_, i) => 0.5 * Math.sin(i / 10));
        const wav = encodeWav(x, 16000);
        expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
        const a = await decodeAudio(wav, nodeCtx());
        expect(a.samples.length).toBe(1600);
        for (let i = 0; i < x.length; i++) expect(Math.abs(a.samples[i]! - x[i]!)).toBeLessThan(1e-3);
    });
});

describe("SenseVoice pieces", () => {
    it("LFR stacks 7 frames with shift 6 and repeats the edges", () => {
        const dim = 2;
        const feats = Float32Array.from({ length: 10 * dim }, (_, i) => Math.floor(i / dim)); // frame index
        const { data, frames } = applyLfr(feats, dim, 7, 6);
        expect(frames).toBe(2);
        // First output: centre 0, left context 3 → frames 0,0,0,0,1,2,3.
        expect(Array.from(data.subarray(0, 14)).filter((_, i) => i % 2 === 0)).toEqual([0, 0, 0, 0, 1, 2, 3]);
        // Second: centre 6 → frames 3..9.
        expect(Array.from(data.subarray(14, 28)).filter((_, i) => i % 2 === 0)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    });

    it("CTC greedy drops blanks and repeats", () => {
        const V = 4;
        const seq = [1, 1, 0, 1, 2, 2, 0, 0, 3];
        const logits = new Float32Array(seq.length * V);
        seq.forEach((t, i) => (logits[i * V + t] = 5));
        expect(ctcGreedy(logits, seq.length, V)).toEqual([1, 1, 2, 3]);
    });

    it("tokens and language hints", () => {
        const syms = parseTokens("<blk> 0\n<|zh|> 1\n▁hello 2\n你 3\n");
        expect(syms).toEqual(["<blk>", "<|zh|>", "▁hello", "你"]);
        expect(senseVoiceLanguage(undefined)).toBe("auto");
        expect(senseVoiceLanguage("zh-CN")).toBe("zh");
        expect(senseVoiceLanguage("Cantonese")).toBe("yue");
        expect(senseVoiceLanguage("粤语")).toBe("yue");
        expect(senseVoiceLanguage("en")).toBe("en");
        expect(senseVoiceLanguage("fr")).toBe("auto");
    });

    it("joins chunk transcripts without spaces in CJK", () => {
        expect(joinTranscript(["大家好。", "今天开会。"])).toBe("大家好。今天开会。");
        expect(joinTranscript(["Hello there.", "Next part", ""])).toBe("Hello there. Next part");
    });
});

describe("ONNX metadata", () => {
    it("reads metadata_props past the graph", () => {
        const enc = new TextEncoder();
        const field = (num: number, payload: Uint8Array) => {
            const len: number[] = [];
            let n = payload.length;
            do {
                len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
                n >>>= 7;
            } while (n);
            return Uint8Array.from([(num << 3) | 2, ...len, ...payload]);
        };
        const entry = (k: string, v: string) => field(14, Uint8Array.from([...field(1, enc.encode(k)), ...field(2, enc.encode(v))]));
        const model = Uint8Array.from([
            0x08, 0x07, // ir_version varint
            ...field(7, new Uint8Array(300)), // a "graph" with a 2-byte length
            ...entry("lfr_window_size", "7"),
            ...entry("neg_mean", "-1.5,2,3.25"),
        ]);
        const meta = readOnnxMetadata(model);
        expect(metaInt(meta, "lfr_window_size")).toBe(7);
        expect(Array.from(metaFloats(meta, "neg_mean"))).toEqual([-1.5, 2, 3.25]);
        expect(() => metaInt(meta, "missing")).toThrow(/missing/);
    });
});

describe("VAD timestamps (silero get_speech_timestamps)", () => {
    const sec = (s: number) => Math.round((s * 16000) / VAD_WINDOW);
    function probs(total: number, speech: [number, number][]): Float32Array {
        const p = new Float32Array(sec(total)).fill(0.05);
        for (const [a, b] of speech) p.fill(0.95, sec(a), sec(b));
        return p;
    }

    it("finds padded speech spans and bridges short pauses", () => {
        const p = probs(10, [
            [1, 3],
            [3.2, 4], // 0.2 s pause < 0.5 s min silence → same span
            [6, 8],
        ]);
        const spans = speechSpans(p, 10 * 16000, VAD_DEFAULTS);
        expect(spans).toHaveLength(2);
        expect(spans[0]!.start / 16000).toBeCloseTo(0.8, 1);
        expect(spans[0]!.end / 16000).toBeCloseTo(4.2, 1);
        expect(spans[1]!.start / 16000).toBeCloseTo(5.8, 1);
    });

    it("drops blips shorter than the minimum speech duration", () => {
        expect(speechSpans(probs(5, [[2, 2.1]]), 5 * 16000, VAD_DEFAULTS)).toEqual([]);
    });

    it("splits speech longer than max_speech_s at a pause", () => {
        const p = probs(70, [
            [0, 20],
            [20.3, 45],
            [45.2, 69],
        ]);
        const spans = speechSpans(p, 70 * 16000, { ...VAD_DEFAULTS, maxSpeechS: 30 });
        expect(spans.length).toBeGreaterThanOrEqual(3);
        for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(30 * 16000 + 2 * 3200);
    });

    it("merges spans up to a chunk size", () => {
        const m = mergeSpans(
            [
                { start: 0, end: 10 },
                { start: 12, end: 20 },
                { start: 25, end: 40 },
            ],
            25,
        );
        expect(m).toEqual([
            { start: 0, end: 20 },
            { start: 25, end: 40 },
        ]);
    });
});

describe("diarization pieces", () => {
    it("pyannote powerset (3 speakers, ≤ 2 at once)", () => {
        const m = powersetMapping(7, 3, 2).map((r) => Array.from(r));
        expect(m).toEqual([
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [1, 1, 0],
            [1, 0, 1],
            [0, 1, 1],
        ]);
    });

    it("complete-linkage clustering by cosine distance, numbered by first member", () => {
        const dim = 8;
        const centers = [
            [1, 0, 0, 0, 0, 0, 0, 0],
            [0, 1, 0, 0, 0, 0, 0, 0],
            [0, 0, 1, 1, 0, 0, 0, 0],
        ];
        const order = [2, 0, 0, 1, 2, 1, 0, 2];
        let seed = 1;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
        const emb = new Float32Array(order.length * dim);
        order.forEach((c, i) => centers[c]!.forEach((v, d) => (emb[i * dim + d] = v + rand())));
        const labels = Array.from(clusterEmbeddings(emb, order.length, dim));
        expect(labels).toEqual([0, 1, 1, 2, 0, 2, 1, 0]);
        expect(Array.from(clusterEmbeddings(emb, order.length, dim, { numClusters: 2 })).sort()).toContain(1);
        expect(new Set(clusterEmbeddings(emb, order.length, dim, { threshold: 2 })).size).toBe(1);
        expect(new Set(clusterEmbeddings(emb, order.length, dim, { threshold: 0.0001 })).size).toBe(order.length);
    });
});

describe("audio tagging pieces", () => {
    it("AudioSet labels CSV with quoted names", () => {
        const names = parseLabels('index,mid,display_name\n0,/m/09x0r,"Speech"\n1,/m/0ytgt,"Child speech, kid speaking"\n');
        expect(names).toEqual(["Speech", "Child speech, kid speaking"]);
    });

    it("10 s windows, short tail merged", () => {
        expect(tagWindows(24 * 16000)).toEqual([
            [0, 160000],
            [160000, 384000],
        ]);
        expect(tagWindows(25 * 16000)).toHaveLength(3);
        expect(tagWindows(8000)).toEqual([[0, 8000]]);
    });

    it("amplitude to dB with a 120 dB floor", () => {
        const p = Float32Array.of(1, 100, 0, 1e-20);
        amplitudeToDb(p);
        expect(Array.from(p)).toEqual([0, 20, -100, -100]);
    });
});

describe("model hosting contract", () => {
    it("model file URLs are <modelBase><org>/<repo>/<path>", () => {
        const sv = AUDIO_MODELS[0]!;
        expect(modelFileUrl("https://cdn.example.com/m", sv, sv.files.model!)).toBe(
            "https://cdn.example.com/m/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/model.int8.onnx",
        );
    });

    it("models.json lists exactly the registry's repos, files, sizes and hashes", () => {
        const manifest = JSON.parse(readFileSync(new URL("../../models.json", import.meta.url), "utf8")) as {
            id: string;
            source: string;
            files: string[];
            checksums: Record<string, { size: number; sha256: string }>;
            license: string;
            approxMB: number;
        }[];
        for (const spec of AUDIO_MODELS) {
            const m = manifest.find((x) => x.id === spec.id);
            expect(m, spec.id).toBeDefined();
            expect(m!.source).toBe(`modelscope:${spec.repo}`);
            expect(m!.license).toBeTruthy();
            const files = Object.values(spec.files);
            expect(m!.files).toEqual(files.map((f) => f.path));
            expect(m!.checksums).toEqual(Object.fromEntries(files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }])));
            expect(Math.abs(m!.approxMB - files.reduce((a, f) => a + f.size, 0) / 1e6)).toBeLessThan(1);
        }
    });

    it("manifest models match the pipeline's model ids (first = default)", () => {
        const manifest = JSON.parse(readFileSync(new URL("../../tongflow.plugin.json", import.meta.url), "utf8"));
        for (const [slot, ids] of Object.entries(SLOT_MODELS)) {
            const s = manifest.slots.find((x: { nodeSlot: string }) => x.nodeSlot === slot);
            expect(s?.models, slot).toEqual(ids);
        }
    });
});

describe("audio slots without weights", () => {
    it("fail the node with the model URL when the weights are not hosted", async () => {
        const ctx = { ...nodeCtx(), modelBase: "file:///nonexistent-models/" };
        const r = await impls.audioTag({ audio: { bytesBase64: b64(audioFixture("hello-zh.wav")), filename: "hello.wav" } }, ctx);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/could not download model k2-fsa\/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19\/model\.int8\.onnx/);
        // Decoding ran first.
        expect(ctx.rec.progress.some((p) => p.message === "decoding audio")).toBe(true);
    });

    it("reject missing input, unknown models and non-audio files", async () => {
        const missing = await impls.transcribe({} as never, nodeCtx());
        expect(missing).toMatchObject({ success: false, error: expect.stringMatching(/missing audio/) });
        const wav = { bytesBase64: b64(audioFixture("hello-zh.wav")), filename: "hello.wav" };
        const wrong = await impls.vadSegment({ audio: wav }, nodeCtx(undefined, { model: "whisper-large" }));
        expect(wrong).toMatchObject({ success: false, error: expect.stringMatching(/unknown model "whisper-large".*silero-vad-v5/) });
        const text = { bytesBase64: b64(new TextEncoder().encode("hello")), filename: "a.txt" };
        const bad = await impls.diarizeSpeakers({ audio: text }, nodeCtx());
        expect(bad.success).toBe(false);
    });

    it("rethrows cancellation instead of failing the node", async () => {
        const ac = new AbortController();
        ac.abort();
        const wav = { bytesBase64: b64(await readFile(new URL("../fixtures/audio/hello-zh.wav", import.meta.url))), filename: "h.wav" };
        await expect(impls.transcribe({ audio: wav }, nodeCtx(ac.signal))).rejects.toThrow();
    });
});
