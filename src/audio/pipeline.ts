/**
 * The T2 audio slot bodies (lazy chunk: loaded on the first audio node, so
 * the entry stays small). Every slot decodes its input with {@link decodeAnyAudio}
 * to 16 kHz mono first; models are fetched from the model base on first use
 * and stay loaded in the worker for later nodes.
 */
import type { EdgeContext } from "../context.js";
import type { Asset } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { decodeAnyAudio, type DecodedAudio, SAMPLE_RATE } from "./decode.js";
import { baseModel, FFMPEG_SUFFIX, forcesFfmpeg } from "../ffmpeg/select.js";
import { diarize, type DiarizeOptions } from "./diarize.js";
import { SenseVoice, type SenseVoiceLanguage, senseVoiceLanguage, senseVoiceText } from "./sensevoice.js";
import { type RecognizedChunk, sentenceTimestamps, type SpanS, type TimedToken, type TimeStamp } from "./timestamps.js";
import { XAsr, xAsrText } from "./transducer.js";
import { tagAudio } from "./tagging.js";
import { detectSpeech, loadVad, mergeSpans, VAD_DEFAULTS, type VadOptions } from "./vad.js";
import { encodeWav } from "./wav.js";
import { checkpoint } from "./checkpoint.js";

/**
 * Model ids as listed in tongflow.plugin.json `slots[].models` (first = default).
 * `<model>+ffmpeg-wasm` is the same model with the input decoded by ffmpeg.wasm
 * instead of WebCodecs ("换实现"); the default falls back to ffmpeg by itself.
 */
export const SLOT_MODELS = {
    transcribe: ["sensevoice-small", `sensevoice-small${FFMPEG_SUFFIX}`, "x-asr-zh-en", `x-asr-zh-en${FFMPEG_SUFFIX}`],
    "transcribe-timestamp": ["sensevoice-small", `sensevoice-small${FFMPEG_SUFFIX}`, "x-asr-zh-en", `x-asr-zh-en${FFMPEG_SUFFIX}`],
    "vad-segment": ["silero-vad-v5", `silero-vad-v5${FFMPEG_SUFFIX}`],
    "diarize-speakers": ["pyannote-campplus-zh", `pyannote-campplus-zh${FFMPEG_SUFFIX}`],
    "audio-tag": ["ced-tiny", `ced-tiny${FFMPEG_SUFFIX}`],
} as const;

function checkModel(ctx: EdgeContext, slot: keyof typeof SLOT_MODELS): void {
    const allowed: readonly string[] = SLOT_MODELS[slot];
    if (ctx.model && !allowed.includes(ctx.model) && ctx.model !== "ffmpeg-wasm") {
        throw new EdgeError(`unknown model "${ctx.model}" for ${slot}; available: ${allowed.join(", ")}`);
    }
}

/** Progress mapper: report `f` (0..1) of a stage spanning [from, to] of the node. */
function stage(ctx: EdgeContext, from: number, to: number, message: string) {
    ctx.onProgress({ fraction: from, message });
    return (f: number, msg?: string) => ctx.onProgress({ fraction: from + (to - from) * f, message: msg ?? message });
}

async function decode(ctx: EdgeContext, bytes: Uint8Array, filename?: string, to = 0.1): Promise<DecodedAudio> {
    return decodeAnyAudio(bytes, ctx, stage(ctx, 0, to, "decoding audio"), { filename, force: forcesFfmpeg(ctx.model) });
}

function num(v: unknown): number | undefined {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Advanced VAD params (`_params`): threshold, min_speech_ms, min_silence_ms, speech_pad_ms, max_speech_s. */
function vadParams(params: Record<string, unknown>): Partial<VadOptions> {
    const o: Partial<VadOptions> = {};
    const t = num(params.threshold);
    if (t !== undefined && t > 0 && t < 1) o.threshold = t;
    const ms = num(params.min_speech_ms);
    if (ms !== undefined && ms >= 0) o.minSpeechMs = ms;
    const sil = num(params.min_silence_ms);
    if (sil !== undefined && sil >= 0) o.minSilenceMs = sil;
    const pad = num(params.speech_pad_ms);
    if (pad !== undefined && pad >= 0) o.speechPadMs = pad;
    const max = num(params.max_speech_s);
    if (max !== undefined && max >= 1) o.maxSpeechS = max;
    return o;
}

let senseVoice: Promise<SenseVoice> | null = null;
function loadSenseVoice(ctx: EdgeContext): Promise<SenseVoice> {
    senseVoice ??= SenseVoice.load(ctx);
    senseVoice.catch(() => {
        senseVoice = null;
    });
    return senseVoice;
}

let xAsr: Promise<XAsr> | null = null;
function loadXAsr(ctx: EdgeContext): Promise<XAsr> {
    xAsr ??= XAsr.load(ctx);
    xAsr.catch(() => {
        xAsr = null;
    });
    return xAsr;
}

/** One speech recognizer behind `transcribe` / `transcribe-timestamp`, picked by the node's model. */
interface Recognizer {
    name: string;
    load(ctx: EdgeContext): Promise<{ recognize(samples: Float32Array): Promise<{ text: string; tokens: TimedToken[] }> }>;
    /** A sentence's text from its token texts. */
    join(tokens: string[]): string;
}

function recognizer(ctx: EdgeContext, language: string | undefined): Recognizer {
    // `x-asr-zh-en+ffmpeg-wasm` is X-ASR with the audio decoded by ffmpeg.wasm (see `decode`).
    if (baseModel(ctx.model) === "x-asr-zh-en") {
        // X-ASR is Chinese/English only and detects which by itself: the language hint is not used.
        return {
            name: "X-ASR",
            load: async (c) => {
                const m = await loadXAsr(c);
                return { recognize: (samples) => m.recognize(samples, c.signal) };
            },
            join: xAsrText,
        };
    }
    const lang: SenseVoiceLanguage = senseVoiceLanguage(language);
    return {
        name: "SenseVoice",
        load: async (c) => {
            const m = await loadSenseVoice(c);
            return { recognize: (samples) => m.recognize(samples, lang) };
        },
        join: senseVoiceText,
    };
}

/** Audio up to this long is recognized in one pass; longer audio is cut at pauses. */
const ONE_PASS_S = 30;
const ASR_CHUNK_S = 25;
/** VAD settings for cutting long audio: short pauses count, no span over the chunk length. */
const ASR_VAD: Partial<VadOptions> = { minSilenceMs: 300, maxSpeechS: ASR_CHUNK_S };

/** Join recognized pieces: no separator between CJK text, a space between Latin words. */
export function joinTranscript(parts: string[]): string {
    let out = "";
    for (const p of parts) {
        const t = p.trim();
        if (!t) continue;
        if (out && /[A-Za-z0-9.,!?;:]$/.test(out) && /^[A-Za-z0-9]/.test(t)) out += " ";
        out += t;
    }
    return out;
}

interface Recognized {
    text: string;
    chunks: RecognizedChunk[];
    /** Speech spans in seconds (only computed when asked for, or for long audio). */
    spans: SpanS[];
    duration: number;
    rec: Recognizer;
}

/**
 * Decode, then recognize: audio up to {@link ONE_PASS_S} in one pass, longer audio in
 * chunks of up to {@link ASR_CHUNK_S} cut at pauses the VAD finds. `withSpans` runs the
 * VAD on short audio too (for timestamps).
 */
async function recognizeAudio(
    bytes: Uint8Array,
    language: string | undefined,
    ctx: EdgeContext,
    withSpans: boolean,
    filename?: string,
): Promise<Recognized> {
    const audio = await decode(ctx, bytes, filename);
    const rec = recognizer(ctx, language);
    ctx.onProgress({ fraction: 0.1, message: `loading ${rec.name}` });
    const onePass = audio.duration <= ONE_PASS_S;
    const [model] = await Promise.all([rec.load(ctx), onePass && !withSpans ? Promise.resolve() : loadVad(ctx)]);
    let spans: SpanS[] = [];
    let chunks: { start: number; end: number }[];
    if (onePass) {
        if (withSpans) {
            const found = await detectSpeech(audio.samples, ctx, ASR_VAD, stage(ctx, 0.1, 0.15, "finding speech"));
            spans = found.map((sp) => ({ start: sp.start / SAMPLE_RATE, end: sp.end / SAMPLE_RATE }));
        }
        chunks = [{ start: 0, end: audio.samples.length }];
    } else {
        const found = await detectSpeech(audio.samples, ctx, ASR_VAD, stage(ctx, 0.1, 0.25, "finding speech"));
        spans = found.map((sp) => ({ start: sp.start / SAMPLE_RATE, end: sp.end / SAMPLE_RATE }));
        chunks = mergeSpans(found, ASR_CHUNK_S * SAMPLE_RATE);
    }
    const report = stage(ctx, onePass ? 0.15 : 0.25, 1, "transcribing");
    const parts: string[] = [];
    const out: RecognizedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
        await checkpoint(ctx.signal);
        const c = chunks[i]!;
        const r = await model.recognize(audio.samples.subarray(c.start, c.end));
        parts.push(r.text);
        out.push({ start: c.start / SAMPLE_RATE, end: c.end / SAMPLE_RATE, tokens: r.tokens });
        report((i + 1) / chunks.length, chunks.length > 1 ? `transcribing ${i + 1}/${chunks.length}` : "transcribing");
    }
    ctx.onProgress({ fraction: 1, message: "done" });
    return { text: joinTranscript(parts), chunks: out, spans, duration: audio.duration, rec };
}

export async function transcribe(bytes: Uint8Array, language: string | undefined, ctx: EdgeContext, filename?: string): Promise<string> {
    checkModel(ctx, "transcribe");
    return (await recognizeAudio(bytes, language, ctx, false, filename)).text;
}

/**
 * `transcribe-timestamp`: the transcript plus sentence-level segments
 * `{start, end, text}` in seconds (see `timestamps.ts`).
 */
export async function transcribeTimestamp(
    bytes: Uint8Array,
    language: string | undefined,
    ctx: EdgeContext,
    filename?: string,
): Promise<{ text: string; time_stamps: TimeStamp[] }> {
    checkModel(ctx, "transcribe-timestamp");
    const r = await recognizeAudio(bytes, language, ctx, true, filename);
    const time_stamps = sentenceTimestamps(r.chunks, r.spans, r.duration, r.rec.join);
    return { text: r.text, time_stamps };
}

export async function vadSegment(bytes: Uint8Array, filename: string | undefined, ctx: EdgeContext): Promise<Asset[]> {
    checkModel(ctx, "vad-segment");
    const audio = await decode(ctx, bytes, filename);
    const spans = await detectSpeech(audio.samples, ctx, { ...VAD_DEFAULTS, ...vadParams(ctx.params ?? {}) }, stage(ctx, 0.1, 0.9, "finding speech"));
    const stem = fileStem(filename, "audio");
    const out = spans.map((s, i) => ({
        bytesBase64: encodeBase64(encodeWav(audio.samples.subarray(s.start, s.end), SAMPLE_RATE)),
        mime: "audio/wav",
        filename: `${stem}-${String(i + 1).padStart(3, "0")}-${(s.start / SAMPLE_RATE).toFixed(2)}s-${(s.end / SAMPLE_RATE).toFixed(2)}s.wav`,
    }));
    ctx.onProgress({ fraction: 1, message: `${out.length} speech segments` });
    return out;
}

export async function diarizeSpeakers(bytes: Uint8Array, ctx: EdgeContext, filename?: string): Promise<string> {
    checkModel(ctx, "diarize-speakers");
    const audio = await decode(ctx, bytes, filename);
    const o: DiarizeOptions = {};
    const k = num(ctx.params?.num_speakers);
    if (k !== undefined && k >= 1) o.numSpeakers = Math.round(k);
    const t = num(ctx.params?.threshold);
    if (t !== undefined && t > 0 && t < 2) o.threshold = t;
    ctx.onProgress({ fraction: 0.1, message: "loading diarization models" });
    const report = stage(ctx, 0.1, 1, "segmenting speakers");
    const segments = await diarize(audio.samples, ctx, o, report);
    return JSON.stringify(segments);
}

export async function audioTag(bytes: Uint8Array, ctx: EdgeContext, filename?: string): Promise<string> {
    checkModel(ctx, "audio-tag");
    const audio = await decode(ctx, bytes, filename);
    ctx.onProgress({ fraction: 0.1, message: "loading CED" });
    const o: { topK?: number; minScore?: number } = {};
    const k = num(ctx.params?.top_k);
    if (k !== undefined && k >= 1) o.topK = Math.round(k);
    const s = num(ctx.params?.min_score);
    if (s !== undefined && s >= 0 && s <= 1) o.minScore = s;
    const tags = await tagAudio(audio.samples, ctx, o, stage(ctx, 0.15, 1, "tagging audio events"));
    return JSON.stringify(tags);
}
