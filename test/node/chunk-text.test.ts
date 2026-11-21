import { describe, expect, it } from "vitest";
import { chunkText, hardCut, splitSentences } from "../../src/kb/chunk.js";
import { impls } from "../../src/index.js";
import { nodeCtx } from "../helpers/node-ctx.js";

const zhSentence = (i: number) => `这是第${i}句话，用来测试中文切块是否按照句子边界进行切分。`;
const zhPara = (from: number, n: number) => Array.from({ length: n }, (_, k) => zhSentence(from + k)).join("");

describe("splitSentences", () => {
    it("splits after Chinese and English terminators and keeps closers and whitespace", () => {
        expect(splitSentences("你好。真的吗？“是的！”好；Then. Next one! ok")).toEqual([
            "你好。",
            "真的吗？",
            "“是的！”",
            "好；",
            "Then. ",
            "Next one! ",
            "ok",
        ]);
    });
    it("does not split decimals or abbreviations without a following space", () => {
        expect(splitSentences("版本 3.5 发布了。")).toEqual(["版本 3.5 发布了。"]);
    });
    it("treats line breaks as boundaries and round-trips the text", () => {
        const s = "第一行\n第二行。第三句……第四句";
        expect(splitSentences(s)).toEqual(["第一行\n", "第二行。", "第三句……", "第四句"]);
        expect(splitSentences(s).join("")).toBe(s);
    });
});

describe("hardCut", () => {
    it("cuts at max, preferring a comma near the end", () => {
        const s = "甲".repeat(80) + "，" + "乙".repeat(60);
        const parts = hardCut(s, 100);
        expect(parts[0]).toBe("甲".repeat(80) + "，");
        expect(parts.join("")).toBe(s);
        expect(parts.every((p) => p.length <= 100)).toBe(true);
    });
    it("never splits a surrogate pair", () => {
        const s = "😀".repeat(60); // 120 code units
        const parts = hardCut(s, 51);
        expect(parts.join("")).toBe(s);
        for (const p of parts) expect(p).toMatch(/^(?:😀)+$/u);
    });
});

describe("chunkText", () => {
    it("short text → one chunk; empty input → none", () => {
        expect(chunkText(["  你好，世界。  "])).toEqual(["你好，世界。"]);
        expect(chunkText(["", "   ", "\n\n"])).toEqual([]);
        expect(chunkText([])).toEqual([]);
    });

    it("joins the collected parts and packs paragraphs up to max_chars", () => {
        const chunks = chunkText(["第一段。", "第二段。"], { maxChars: 100 });
        expect(chunks).toEqual(["第一段。\n\n第二段。"]);
    });

    it("splits long prose at sentence ends, ≤ max_chars, with ≈ overlap between chunks", () => {
        const text = zhPara(1, 40); // ≈ 1100 chars, one paragraph
        const chunks = chunkText([text]);
        expect(chunks.length).toBeGreaterThanOrEqual(3);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(500);
            expect(c.endsWith("。")).toBe(true); // cut at a sentence end, not mid-sentence
        }
        // Each chunk after the first starts with the last whole sentence(s) of the previous one, ≤ 80 chars.
        for (let i = 1; i < chunks.length; i++) {
            const prev = chunks[i - 1]!;
            let k = 0;
            for (let n = 1; n <= Math.min(prev.length, chunks[i]!.length); n++) if (chunks[i]!.startsWith(prev.slice(-n))) k = n;
            expect(k).toBeGreaterThan(0);
            expect(k).toBeLessThanOrEqual(80);
            expect(prev.slice(-k).startsWith("这是第")).toBe(true); // a sentence start
        }
        // Nothing is lost: every sentence appears in some chunk.
        for (let i = 1; i <= 40; i++) expect(chunks.some((c) => c.includes(zhSentence(i)))).toBe(true);
    });

    it("hard-cuts a run without punctuation", () => {
        const chunks = chunkText(["字".repeat(1200)], { maxChars: 500 });
        expect(chunks.every((c) => c.length <= 500)).toBe(true);
        expect(chunks.join("").replace(/\s/g, "").length).toBeGreaterThanOrEqual(1200);
    });

    it("keeps a Markdown table that fits whole, moving it to the next chunk instead of splitting", () => {
        const table = ["| 地区 | 销量 |", "| --- | --- |", ...Array.from({ length: 10 }, (_, i) => `| 华东${i} | ${1000 + i} |`)].join("\n");
        const before = zhPara(1, 12); // ≈ 330 chars
        const chunks = chunkText([before, table, "表后的说明文字。"], { maxChars: 500 });
        const withTable = chunks.filter((c) => c.includes("| 地区 | 销量 |"));
        expect(withTable).toHaveLength(1);
        expect(withTable[0]).toContain(table); // intact
        expect(chunks.some((c) => c.includes("| 华东9 | 1009 |") && !c.includes("| 地区 |"))).toBe(false);
    });

    it("splits a table longer than max_chars between rows and repeats the header", () => {
        const header = "| 地区 | 产品 | 销量 |\n| --- | --- | --- |";
        const rows = Array.from({ length: 60 }, (_, i) => `| 华东区域${i} | 卷烟产品${i} | ${1000 + i} |`);
        const chunks = chunkText([[header, ...rows].join("\n")], { maxChars: 400 });
        expect(chunks.length).toBeGreaterThan(2);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(400);
            expect(c.startsWith(header)).toBe(true);
        }
        for (const r of rows) expect(chunks.filter((c) => c.includes(r))).toHaveLength(1); // no row split or duplicated
    });

    it("moves a trailing heading to the chunk with its content and adds no overlap into a new section", () => {
        const chunks = chunkText([zhPara(1, 16), "## 第二章", zhPara(100, 4)], { maxChars: 500 });
        const idx = chunks.findIndex((c) => c.includes("## 第二章"));
        expect(chunks[idx]!.startsWith("## 第二章")).toBe(true);
        expect(chunks[idx]).toContain(zhSentence(100));
        expect(chunks[idx - 1]!.endsWith("## 第二章")).toBe(false);
    });

    it("keeps a space between English sentences that straddle the overlap", () => {
        const en = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} of the test.`).join(" ");
        const chunks = chunkText([en], { maxChars: 200 });
        expect(chunks.length).toBeGreaterThan(3);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(200);
            expect(c).not.toMatch(/\.[A-Z]/);
        }
    });

    it("clamps max_chars and keeps the overlap below half a chunk", () => {
        const chunks = chunkText([zhPara(1, 10)], { maxChars: 10 });
        expect(chunks.every((c) => c.length <= 50)).toBe(true);
    });
});

describe("chunk-text slot", () => {
    it("chunks collected texts with the default size", async () => {
        const out = await impls.chunkText({ texts: ["# 标题", zhPara(1, 30)] }, nodeCtx());
        expect(out.success).toBe(true);
        expect(out.chunks!.length).toBeGreaterThan(1);
        expect(out.chunks![0]!.startsWith("# 标题")).toBe(true);
    });
    it("honours max_chars", async () => {
        const out = await impls.chunkText({ texts: [zhPara(1, 30)], max_chars: 200 }, nodeCtx());
        expect(out.chunks!.every((c) => c.length <= 200)).toBe(true);
    });
    it("fails on no text and on a bad max_chars", async () => {
        expect(await impls.chunkText({ texts: ["  "] }, nodeCtx())).toEqual({
            success: false,
            error: "no text to chunk (all inputs are empty)",
        });
        const bad = await impls.chunkText({ texts: ["你好"], max_chars: -3 }, nodeCtx());
        expect(bad).toEqual({ success: false, error: "max_chars must be a positive integer" });
    });
});
