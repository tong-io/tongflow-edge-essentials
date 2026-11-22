/**
 * Model files of the alternative audio and text implementations (issue 30, part B):
 * the extra `transcribe` and `diarize-speakers` models. Same contract as
 * `registry.ts`: paths are `<repo>/<path>` under the model base (the ModelScope repo
 * layout), and every file carries its size and SHA-256 (from the ModelScope API), checked
 * before a download is cached. `models.json` lists the same entries (a unit test keeps the
 * two in step).
 *
 * The models run by transformers.js (Whisper, Cohere Transcribe) are
 * verified from their `models.json` checksums while transformers.js streams them
 * (`ml/verified-fetch.ts`); the others are fetched and verified by `models/hub.ts`.
 */
import type { ModelSpec } from "./registry.js";

export const ZIPFORMER_CTC_ZH = {
    id: "zipformer-ctc-small-zh-int8",
    repo: "csukuangfj/sherpa-onnx-zipformer-ctc-small-zh-int8-2025-07-16",
    files: {
        model: { path: "model.int8.onnx", size: 62666860, sha256: "32e5f17cc9a77d480f8d94bda97b7cc7a40965b6651b35385813f561a74129c8" },
        tokens: { path: "tokens.txt", size: 13366, sha256: "6fed8c6c248516f38e7faa19404b57413e8ce259f1cbc1fa4aebc86eac32fdfd" },
    },
} as const satisfies ModelSpec;

export const NEMOTRON_DIARIZATION = {
    id: "nemotron-3-diarization-q4",
    repo: "onnx-community/Nemotron-3-Diarization-ONNX",
    files: {
        model: { path: "onnx/model_q4.onnx", size: 359731, sha256: "3e5e93dfd8289770343c402079d36034faa4a2eac260f66115f85ba9a2de41b2" },
        data: { path: "onnx/model_q4.onnx_data", size: 82768000, sha256: "4513ed877d7cb83944bcb27c747221a7180e03f790d1c703e50af01792b7b8f4" },
    },
} as const satisfies ModelSpec;

export const QWEN3_ASR = {
    id: "qwen3-asr-0.6b-int8",
    repo: "jkman2023/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    files: {
        conv: { path: "conv_frontend.onnx", size: 44148281, sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e" },
        encoder: { path: "encoder.int8.onnx", size: 182491662, sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9" },
        decoder: { path: "decoder.int8.onnx", size: 755914231, sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771" },
        vocab: { path: "tokenizer/vocab.json", size: 2776833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910" },
        merges: { path: "tokenizer/merges.txt", size: 1671853, sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5" },
        tokenizerConfig: { path: "tokenizer/tokenizer_config.json", size: 12487, sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c" },
        // Not fetched at runtime: the Apache-2.0 text the mirror ships, hosted next to the weights.
        license: { path: "LICENSE", size: 11358, sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30" },
    },
} as const satisfies ModelSpec;

export const WHISPER_TURBO = {
    id: "whisper-large-v3-turbo",
    repo: "onnx-community/whisper-large-v3-turbo",
    files: {
        config: { path: "config.json", size: 1332, sha256: "35cd83669f75bc2867f3b3a4461850392d5e308cd6ea951c3700539883c28df1" },
        generation: { path: "generation_config.json", size: 3897, sha256: "16f95291d2f47c944d3c2b19390bba7965666555c1ea2a0bdc850d1fab45612f" },
        preprocessor: { path: "preprocessor_config.json", size: 340, sha256: "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711" },
        tokenizer: { path: "tokenizer.json", size: 2480617, sha256: "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca" },
        tokenizerConfig: { path: "tokenizer_config.json", size: 282843, sha256: "844b642c73a91359722f47b35705f7174686df33d252695d8572cf9ac03a6389" },
        encoderQ4f16: { path: "onnx/encoder_model_q4f16.onnx", size: 369974078, sha256: "aafd3383f1aa372db0825a885730ebbbae7e34871ec0460428663c69641a63d0" },
        decoderQ4f16: { path: "onnx/decoder_model_merged_q4f16.onnx", size: 193505017, sha256: "45981cdd958a4c8e1447839850d2e6e27e30974ccbe31b4a1e5ebe9ad8965a5f" },
        encoderQ4: { path: "onnx/encoder_model_q4.onnx", size: 424942775, sha256: "7e64b20dd7b556cb7a2c1c65d9fbf31af985323c006f993d2a9dd10083547d78" },
        decoderQ4: { path: "onnx/decoder_model_merged_q4.onnx", size: 334147222, sha256: "8b933ac24074a24a1635084d06a4ed37e387ef22d980f184a5fc27418e9ceeb8" },
    },
} as const satisfies ModelSpec;

export const COHERE_TRANSCRIBE = {
    id: "cohere-transcribe-03-2026",
    repo: "onnx-community/cohere-transcribe-03-2026-ONNX",
    files: {
        config: { path: "config.json", size: 5102, sha256: "09cec8fb9a44e8c278b23efd2b8afbf29e560c2eb2b5c1a6b448d8b33a6632bf" },
        generation: { path: "generation_config.json", size: 233, sha256: "dd575639e03b2651c2ecad52c1a51e6126d2a516780cfe85e7b4517f05bd9754" },
        preprocessor: { path: "preprocessor_config.json", size: 565, sha256: "25dee36a3a47950bbed2e8c7332e99a87f1b3244864db23f972ccd4121eb469d" },
        processor: { path: "processor_config.json", size: 634, sha256: "b362db9538c695d84be46232025d8488423bd47a0fa3412d6019ec32c0615940" },
        tokenizer: { path: "tokenizer.json", size: 1152395, sha256: "e263c0ba13be0f0803705b002756908f84efc6e75a4c273231a01c4371908a2b" },
        tokenizerConfig: { path: "tokenizer_config.json", size: 4549, sha256: "4c8fec06c9e195180299db3baa370d0090be68ec611cadcf54c43217a306ca05" },
        encoder: { path: "onnx/encoder_model_q4f16.onnx", size: 1410988, sha256: "81c3369197348c87f28048fcd0cc3fa286b4f63cd950fa52c9756f2ea1c6eefa" },
        encoderData: { path: "onnx/encoder_model_q4f16.onnx_data", size: 1435501056, sha256: "6b9972eaf442a13689096fe27722f493f279e71bd4c6ae15cb6b95364aa6b3d8" },
        decoder: { path: "onnx/decoder_model_merged_q4f16.onnx", size: 194936, sha256: "4c5c1a993dc715920fb3d46bfeb35350e6edf58ce474ecd6bb150ff58a8055c6" },
        decoderData: { path: "onnx/decoder_model_merged_q4f16.onnx_data", size: 97951744, sha256: "d00de89d2b34d61393a0a3460bee1bf418eed2ca0d11be43d3db237e1250358f" },
    },
} as const satisfies ModelSpec;

export const ALT_MODELS: readonly ModelSpec[] = [
    WHISPER_TURBO,
    COHERE_TRANSCRIBE,
    QWEN3_ASR,
    ZIPFORMER_CTC_ZH,
    NEMOTRON_DIARIZATION,
];

