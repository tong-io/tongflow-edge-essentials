// Alternative `transcribe`, `diarize-speakers` and `embed-text` models (issue 30, part B),
// in the built plugin worker over the engine protocol.
//
// Default run: no weights, no GPU. The WebGPU-only models must fail with the WebGPU
// error, the others with the model URL. With EDGE_MODELS_DIR set, the real-model tests
// run against scanall's demo samples (SCANALL_SAMPLES_DIR, default
// ../../../ctsource/scanall/demo/samples) and the defaults, and write the comparison
// to test-results/alt-*.json. Run them one model at a time, e.g.
//   EDGE_MODELS_DIR=… npx vitest run --project browser test/browser/alt-audio-text.test.ts -t "whisper"
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { call, startWorker, toBase64 } from "./harness.js";

declare const __EDGE_MODELS__: string;
declare const __EDGE_WEBGPU__: boolean;
declare const __SCANALL_SAMPLES__: boolean;
const MODELS = Boolean(__EDGE_MODELS__);
const WEBGPU = __EDGE_WEBGPU__;
const SAMPLES = __SCANALL_SAMPLES__;

async function sample(name: string, mime: string) {
    const res = await fetch(`/__samples/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`sample ${name}: ${res.status}`);
    return { bytesBase64: toBase64(new Uint8Array(await res.arrayBuffer())), filename: name, mime };
}
const meeting = () => sample("项目周会录音.m4a", "audio/mp4");
const video = () => sample("产品介绍短片.mp4", "video/mp4");

/** The demo meeting's script (demo/tools/make_media.py): speaker per sentence and text. */
const MEETING: [0 | 1, string][] = [
    [0, "大家好，我们开始本周的智慧仓储二期项目周会。今天主要过三件事：研发进度、扫码识别率，还有上线前的试运行安排。"],
    [1, "好的，我先说研发。出入库主流程上周已经联调完了，入库上架、波次拣选、复核打包三个场景都过了内部测试。"],
    [1, "一共发现二十三个缺陷，已经关闭十九个，剩下四个预计周五之前全部关掉，同时出一份回归测试报告。"],
    [0, "四个遗留缺陷里，有没有影响上线的？"],
    [1, "有一个比较关键，是波次拣选在订单超过五百行的时候会超时。我们已经定位到是数据库索引的问题，改完再压测一次。"],
    [0, "明白。第二件事是扫码识别率。现场测下来是百分之九十九点二，验收要求是百分之九十九点五，还差一点。"],
    [1, "主要是有些纸箱的条码褶皱了，顶部相机拍不清。自动化部建议在分拣口侧面再加一台补光扫码器，预算大概一万八千元。"],
    [0, "这个预算我刚跟周经理确认过，可以从项目预备费里出。请陈思齐那边下周三之前完成选型和下单。"],
    [0, "第三件事，试运行。上线日期还是十二月十五号不变，十二月一号开始试运行，一共两周。"],
    [1, "试运行期间研发会安排两个人驻场，每天下午五点半开十五分钟站会，问题当天记录、当天分派。"],
    [0, "好。另外提醒一下风险：第二批谐波减速器的交期可能要延误一周，供应商答应二十五号之前给确定日期。"],
    [1, "如果真的延误，我们可以先用三号堆垛机临时顶上，不影响上线。"],
    [0, "那今天就到这里。会议纪要我下午发出来，下周一同一时间再碰。谢谢大家。"],
    [1, "谢谢，辛苦了。"],
];
/** The product video's narration (same script). */
const VIDEO_TEXT =
    "这是澄岚示例园区能源管理平台的产品介绍。我们的目标是，让园区里的每一度电都看得见、管得住。" +
    "平台有三大核心能力。第一，全量计量采集，单台网关最多接入二百五十六块表。第二，实时监测和告警。第三，光储充协同，峰段放电，谷段充电。" +
    "在示例产业园试点十二个月，综合用电量下降百分之十一点四，峰段用电占比下降八个百分点，变压器过载告警减少百分之八十七。" +
    "标准实施周期是十周。欢迎联系我们，预约现场勘查。";

/**
 * The same scripts with numbers written as digits (what ITN-capable models print). The
 * reported CER is the lower of the two, so writing 99.2% or 百分之九十九点二 costs nothing.
 */
function itn(s: string): string {
    const table: [string, string][] = [
        ["二十三个", "23个"], ["十九个", "19个"], ["剩下四个", "剩下4个"], ["四个遗留", "4个遗留"], ["五百行", "500行"],
        ["百分之九十九点二", "99.2%"], ["百分之九十九点五", "99.5%"], ["一万八千元", "18000元"], ["十二月十五号", "12月15号"],
        ["十二月一号", "12月1号"], ["五点半", "5点半"], ["十五分钟", "15分钟"], ["二十五号", "25号"], ["三号堆垛机", "3号堆垛机"],
        ["二百五十六块", "256块"], ["十二个月", "12个月"], ["百分之十一点四", "11.4%"], ["八个百分点", "8个百分点"],
        ["百分之八十七", "87%"], ["十周", "10周"],
    ];
    for (const [a, b] of table) s = s.split(a).join(b);
    return s;
}

/** Characters that count for CER: letters, digits and CJK; punctuation and spaces dropped. */
function cerChars(s: string): string[] {
    return [...s.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
}
function levenshtein(a: string[], b: string[]): number {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length]!;
}
function cer(hyp: string, ref: string): number {
    const h = cerChars(hyp);
    const one = (x: string) => {
        const r = cerChars(x);
        return levenshtein(h, r) / r.length;
    };
    return Math.round(Math.min(one(ref), one(itn(ref))) * 1000) / 10;
}
const PUNCT = /[，。、？！：；,.?!:;]/g;

async function record(name: string, data: unknown) {
    await commands.writeFile(`test-results/${name}.json`, JSON.stringify(data, null, 2));
}

describe("alternative audio models without weights", () => {
    it.skipIf(WEBGPU)("Whisper and Cohere Transcribe need WebGPU: clear error", async () => {
        const audio = await fixtureWav();
        for (const model of ["whisper-large-v3-turbo", "cohere-transcribe-03-2026"]) {
            const r = await call("transcribe", { audio }, { model });
            expect(r.out.success, model).toBe(false);
            expect(r.out.error, model).toMatch(/needs WebGPU/);
        }
    });

    it("Zipformer-CTC and Nemotron fail with their model URL when nothing is hosted", async () => {
        const w = startWorker(`/dist/index.js?modelBase=${encodeURIComponent("/no-models-here/")}`);
        const audio = await fixtureWav();
        const z = await call("transcribe", { audio }, { worker: w, model: "zipformer-ctc-small-zh" });
        expect(z.out.error).toContain(`${location.origin}/no-models-here/csukuangfj/sherpa-onnx-zipformer-ctc-small-zh-int8-2025-07-16/`);
        const n = await call("diarizeSpeakers", { audio }, { worker: w, model: "nemotron-3-diarization" });
        expect(n.out.error).toContain(`${location.origin}/no-models-here/onnx-community/Nemotron-3-Diarization-ONNX/onnx/model_q4.onnx`);
        const bad = await call("transcribe", { audio }, { worker: w, model: "moonshine-base-zh" });
        expect(bad.out.error).toMatch(/unknown model "moonshine-base-zh" for transcribe/);
        w.worker.terminate();
    });
});

async function fixtureWav() {
    const res = await fetch("/test/fixtures/audio/hello-zh.wav");
    return { bytesBase64: toBase64(new Uint8Array(await res.arrayBuffer())), filename: "hello-zh.wav", mime: "audio/wav" };
}

/** `warm: false`: one run per input (Qwen3-ASR is slow on the CPU; its time includes loading). */
const ASR_MODELS = [
    { model: "sensevoice-small", webgpu: false, warm: true },
    { model: "zipformer-ctc-small-zh", webgpu: false, warm: true },
    { model: "qwen3-asr-0.6b", webgpu: false, warm: false },
    { model: "whisper-large-v3-turbo", webgpu: true, warm: true },
    { model: "cohere-transcribe-03-2026", webgpu: true, warm: true },
];

describe.skipIf(!MODELS || !SAMPLES)("transcribe alternatives on the demo meeting and video (real models)", () => {
    for (const { model, webgpu, warm } of ASR_MODELS) {
        it.skipIf(webgpu && !WEBGPU)(`transcribe: ${model}`, async () => {
            const w = startWorker("/dist/index.js");
            const meetingRef = MEETING.map(([, t]) => t).join("");
            const out: Record<string, unknown> = { model };
            for (const [label, input, ref, seconds] of [
                ["meeting", await meeting(), meetingRef, 133.1],
                ["video", await video(), VIDEO_TEXT, 50],
            ] as const) {
                const t0 = performance.now();
                const first = await call("transcribe", { audio: input }, { worker: w, model });
                const firstMs = performance.now() - t0;
                expect(first.out.error, `${model} ${label}`).toBeUndefined();
                const t1 = performance.now();
                const again = warm ? await call("transcribe", { audio: input }, { worker: w, model }) : first;
                const warmMs = warm ? performance.now() - t1 : firstMs;
                const text: string = again.out.text;
                expect(text.length).toBeGreaterThan(20);
                out[label] = {
                    text,
                    cer: cer(text, ref),
                    punctuation: (text.match(PUNCT) ?? []).length,
                    firstMs: Math.round(firstMs),
                    warmMs: Math.round(warmMs),
                    rtf: Math.round((warmMs / 1000 / seconds) * 100) / 100,
                    downloadedFiles: [...new Set(first.downloads.map((d) => d.file))],
                };
                console.warn(`[alt-asr] ${model} ${label}: CER ${cer(text, ref)}% warm ${Math.round(warmMs)} ms: ${text.slice(0, 80)}…`);
            }
            await record(`alt-asr-${model}`, out);
            w.worker.terminate();
        }, 3_600_000);
    }
});

/** Speaker of each turn (consecutive same-speaker segments merged). */
function turns(segs: { speaker: number; start: number; end: number }[]): number[] {
    const out: number[] = [];
    for (const s of [...segs].sort((a, b) => a.start - b.start)) if (out[out.length - 1] !== s.speaker) out.push(s.speaker);
    return out;
}

describe.skipIf(!MODELS || !SAMPLES)("diarize-speakers alternatives on the demo meeting (real models)", () => {
    for (const model of ["pyannote-campplus-zh", "nemotron-3-diarization"]) {
        it(`diarize-speakers: ${model}`, async () => {
            const w = startWorker("/dist/index.js");
            const audio = await meeting();
            const t0 = performance.now();
            const first = await call("diarizeSpeakers", { audio }, { worker: w, model });
            const firstMs = performance.now() - t0;
            expect(first.out.error).toBeUndefined();
            const t1 = performance.now();
            const again = await call("diarizeSpeakers", { audio }, { worker: w, model });
            const warmMs = performance.now() - t1;
            const segs = JSON.parse(again.out.segments) as { speaker: number; start: number; end: number }[];
            for (const s of segs) expect(Object.keys(s).sort()).toEqual(["end", "speaker", "start"]);
            const truth = turns(MEETING.map(([spk], i) => ({ speaker: spk, start: i, end: i + 1 })));
            const got = turns(segs);
            const speakers = new Set(segs.map((s) => s.speaker)).size;
            const result = {
                model,
                segments: segs.length,
                speakers,
                turnsFound: got.length,
                turnsTruth: truth.length,
                turnSequenceMatches: JSON.stringify(got) === JSON.stringify(truth),
                firstMs: Math.round(firstMs),
                warmMs: Math.round(warmMs),
                rtf: Math.round((warmMs / 1000 / 133.1) * 100) / 100,
                segs,
            };
            console.warn(`[alt-diar] ${model}: ${speakers} speakers, ${got.length}/${truth.length} turns, match=${result.turnSequenceMatches}, warm ${Math.round(warmMs)} ms`);
            await record(`alt-diar-${model}`, result);
            expect(speakers).toBe(2);
            w.worker.terminate();
        }, 1_800_000);
    }
});

/**
 * Retrieval check for `embed-text` + the host-side `createQueryEmbedder`: the demo
 * documents (parsed and chunked by the plugin) plus the meeting and video scripts, the
 * README's questions (scanned PDF / whiteboard ones left out: they need OCR), and an
 * answer pattern per question. recall@3 = share of questions with a matching chunk in the top 3.
 */
const QUESTIONS: [string, RegExp][] = [
    ["试运行从哪天开始？", /12 月 1 日起|十二月一号开始试运行/],
    ["扫码识别率的问题由谁负责解决？", /自动化部牵头|补光扫码器选型|陈思齐那边/],
    ["专业版最多能接入多少块表？", /10,000/],
    ["试点园区的用电量下降了多少？", /11\.4%|十一点四/],
    ["华北区 10 月为什么没完成目标？", /大客户项目延期/],
    ["西南区的环比增长是多少？", /\+15\.2%/],
    ["这个方案的静态回收期是多久？", /静态回收期/],
    ["换型现在平均要多长时间？", /换型平均耗时/],
    ["扫码识别率现在是多少？", /99\.2%|九十九点二/],
    ["补光扫码器的预算是多少？", /1\.8 万元|一万八千/],
    ["试点之后综合用电量下降了多少？", /11\.4%|十一点四/],
    ["标准实施周期是多久？", /标准实施周期/],
];
const DOCS: [string, string][] = [
    ["项目周例会纪要.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["产品白皮书.pdf", "application/pdf"],
    ["月度销售.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["方案汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
];

function unpackTfv1(b64: string): { dims: number; rows: Float32Array[] } {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const v = new DataView(u8.buffer);
    expect(String.fromCharCode(u8[0]!, u8[1]!, u8[2]!, u8[3]!)).toBe("TFV1");
    const dims = v.getUint32(4, true);
    const count = v.getUint32(8, true);
    const data = new Float32Array(u8.buffer.slice(12, 12 + 4 * count * dims));
    return { dims, rows: Array.from({ length: count }, (_, i) => data.subarray(i * dims, (i + 1) * dims)) };
}

describe.skipIf(!MODELS || !SAMPLES)("embed-text alternatives: recall@3 on the demo samples (real models)", () => {
    for (const model of ["bge-small-zh-v1.5", "harrier-oss-v1-270m", "granite-embedding-97m-multilingual-r2"]) {
        it(`embed-text + createQueryEmbedder: ${model}`, async () => {
            const w = startWorker("/dist/index.js");
            const texts: string[] = [];
            for (const [name, mime] of DOCS) {
                const p = await call("parseDocument", { document: await sample(name, mime) }, { worker: w });
                expect(p.out.error, name).toBeUndefined();
                texts.push(p.out.text);
            }
            texts.push(MEETING.map(([, t]) => t).join(""), VIDEO_TEXT);
            const ch = await call("chunkText", { texts }, { worker: w });
            const chunks: string[] = ch.out.chunks;
            const t0 = performance.now();
            const e = await call("embedText", { texts: chunks }, { worker: w, model });
            const docMs = performance.now() - t0;
            if (e.out.error) console.warn(`[alt-embed] ${model} error: ${e.out.error}`);
            expect(e.out.error).toBeUndefined();
            const tw = performance.now();
            await call("embedText", { texts: chunks }, { worker: w, model });
            const warmDocMs = performance.now() - tw;
            const { dims, rows } = unpackTfv1(e.out.vectors.bytesBase64);
            const mod = (await import(/* @vite-ignore */ `${location.origin}/dist/embed-query.js`)) as typeof import("../../src/embed-query.js");
            const q = mod.createQueryEmbedder({ model });
            expect(q.model.id).toBe(model);
            expect(q.model.dims).toBe(dims);
            let hits = 0;
            let rr = 0;
            const perQuestion: unknown[] = [];
            const t1 = performance.now();
            for (const [question, answer] of QUESTIONS) {
                const qv = await q.embed(question);
                expect(qv.length).toBe(dims);
                const ranked = rows
                    .map((r, i) => ({ i, s: r.reduce((a, x, k) => a + x * qv[k]!, 0) }))
                    .sort((a, b) => b.s - a.s);
                const rank = ranked.findIndex((x) => answer.test(chunks[x.i]!)) + 1;
                if (rank >= 1 && rank <= 3) hits++;
                if (rank >= 1) rr += 1 / rank;
                perQuestion.push({ question, rank });
            }
            const queryMs = (performance.now() - t1) / QUESTIONS.length;
            const result = {
                model,
                dims,
                chunks: chunks.length,
                recallAt3: Math.round((hits / QUESTIONS.length) * 1000) / 1000,
                mrr: Math.round((rr / QUESTIONS.length) * 1000) / 1000,
                firstDocEmbedMs: Math.round(docMs),
                warmDocEmbedMs: Math.round(warmDocMs),
                queryMs: Math.round(queryMs),
                perQuestion,
            };
            console.warn(`[alt-embed] ${model}: recall@3 ${result.recallAt3} MRR ${result.mrr} (${chunks.length} chunks, docs warm ${Math.round(warmDocMs)} ms)`);
            await record(`alt-embed-${model}`, result);
            expect(hits).toBeGreaterThan(QUESTIONS.length / 2);
            w.worker.terminate();
        }, 1_800_000);
    }
});
