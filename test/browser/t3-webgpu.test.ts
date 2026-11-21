// T3 (WebGPU) nodes in the built worker, over the engine protocol.
//
// Default run: headless Chromium has no GPU adapter, so every T3 method must
// fail with the clear WebGPU error. With EDGE_MODELS_DIR set (see README) the
// browser is launched with the WebGPU flags, the directory is served as the
// default model base /models/, and real inference runs for every model whose
// files are present there. No test ever downloads a model from the internet.
import { describe, expect, it } from "vitest";
import { pluginWorker } from "./harness.js";

declare const __EDGE_MODELS__: string;
declare const __EDGE_WEBGPU__: boolean;
/** EDGE_MODELS_DIR is set: its files are served at /models/ (vitest.config.ts). */
const MODELS = Boolean(__EDGE_MODELS__);
/** Chromium was launched with the WebGPU flags. */
const WEBGPU = __EDGE_WEBGPU__;

let seq = 100_000;

interface Run {
    out: any;
    progress: { message: string; percent?: number; t: number }[];
    downloads: { loaded: number; total?: number; file?: string }[];
    ms: number;
}

/** Invoke a method as the engine does, with nodeSlot / model / params, and optional cancel. */
function invoke(
    method: string,
    nodeSlot: string,
    input: Record<string, unknown>,
    opts: { model?: string; params?: Record<string, unknown>; cancelWhen?: (r: Run) => boolean; worker?: { worker: Worker; ready: Promise<unknown> } } = {},
): Promise<Run> {
    const { worker: w, ready } = opts.worker ?? pluginWorker();
    const id = ++seq;
    const run: Run = { out: undefined, progress: [], downloads: [], ms: 0 };
    const t0 = performance.now();
    return ready.then(
        () =>
            new Promise((resolve, reject) => {
                let cancelled = false;
                const onMessage = (e: MessageEvent) => {
                    const m = e.data;
                    if (m.id !== id) return;
                    if (m.type === "progress") run.progress.push({ message: m.message, percent: m.percent, t: performance.now() - t0 });
                    else if (m.type === "model-download") run.downloads.push({ loaded: m.loaded, total: m.total, file: m.file });
                    else {
                        w.removeEventListener("message", onMessage);
                        run.ms = performance.now() - t0;
                        if (m.type === "error") reject(Object.assign(new Error(m.message), { name: m.name, run }));
                        else resolve({ ...run, out: m.output });
                        return;
                    }
                    if (!cancelled && opts.cancelWhen?.(run)) {
                        cancelled = true;
                        w.postMessage({ type: "cancel", id });
                    }
                };
                w.addEventListener("message", onMessage);
                w.postMessage({ type: "invoke", id, method, nodeSlot, input, model: opts.model, params: opts.params ?? {} });
            }),
    );
}

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** A PNG with dark Chinese text on white, drawn here (no fixture file needed). */
async function textImage(lines: string[], width = 900): Promise<{ bytesBase64: string; filename: string; mime: string }> {
    const lineH = 56;
    const c = new OffscreenCanvas(width, 60 + lines.length * lineH);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#c62828";
    g.fillRect(20, 20, 60, 60);
    g.fillStyle = "#111";
    g.font = "40px sans-serif";
    lines.forEach((l, i) => g.fillText(l, 110, 64 + i * lineH));
    const blob = await c.convertToBlob({ type: "image/png" });
    return { bytesBase64: toBase64(new Uint8Array(await blob.arrayBuffer())), filename: "invoice.png", mime: "image/png" };
}

/** A second, fresh plugin worker configured through the entry URL's ?modelBase= query. */
function freshWorker(modelBase: string): { worker: Worker; ready: Promise<unknown> } {
    const worker = new Worker(new URL(`/dist/index.js?modelBase=${encodeURIComponent(modelBase)}`, location.origin), { type: "module" });
    const ready = new Promise((resolve) => {
        const on = (e: MessageEvent) => {
            if (e.data?.type !== "ready") return;
            worker.removeEventListener("message", on);
            resolve(e.data);
        };
        worker.addEventListener("message", on);
    });
    return { worker, ready };
}

/** ms until the first streamed token: model load + prefill. */
function firstTokenMs(r: Run, label: string): number | undefined {
    return r.progress.find((p) => p.message.startsWith(`${label}: `))?.t;
}

async function hasModel(repo: string): Promise<boolean> {
    const r = await fetch(`/models/${repo}/config.json`, { method: "HEAD" });
    return r.ok;
}

const image = () => textImage(["发票号码：20261121", "金额：人民币 1,280.00 元"]);

describe.runIf(!WEBGPU)("T3 nodes without WebGPU (default headless Chromium)", () => {
    it.each([
        ["imageGenText", "image-gen-text", async () => ({ text: "描述这张图", image: await image() })],
        ["imageGenText", "image-describe", async () => ({ image: await image() })],
        ["ocrImageGlm", "ocr-image", async () => ({ image: await image() })],
        ["embedImage", "embed-image", async () => ({ image: await image() })],
        ["genText", "gen-text", async () => ({ text: "合同金额 100 万元，2026 年 3 月 1 日签订。" })],
    ])("%s (%s) fails with a clear WebGPU error", async (method, slot, input) => {
        const r = await invoke(method, slot, await input());
        expect(r.out.success).toBe(false);
        expect(r.out.error).toMatch(/this node needs WebGPU/);
        expect(r.downloads).toEqual([]);
    });
});

describe.runIf(MODELS)("T3 nodes with real models from EDGE_MODELS_DIR (WebGPU)", () => {
    const LONG = 15 * 60_000;
    const timings: Record<string, number> = {};
    const log = (k: string, ms: number) => {
        timings[k] = Math.round(ms);
        console.warn(`[t3] ${k}: ${Math.round(ms)} ms`);
    };

    it("the worker sees a WebGPU adapter", async () => {
        const r = await invoke("genText", "gen-text", { text: "x" }, { model: "no-such-model" });
        // Past the WebGPU gate, the model choice is validated.
        expect(r.out.error).toMatch(/unknown model "no-such-model"; this node supports lfm2\.5-350m/);
    });

    it(
        "gen-text: LFM2.5-350M extracts key points as JSON, streaming tokens; the second run reuses the loaded model",
        async (ctx) => {
            if (!(await hasModel("LiquidAI/LFM2.5-350M-ONNX"))) ctx.skip("LiquidAI/LFM2.5-350M-ONNX is not in EDGE_MODELS_DIR");
            const text =
                "2026 年 11 月 3 日，甲方上海星河贸易有限公司与乙方杭州云杉科技有限公司签订软件服务合同。" +
                "合同总金额为人民币 128 万元，分三期支付：签约后 10 个工作日内支付 30%，系统上线验收后支付 50%，" +
                "质保期满后支付剩余 20%。项目计划于 2027 年 3 月 31 日前完成上线，质保期为 12 个月。" +
                "如乙方延期交付，每延期一日按合同总额的 0.1% 支付违约金。";
            const first = await invoke("genText", "gen-text", { text });
            log("gen-text first run (load + generate)", first.ms);
            log("gen-text first run, until the first token", firstTokenMs(first, "extracting") ?? NaN);
            expect(first.out.error).toBeUndefined();
            expect(first.out.success).toBe(true);
            const parsed = JSON.parse(first.out.text);
            console.warn("[t3] key points:", JSON.stringify(parsed, null, 1));
            expect(Array.isArray(parsed.key_points)).toBe(true);
            expect(parsed.key_points.length).toBeGreaterThan(0);
            expect(parsed.key_points.join("")).toMatch(/128|万元|2027/);
            // downloads reported with byte totals and file labels
            expect(first.downloads.length).toBeGreaterThan(0);
            const last = first.downloads.at(-1)!;
            expect(last.total).toBeGreaterThan(200e6);
            expect(last.loaded).toBe(last.total);
            expect(first.downloads.some((d) => /LFM2\.5-350M · /.test(d.file ?? ""))).toBe(true);
            // streamed tokens
            const streamed = first.progress.filter((p) => /^extracting: \d+ tokens?/.test(p.message));
            expect(streamed.length).toBeGreaterThan(1);
            expect(first.progress.some((p) => /^(downloading|loading) LFM2\.5-350M/.test(p.message))).toBe(true);

            const second = await invoke("genText", "gen-text", { text, userPrompt: "只列出金额和付款比例" });
            log("gen-text second run (model resident)", second.ms);
            log("gen-text second run, until the first token", firstTokenMs(second, "extracting") ?? NaN);
            expect(second.out.success).toBe(true);
            expect(second.downloads).toEqual([]);
            console.warn("[t3] focused key points:", second.out.text);
            const tokens = Number(/(\d+) tokens?/.exec(streamed.at(-1)!.message)?.[1] ?? 0);
            console.warn(`[t3] gen-text first run streamed ${tokens} tokens`);
        },
        LONG,
    );

    it(
        "gen-text: a fresh worker (model base from ?modelBase=) loads LFM2.5-350M from the Cache API",
        async (ctx) => {
            if (!(await hasModel("LiquidAI/LFM2.5-350M-ONNX"))) ctx.skip("LiquidAI/LFM2.5-350M-ONNX is not in EDGE_MODELS_DIR");
            const w = freshWorker("/models/");
            try {
                const r = await invoke("genText", "gen-text", { text: "会议定于 12 月 5 日下午三点在 3 号会议室召开，请各部门负责人准时参加。" }, { worker: w });
                log("gen-text fresh worker, cached model (load + generate)", r.ms);
                log("gen-text fresh worker, until the first token", firstTokenMs(r, "extracting") ?? NaN);
                expect(r.out.success).toBe(true);
                expect(r.progress.some((p) => p.message === "loading LFM2.5-350M from the browser cache")).toBe(true);
                console.warn("[t3] key points:", r.out.text);
            } finally {
                w.worker.terminate();
            }
        },
        LONG,
    );

    it(
        "gen-text: cancelling mid-generation stops the call with an abort",
        async (ctx) => {
            if (!(await hasModel("LiquidAI/LFM2.5-350M-ONNX"))) ctx.skip("LiquidAI/LFM2.5-350M-ONNX is not in EDGE_MODELS_DIR");
            const text = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 条：本季度第 ${i + 1} 个项目的预算为 ${(i + 1) * 13} 万元，负责人为第 ${i + 1} 组。`).join("");
            const t0 = performance.now();
            const err = await invoke("genText", "gen-text", { text }, { cancelWhen: (r) => r.progress.some((p) => /^extracting: \d+ tokens/.test(p.message)) }).then(
                () => undefined,
                (e: Error & { run?: Run }) => e,
            );
            log("gen-text cancel round trip", performance.now() - t0);
            if (!err) console.warn("[t3] cancel: the call finished before the cancel landed");
            expect(err, "the call should have been cancelled").toBeDefined();
            expect(err!.name).toMatch(/AbortError/);
            // the worker stays usable
            const again = await invoke("genText", "gen-text", { text: "会议定于 12 月 5 日下午三点在 3 号会议室召开。" });
            expect(again.out.success).toBe(true);
        },
        LONG,
    );

    it(
        "image-gen-text: Qwen3.5-0.8B describes an image in Chinese",
        async (ctx) => {
            if (!(await hasModel("onnx-community/Qwen3.5-0.8B-ONNX"))) ctx.skip("onnx-community/Qwen3.5-0.8B-ONNX is not in EDGE_MODELS_DIR");
            const r = await invoke("imageGenText", "image-gen-text", { text: "", image: await image(), max_new_tokens: 128 });
            log("image-gen-text (load + generate)", r.ms);
            expect(r.out.error).toBeUndefined();
            console.warn("[t3] description:", r.out.text);
            expect(r.out.text).toMatch(/[一-鿿]/);
            const d = await invoke("imageGenText", "image-describe", { image: await image() }, { params: { max_new_tokens: 96 } });
            expect(d.out.success).toBe(true);
        },
        LONG,
    );

    it(
        "image-describe: Qwen3.5-0.8B on the scanall demo's whiteboard photo and video frame, short and without loops",
        async (ctx) => {
            if (!(await hasModel("onnx-community/Qwen3.5-0.8B-ONNX"))) ctx.skip("onnx-community/Qwen3.5-0.8B-ONNX is not in EDGE_MODELS_DIR");
            // whiteboard.jpg = scanall demo/samples/白板照片.jpg; slide-frame.jpg = 产品介绍短片.mp4 at 11 s.
            for (const [name, about] of [
                ["whiteboard.jpg", /Q4|冲刺|白板|宇航|猫|咖啡/],
                ["slide-frame.jpg", /核心能力/],
            ] as const) {
                const res = await fetch(`/test/fixtures/${name}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const r = await invoke("imageGenText", "image-describe", { image: { bytesBase64: toBase64(bytes), mime: "image/jpeg", filename: name } });
                log(`image-describe ${name}`, r.ms);
                expect(r.out.error).toBeUndefined();
                const text: string = r.out.text;
                console.warn(`[t3] ${name}:`, text);
                expect(text).toMatch(about);
                // The default budget is 192 new tokens; the strict prompt asks for 1-3 sentences.
                expect(text.length).toBeLessThan(400);
                // No clause twice (the post-filter would have cut it).
                const clauses = text.split(/[。！？；，、\n]/).map((c) => c.replace(/[\s\p{P}\p{S}]/gu, "")).filter((c) => c.length >= 4);
                expect(new Set(clauses).size).toBe(clauses.length);
            }
        },
        LONG,
    );

    it(
        "ocr-image (glm-ocr): GLM-OCR reads the text",
        async (ctx) => {
            if (!(await hasModel("onnx-community/GLM-OCR-ONNX"))) ctx.skip("onnx-community/GLM-OCR-ONNX is not in EDGE_MODELS_DIR");
            const r = await invoke("ocrImageGlm", "ocr-image", { image: await image() }, { model: "glm-ocr" });
            log("ocr-image glm (load + generate)", r.ms);
            expect(r.out.error).toBeUndefined();
            console.warn("[t3] ocr:", r.out.text);
            expect(r.out.text).toMatch(/20261121/);
        },
        LONG,
    );

    it(
        "a model that fails to build its session does not break the next model in the same worker",
        async (ctx) => {
            const broken = "onnx-community/embeddinggemma-2-ONNX";
            if (!(await hasModel(broken)) || !(await hasModel("onnx-community/GLM-OCR-ONNX"))) ctx.skip("needs EmbeddingGemma 2 and GLM-OCR in EDGE_MODELS_DIR");
            // Junk responses would otherwise stay in transformers.js' Cache API bucket.
            const forget = async () => {
                const cache = await caches.open("transformers-cache");
                for (const req of await cache.keys()) if (req.url.includes(`/models/${broken}/onnx/`)) await cache.delete(req);
            };
            const w = freshWorker("/models/");
            try {
                await fetch(`/__corrupt-graphs?repo=${encodeURIComponent(broken)}`);
                const bad = await invoke("embedImage", "embed-image", { image: await image() }, { worker: w });
                expect(bad.out.success).toBe(false);
                expect(bad.out.error).toMatch(/could not load EmbeddingGemma 2/);
                await fetch("/__corrupt-graphs?repo=");
                await forget();
                // transformers.js chains session creation; before the bundle patch the rejected
                // link made every later session in this worker fail with the error above.
                const r = await invoke("ocrImageGlm", "ocr-image", { image: await image() }, { model: "glm-ocr", worker: w });
                log("ocr-image glm after a failed load (load + generate)", r.ms);
                expect(r.out.error).toBeUndefined();
                expect(r.out.text).toMatch(/20261121/);
            } finally {
                await fetch("/__corrupt-graphs?repo=");
                await forget();
                w.worker.terminate();
            }
        },
        LONG,
    );

    it(
        "embed-image: EmbeddingGemma 2 returns one normalized 768-d TFV1 vector",
        async (ctx) => {
            if (!(await hasModel("onnx-community/embeddinggemma-2-ONNX"))) ctx.skip("onnx-community/embeddinggemma-2-ONNX is not in EDGE_MODELS_DIR");
            const r = await invoke("embedImage", "embed-image", { image: await image() });
            log("embed-image (load + embed)", r.ms);
            expect(r.out.error).toBeUndefined();
            const bytes = Uint8Array.from(atob(r.out.vectors.bytesBase64), (ch) => ch.charCodeAt(0));
            const v = new DataView(bytes.buffer);
            expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("TFV1");
            expect(v.getUint32(4, true)).toBe(768);
            expect(v.getUint32(8, true)).toBe(1);
            let sq = 0;
            for (let i = 0; i < 768; i++) sq += v.getFloat32(12 + 4 * i, true) ** 2;
            expect(Math.sqrt(sq)).toBeCloseTo(1, 3);
            expect(r.out.vectors.filename).toBe("invoice.tfv1");
        },
        LONG,
    );
});
