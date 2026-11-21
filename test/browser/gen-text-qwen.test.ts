// gen-text with Qwen3.5-0.8B text-only (`qwen3.5-0.8b-text`) next to the LFM2.5-350M default,
// in the built worker over the engine protocol. Real models only: runs when EDGE_MODELS_DIR
// holds the repos (served at /models/, see vitest.config.ts) and Chromium has WebGPU.
import { describe, expect, it } from "vitest";
import { pluginWorker } from "./harness.js";

declare const __EDGE_MODELS__: string;
const MODELS = Boolean(__EDGE_MODELS__);
if (!MODELS) console.warn("[gen-text-qwen] EDGE_MODELS_DIR is not set: skipping the real-model gen-text comparison");

let seq = 300_000;

interface Run {
    out: any;
    progress: { message: string; t: number }[];
    downloads: { loaded: number; total?: number; file?: string }[];
    ms: number;
}

function invoke(input: Record<string, unknown>, model?: string, params: Record<string, unknown> = {}): Promise<Run> {
    const { worker: w, ready } = pluginWorker();
    const id = ++seq;
    const run: Run = { out: undefined, progress: [], downloads: [], ms: 0 };
    const t0 = performance.now();
    return ready.then(
        () =>
            new Promise((resolve, reject) => {
                const onMessage = (e: MessageEvent) => {
                    const m = e.data;
                    if (m.id !== id) return;
                    if (m.type === "progress") run.progress.push({ message: m.message, t: performance.now() - t0 });
                    else if (m.type === "model-download") run.downloads.push({ loaded: m.loaded, total: m.total, file: m.file });
                    else {
                        w.removeEventListener("message", onMessage);
                        run.ms = performance.now() - t0;
                        if (m.type === "error") reject(new Error(m.message));
                        else resolve({ ...run, out: m.output });
                    }
                };
                w.addEventListener("message", onMessage);
                w.postMessage({ type: "invoke", id, method: "genText", nodeSlot: "gen-text", input, model, params });
            }),
    );
}

async function hasModel(repo: string): Promise<boolean> {
    return (await fetch(`/models/${repo}/config.json`, { method: "HEAD" })).ok;
}

const CONTRACT =
    "2026 年 11 月 3 日，甲方上海星河贸易有限公司与乙方杭州云杉科技有限公司签订软件服务合同。" +
    "合同总金额为人民币 128 万元，分三期支付：签约后 10 个工作日内支付 30%，系统上线验收后支付 50%，" +
    "质保期满后支付剩余 20%。项目计划于 2027 年 3 月 31 日前完成上线，质保期为 12 个月。" +
    "如乙方延期交付，每延期一日按合同总额的 0.1% 支付违约金。";

/** The scanall demo meeting (demo/samples/项目周会录音.m4a): its script, numbers in digits as SenseVoice writes them. */
const MEETING =
    "大家好，我们开始本周的智慧仓储二期项目周会。今天主要过三件事，研发进度、扫码识别率，还有上线前的试运行安排。" +
    "好的，我先说研发。出入库主流程上周已经联调完了，入库上架、波次拣选、复核打包三个场景都过了内部测试。" +
    "一共发现23个缺陷，已经关闭19个，剩下4个，预计周五之前全部关掉，同时出一份回归测试报告。" +
    "四个遗留缺陷里有没有影响上线的？有一个比较关键，是波次拣选在订单超过500行的时候会超时。我们已经定位到是数据库索引的问题，改完再压测一次。" +
    "明白，第二件事是扫码识别率，现场测下来是99.2%，验收要求是99.5%，还差一点。" +
    "主要是有些纸箱的条码褶皱了，顶部相机拍不清。自动化部建议在分拣口侧面再加一台补光扫码器，预算大概18000元。" +
    "这个预算我刚跟周经理确认过，可以从项目预备费里出，请陈思齐那边下周三之前完成选型和下单。" +
    "第三件事，试运行。上线日期还是12月15号不变，12月1号开始试运行，一共两周。" +
    "试运行期间研发会安排两个人驻场，每天下午5点半开15分钟站会，问题当天记录、当天分派。" +
    "好，另外提醒一下风险，第二批谐波减速器的交期可能要延误一周，供应商答应25号之前给确定日期。" +
    "如果真的延误，我们可以先用3号堆垛机临时顶上，不影响上线。那今天就到这里，会议纪要我下午发出来，下周一同一时间再碰。谢谢大家。谢谢，辛苦了。";

/** Numbers in the key points that do not occur in the source (an invented figure). */
function inventedNumbers(points: string[], source: string): string[] {
    const src = source.replace(/\s/g, "");
    return points.flatMap((p) => p.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !src.includes(n));
}

describe.runIf(MODELS)("gen-text: Qwen3.5-0.8B text next to LFM2.5-350M (WebGPU, real models)", () => {
    const LONG = 20 * 60_000;
    const rows: string[] = [];

    for (const [label, text] of [
        ["contract", CONTRACT],
        ["meeting", MEETING],
    ] as const) {
        it(
            `${label}: both models return {"key_points": [...]} without invented numbers`,
            async (ctx) => {
                const models = [
                    ["lfm2.5-350m", "LiquidAI/LFM2.5-350M-ONNX"],
                    ["qwen3.5-0.8b-text", "onnx-community/Qwen3.5-0.8B-Text-ONNX"],
                ] as const;
                let ran = 0;
                for (const [id, repo] of models) {
                    if (!(await hasModel(repo))) {
                        console.warn(`[gen-text-qwen] ${repo} is not in EDGE_MODELS_DIR: skipping ${id}`);
                        continue;
                    }
                    ran++;
                    const first = await invoke({ text }, id);
                    expect(first.out.error, `${id}: ${first.out.error}`).toBeUndefined();
                    const again = await invoke({ text }, id);
                    const points: string[] = JSON.parse(first.out.text).key_points;
                    const firstToken = first.progress.find((p) => /^extracting: /.test(p.message))?.t ?? NaN;
                    const tokens = Number(/(\d+) tokens?/.exec(first.progress.filter((p) => /^extracting: \d+ tokens?/.test(p.message)).at(-1)?.message ?? "")?.[1] ?? 0);
                    const row = `${label} ${id}: first run ${Math.round(first.ms)} ms (first token at ${Math.round(firstToken)} ms), resident ${Math.round(again.ms)} ms, ${tokens} tokens, ${points.length} key points`;
                    rows.push(row);
                    console.warn(`[gen-text-qwen] ${row}\n${JSON.stringify(points, null, 1)}`);
                    expect(points.length).toBeGreaterThan(0);
                    expect(inventedNumbers(points, text), `${id} invented numbers`).toEqual([]);
                    expect(again.out.text).toBe(first.out.text); // greedy: deterministic
                    if (id === "qwen3.5-0.8b-text" && first.downloads.length) {
                        // the text-only export: one ~469 MB external-data file, verified while it streams
                        expect(first.downloads.some((d) => (d.total ?? 0) > 400e6)).toBe(true);
                    }
                }
                if (!ran) ctx.skip("neither gen-text model is in EDGE_MODELS_DIR");
            },
            LONG,
        );
    }

    it("summary", () => {
        console.warn(`[gen-text-qwen] summary\n${rows.join("\n")}`);
    });
});
