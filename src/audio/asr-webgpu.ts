/**
 * The WebGPU-only `transcribe` alternatives, on transformers.js (the shared T3 runtime:
 * weights from the model base, SHA-256-checked as they stream, cached in the Cache API,
 * one loaded model shared between nodes):
 *
 *  - **Whisper large-v3-turbo** (OpenAI, MIT; `onnx-community/whisper-large-v3-turbo`):
 *    q4f16 encoder + merged decoder, ≈ 564 MB (q4, ≈ 759 MB, on adapters without
 *    `shader-f16`). Multilingual with **automatic language detection**: transformers.js
 *    itself defaults to English when no language is given, so the language token is
 *    predicted first (one decoder step after `<|startoftranscript|>` on the first piece
 *    of speech), then forced for every piece. Whisper writes punctuation.
 *  - **Cohere Transcribe 03-2026** (Cohere, Apache-2.0; `onnx-community/cohere-transcribe-03-2026-ONNX`):
 *    q4f16, ≈ 1.53 GB. 14 languages incl. Mandarin, with punctuation (`<|pnc|>`). It has no
 *    language detection: the `language` input picks one, Chinese (`zh`) when absent.
 *    Only q4f16 exists at a usable size, so it needs a GPU with `shader-f16`.
 *
 * Both fail with the plugin's clear WebGPU error where WebGPU is missing.
 */
import type { EdgeContext } from "../context.js";
import type { T3Model } from "../ml/catalog.js";
import { withModel } from "../ml/runtime.js";
import { requireWebGPU } from "../ml/webgpu.js";
import { COHERE_TRANSCRIBE, WHISPER_TURBO } from "../models/alt-registry.js";
import { EdgeError } from "../util/errors.js";

const files = (spec: { files: Record<string, { path: string }> }, ...keys: string[]) => keys.map((k) => spec.files[k]!.path);

export const WHISPER_T3: T3Model = {
    id: "whisper-large-v3-turbo",
    name: "Whisper large-v3-turbo",
    repo: WHISPER_TURBO.repo,
    license: "MIT",
    licenseUrl: "https://github.com/openai/whisper/blob/main/LICENSE",
    attribution: "Whisper large-v3-turbo by OpenAI (MIT); ONNX conversion by onnx-community",
    files: files(WHISPER_TURBO, "config", "generation", "preprocessor", "tokenizer", "tokenizerConfig"),
    f16: { dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, approxMB: 564, external: false },
    fallback: { dtype: { encoder_model: "q4", decoder_model_merged: "q4" }, approxMB: 760, external: false },
};

export const COHERE_T3: T3Model = {
    id: "cohere-transcribe-03-2026",
    name: "Cohere Transcribe 03-2026",
    repo: COHERE_TRANSCRIBE.repo,
    license: "Apache-2.0",
    licenseUrl: "https://www.modelscope.cn/models/onnx-community/cohere-transcribe-03-2026-ONNX",
    attribution: "Cohere Transcribe 03-2026 by Cohere (Apache-2.0); ONNX conversion by onnx-community",
    files: files(COHERE_TRANSCRIBE, "config", "generation", "preprocessor", "processor", "tokenizer", "tokenizerConfig"),
    f16: { dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, approxMB: 1535 },
    fallback: { dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, approxMB: 1535 },
};

/** Cohere Transcribe's 14 languages. */
export const COHERE_LANGUAGES = ["en", "fr", "de", "es", "it", "pt", "nl", "pl", "el", "ar", "ja", "zh", "vi", "ko"] as const;

/** A free-form language hint → ISO 639-1 (or Whisper's `yue`); `undefined` = auto / unknown. */
export function isoLanguage(hint: string | undefined): string | undefined {
    const h = (hint ?? "").trim().toLowerCase();
    if (!h || h === "auto") return undefined;
    if (/^(yue|zh-hk|zh_hk|zh-yue|cantonese|粤语|粵語|廣東話|广东话)/.test(h)) return "yue";
    if (/^(zh|cmn|chinese|mandarin|中文|普通话|汉语|漢語|国语)/.test(h)) return "zh";
    if (/^(en|english|英语|英文)/.test(h)) return "en";
    if (/^(ja|jp|japanese|日语|日本語)/.test(h)) return "ja";
    if (/^(ko|kr|korean|韩语|한국어)/.test(h)) return "ko";
    const m = /^([a-z]{2,3})(?:[-_].*)?$/.exec(h);
    return m ? m[1] : undefined;
}

/** Cohere's language for a hint: one of its 14, Chinese when absent; Cantonese → zh. */
export function cohereLanguage(hint: string | undefined): string {
    const iso = isoLanguage(hint);
    if (!iso) return "zh";
    const l = iso === "yue" ? "zh" : iso;
    if (!(COHERE_LANGUAGES as readonly string[]).includes(l)) {
        throw new EdgeError(`Cohere Transcribe does not support language "${hint}" (supported: ${COHERE_LANGUAGES.join(", ")})`);
    }
    return l;
}

/** `<|zh|>` → `zh` from Whisper's `lang_to_id`; `undefined` when the id is not a language token. */
export function whisperLanguageOf(id: number, langToId: Record<string, number>): string | undefined {
    for (const [tok, v] of Object.entries(langToId)) if (v === id) return tok.replace(/^<\|(.*)\|>$/, "$1");
    return undefined;
}

type Tensorish = { tolist(): unknown[]; dispose?(): void };
interface AsrPipeline {
    (audio: Float32Array, options: Record<string, unknown>): Promise<{ text: string }>;
    model: {
        generate(o: Record<string, unknown>): Promise<Tensorish>;
        generation_config: { decoder_start_token_id?: number; lang_to_id?: Record<string, number> };
    };
    processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
    dispose(): Promise<void>;
}

/** A WebGPU recognizer for one recording (the language is fixed on its first piece). */
export interface WebGpuAsr {
    recognize(samples: Float32Array): Promise<string>;
    /** Whisper with segment timestamps (seconds within the piece). */
    recognizeTimed(samples: Float32Array): Promise<{ text: string; chunks: { timestamp: (number | null)[]; text: string }[] }>;
    /** The language actually used (detected or given). */
    readonly language: string | undefined;
}

async function loadSpec(model: T3Model) {
    const gpu = await requireWebGPU();
    if (model === COHERE_T3 && !gpu.f16) {
        throw new EdgeError(
            "Cohere Transcribe needs a WebGPU adapter with shader-f16 (its only browser-sized weights are q4f16); this GPU lacks it",
        );
    }
    return gpu.f16 ? model.f16 : model.fallback;
}

/**
 * A recognizer for `modelId` (`whisper-large-v3-turbo` or `cohere-transcribe-03-2026`).
 * Every piece runs through the shared T3 runtime (`withModel`): the model loads on the
 * first piece and stays resident for the next ones and later nodes.
 */
export async function webGpuAsr(ctx: EdgeContext, modelId: string, language: string | undefined): Promise<WebGpuAsr> {
    const model = modelId === COHERE_T3.id ? COHERE_T3 : WHISPER_T3;
    const variant = await loadSpec(model);
    const cohereLang = model === COHERE_T3 ? cohereLanguage(language) : undefined;
    const spec = {
        model,
        variant,
        load: async (tf: Parameters<Parameters<typeof withModel>[1]["load"]>[0], progress_callback: (p: never) => void) => {
            const make = tf.pipeline as unknown as (task: string, repo: string, o: object) => Promise<AsrPipeline>;
            const p = await make("automatic-speech-recognition", model.repo, { dtype: variant.dtype, device: "webgpu", progress_callback });
            return { value: p, dispose: () => p.dispose() };
        },
    };
    const run = <R>(use: (p: AsrPipeline) => Promise<R>) => withModel<AsrPipeline, R>(ctx, spec, use);
    let lang = model === WHISPER_T3 ? isoLanguage(language) : cohereLang;
    const whisperLang = async (p: AsrPipeline, samples: Float32Array) => {
        if (!lang) {
            lang = (await detectWhisperLanguage(p, samples)) ?? "zh";
            ctx.onProgress({ message: `Whisper detected language: ${lang}` });
        }
        return lang;
    };
    return {
        get language() {
            return lang;
        },
        recognize: (samples) =>
            run(async (p) => {
                if (model === COHERE_T3) {
                    // generation_config has no length: the default 20 tokens would cut the text.
                    const maxNew = Math.min(1024, Math.ceil((samples.length / 16000) * 12) + 24);
                    return (await p(samples, { language: cohereLang, max_new_tokens: maxNew })).text.trim();
                }
                const l = await whisperLang(p, samples);
                return (await p(samples, { language: l, task: "transcribe", return_timestamps: false })).text.trim();
            }),
        recognizeTimed: (samples) =>
            run(async (p) => {
                const l = await whisperLang(p, samples);
                const r = (await p(samples, { language: l, task: "transcribe", return_timestamps: true })) as {
                    text: string;
                    chunks?: { timestamp: (number | null)[]; text: string }[];
                };
                return { text: r.text.trim(), chunks: r.chunks ?? [{ timestamp: [0, samples.length / 16000], text: r.text }] };
            }),
    };
}

/** One decoder step after `<|startoftranscript|>`: the most likely language token. */
async function detectWhisperLanguage(p: AsrPipeline, samples: Float32Array): Promise<string | undefined> {
    const cfg = p.model.generation_config;
    const sot = cfg.decoder_start_token_id;
    if (sot === undefined || !cfg.lang_to_id) return undefined;
    const { input_features } = await p.processor(samples.subarray(0, Math.min(samples.length, 30 * 16000)));
    const out = await p.model.generate({ inputs: input_features, decoder_input_ids: [sot], max_new_tokens: 1 });
    const seq = (out.tolist() as (number | bigint)[][])[0] ?? [];
    out.dispose?.();
    const id = Number(seq[seq.length - 1]);
    return whisperLanguageOf(id, cfg.lang_to_id);
}
