/**
 * Alternative implementations of the audio slots (issue 30, part B), picked by the
 * node's model (`ctx.model`; the slot's first model stays the default):
 *
 * `transcribe`
 *  - `whisper-large-v3-turbo`: Whisper on WebGPU, multilingual, auto language, punctuation;
 *  - `cohere-transcribe-03-2026`: Cohere Transcribe on WebGPU, 14 languages, punctuation;
 *  - `qwen3-asr-0.6b`: Qwen3-ASR-0.6B (sherpa-onnx int8 export) on the wasm EP, punctuation;
 *  - `zipformer-ctc-small-zh`: Zipformer-CTC small zh on the wasm EP, **no punctuation**.
 *
 * `diarize-speakers`
 *  - `nemotron-3-diarization`: Nemotron-3-Diarization (Streaming Sortformer) on the wasm EP.
 *
 * Every one returns exactly the slot's ABI output (`text`; `segments` JSON `[{speaker,start,end}]`).
 * Long audio is cut at pauses with Silero VAD into pieces of at most 25 s (28 s for
 * Whisper, whose window is 30 s), recognized in order and joined like the default path.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError } from "../util/errors.js";
import { checkpoint } from "./checkpoint.js";
import { SAMPLE_RATE } from "./decode.js";
import type { SpeakerSegment } from "./diarize.js";
import { detectSpeech, loadVad, mergeSpans } from "./vad.js";

export const ALT_TRANSCRIBE_MODELS = ["whisper-large-v3-turbo", "cohere-transcribe-03-2026", "qwen3-asr-0.6b", "zipformer-ctc-small-zh"] as const;
export const ALT_DIARIZE_MODELS = ["nemotron-3-diarization"] as const;

export type AltTranscribeModel = (typeof ALT_TRANSCRIBE_MODELS)[number];

export function isAltTranscribe(model: string | undefined): model is AltTranscribeModel {
    return !!model && (ALT_TRANSCRIBE_MODELS as readonly string[]).includes(model);
}
export function isAltDiarize(model: string | undefined): boolean {
    return !!model && (ALT_DIARIZE_MODELS as readonly string[]).includes(model);
}

/** Join recognized pieces: no separator between CJK text, a space between Latin words. */
export function joinPieces(parts: string[]): string {
    let out = "";
    for (const p of parts) {
        const t = p.trim();
        if (!t) continue;
        if (out && /[A-Za-z0-9.,!?;:]$/.test(out) && /^[A-Za-z0-9]/.test(t)) out += " ";
        out += t;
    }
    return out;
}

type Report = (f: number, msg?: string) => void;

/**
 * Recognize `samples` in one pass when short, else in VAD pieces of ≤ `chunkS` seconds.
 * `prepare` gets the first piece (Whisper's language detection) before recognition.
 */
async function recognizePieces(
    samples: Float32Array,
    ctx: EdgeContext,
    report: Report,
    recognize: (s: Float32Array) => Promise<string>,
    o: { onePassS: number; chunkS: number; prepare?: (s: Float32Array) => Promise<void> },
): Promise<string> {
    if (samples.length <= o.onePassS * SAMPLE_RATE) {
        await o.prepare?.(samples);
        report(0.2, "transcribing");
        const t = await recognize(samples);
        report(1, "done");
        return t.trim();
    }
    await loadVad(ctx);
    const spans = await detectSpeech(samples, ctx, { minSilenceMs: 300, maxSpeechS: o.chunkS }, (f) => report(0.15 * f, "finding speech"));
    const chunks = mergeSpans(spans, o.chunkS * SAMPLE_RATE);
    if (!chunks.length) return "";
    await o.prepare?.(samples.subarray(chunks[0]!.start, chunks[0]!.end));
    const parts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
        await checkpoint(ctx.signal);
        const c = chunks[i]!;
        parts.push(await recognize(samples.subarray(c.start, c.end)));
        report(0.15 + (0.85 * (i + 1)) / chunks.length, `transcribing ${i + 1}/${chunks.length}`);
    }
    return joinPieces(parts);
}

let zipformer: Promise<import("./zipformer-ctc.js").ZipformerCtc> | null = null;
let qwen3: Promise<import("./qwen3-asr.js").Qwen3Asr> | null = null;

function loadOnce<T>(slot: Promise<T> | null, set: (p: Promise<T> | null) => void, make: () => Promise<T>): Promise<T> {
    const p = slot ?? make();
    set(p);
    p.catch(() => set(null));
    return p;
}

/** `transcribe` with an alternative model: 16 kHz mono in, the ABI `text` out. */
export async function transcribeAlt(
    model: AltTranscribeModel,
    samples: Float32Array,
    language: string | undefined,
    ctx: EdgeContext,
    report: Report,
): Promise<string> {
    switch (model) {
        case "zipformer-ctc-small-zh": {
            report(0, "loading Zipformer-CTC");
            const m = await loadOnce(zipformer, (p) => (zipformer = p), async () => (await import("./zipformer-ctc.js")).ZipformerCtc.load(ctx));
            return recognizePieces(samples, ctx, report, (s) => m.recognize(s), { onePassS: 30, chunkS: 25 });
        }
        case "qwen3-asr-0.6b": {
            report(0, "loading Qwen3-ASR-0.6B");
            const m = await loadOnce(qwen3, (p) => (qwen3 = p), async () => (await import("./qwen3-asr.js")).Qwen3Asr.load(ctx));
            // Auto language: the first piece's detected language is forced for the rest, so a
            // piece cannot start with a stray "language …" instead of its text.
            let lang = language;
            return recognizePieces(
                samples,
                ctx,
                report,
                async (s) => {
                    const r = await m.recognize(s, lang, ctx.signal);
                    lang ??= r.language;
                    return r.text;
                },
                { onePassS: 30, chunkS: 25 },
            );
        }
        case "whisper-large-v3-turbo":
        case "cohere-transcribe-03-2026": {
            const { withWebGpuAsr } = await import("./asr-webgpu.js");
            report(0, `loading ${model}`);
            return withWebGpuAsr(ctx, model, language, (asr) =>
                recognizePieces(samples, ctx, report, (s) => asr.recognize(s), {
                    onePassS: model === "whisper-large-v3-turbo" ? 29 : 30,
                    chunkS: model === "whisper-large-v3-turbo" ? 28 : 25,
                    prepare: (s) => asr.prepare(s),
                }),
            );
        }
        default:
            throw new EdgeError(`unknown transcribe model "${model as string}"`);
    }
}

/** `diarize-speakers` with an alternative model. `_params.threshold` = speaker probability threshold (default 0.5). */
export async function diarizeAlt(model: string, samples: Float32Array, ctx: EdgeContext, report: Report): Promise<SpeakerSegment[]> {
    if (model !== "nemotron-3-diarization") throw new EdgeError(`unknown diarize-speakers model "${model}"`);
    const { diarizeNemotron } = await import("./nemotron.js");
    const t = Number(ctx.params?.threshold);
    return diarizeNemotron(samples, ctx, Number.isFinite(t) && t > 0 && t < 1 ? { threshold: t } : {}, report);
}
