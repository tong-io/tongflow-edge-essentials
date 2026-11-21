/**
 * X-ASR zh-en (Apache-2.0, Gilgamesh-J/X-ASR): a non-streaming Zipformer2
 * transducer with punctuation and casing, on the sherpa-onnx int8 export
 * (encoder, decoder, joiner), run with onnxruntime-web. The front end and the
 * decoding follow sherpa-onnx's `OfflineRecognizerTransducerImpl` and
 * `OfflineTransducerGreedySearchDecoder`:
 * 80-bin Kaldi fbank (povey window, no snip_edges, samples in [-1, 1]) →
 * encoder → greedy search, at most one symbol per encoder frame, the decoder
 * context starting as `[-1, …, -1, blank]`, `<unk>` treated as blank → tokens
 * with `▁` read as a space, spaces between CJK characters and before punctuation
 * removed (sherpa's `RemoveSpaceBetweenCjk`).
 */
import type { EdgeContext } from "../context.js";
import { createSession, loadOrt, type OrtSession } from "../ml/ort.js";
import { readOnnxMetadata } from "../ml/onnx-meta.js";
import { fetchModelFile } from "../models/hub.js";
import { X_ASR } from "../models/registry.js";
import { checkpoint } from "./checkpoint.js";
import { Fbank, SPEAKER_FBANK } from "./fbank.js";
import { parseTokens } from "./sensevoice.js";
import type { TimedToken } from "./timestamps.js";

/** sherpa-onnx's default feature config for transducers (also what CAM++ uses). */
export const TRANSDUCER_FBANK = SPEAKER_FBANK;
/** Encoder frames are 4 fbank frames (40 ms) apart. */
export const TRANSDUCER_FRAME_S = 0.04;

export interface TransducerHyp {
    tokens: number[];
    /** Encoder frame of each token. */
    frames: number[];
}

/** The joiner for one encoder frame against the current decoder output: logits over the vocabulary. */
export type JoinFn = (frame: number, decoderOut: Float32Array) => Promise<Float32Array> | Float32Array;
/** The decoder for the last `contextSize` tokens (`-1` = none). */
export type DecodeFn = (context: number[]) => Promise<Float32Array> | Float32Array;

function argmax(x: Float32Array): number {
    let best = 0;
    let v = -Infinity;
    for (let i = 0; i < x.length; i++) {
        if (x[i]! > v) {
            v = x[i]!;
            best = i;
        }
    }
    return best;
}

/**
 * Greedy transducer search as sherpa-onnx runs it offline: one joiner call per
 * encoder frame, at most one symbol per frame, the decoder re-run after each
 * emitted symbol. `blank` (0) and `unk` are not emitted.
 */
export async function greedySearch(
    numFrames: number,
    contextSize: number,
    join: JoinFn,
    decode: DecodeFn,
    opts: { blank?: number; unk?: number; signal?: AbortSignal } = {},
): Promise<TransducerHyp> {
    const blank = opts.blank ?? 0;
    const unk = opts.unk ?? -1;
    const context = new Array<number>(contextSize).fill(-1);
    context[contextSize - 1] = blank;
    let decoderOut = await decode(context.slice());
    const hyp: TransducerHyp = { tokens: [], frames: [] };
    for (let t = 0; t < numFrames; t++) {
        if ((t & 127) === 127 && opts.signal) await checkpoint(opts.signal);
        const y = argmax(await join(t, decoderOut));
        if (y !== blank && y !== unk) {
            hyp.tokens.push(y);
            hyp.frames.push(t);
            context.push(y);
            context.shift();
            decoderOut = await decode(context.slice());
        }
    }
    return hyp;
}

const isCjk = (cp: number) =>
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xa840 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff65 && cp <= 0xffdc) ||
    (cp >= 0x20000 && cp <= 0x2ffff);
const isHangul = (cp: number) =>
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff) ||
    (cp >= 0xffa0 && cp <= 0xffdc);
const isPunct = (cp: number) =>
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff01 && cp <= 0xff0f) ||
    (cp >= 0xff1a && cp <= 0xff20);

/** sherpa-onnx `RemoveSpaceBetweenCjk`: drop a space between two CJK (non-Hangul) characters or before punctuation. */
export function removeSpaceBetweenCjk(text: string): string {
    const cps = Array.from(text, (c) => c.codePointAt(0)!);
    if (cps.length < 2) return text;
    const cjk = (cp: number) => isCjk(cp) && !isHangul(cp);
    let out = String.fromCodePoint(cps[0]!);
    for (let i = 1; i < cps.length; i++) {
        if (cps[i] === 0x20 && i + 1 < cps.length && ((cjk(cps[i - 1]!) && cjk(cps[i + 1]!)) || isPunct(cps[i + 1]!))) continue;
        out += String.fromCodePoint(cps[i]!);
    }
    return out;
}

/** The text sherpa-onnx reports for a token sequence (`▁` → space, CJK spaces removed), trimmed. */
export function sherpaText(syms: readonly string[], tokens: readonly number[]): string {
    let text = "";
    for (const id of tokens) {
        const s = syms[id] ?? "";
        text += s.startsWith("▁") ? ` ${s.slice(1)}` : s;
    }
    return removeSpaceBetweenCjk(text).trim();
}

/** Full-width punctuation never needs a space after it: 「大家好， 今天」 → 「大家好，今天」. */
export function tidyTranscript(text: string): string {
    return text.replace(/([，。！？；：、）】」』])[ \t]+/g, "$1").trim();
}

/** X-ASR's text from its token texts (a leading `▁` already a space): sherpa's rules plus {@link tidyTranscript}. */
export function xAsrText(tokens: readonly string[]): string {
    return tidyTranscript(removeSpaceBetweenCjk(tokens.join("")).trim());
}

export interface TransducerResult {
    text: string;
    tokens: TimedToken[];
}

export class XAsr {
    private readonly fbank = new Fbank(TRANSDUCER_FBANK);
    private constructor(
        private readonly encoder: OrtSession,
        private readonly decoder: OrtSession,
        private readonly joiner: OrtSession,
        private readonly contextSize: number,
        private readonly syms: string[],
        private readonly ort: typeof import("onnxruntime-web"),
    ) {}

    static async load(ctx: EdgeContext): Promise<XAsr> {
        const [enc, dec, join, tokens] = await Promise.all([
            fetchModelFile(ctx, X_ASR, X_ASR.files.encoder),
            fetchModelFile(ctx, X_ASR, X_ASR.files.decoder),
            fetchModelFile(ctx, X_ASR, X_ASR.files.joiner),
            fetchModelFile(ctx, X_ASR, X_ASR.files.tokens),
        ]);
        const contextSize = Number.parseInt(readOnnxMetadata(dec).context_size ?? "2", 10) || 2;
        const ort = await loadOrt(ctx);
        const encoder = await createSession(ctx, enc);
        const decoder = await createSession(ctx, dec);
        const joiner = await createSession(ctx, join);
        return new XAsr(encoder, decoder, joiner, contextSize, parseTokens(new TextDecoder().decode(tokens)), ort);
    }

    /** Recognize one utterance (16 kHz mono; keep it under ~30 s: longer input overflows the encoder's attention). */
    async recognize(samples: Float32Array, signal?: AbortSignal): Promise<TransducerResult> {
        const { data: feats, frames } = this.fbank.compute(samples);
        if (!frames) return { text: "", tokens: [] };
        const T = this.ort.Tensor;
        const x = new T("float32", feats, [1, frames, this.fbank.dim]);
        const xLens = new T("int32", Int32Array.of(frames), [1]);
        const enc = await this.encoder.run({ x, x_lens: xLens });
        x.dispose();
        xLens.dispose();
        const encOut = enc.encoder_out!;
        const [, numFrames, dim] = encOut.dims as number[];
        const encData = encOut.data as Float32Array;
        const outLen = Number((enc.encoder_out_lens!.data as Int32Array)[0] ?? numFrames);
        const unk = this.syms.indexOf("<unk>");
        const hyp = await greedySearch(
            Math.min(outLen, numFrames!),
            this.contextSize,
            async (t, decoderOut) => {
                const e = new T("float32", encData.slice(t * dim!, (t + 1) * dim!), [1, dim!]);
                const d = new T("float32", decoderOut, [1, decoderOut.length]);
                const r = await this.joiner.run({ encoder_out: e, decoder_out: d });
                e.dispose();
                d.dispose();
                const logit = r.logit!;
                const v = (logit.data as Float32Array).slice();
                logit.dispose();
                return v;
            },
            async (context) => {
                const y = new T("int32", Int32Array.from(context), [1, context.length]);
                const r = await this.decoder.run({ y });
                y.dispose();
                const out = r.decoder_out!;
                const v = (out.data as Float32Array).slice();
                out.dispose();
                return v;
            },
            { unk, ...(signal ? { signal } : {}) },
        );
        for (const t of Object.values(enc)) t.dispose();
        const tokens = hyp.tokens.map((id, i) => ({ text: (this.syms[id] ?? "").replace(/^▁/, " "), time: hyp.frames[i]! * TRANSDUCER_FRAME_S }));
        return { text: xAsrText(tokens.map((t) => t.text)), tokens };
    }
}
