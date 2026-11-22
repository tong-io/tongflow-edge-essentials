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

/** Length of the UTF-8 sequence starting with byte `b` (0 = not a lead byte). */
function utf8Len(b: number): number {
    if (b < 0x80) return 1;
    if (b >= 0xc2 && b <= 0xdf) return 2;
    if (b >= 0xe0 && b <= 0xef) return 3;
    if (b >= 0xf0 && b <= 0xf4) return 4;
    return 0;
}

/**
 * CTC tokens → text units with times: byte pieces are collected into whole UTF-8
 * characters (a Chinese character is three byte tokens), each timed at the frame of the
 * token that brought its first byte. Invalid bytes are dropped instead of blocking the
 * rest. `▁` (word boundary) becomes a leading space; without byte-BPE, each token is a unit.
 */
export function timedUnits(ids: readonly number[], frames: readonly number[], syms: readonly string[], byteBpe: boolean, frameS: number): TimedToken[] {
    const out: TimedToken[] = [];
    const at = (i: number) => Math.round(frames[i]! * frameS * 1000) / 1000;
    if (!byteBpe) {
        ids.forEach((id, i) => {
            const sym = syms[id] ?? "";
            if (sym && !/^<.*>$/.test(sym)) out.push({ text: sym.replace(/\u2581/g, " "), time: at(i) });
        });
        return out;
    }
    const table = byteBpeTable();
    const buf: { b: number; t: number }[] = [];
    let space = false;
    const flush = () => {
        while (buf.length) {
            const n = utf8Len(buf[0]!.b);
            if (!n || buf.slice(1, n).some((x) => (x.b & 0xc0) !== 0x80)) {
                buf.shift(); // not a valid start: drop it
                continue;
            }
            if (buf.length < n) return; // wait for the rest of the character
            const ch = new TextDecoder().decode(Uint8Array.from(buf.slice(0, n), (x) => x.b));
            out.push({ text: (space && out.length ? " " : "") + ch, time: buf[0]!.t });
            space = false;
            buf.splice(0, n);
        }
    };
    ids.forEach((id, i) => {
        const sym = syms[id] ?? "";
        if (!sym || /^<.*>$/.test(sym)) return;
        for (const c of sym) {
            const cp = c.codePointAt(0)!;
            if (cp === 0x2581) {
                flush();
                space = true;
                continue;
            }
            const b = table.get(cp) ?? (cp >= 0x20 && cp < 0x7f ? cp : undefined);
            if (b !== undefined) buf.push({ b, t: at(i) });
        }
        flush();
    });
    return out;
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
