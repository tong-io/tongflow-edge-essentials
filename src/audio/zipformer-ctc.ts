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
import { decodeByteBpe, isByteBpe } from "./bbpe.js";
import { Fbank, SPEAKER_FBANK } from "./fbank.js";
import { ctcGreedy, parseTokens } from "./sensevoice.js";

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

    /** Recognize one utterance (16 kHz mono; long audio should be cut at pauses first). */
    async recognize(samples: Float32Array): Promise<string> {
        const { data, frames } = this.fbank.compute(samples);
        if (frames < 10) return "";
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
        const ids = ctcGreedy(lp.data as Float32Array, n, vocab!);
        for (const t of Object.values(out)) t.dispose();
        for (const t of Object.values(feeds)) t.dispose();
        return ctcTokensToText(ids, this.syms, this.byteBpe);
    }
}
