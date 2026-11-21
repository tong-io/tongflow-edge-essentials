// Pure logic of the alternative audio/text implementations (issue 30, part B): byte-BPE,
// CTC text, NeMo / Whisper log-mel, the Sortformer speaker cache, segment post-processing,
// Qwen3-ASR prompt/decoding helpers, language hints, the embedding model table, and the models.json / manifest / registry agreement.
//
// Golden numbers come from Python (numpy) ports of the same reference code (transformers'
// NemotronAsrStreamingFeatureExtractor / Nemotron3DiarizationSpeakerCache, HF's
// WhisperFeatureExtractor), run on the same synthetic signal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALT_DIARIZE_MODELS, ALT_TRANSCRIBE_MODELS, joinPieces } from "../../src/audio/alternatives.js";
import { COHERE_T3, WHISPER_T3, cohereLanguage, isoLanguage, whisperLanguageOf } from "../../src/audio/asr-webgpu.js";
import { byteBpeTable, decodeByteBpe, isByteBpe } from "../../src/audio/bbpe.js";
import { logitsToSegments, nemoLogMel, slaneyMelBank, SpeakerCache } from "../../src/audio/nemotron.js";
import { SLOT_MODELS } from "../../src/audio/pipeline.js";
import {
    audioTokensLen,
    ByteLevelDecoder,
    generatedLanguage,
    generatedText,
    isDegenerateRepetition,
    PROMPT_AFTER,
    PROMPT_BEFORE,
    QWEN3_TOKENS,
    qwen3LanguageName,
    trimDegenerateTail,
    whisperLogMel,
} from "../../src/audio/qwen3-asr.js";
import { ctcTokensToText } from "../../src/audio/zipformer-ctc.js";
import { hostedFiles } from "../../src/ml/catalog.js";
import { normalizeRowsL2 } from "../../src/ml/bge.js";
import { BGE_QUERY_INSTRUCTION, EMBED_MODELS, HARRIER_QUERY_INSTRUCTION, resolveEmbedModel } from "../../src/ml/models.js";
import { ALT_MODELS, COHERE_TRANSCRIBE, WHISPER_TURBO } from "../../src/models/alt-registry.js";

const root = new URL("../../", import.meta.url);

/** The LCG the golden script uses (glibc constants), values in [0, 1). */
function lcg(n: number, seed: number): Float64Array {
    const out = new Float64Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
        x = (Math.imul(1103515245, x) + 12345) & 0x7fffffff; // mod 2^31, exact in 32-bit arithmetic
        out[i] = x / 2147483648;
    }
    return out;
}
function chirp(): Float32Array {
    const n = 16000;
    const noise = lcg(n, 12345);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / 16000;
        s[i] = 0.3 * Math.sin(2 * Math.PI * (200 + 800 * t) * t) + 0.05 * (noise[i]! - 0.5);
    }
    return s;
}

describe("byte-level BPE (icefall table) and CTC text", () => {
    it("the table maps 256 code points to the 256 bytes", () => {
        const t = byteBpeTable();
        const bytes = new Set([...t.entries()].filter(([cp]) => cp !== 8263).map(([, b]) => b));
        expect(bytes.size).toBe(256);
        expect(t.get("A".codePointAt(0)!)).toBe(0x41); // printable ASCII stands for itself
    });

    it("decodes UTF-8 byte pieces and word boundaries", () => {
        // 你 = e4 bd a0: bytes ≥ 0x7f are the code points PRINTABLE_BASE_CHARS gives them.
        const enc = (bytes: number[]) => {
            const inv = new Map([...byteBpeTable().entries()].filter(([cp]) => cp !== 8263).map(([cp, b]) => [b, cp]));
            return bytes.map((b) => String.fromCodePoint(inv.get(b)!)).join("");
        };
        expect(decodeByteBpe(enc([0xe4, 0xbd, 0xa0]) + enc([0xe5, 0xa5, 0xbd]))).toBe("你好");
        expect(decodeByteBpe(`▁HELLO▁WORLD`)).toBe("HELLO WORLD");
        expect(decodeByteBpe(enc([0xe4, 0xbd]))).toBe(""); // a cut character is dropped
        expect(isByteBpe([enc([0xe4]), enc([0xbd, 0xa0]), "<blk>"])).toBe(true);
        expect(isByteBpe(["你", "好", "世界"])).toBe(false);
    });

    it("CTC ids → text, skipping <blk>-style symbols", () => {
        expect(ctcTokensToText([1, 2, 3], ["<blk>", "▁HI", "▁THERE", "<unk>"], false)).toBe("HI THERE");
    });

    it("joins pieces like the default path", () => {
        expect(joinPieces(["你好。", " 世界", "hello", "world"])).toBe("你好。世界hello world");
    });
});

describe("NeMo log-mel (Nemotron-3-Diarization front end)", () => {
    const g = {
        frames: 101,
        valid: 100,
        at: [
            [0, 0, -7.682775974273682],
            [10, 5, -12.217642784118652],
            [50, 64, -7.320435523986816],
            [99, 127, -5.252168655395508],
        ],
    };
    it("Slaney mel bank = librosa / transformers mel_filter_bank", () => {
        const fb = slaneyMelBank(512, 128, 16000);
        expect(fb[3]![2]).toBeCloseTo(0, 9);
        expect(fb[40]![30]).toBeCloseTo(0.00400473503395915, 7);
        expect(fb[127]![250]).toBeCloseTo(0.005223188549280167, 7);
        const fb400 = slaneyMelBank(400, 128, 16000);
        const sum = (r: Float32Array) => r.reduce((a, x) => a + x, 0);
        expect(sum(fb400[0]!)).toBeCloseTo(0.012373986653983593, 6);
        expect(sum(fb400[64]!)).toBeCloseTo(0.024841200560331345, 6);
        expect(sum(fb400[127]!)).toBeCloseTo(0.024936042726039886, 6);
    });

    it("features match the numpy port of NemotronAsrStreamingFeatureExtractor", () => {
        const { data, frames, valid } = nemoLogMel(chirp());
        expect(frames).toBe(g.frames);
        expect(valid).toBe(g.valid);
        for (const [f, b, v] of g.at) expect(data[f! * 128 + b!]).toBeCloseTo(v!, 3);
        expect(data.subarray(100 * 128).every((x) => x === 0)).toBe(true); // masked tail
    });
});

describe("Sortformer speaker cache (Nemotron offline mode)", () => {
    it("FIFO → cache → compression reproduce transformers' Nemotron3DiarizationSpeakerCache", () => {
        const H = 512;
        const K = 8;
        const rng = lcg(3 * (400 * H + 400 * 8 * K) + 10, 777);
        let off = 0;
        const take = (k: number) => {
            const v = rng.subarray(off, off + k);
            off += k;
            return v;
        };
        const c = new SpeakerCache();
        const silence = new Float32Array(H).fill(0.25);
        for (let step = 0; step < 3; step++) {
            const cached = c.cached();
            const right = step < 2 ? 40 : 0;
            const chunk = Float32Array.from(take((340 + right) * H), (x) => x - 0.5);
            const input = new Float32Array(cached.length + chunk.length);
            input.set(cached);
            input.set(chunk, cached.length);
            const frames = input.length / H;
            const logits = Float32Array.from(take(frames * 8 * K), (x) => (x - 0.5) * 8);
            c.update(input, logits, silence, 340);
        }
        expect(c.cacheFrames).toBe(264);
        expect(c.fifoFrames).toBe(40);
        const cache = c.cached();
        const embeds = cache.subarray(0, 264 * H);
        const fifo = cache.subarray(264 * H);
        const sum = (a: Float32Array) => a.reduce((s, x) => s + x, 0);
        expect(sum(embeds)).toBeCloseTo(1246.22573949676, 1);
        expect(sum(fifo)).toBeCloseTo(-39.11477076727897, 1);
        let silent = 0;
        for (let r = 0; r < 264; r++) if (embeds.subarray(r * H, (r + 1) * H).every((x) => x === 0.25)) silent++;
        expect(silent).toBe(8); // one reserved silence slot per speaker
    });

    it("pools sigmoid probabilities per encoder frame (8 logit frames)", () => {
        const logits = new Float32Array(2 * 8 * 2).fill(0); // sigmoid(0) = 0.5
        logits.fill(100, 16); // second frame: speaker 0 and 1 ≈ 1
        const p = SpeakerCache.poolProbs(logits, 2, 2, 8);
        expect(Array.from(p).map((x) => Math.round(x * 100) / 100)).toEqual([0.5, 0.5, 1, 1]);
        expect(Array.from(SpeakerCache.poolProbs(logits, 2, 2, 8, Uint8Array.of(0, 1)))[0]).toBe(0);
    });
});

describe("speaker activity → segments", () => {
    it("thresholds, merges same-speaker gaps ≤ 0.5 s, drops < 0.3 s, renumbers by arrival", () => {
        const K = 8;
        const frames = 400; // 4 s at 10 ms
        const logits = new Float32Array(frames * K).fill(-10);
        const on = (k: number, a: number, b: number) => {
            for (let f = a; f < b; f++) logits[f * K + k] = 10;
        };
        on(3, 0, 100); // speaker 3 first: becomes 0
        on(3, 130, 200); // gap 0.3 s: merged
        on(5, 210, 380); // becomes 1
        on(6, 390, 395); // 0.05 s: dropped
        expect(logitsToSegments(logits, frames, K)).toEqual([
            { speaker: 0, start: 0, end: 2 },
            { speaker: 1, start: 2.1, end: 3.8 },
        ]);
    });
});

describe("Qwen3-ASR glue", () => {
    it("Whisper log-mel matches the numpy port of HF's WhisperFeatureExtractor", () => {
        const { data, frames } = whisperLogMel(chirp());
        expect(frames).toBe(100);
        const at: [number, number, number][] = [
            [0, 0, 0.9808244705200195],
            [10, 5, 0.1477089375257492],
            [50, 64, 0.27774694561958313],
            [99, 127, 0.2577146887779236],
        ];
        for (const [f, b, v] of at) expect(data[f * 128 + b]).toBeCloseTo(v, 4);
    });

    it("audio token count = sherpa-onnx FeatToAudioTokensLen", () => {
        expect(audioTokensLen(149)).toBe(20); // hello-zh: 1.49 s
        expect(audioTokensLen(2104)).toBe(274); // dialog-zh: 21 s
        expect(audioTokensLen(100)).toBe(13);
        expect(audioTokensLen(0)).toBe(0);
    });

    it("prompt ids and the language prefix", () => {
        expect(PROMPT_BEFORE).toEqual([151644, 8948, 198, 151645, 198, 151644, 872, 198, 151669]);
        expect(PROMPT_AFTER).toEqual([151670, 151645, 198, 151644, 77091, 198]);
        expect(qwen3LanguageName("zh-CN")).toBe("Chinese");
        expect(qwen3LanguageName("粤语")).toBe("Cantonese");
        expect(qwen3LanguageName("en")).toBe("English");
        expect(qwen3LanguageName(undefined)).toBeUndefined();
        // "你好，世界。" as the model writes it: language Chinese<asr_text>…
        const vocab: Record<string, number> = { language: 11528, ĠChinese: 8453, "ä½łå¥½": 108386, "ï¼Į": 3837, "ä¸ĸçķĮ": 99489, "ãĢĤ": 1773 };
        const dec = new ByteLevelDecoder(vocab);
        expect(generatedText([11528, 8453, QWEN3_TOKENS.asrText, 108386, 3837, 99489, 1773], dec)).toBe("你好，世界。");
        expect(generatedText([108386, 1773], dec)).toBe("你好。");
        expect(generatedText([11528, 8453, 108386, 1773], dec)).toBe("你好。"); // no <asr_text>
        expect(generatedText([108386, 11528, 8453, QWEN3_TOKENS.asrText, 1773], dec)).toBe("你好。"); // repeated mid-piece
        expect(generatedLanguage([11528, 8453, QWEN3_TOKENS.asrText, 108386], dec)).toBe("Chinese");
        expect(generatedLanguage([108386], dec)).toBeUndefined();
        expect(dec.id("ĠChinese")).toBe(8453);
    });

    it("stops degenerate repetition and trims the loop", () => {
        const ids = [1, 2, 3, ...Array.from({ length: 64 }, (_, i) => (i % 2 ? 7 : 8))];
        expect(isDegenerateRepetition(ids)).toBe(true);
        expect(isDegenerateRepetition(Array.from({ length: 64 }, (_, i) => i))).toBe(false);
        expect(trimDegenerateTail(ids)).toEqual([1, 2, 3]);
    });
});

describe("language hints", () => {
    it("ISO codes, Cohere's 14 languages, Whisper's language tokens", () => {
        expect(isoLanguage("zh-CN")).toBe("zh");
        expect(isoLanguage("Cantonese")).toBe("yue");
        expect(isoLanguage("fr-FR")).toBe("fr");
        expect(isoLanguage("auto")).toBeUndefined();
        expect(cohereLanguage(undefined)).toBe("zh");
        expect(cohereLanguage("粤语")).toBe("zh");
        expect(cohereLanguage("de")).toBe("de");
        expect(() => cohereLanguage("ru")).toThrow(/does not support language "ru"/);
        expect(whisperLanguageOf(50260, { "<|en|>": 50259, "<|zh|>": 50260 })).toBe("zh");
        expect(whisperLanguageOf(1, { "<|en|>": 50259 })).toBeUndefined();
    });
});

describe("embedding models (embed-text and the host's createQueryEmbedder)", () => {
    it("per-model pooling, device and query instruction; aliases", () => {
        expect(resolveEmbedModel("bge-small-zh-v1.5").queryInstruction).toBe(BGE_QUERY_INSTRUCTION);
        const h = resolveEmbedModel("harrier-oss-v1-270m");
        expect(h).toMatchObject({ dims: 640, pooling: "model", device: "webgpu", dtype: "q4", queryInstruction: HARRIER_QUERY_INSTRUCTION });
        expect(HARRIER_QUERY_INSTRUCTION).toBe("Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ");
        const g = resolveEmbedModel("granite-embedding-97m-r2");
        expect(g).toMatchObject({ id: "granite-embedding-97m-multilingual-r2", dims: 384, pooling: "cls", device: "wasm", dtype: "q8", queryInstruction: "" });
        expect(resolveEmbedModel("onnx-community/harrier-oss-v1-270m-ONNX").id).toBe("harrier-oss-v1-270m");
        expect(Object.keys(EMBED_MODELS)).toHaveLength(4);
    });

    it("L2-normalizes rows", () => {
        const d = normalizeRowsL2(Float32Array.of(3, 4, 0, 0), 2);
        expect(Array.from(d).map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0.6, 0.8, 0, 0]);
    });
});

describe("manifest, models.json and the alternative registry agree", () => {
    const models = JSON.parse(readFileSync(new URL("models.json", root), "utf8")) as {
        id: string;
        source: string;
        files: string[];
        checksums: Record<string, { size: number; sha256: string }>;
        license: string;
        licenseUrl: string;
        attribution: string;
        approxMB: number;
    }[];
    const manifest = JSON.parse(readFileSync(new URL("tongflow.plugin.json", root), "utf8")) as { slots: { nodeSlot: string; models?: string[] }[] };

    it("every alternative model is in models.json with files, sizes, hashes, license and attribution", () => {
        for (const spec of ALT_MODELS) {
            const m = models.find((x) => x.id === spec.id);
            expect(m, spec.id).toBeDefined();
            expect(m!.source).toBe(`modelscope:${spec.repo}`);
            const files = Object.values(spec.files);
            expect(m!.files).toEqual(files.map((f) => f.path));
            expect(m!.checksums).toEqual(Object.fromEntries(files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }])));
            expect(m!.license && m!.licenseUrl && m!.attribution, spec.id).toBeTruthy();
            expect(Math.abs(m!.approxMB - files.reduce((a, f) => a + f.size, 0) / 1e6)).toBeLessThan(1);
        }
        expect(readFileSync(new URL("licenses/OpenMDW-1.1.txt", root), "utf8")).toMatch(/retain in your distribution \(1\) a copy of this agreement/);
    });

    it("the WebGPU ASR catalogs only load registered files", () => {
        const reg = (spec: typeof WHISPER_TURBO | typeof COHERE_TRANSCRIBE) => new Set(Object.values(spec.files).map((f) => f.path));
        for (const f of hostedFiles(WHISPER_T3)) expect(reg(WHISPER_TURBO).has(f), f).toBe(true);
        for (const f of hostedFiles(COHERE_T3)) expect(reg(COHERE_TRANSCRIBE).has(f), f).toBe(true);
    });

    it("manifest: defaults first and unchanged, alternatives after them", () => {
        const models = (slot: string) => manifest.slots.find((s) => s.nodeSlot === slot)!.models!;
        expect(models("transcribe")[0]).toBe("sensevoice-small");
        expect(models("diarize-speakers")[0]).toBe("pyannote-campplus-zh");
        expect(models("embed-text").slice(0, 2)).toEqual(["bge-small-zh-v1.5", "bge-base-zh-v1.5"]);
        for (const id of ALT_TRANSCRIBE_MODELS) expect(models("transcribe")).toContain(id);
        for (const id of ALT_DIARIZE_MODELS) expect(models("diarize-speakers")).toContain(id);
        expect(models("embed-text")).toEqual(expect.arrayContaining(["harrier-oss-v1-270m", "granite-embedding-97m-multilingual-r2"]));
        expect(SLOT_MODELS.transcribe).toEqual(expect.arrayContaining([...ALT_TRANSCRIBE_MODELS]));
    });
});
