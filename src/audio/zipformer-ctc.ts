/**
 * Zipformer-CTC small zh (k2-fsa/icefall, Apache-2.0), the sherpa-onnx int8 export
 * `sherpa-onnx-zipformer-ctc-small-zh-int8-2025-07-16` (62.7 MB), on onnxruntime-web.
 * The front end is sherpa-onnx's default (80-bin Kaldi fbank, povey window, no
 * snip-edges, samples in [-1, 1]); the model returns log-probabilities over 1000
 * byte-level BPE tokens, decoded with CTC greedy search and icefall's byte table.
 *
 * Trained on WenetSpeech-style Mandarin: **the output has no punctuation** (and no
 * casing for Latin words). It is the tiny fallback of `transcribe`.
 */
import type { EdgeContext } from "../context.js";
import { createSession, loadOrt, type OrtSession } from "../ml/ort.js";
import { fetchModelFile } from "../models/hub.js";
import { ZIPFORMER_CTC_ZH } from "../models/alt-registry.js";
import { byteBpeTable, decodeByteBpe, isByteBpe } from "./bbpe.js";
import { Fbank, SPEAKER_FBANK } from "./fbank.js";
import { ctcGreedyFrames, parseTokens } from "./sensevoice.js";
import type { TimedToken } from "./timestamps.js";

/** CTC token ids → text: drop `<…>` symbols, join, byte-BPE decode (or `▁` → space). */
export function ctcTokensToText(ids: readonly number[], syms: readonly string[], byteBpe: boolean): string {
    let s = "";
    for (const id of ids) {
        const sym = syms[id] ?? "";
        if (!sym || /^<.*>$/.test(sym)) continue;
        s += sym;
    }
    const text = byteBpe ? decodeByteBpe(s) : s.replace(/▁/g, " ");
    return text.replace(/\s+/g, " ").trim();
}

/**
 * CTC tokens → text units with times: byte pieces are grouped until they decode to whole
 * UTF-8 characters (a Chinese character is three byte tokens), each unit timed at its
 * first token's frame. `▁` (word boundary) becomes a leading space.
 */
export function timedUnits(ids: readonly number[], frames: readonly number[], syms: readonly string[], byteBpe: boolean, frameS: number): TimedToken[] {
    const out: TimedToken[] = [];
    let pending = "";
    let pendingAt = 0;
    for (let i = 0; i < ids.length; i++) {
        const sym = syms[ids[i]!] ?? "";
        if (!sym || /^<.*>$/.test(sym)) continue;
        if (!pending) pendingAt = frames[i]! * frameS;
        pending += sym;
        const text = byteBpe ? decodeByteBpe(pending.replace(/^\u2581/, "")) : pending.replace(/\u2581/g, " ");
        // A unit is complete once its bytes decode without a dangling partial character.
        const complete = !byteBpe || new TextDecoder("utf-8", { fatal: false }).decode(byteBytes(pending)).indexOf("\uFFFD") < 0;
        if (complete && text) {
            out.push({ text: (pending.startsWith("\u2581") && out.length ? " " : "") + text, time: Math.round(pendingAt * 1000) / 1000 });
            pending = "";
        }
    }
    return out;
}

/** The raw bytes a byte-BPE string stands for (word boundaries dropped). */
function byteBytes(s: string): Uint8Array {
    const t = byteBpeTable();
    const out: number[] = [];
    for (const ch of s) {
        const b = t.get(ch.codePointAt(0)!);
        if (b !== undefined) out.push(b);
    }
    return Uint8Array.from(out);
}

/** Zipformer's text from its timed units (CJK joined without spaces). */
export function zipformerText(tokens: readonly string[]): string {
    return tokens.join("").replace(/\s+/g, " ").trim();
}

export class ZipformerCtc {
    private readonly fbank = new Fbank(SPEAKER_FBANK);
    private readonly byteBpe: boolean;
    private constructor(
        private readonly session: OrtSession,
        private readonly syms: string[],
        private readonly ort: typeof import("onnxruntime-web"),
    ) {
        this.byteBpe = isByteBpe(syms);
    }

    static async load(ctx: EdgeContext): Promise<ZipformerCtc> {
        const [model, tokens] = await Promise.all([
            fetchModelFile(ctx, ZIPFORMER_CTC_ZH, ZIPFORMER_CTC_ZH.files.model),
            fetchModelFile(ctx, ZIPFORMER_CTC_ZH, ZIPFORMER_CTC_ZH.files.tokens),
        ]);
        const ort = await loadOrt(ctx);
        const session = await createSession(ctx, model);
        return new ZipformerCtc(session, parseTokens(new TextDecoder().decode(tokens)), ort);
    }

    /** Recognize one utterance (16 kHz mono; long audio should be cut at pauses first), with token times. */
    async recognize(samples: Float32Array): Promise<{ text: string; tokens: TimedToken[] }> {
        const { data, frames } = this.fbank.compute(samples);
        if (frames < 10) return { text: "", tokens: [] };
        const T = this.ort.Tensor;
        const feeds = {
            x: new T("float32", data, [1, frames, this.fbank.dim]),
            x_lens: new T("int64", BigInt64Array.of(BigInt(frames)), [1]),
        };
        const out = await this.session.run(feeds);
        const lp = out.log_probs!;
        const [, outFrames, vocab] = lp.dims as number[];
        const lens = out.log_probs_len?.data as BigInt64Array | undefined;
        const n = lens ? Math.min(Number(lens[0]), outFrames!) : outFrames!;
        const r = ctcGreedyFrames(lp.data as Float32Array, n, vocab!);
        for (const t of Object.values(out)) t.dispose();
        for (const t of Object.values(feeds)) t.dispose();
        // Output frames cover the input frames evenly (zipformer2 subsamples by 4: 40 ms).
        const frameS = (frames * 0.01) / Math.max(1, outFrames!);
        return { text: ctcTokensToText(r.tokens, this.syms, this.byteBpe), tokens: timedUnits(r.tokens, r.frames, this.syms, this.byteBpe, frameS) };
    }
}
