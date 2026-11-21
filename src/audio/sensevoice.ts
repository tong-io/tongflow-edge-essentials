/**
 * SenseVoiceSmall (by FunASR/FunAudioLLM) speech recognition on the
 * sherpa-onnx int8 export, run with onnxruntime-web. The front end follows
 * sherpa-onnx's `OfflineRecognizerSenseVoiceImpl`: 80-bin Kaldi fbank →
 * low-frame-rate stacking (7 frames, shift 6) → CMVN from the model metadata →
 * CTC greedy search; the first four output tokens are the language, emotion,
 * event and ITN tags.
 */
import type { EdgeContext } from "../context.js";
import { createSession, loadOrt, type OrtSession } from "../ml/ort.js";
import { metaFloats, metaInt, readOnnxMetadata } from "../ml/onnx-meta.js";
import { fetchModelFile } from "../models/hub.js";
import { SENSEVOICE } from "../models/registry.js";
import { Fbank, SENSEVOICE_FBANK } from "./fbank.js";
import type { TimedToken } from "./timestamps.js";

export const SENSEVOICE_LANGUAGES = ["auto", "zh", "en", "ja", "ko", "yue"] as const;
export type SenseVoiceLanguage = (typeof SENSEVOICE_LANGUAGES)[number];

/** Map a free-form language hint (zh-CN, Chinese, 粤语, …) to SenseVoice's language ids. */
export function senseVoiceLanguage(hint: string | undefined): SenseVoiceLanguage {
    const h = (hint ?? "").trim().toLowerCase();
    if (!h || h === "auto") return "auto";
    if (/^(yue|zh-hk|zh_hk|zh-yue|cantonese|粤语|粵語|廣東話|广东话)/.test(h)) return "yue";
    if (/^(zh|cmn|chinese|mandarin|中文|普通话|汉语|漢語|国语)/.test(h)) return "zh";
    if (/^(en|english|英语|英文)/.test(h)) return "en";
    if (/^(ja|jp|japanese|日语|日本語)/.test(h)) return "ja";
    if (/^(ko|kr|korean|韩语|한국어)/.test(h)) return "ko";
    return "auto";
}

/** Low-frame-rate stacking, as sherpa-onnx `ApplyLfr` (edge frames repeat). */
export function applyLfr(feats: Float32Array, dim: number, windowSize: number, windowShift: number): { data: Float32Array; frames: number } {
    const inFrames = feats.length / dim;
    if (!inFrames) return { data: new Float32Array(0), frames: 0 };
    const outFrames = 1 + Math.floor((inFrames - 1) / windowShift);
    const outDim = dim * windowSize;
    const out = new Float32Array(outFrames * outDim);
    const left = Math.floor((windowSize - 1) / 2);
    for (let i = 0; i < outFrames; i++) {
        const center = i * windowShift;
        const leftPad = center < left ? left - center : 0;
        const first = center < left ? 0 : center - left;
        const maxOffset = inFrames - 1 - first;
        for (let j = 0; j < windowSize; j++) {
            let src = 0;
            if (j >= leftPad) {
                const off = j - leftPad;
                src = off > maxOffset ? inFrames - 1 : first + off;
            }
            out.set(feats.subarray(src * dim, src * dim + dim), i * outDim + j * dim);
        }
    }
    return { data: out, frames: outFrames };
}

/** CTC greedy search over [frames × vocab] logits: argmax, drop repeats and blank. */
export function ctcGreedy(logits: Float32Array, frames: number, vocab: number, blank = 0): number[] {
    return ctcGreedyFrames(logits, frames, vocab, blank).tokens;
}

/** {@link ctcGreedy} with the output frame of each token (sherpa-onnx's CTC timestamps). */
export function ctcGreedyFrames(logits: Float32Array, frames: number, vocab: number, blank = 0): { tokens: number[]; frames: number[] } {
    const tokens: number[] = [];
    const at: number[] = [];
    let prev = -1;
    for (let t = 0; t < frames; t++) {
        const row = t * vocab;
        let best = 0;
        let bestVal = -Infinity;
        for (let v = 0; v < vocab; v++) {
            const x = logits[row + v]!;
            if (x > bestVal) {
                bestVal = x;
                best = v;
            }
        }
        if (best !== blank && best !== prev) {
            tokens.push(best);
            at.push(t);
        }
        prev = best;
    }
    return { tokens, frames: at };
}

export function parseTokens(text: string): string[] {
    const syms: string[] = [];
    for (const line of text.split("\n")) {
        const l = line.replace(/\r$/, "");
        if (!l) continue;
        const sp = l.lastIndexOf(" ");
        const sym = sp >= 0 ? l.slice(0, sp) : l;
        const id = Number(sp >= 0 ? l.slice(sp + 1) : syms.length);
        syms[id] = sym;
    }
    return syms;
}

/** SenseVoice's text from its token texts (a leading `▁` already a space). */
export function senseVoiceText(tokens: readonly string[]): string {
    return tokens.join("").trim();
}

export interface SenseVoiceResult {
    text: string;
    /** Detected language tag without brackets, e.g. "zh". */
    language: string;
    /**
     * The text tokens with their times in seconds, as sherpa-onnx computes them:
     * `(frame - 4) × lfr_window_shift × 10 ms` (the first four output frames are the
     * language, emotion, event and ITN queries).
     */
    tokens: TimedToken[];
}

interface Meta {
    lfrWindow: number;
    lfrShift: number;
    negMean: Float32Array;
    invStd: Float32Array;
    normalizeSamples: boolean;
    withItn: number;
    langIds: Record<SenseVoiceLanguage, number>;
    vocab: number;
}

export class SenseVoice {
    private readonly fbank: Fbank;
    private constructor(
        private readonly session: OrtSession,
        private readonly meta: Meta,
        private readonly syms: string[],
        private readonly ort: typeof import("onnxruntime-web"),
    ) {
        this.fbank = new Fbank({ ...SENSEVOICE_FBANK, inputScale: meta.normalizeSamples ? 1 : 32768 });
    }

    static async load(ctx: EdgeContext): Promise<SenseVoice> {
        const [model, tokens] = await Promise.all([
            fetchModelFile(ctx, SENSEVOICE, SENSEVOICE.files.model),
            fetchModelFile(ctx, SENSEVOICE, SENSEVOICE.files.tokens),
        ]);
        const m = readOnnxMetadata(model);
        const meta: Meta = {
            lfrWindow: metaInt(m, "lfr_window_size"),
            lfrShift: metaInt(m, "lfr_window_shift"),
            negMean: metaFloats(m, "neg_mean"),
            invStd: metaFloats(m, "inv_stddev"),
            normalizeSamples: metaInt(m, "normalize_samples") !== 0,
            withItn: metaInt(m, "with_itn"),
            vocab: metaInt(m, "vocab_size"),
            langIds: {
                auto: metaInt(m, "lang_auto"),
                zh: metaInt(m, "lang_zh"),
                en: metaInt(m, "lang_en"),
                ja: metaInt(m, "lang_ja"),
                ko: metaInt(m, "lang_ko"),
                yue: metaInt(m, "lang_yue"),
            },
        };
        const ort = await loadOrt(ctx);
        const session = await createSession(ctx, model);
        return new SenseVoice(session, meta, parseTokens(new TextDecoder().decode(tokens)), ort);
    }

    /** Recognize one utterance (16 kHz mono; keep it under ~30 s). */
    async recognize(samples: Float32Array, language: SenseVoiceLanguage = "auto"): Promise<SenseVoiceResult> {
        const { data: fb } = this.fbank.compute(samples);
        const { data: x, frames } = applyLfr(fb, this.fbank.dim, this.meta.lfrWindow, this.meta.lfrShift);
        if (!frames) return { text: "", language: "", tokens: [] };
        const dim = this.meta.negMean.length;
        const { negMean, invStd } = this.meta;
        for (let f = 0; f < frames; f++) {
            const row = f * dim;
            for (let d = 0; d < dim; d++) x[row + d] = (x[row + d]! + negMean[d]!) * invStd[d]!;
        }
        const T = this.ort.Tensor;
        const feeds = {
            x: new T("float32", x, [1, frames, dim]),
            x_length: new T("int32", Int32Array.of(frames), [1]),
            language: new T("int32", Int32Array.of(this.meta.langIds[language]), [1]),
            text_norm: new T("int32", Int32Array.of(this.meta.withItn), [1]),
        };
        const out = await this.session.run(feeds);
        const logits = out.logits!;
        const [, outFrames, vocab] = logits.dims as number[];
        const { tokens, frames: at } = ctcGreedyFrames(logits.data as Float32Array, outFrames!, vocab!);
        for (const t of Object.values(out)) t.dispose();
        for (const t of Object.values(feeds)) t.dispose();
        const lang = tokens.length >= 1 ? (this.syms[tokens[0]!] ?? "") : "";
        const shiftS = (this.meta.lfrShift * 10) / 1000;
        const timed: TimedToken[] = [];
        for (let i = 4; i < tokens.length; i++) {
            const s = this.syms[tokens[i]!] ?? "";
            if (/^<\|.*\|>$/.test(s)) continue;
            timed.push({ text: s.replace(/^▁/, " "), time: Math.max(0, (at[i]! - 4) * shiftS) });
        }
        const text = senseVoiceText(timed.map((t) => t.text));
        return { text, language: lang.replace(/^<\|(.*)\|>$/, "$1"), tokens: timed };
    }
}
