/**
 * The model files the audio slots download, by model id. Paths are relative to
 * the model base URL as `<repo>/<path>` (the ModelScope repo layout), and every
 * file carries its size and SHA-256 so a download is verified before it is
 * cached. `models.json` at the repository root lists the same entries for the
 * hosting sync (a unit test keeps the two in step).
 */
export interface ModelFile {
    path: string;
    size: number;
    sha256: string;
}

export interface ModelSpec {
    id: string;
    /** `<org>/<repo>` under the model base (mirrors ModelScope). */
    repo: string;
    files: Record<string, ModelFile>;
}

export const SENSEVOICE = {
    id: "sensevoice-small-int8",
    repo: "pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
    files: {
        model: {
            path: "model.int8.onnx",
            size: 239233841,
            sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
        },
        tokens: {
            path: "tokens.txt",
            size: 315894,
            sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
        },
    },
} as const satisfies ModelSpec;

export const SILERO_VAD = {
    id: "silero-vad-v5",
    repo: "pengzhendong/silero-vad",
    files: {
        model: {
            path: "v5/silero_vad.onnx",
            size: 2327524,
            sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f",
        },
    },
} as const satisfies ModelSpec;

export const PYANNOTE_SEGMENTATION = {
    id: "pyannote-segmentation-3.0",
    repo: "pengzhendong/sherpa-onnx-pyannote-segmentation-3-0",
    files: {
        model: {
            path: "model.onnx",
            size: 5992913,
            sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
        },
    },
} as const satisfies ModelSpec;

export const CAMPLUS_ZH = {
    id: "3dspeaker-campplus-zh-cn-16k",
    repo: "lihuoo/3dspeaker-recognition-models",
    files: {
        model: {
            path: "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
            size: 28281138,
            sha256: "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11",
        },
    },
} as const satisfies ModelSpec;

export const CED_TINY = {
    id: "ced-tiny-int8",
    repo: "k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19",
    files: {
        model: {
            path: "model.int8.onnx",
            size: 6133417,
            sha256: "73aa22e783115f6a4ae169b36089907e07d0fd44795595eddea9c1bfc74cc945",
        },
        labels: {
            path: "class_labels_indices.csv",
            size: 14675,
            sha256: "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429",
        },
    },
} as const satisfies ModelSpec;

/**
 * X-ASR zh-en (Apache-2.0), sherpa-onnx's int8 export
 * `sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03`. The ModelScope
 * mirror holds the release archive's files unpacked; they were checked byte for byte
 * against the archive whose SHA-256 the GitHub release `k2-fsa/sherpa-onnx` `asr-models` lists.
 */
export const X_ASR = {
    id: "x-asr-zh-en-int8",
    repo: "mogenle/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03",
    files: {
        encoder: {
            path: "encoder-epoch-99-avg-1.int8.onnx",
            size: 161015713,
            sha256: "7f6aa62056efd8af9da13e0faa81cd3f284d2fb2e3b63de56fd2dfd3450910dc",
        },
        decoder: {
            path: "decoder-epoch-99-avg-1.onnx",
            size: 11309084,
            sha256: "72f47405d3c1033bebccbef82f90071e7b4ba3e71b9c986f2b74244b25723aed",
        },
        joiner: {
            path: "joiner-epoch-99-avg-1.int8.onnx",
            size: 2581422,
            sha256: "aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3",
        },
        tokens: {
            path: "tokens.txt",
            size: 58806,
            sha256: "b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c",
        },
    },
} as const satisfies ModelSpec;

export const AUDIO_MODELS: readonly ModelSpec[] = [SENSEVOICE, SILERO_VAD, PYANNOTE_SEGMENTATION, CAMPLUS_ZH, CED_TINY, X_ASR];
