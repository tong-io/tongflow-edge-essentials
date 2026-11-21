// Qwen3.5 image description: repetition control and the repeated-sentence post-filter.
import { describe, expect, it } from "vitest";
import { DESCRIBE_PROMPT_ZH, SYSTEM_ZH } from "../../src/ml/prompts.js";
import { applyRepeatControl, cleanDescription, generatedRepeatProcessor, trimRepetition } from "../../src/ml/repeat.js";
import { QWEN_MAX_NEW_TOKENS, QWEN_NO_REPEAT_NGRAM, QWEN_REPETITION_PENALTY } from "../../src/slots/image-gen-text.js";

describe("trimRepetition", () => {
    it("cuts the demo's loop on a contract page at the first repeated clause", () => {
        const loop = "这是一份采购合同的扫描页，背景为纯白色，内容清晰，" + "背景为纯白色，内容清晰，".repeat(40);
        expect(trimRepetition(loop, true)).toBe("这是一份采购合同的扫描页，背景为纯白色，内容清晰。");
    });

    it("cuts a repeated sentence and everything after it", () => {
        const t = "白板上写着「Q4 冲刺目标」。右上角贴着一张宇航员的照片。白板上写着「Q4 冲刺目标」。下方有一杯咖啡。";
        expect(trimRepetition(t)).toBe("白板上写着「Q4 冲刺目标」。右上角贴着一张宇航员的照片。");
    });

    it("keeps one copy of a run repeated without punctuation", () => {
        expect(trimRepetition("画面是一张幻灯片内容清晰内容清晰内容清晰内容清晰")).toBe("画面是一张幻灯片内容清晰。");
    });

    it("leaves text without repetition alone, including short repeated clauses and table rules", () => {
        const ok = "幻灯片标题是「三大核心能力」，下面列出三条要点：①全量计量采集，②实时监测告警，③光储充协同。右下角写着「演示素材 · 内容虚构」。";
        expect(trimRepetition(ok)).toBe(ok);
        expect(trimRepetition("红色，蓝色，红色，绿色。")).toBe("红色，蓝色，红色，绿色。");
        const table = "| 地区 | 销售额 |\n|---|---|---|---|\n| 华东 | 1200 |";
        expect(trimRepetition(table)).toBe(table);
    });

    it("drops an unfinished last sentence when generation hit the token limit", () => {
        expect(trimRepetition("图中是一只猫。猫的眼睛是绿色的，正看向", true)).toBe("图中是一只猫。");
        expect(trimRepetition("图中是一只猫。猫的眼睛是绿色的，正看向", false)).toBe("图中是一只猫。猫的眼睛是绿色的，正看向");
        // Nothing finished to fall back to: keep what there is.
        expect(trimRepetition("图中是一只猫，正看向", true)).toBe("图中是一只猫，正看向");
    });
});

describe("cleanDescription", () => {
    it("drops a trailing 「无法辨认」 filler line after a description, keeps it when it is the answer", () => {
        expect(cleanDescription("图片展示了Q4冲刺目标。\n无法辨认。")).toBe("图片展示了Q4冲刺目标。");
        expect(cleanDescription("图片展示了Q4冲刺目标。\n无法辨认\n无法辨认")).toBe("图片展示了Q4冲刺目标。");
        expect(cleanDescription("无法辨认。")).toBe("无法辨认。");
        expect(cleanDescription("左下角的小字无法辨认。")).toBe("左下角的小字无法辨认。");
    });
});

describe("applyRepeatControl (generated tokens only)", () => {
    it("penalizes tokens already generated, both signs", () => {
        const logits = Float32Array.from([2, -2, 2, -2, 5]);
        applyRepeatControl([0n, 1n], logits, { penalty: 2, ngram: 0 });
        expect(Array.from(logits)).toEqual([1, -4, 2, -2, 5]);
    });

    it("bans the token that would complete an n-gram seen before", () => {
        // generated: 7 8 9 7 8 → with 3-grams, after "7 8" the token 9 is banned
        const logits = new Float32Array(10).fill(1);
        applyRepeatControl([7, 8, 9, 7, 8], logits, { penalty: 1, ngram: 3 });
        expect(logits[9]).toBe(-Infinity);
        expect([...logits].filter((v) => v === -Infinity)).toHaveLength(1);
        const none = new Float32Array(10).fill(1);
        applyRepeatControl([7, 8], none, { penalty: 1, ngram: 3 });
        expect([...none].every((v) => v === 1)).toBe(true);
    });

    it("the processor skips the prompt: a word from the instruction is not penalized", () => {
        class LogitsProcessor {
            _call(_ids: bigint[][], _logits: unknown): unknown {
                return _logits;
            }
        }
        const proc = generatedRepeatProcessor({ LogitsProcessor }, 3, { penalty: 2, ngram: 0 }) as LogitsProcessor;
        const row = { data: Float32Array.from([4, 4, 4, 4, 4]) };
        // prompt = ids 0 1 2, generated so far = 3
        proc._call([[0n, 1n, 2n, 3n]], [row]);
        expect(Array.from(row.data)).toEqual([4, 4, 4, 2, 4]);
    });
});

describe("Qwen defaults", () => {
    it("short answers, a mild penalty, a strict prompt", () => {
        expect(QWEN_MAX_NEW_TOKENS).toBeGreaterThanOrEqual(160);
        expect(QWEN_MAX_NEW_TOKENS).toBeLessThanOrEqual(200);
        expect(QWEN_REPETITION_PENALTY).toBeGreaterThanOrEqual(1.1);
        expect(QWEN_REPETITION_PENALTY).toBeLessThanOrEqual(1.15);
        expect(QWEN_NO_REPEAT_NGRAM).toBeGreaterThan(0);
        expect(DESCRIBE_PROMPT_ZH).toMatch(/1 到 3 句/);
        expect(DESCRIBE_PROMPT_ZH).toMatch(/无法辨认/);
        expect(DESCRIBE_PROMPT_ZH).toMatch(/不要编造/);
        expect(SYSTEM_ZH).toMatch(/无法辨认/);
    });
});
