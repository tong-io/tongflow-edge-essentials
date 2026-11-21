/**
 * Qwen3-ASR-0.6B (Qwen team, Alibaba Cloud; Apache-2.0) on onnxruntime-web (wasm EP),
 * from the sherpa-onnx int8 export (`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`:
 * conv front end 44 MB + encoder 182 MB + decoder 756 MB = 983 MB).
 *
 * The graphs are plain ONNX (MatMulInteger / DynamicQuantizeLinear, no custom ops), so the
 * glue is a TypeScript port of sherpa-onnx's `OfflineRecognizerQwen3ASRImpl` (Apache-2.0):
 *  - Whisper log-mel: 128 Slaney mel bins of a centred 400-point STFT (periodic Hann,
 *    reflect padding, hop 160), log10, floor at max − 8, (x + 4) / 4 (HF's
 *    `WhisperFeatureExtractor`, which the model was trained with);
 *  - conv front end (100-frame chunks) → encoder (valid audio tokens masked) → audio features;
 *  - the chat prompt `<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>` +
 *    one `<|audio_pad|>` per audio token + `<|audio_end|><|im_end|>\n<|im_start|>assistant\n`,
 *    optionally followed by `language <Name><asr_text>` to force the language;
 *  - greedy decoding with the export's KV-cache protocol (the decoder returns this step's
 *    keys/values, written into the cache at `cache_position`), stopping at `<|im_end|>`, with
 *    sherpa-onnx's guard against degenerate repetition;
 *  - the model writes `language Chinese<asr_text>…`; the prefix is dropped and the GPT-2
 *    byte-level BPE is decoded. Output has punctuation.
 *
 * Slow on a CPU: it is a 0.6B-parameter decoder (see the README for measured speed).
 */
import type { EdgeContext } from "../context.js";
import { loadOrt, type OrtSession } from "../ml/ort.js";
import { fetchModelFile } from "../models/hub.js";
import { QWEN3_ASR } from "../models/alt-registry.js";
import { checkpoint } from "./checkpoint.js";
import { slaneyMelBank } from "./nemotron.js";

type Ort = typeof import("onnxruntime-web");
type OrtTensor = import("onnxruntime-web").Tensor;

/* ---------------------------------------------------------------- features */

const N_FFT = 400;
const HOP = 160;
const N_MELS = 128;
const BINS = N_FFT / 2 + 1;

let dft: { cos: Float64Array; sin: Float64Array; window: Float64Array; mel: Float32Array[] } | undefined;

/** Whisper-style normalized log-mel, [frames × 128] with frames = floor(n / 160). */
export function whisperLogMel(samples: Float32Array): { data: Float32Array; frames: number } {
    if (!dft) {
        const cos = new Float64Array(BINS * N_FFT);
        const sin = new Float64Array(BINS * N_FFT);
        for (let k = 0; k < BINS; k++) {
            for (let n = 0; n < N_FFT; n++) {
                const a = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT;
                cos[k * N_FFT + n] = Math.cos(a);
                sin[k * N_FFT + n] = Math.sin(a);
            }
        }
        const window = new Float64Array(N_FFT);
        for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); // periodic
        dft = { cos, sin, window, mel: slaneyMelBank(N_FFT, N_MELS, 16000) };
    }
    const n = samples.length;
    const frames = Math.floor(n / HOP);
    const out = new Float32Array(frames * N_MELS);
    if (!frames) return { data: out, frames: 0 };
    const pad = N_FFT / 2;
    // torch.stft(center=True, pad_mode="reflect"): x[-i] = x[i], x[n-1+i] = x[n-1-i].
    const at = (j: number) => {
        if (j < 0) j = -j;
        if (j >= n) j = 2 * (n - 1) - j;
        return j >= 0 && j < n ? samples[j]! : 0;
    };
    const frame = new Float64Array(N_FFT);
    const pow = new Float64Array(BINS);
    let max = -Infinity;
    for (let f = 0; f < frames; f++) {
        const start = f * HOP - pad;
        for (let i = 0; i < N_FFT; i++) frame[i] = at(start + i) * dft.window[i]!;
        for (let k = 0; k < BINS; k++) {
            let re = 0;
            let im = 0;
            const row = k * N_FFT;
            for (let i = 0; i < N_FFT; i++) {
                re += frame[i]! * dft.cos[row + i]!;
                im -= frame[i]! * dft.sin[row + i]!;
            }
            pow[k] = re * re + im * im;
        }
        for (let m = 0; m < N_MELS; m++) {
            const w = dft.mel[m]!;
            let s = 0;
            for (let k = 0; k < BINS; k++) s += w[k]! * pow[k]!;
            const v = Math.log10(Math.max(s, 1e-10));
            out[f * N_MELS + m] = v;
            if (v > max) max = v;
        }
    }
    const floor = max - 8;
    for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, floor) + 4) / 4;
    return { data: out, frames };
}

/** Audio tokens the conv front end yields for `featLen` mel frames (sherpa-onnx `FeatToAudioTokensLen`, 100-frame chunks). */
export function audioTokensLen(featLen: number, chunk = 100): number {
    if (featLen <= 0) return 0;
    const half = (x: number) => Math.floor((x + 1) / 2);
    const full = half(half(half(chunk)));
    const after = (x: number) => {
        if (x <= 0) return 0;
        let y = Math.floor((x - 1) / 2) + 1;
        y = Math.floor((y - 1) / 2) + 1;
        return Math.floor((y - 1) / 2) + 1;
    };
    const rem = featLen % chunk;
    return Math.floor(featLen / chunk) * full + (rem ? after(rem) : 0);
}

/* ---------------------------------------------------------------- tokenizer */

export const QWEN3_TOKENS = {
    endoftext: 151643,
    imStart: 151644,
    imEnd: 151645,
    audioStart: 151669,
    audioEnd: 151670,
    audioPad: 151676,
    asrText: 151704,
} as const;
const T = QWEN3_TOKENS;
/** `<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>` (system 8948, \n 198, user 872). */
export const PROMPT_BEFORE: readonly number[] = [T.imStart, 8948, 198, T.imEnd, 198, T.imStart, 872, 198, T.audioStart];
/** `<|audio_end|><|im_end|>\n<|im_start|>assistant\n` (assistant 77091). */
export const PROMPT_AFTER: readonly number[] = [T.audioEnd, T.imEnd, 198, T.imStart, 77091, 198];
const LANGUAGE_ID = 11528; // "language"

/** A free-form language hint → the name Qwen3-ASR writes (`language Chinese<asr_text>`); `undefined` = auto. */
export function qwen3LanguageName(hint: string | undefined): string | undefined {
    const h = (hint ?? "").trim().toLowerCase();
    if (!h || h === "auto") return undefined;
    if (/^(yue|zh-hk|zh_hk|cantonese|粤语|粵語|广东话|廣東話)/.test(h)) return "Cantonese";
    if (/^(zh|cmn|chinese|mandarin|中文|普通话|汉语|漢語)/.test(h)) return "Chinese";
    const names: Record<string, string> = {
        en: "English", ja: "Japanese", ko: "Korean", ar: "Arabic", de: "German", fr: "French", es: "Spanish", pt: "Portuguese",
        id: "Indonesian", it: "Italian", ru: "Russian", th: "Thai", vi: "Vietnamese", tr: "Turkish", hi: "Hindi", ms: "Malay",
        nl: "Dutch", sv: "Swedish", da: "Danish", fi: "Finnish", pl: "Polish", cs: "Czech", fa: "Persian", el: "Greek",
        ro: "Romanian", hu: "Hungarian",
    };
    return names[h.slice(0, 2)];
}

/** GPT-2 `bytes_to_unicode`, reversed: code point → byte. */
function unicodeToBytes(): Map<number, number> {
    const bs: number[] = [];
    for (let c = 33; c <= 126; c++) bs.push(c);
    for (let c = 161; c <= 172; c++) bs.push(c);
    for (let c = 174; c <= 255; c++) bs.push(c);
    const cs = bs.slice();
    let n = 0;
    for (let b = 0; b < 256; b++) {
        if (!bs.includes(b)) {
            bs.push(b);
            cs.push(256 + n++);
        }
    }
    const m = new Map<number, number>();
    bs.forEach((b, i) => m.set(cs[i]!, b));
    return m;
}

/** Qwen2 byte-level BPE, decode direction only (the prompt ids are fixed). */
export class ByteLevelDecoder {
    private readonly inv: string[] = [];
    private readonly ids = new Map<string, number>();
    private readonly u2b = unicodeToBytes();
    constructor(vocab: Record<string, number>) {
        for (const [tok, id] of Object.entries(vocab)) {
            this.inv[id] = tok;
            this.ids.set(tok, id);
        }
    }
    id(token: string): number | undefined {
        return this.ids.get(token);
    }
    /** Ids → text; ids outside the BPE vocabulary (special tokens) are skipped. */
    decode(ids: readonly number[]): string {
        const bytes: number[] = [];
        for (const id of ids) {
            const tok = this.inv[id];
            if (tok === undefined) continue;
            for (const ch of tok) {
                const b = this.u2b.get(ch.codePointAt(0)!);
                if (b !== undefined) bytes.push(b);
            }
        }
        return new TextDecoder("utf-8").decode(Uint8Array.from(bytes)).replace(/�/g, "");
    }
}

/** sherpa-onnx: the last 64 ids use at most 3 distinct tokens. */
export function isDegenerateRepetition(ids: readonly number[], window = 64, maxDistinct = 3): boolean {
    if (ids.length < window) return false;
    return new Set(ids.slice(-window)).size <= maxDistinct;
}

/** Drop the looping tail (the trailing run of the loop's tokens inside the window). */
export function trimDegenerateTail(ids: readonly number[], window = 64, maxDistinct = 3): number[] {
    const loop = new Set<number>();
    for (const t of ids.slice(-window)) if (loop.size < maxDistinct) loop.add(t);
    let keep = ids.length;
    const start = Math.max(0, ids.length - window);
    while (keep > start && loop.has(ids[keep - 1]!)) keep--;
    return ids.slice(0, keep);
}

/** The language name of a leading `language X<asr_text>` (`undefined` without one). */
export function generatedLanguage(ids: readonly number[], dec: ByteLevelDecoder): string | undefined {
    const at = ids.slice(0, 16).indexOf(T.asrText);
    if (at < 2 || ids[0] !== LANGUAGE_ID) return undefined;
    return dec.decode(ids.slice(1, at)).trim() || undefined;
}

/**
 * Generated ids → text: drop the leading `language X<asr_text>`, decode. A `language X`
 * the model writes without `<asr_text>` (seen when it starts a piece in auto mode) is
 * dropped too, as is any later `language X<asr_text>` it repeats mid-piece.
 */
export function generatedText(ids: readonly number[], dec: ByteLevelDecoder): string {
    const out: number[] = [];
    for (let i = 0; i < ids.length; i++) {
        if (ids[i] === LANGUAGE_ID) {
            const at = ids.slice(i, i + 16).indexOf(T.asrText);
            if (at > 0) {
                i += at;
                continue;
            }
            if (i === 0 && ids.length > 1) {
                i += 1; // "language" + the name token
                continue;
            }
        }
        if (ids[i] === T.asrText) continue;
        out.push(ids[i]!);
    }
    return dec.decode(out.filter((x) => x < T.endoftext)).trim();
}

/* ---------------------------------------------------------------- model */

const LAYERS = 28;
const KV_HEADS = 8;
const HEAD_DIM = 128;

export class Qwen3Asr {
    private constructor(
        private readonly ort: Ort,
        private readonly conv: OrtSession,
        private readonly encoder: OrtSession,
        private readonly decoder: OrtSession,
        private readonly tok: ByteLevelDecoder,
    ) {}

    static async load(ctx: EdgeContext): Promise<Qwen3Asr> {
        const f = QWEN3_ASR.files;
        const ort = await loadOrt(ctx);
        const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" as const };
        // One file at a time: the decoder alone is 756 MB, so each file's bytes can be freed once its session holds them.
        const conv = await ort.InferenceSession.create(await fetchModelFile(ctx, QWEN3_ASR, f.conv), opts);
        const encoder = await ort.InferenceSession.create(await fetchModelFile(ctx, QWEN3_ASR, f.encoder), opts);
        const decoder = await ort.InferenceSession.create(await fetchModelFile(ctx, QWEN3_ASR, f.decoder), opts);
        const vocab = JSON.parse(new TextDecoder().decode(await fetchModelFile(ctx, QWEN3_ASR, f.vocab))) as Record<string, number>;
        return new Qwen3Asr(ort, conv, encoder, decoder, new ByteLevelDecoder(vocab));
    }

    /** Audio features [1 × A × 1024] of one utterance (≤ 30 s), and A. */
    private async encode(samples: Float32Array): Promise<{ features: OrtTensor; tokens: number }> {
        const { Tensor } = this.ort;
        const { data, frames } = whisperLogMel(samples);
        const convOut = (await this.conv.run({ input_features: new Tensor("float32", data, [1, frames, N_MELS]) })).conv_output!;
        const convFrames = convOut.dims[1]!;
        const valid = Math.min(audioTokensLen(frames), convFrames);
        const mask = new Uint8Array(convFrames).fill(1, 0, valid);
        const enc = await this.encoder.run({ input_features: convOut, feature_attention_mask: new Tensor("bool", mask, [1, convFrames]) });
        convOut.dispose();
        const af = enc.audio_features!;
        const H = af.dims[2]!;
        const all = af.data as Float32Array;
        // Trailing all-silent tokens are dropped (sherpa-onnx TrimAudioFeatures).
        let A = valid;
        while (A > 0) {
            let m = 0;
            for (let h = 0; h < H; h++) m = Math.max(m, Math.abs(all[(A - 1) * H + h]!));
            if (m > 1e-6) break;
            A--;
        }
        const features = new Tensor("float32", all.slice(0, A * H), [1, A, H]);
        af.dispose();
        return { features, tokens: A };
    }

    /**
     * Recognize one utterance (16 kHz mono, at most ~30 s). `language` is a hint (ISO code,
     * name, 中文…) or the name a previous piece reported; `language` in the result is the
     * name the model wrote (or was given).
     */
    async recognize(samples: Float32Array, language: string | undefined, signal: AbortSignal): Promise<{ text: string; language?: string }> {
        if (samples.length < 2 * HOP) return { text: "" };
        const { Tensor } = this.ort;
        const { features, tokens: A } = await this.encode(samples);
        if (!A) {
            features.dispose();
            return { text: "" };
        }
        const lang = qwen3LanguageName(language) ?? (language && /^[A-Z][a-z]+$/.test(language) ? language : undefined);
        const langId = lang ? this.tok.id(`Ġ${lang}`) : undefined;
        const forced = langId !== undefined ? [LANGUAGE_ID, langId, T.asrText] : [];
        const prompt = [...PROMPT_BEFORE, ...new Array<number>(A).fill(T.audioPad), ...PROMPT_AFTER, ...forced];
        const maxNew = Math.ceil((samples.length / 16000) * 10) + 16;
        const L = prompt.length + maxNew;
        const stride = KV_HEADS * HEAD_DIM;
        const keys = Array.from({ length: LAYERS }, () => new Float32Array(L * stride));
        const values = Array.from({ length: LAYERS }, () => new Float32Array(L * stride));

        const step = async (ids: number[], pos: number): Promise<number> => {
            const n = ids.length;
            const feeds: Record<string, OrtTensor> = {
                input_ids: new Tensor("int64", BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]),
                audio_features: features,
                attention_mask: new Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
                cache_position: new Tensor("int64", BigInt64Array.from({ length: n }, (_, i) => BigInt(pos + i)), [n]),
            };
            for (let l = 0; l < LAYERS; l++) {
                feeds[`cache_key_${l}`] = new Tensor("float32", keys[l]!, [1, L, KV_HEADS, HEAD_DIM]);
                feeds[`cache_value_${l}`] = new Tensor("float32", values[l]!, [1, L, KV_HEADS, HEAD_DIM]);
            }
            const out = await this.decoder.run(feeds);
            for (let l = 0; l < LAYERS; l++) {
                keys[l]!.set(out[`key_delta_${l}`]!.data as Float32Array, pos * stride);
                values[l]!.set(out[`value_delta_${l}`]!.data as Float32Array, pos * stride);
            }
            const logits = out.logits!;
            const V = logits.dims[2]!;
            const d = logits.data as Float32Array;
            const row = (logits.dims[1]! - 1) * V;
            let best = 0;
            let bestVal = -Infinity;
            for (let v = 0; v < V; v++) {
                const x = d[row + v]!;
                if (x > bestVal) {
                    bestVal = x;
                    best = v;
                }
            }
            for (const t of Object.values(out)) t.dispose();
            return best;
        };

        try {
            await checkpoint(signal);
            let next = await step(prompt, 0);
            let gen: number[] = [];
            let pos = prompt.length;
            while (next !== T.imEnd && next !== T.endoftext && gen.length < maxNew) {
                gen.push(next);
                if (isDegenerateRepetition(gen)) {
                    gen = trimDegenerateTail(gen);
                    break;
                }
                if ((gen.length & 7) === 0) await checkpoint(signal);
                next = await step([next], pos++);
            }
            const all = [...forced, ...gen];
            const detected = generatedLanguage(all, this.tok);
            return { text: generatedText(all, this.tok), ...(detected ? { language: detected } : {}) };
        } finally {
            features.dispose();
        }
    }
}
