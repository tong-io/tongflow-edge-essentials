/**
 * Alternative implementations of the audio slots (issue 30, part B), picked by the
 * node's model (`ctx.model`; `<model>+ffmpeg-wasm` = the same model with the input
 * decoded by ffmpeg.wasm). The slot's first model stays the default.
 *
 * `transcribe` (and `transcribe-timestamp` where the model gives times)
 *  - `whisper-large-v3-turbo`: Whisper on WebGPU, multilingual, auto language, punctuation;
 *    segment timestamps for `transcribe-timestamp`;
 *  - `cohere-transcribe-03-2026`: Cohere Transcribe on WebGPU, 14 languages, punctuation;
 *  - `qwen3-asr-0.6b`: Qwen3-ASR-0.6B (sherpa-onnx int8 export) on the wasm EP, punctuation;
 *  - `zipformer-ctc-small-zh`: Zipformer-CTC small zh on the wasm EP, **no punctuation**;
 *    CTC token times for `transcribe-timestamp`.
 *
 * `diarize-speakers`
 *  - `nemotron-3-diarization`: Nemotron-3-Diarization (Streaming Sortformer) on the wasm EP.
 *
 * The recognizers plug into the pipeline's own chunking (Silero VAD pieces of ≤ 25 s) and
 * joining, so every one returns exactly the slot's ABI output.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError } from "../util/errors.js";
import type { SpeakerSegment } from "./diarize.js";
import type { TimedToken } from "./timestamps.js";

/** Recognizers of `transcribe`. */
export const ALT_TRANSCRIBE_MODELS = ["whisper-large-v3-turbo", "cohere-transcribe-03-2026", "qwen3-asr-0.6b", "zipformer-ctc-small-zh"] as const;
/** The ones that give times, also offered by `transcribe-timestamp`. */
export const ALT_TIMESTAMP_MODELS = ["whisper-large-v3-turbo", "zipformer-ctc-small-zh"] as const;
export const ALT_DIARIZE_MODELS = ["nemotron-3-diarization"] as const;

export type AltTranscribeModel = (typeof ALT_TRANSCRIBE_MODELS)[number];

export function isAltTranscribe(model: string | undefined): model is AltTranscribeModel {
    return !!model && (ALT_TRANSCRIBE_MODELS as readonly string[]).includes(model);
}
export function isAltDiarize(model: string | undefined): boolean {
    return !!model && (ALT_DIARIZE_MODELS as readonly string[]).includes(model);
}

/** The pipeline's recognizer contract (`pipeline.ts`). */
export interface AltRecognizer {
    name: string;
    load(ctx: EdgeContext): Promise<{ recognize(samples: Float32Array): Promise<{ text: string; tokens: TimedToken[] }> }>;
    join(tokens: string[]): string;
}

/** CJK joined without spaces, Latin words with one. */
export function joinUnits(tokens: readonly string[]): string {
    return tokens.join("").replace(/\s+/g, " ").replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1").trim();
}

/**
 * Whisper's segments `[{timestamp: [start, end], text}]` → per-character tokens spread
 * evenly over each segment (Whisper times whole segments, not words).
 */
export function segmentTokens(chunks: readonly { timestamp: readonly (number | null)[]; text: string }[], duration: number): TimedToken[] {
    const out: TimedToken[] = [];
    for (const c of chunks) {
        const start = c.timestamp[0] ?? 0;
        const end = c.timestamp[1] ?? duration;
        const chars = [...c.text.trim()];
        chars.forEach((ch, i) => {
            const t = start + ((Math.max(start, end) - start) * i) / Math.max(1, chars.length);
            out.push({ text: ch, time: Math.round(Math.min(duration, t) * 1000) / 1000 });
        });
    }
    return out;
}

let zipformer: Promise<import("./zipformer-ctc.js").ZipformerCtc> | null = null;
let qwen3: Promise<import("./qwen3-asr.js").Qwen3Asr> | null = null;

/**
 * The recognizer for an alternative `transcribe` model (`base` = the model id without
 * `+ffmpeg-wasm`). `timestamps` asks the WebGPU Whisper path for its segment times.
 */
export function altRecognizer(base: AltTranscribeModel, language: string | undefined, timestamps: boolean): AltRecognizer {
    switch (base) {
        case "zipformer-ctc-small-zh":
            return {
                name: "Zipformer-CTC",
                load: async (ctx) => {
                    zipformer ??= import("./zipformer-ctc.js").then((m) => m.ZipformerCtc.load(ctx));
                    zipformer.catch(() => (zipformer = null));
                    const m = await zipformer;
                    return { recognize: (s) => m.recognize(s) };
                },
                join: joinUnits,
            };
        case "qwen3-asr-0.6b":
            return {
                name: "Qwen3-ASR-0.6B",
                load: async (ctx) => {
                    qwen3 ??= import("./qwen3-asr.js").then((m) => m.Qwen3Asr.load(ctx));
                    qwen3.catch(() => (qwen3 = null));
                    const m = await qwen3;
                    // Auto language: the first piece's detected language is forced for the rest, so a
                    // piece cannot open with a stray "language …" instead of its text.
                    let lang = language;
                    return {
                        recognize: async (s) => {
                            const r = await m.recognize(s, lang, ctx.signal);
                            lang ??= r.language;
                            return { text: r.text, tokens: [] };
                        },
                    };
                },
                join: joinUnits,
            };
        case "whisper-large-v3-turbo":
        case "cohere-transcribe-03-2026":
            return {
                name: base === "whisper-large-v3-turbo" ? "Whisper large-v3-turbo" : "Cohere Transcribe",
                load: async (ctx) => {
                    const { webGpuAsr } = await import("./asr-webgpu.js");
                    const asr = await webGpuAsr(ctx, base, language);
                    return {
                        recognize: async (s) => {
                            if (timestamps && base === "whisper-large-v3-turbo") {
                                const r = await asr.recognizeTimed(s);
                                return { text: r.text, tokens: segmentTokens(r.chunks, s.length / 16000) };
                            }
                            return { text: await asr.recognize(s), tokens: [] };
                        },
                    };
                },
                join: joinUnits,
            };
        default:
            throw new EdgeError(`unknown transcribe model "${base as string}"`);
    }
}

/** `diarize-speakers` with an alternative model. `_params.threshold` = speaker probability threshold (default 0.5). */
export async function diarizeAlt(
    model: string,
    samples: Float32Array,
    ctx: EdgeContext,
    report: (f: number, msg?: string) => void,
): Promise<SpeakerSegment[]> {
    if (model !== "nemotron-3-diarization") throw new EdgeError(`unknown diarize-speakers model "${model}"`);
    const { diarizeNemotron } = await import("./nemotron.js");
    const t = Number(ctx.params?.threshold);
    return diarizeNemotron(samples, ctx, Number.isFinite(t) && t > 0 && t < 1 ? { threshold: t } : {}, report);
}
