import { describe, expect, it } from "vitest";
import { impls } from "../../src/index.js";

const { parseDocument } = impls;
import { fixture, nodeCtx } from "../helpers/node-ctx.js";

async function parse(name: string, mime?: string) {
    const ctx = nodeCtx();
    const out = await parseDocument({ document: await fixture(name, mime) }, ctx);
    return { out, ctx };
}

async function text(name: string, mime?: string) {
    const { out } = await parse(name, mime);
    expect(out.error).toBeUndefined();
    expect(out.success).toBe(true);
    expect(out.images).toEqual([]);
    return out.text ?? "";
}

describe("parse-document", () => {
    it("pdf: text layer via pdf.js (legacy build), with page progress", async () => {
        const { out, ctx } = await parse("report.pdf");
        expect(out.success).toBe(true);
        expect(out.text).toContain("季度报告");
        expect(out.text).toContain("华东区销售额增长百分之十二");
        expect(ctx.rec.progress.some((p) => p.message === "page 1/1")).toBe(true);
    });

    it("pdf without a text layer: success with empty text (OCR is the host's call)", async () => {
        const t = await text("no-text-layer.pdf");
        expect(t).toBe("");
    });

    it("docx: mammoth → markdown with headings, list and table", async () => {
        const t = await text("report.docx");
        expect(t).toMatch(/^# 季度报告 Quarterly Report/m);
        expect(t).toMatch(/^## 主要结论/m);
        expect(t).toMatch(/^[-*] +华东区销售额增长百分之十二/m);
        expect(t).toMatch(/\|\s*华东\s*\|\s*1200\s*\|/);
    });

    it("xlsx / xls / ods: one heading and table per sheet", async () => {
        for (const f of ["sales.xlsx", "sales.xls", "sales.ods"]) {
            const t = await text(f);
            expect(t, f).toContain("## 销售");
            expect(t, f).toMatch(/\| 产品 \| 数量 \| 单价 \|/);
            expect(t, f).toMatch(/\| 苹果 \| 12 \| 3\.5 \|/);
            expect(t, f).toContain("## Notes");
            expect(t, f).toContain("a\\|b"); // pipes escaped inside cells
        }
    });

    it("csv: PapaParse, quoted delimiters, UTF-8 and GBK", async () => {
        for (const f of ["cities.csv", "cities-gbk.csv"]) {
            const t = await text(f);
            expect(t, f).toContain("| 城市 | 人口（万） | 备注 |");
            expect(t, f).toContain("| 上海 | 2487 | 直辖市, 东部 |");
        }
    });

    it("pptx: slides, table and speaker notes", async () => {
        const t = await text("launch.pptx");
        expect(t).toContain("## Slide 1");
        expect(t).toContain("产品发布会");
        expect(t).toContain("第二行：欢迎各位来宾");
        expect(t).toContain("> Notes: 演讲者备注：先介绍团队");
        expect(t).toContain("## Slide 2");
        expect(t).toMatch(/\| 型号 \| 价格 \|/);
        expect(t.indexOf("产品发布会")).toBeLessThan(t.indexOf("第二行"));
    });

    it("eml: headers, plain body, attachment list", async () => {
        const t = await text("meeting.eml");
        expect(t).toMatch(/^# 会议纪要：项目启动/);
        expect(t).toContain("- From: 张三 <zhangsan@example.com>");
        expect(t).toContain("- To: Li Si <lisi@example.com>");
        expect(t).toContain("- Cc: wangwu@example.com");
        expect(t).toContain("项目于下周一正式启动");
        expect(t).toContain("## Attachments");
        expect(t).toContain("- agenda.txt (text/plain");
    });

    it("msg: Outlook message with CJK text (msgreader)", async () => {
        const t = await text("hello-cjk.msg");
        expect(t.startsWith("# ")).toBe(true);
        expect(t).toMatch(/[぀-ヿ一-鿿]/);
    });

    it("html: main content, navigation and footer dropped", async () => {
        const t = await text("article.html");
        expect(t).toContain("城市更新的十年");
        expect(t).toContain("老旧小区加装电梯");
        expect(t).toMatch(/^## 典型案例/m);
        expect(t).not.toContain("关于我们");
    });

    it("markdown and plain text pass through", async () => {
        expect(await text("notes.md")).toBe("# 读书笔记\n\n- 第一章：问题的提出\n- 第二章：方法\n\n> 引用：知行合一。");
        expect(await text("plain.txt", "text/plain")).toBe("这是一个纯文本文件。\nSecond line.");
    });

    it("epub: title and chapters in spine order (zip.js + linkedom)", async () => {
        const t = await text("book.epub");
        expect(t).toMatch(/^# 山海小记/);
        expect(t).toContain("第一章 出发");
        expect(t).toContain("清晨，我们从山脚出发");
        expect(t.indexOf("第一章")).toBeLessThan(t.indexOf("第二章"));
    });

    it("legacy formats via xberg-wasm: doc, ppt, rtf, odt", async () => {
        const ctx = nodeCtx();
        for (const f of ["report.doc", "report.rtf", "report.odt"]) {
            const out = await parseDocument({ document: await fixture(f) }, ctx);
            expect(out.error, f).toBeUndefined();
            expect(out.text, f).toContain("华东区销售额增长百分之十二");
        }
        const ppt = await parseDocument({ document: await fixture("launch.ppt") }, ctx);
        expect(ppt.error).toBeUndefined();
        expect(ppt.text).toContain("产品发布会");
        // The wasm is fetched once, with download progress.
        const xb = ctx.rec.downloads.filter((d) => d.label === "xberg-wasm");
        expect(xb.length).toBeGreaterThan(0);
        expect(xb.at(-1)!.loaded).toBeGreaterThan(10_000_000);
    });

    it("dispatches by content when the name and MIME say nothing", async () => {
        const f = await fixture("report.docx");
        const out = await parseDocument({ document: { bytesBase64: f.bytesBase64 } }, nodeCtx());
        expect(out.text).toContain("季度报告");
        const p = await fixture("report.pdf");
        const outPdf = await parseDocument(
            { document: { bytesBase64: p.bytesBase64, mime: "application/octet-stream", filename: "blob" } },
            nodeCtx(),
        );
        expect(outPdf.text).toContain("季度报告");
    });

    it("unknown, archive and image inputs fail with a clear error", async () => {
        const bin = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 0, 0, 0, 7]).toString("base64");
        const unknown = await parseDocument({ document: { bytesBase64: bin, filename: "data.bin", mime: "application/x-foo" } }, nodeCtx());
        expect(unknown).toEqual({ success: false, error: "unsupported document format (application/x-foo, .bin)" });
        const zip = await parseDocument({ document: { bytesBase64: "UEsDBAo=", filename: "a.zip" } }, nodeCtx());
        expect(zip.success).toBe(false);
        expect(zip.error).toMatch(/archives/);
        const png = await parseDocument({ document: { bytesBase64: "iVBORw0KGgo=", filename: "a.png" } }, nodeCtx());
        expect(png.error).toMatch(/ocr-image/);
    });

    it("a corrupt file fails without throwing", async () => {
        const out = await parseDocument({ document: { bytesBase64: Buffer.from("not really a docx").toString("base64"), filename: "x.docx" } }, nodeCtx());
        expect(out.success).toBe(false);
        expect(out.error).toBeTruthy();
    });

    it("an aborted run rejects instead of reporting a failure", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(parseDocument({ document: await fixture("report.pdf") }, nodeCtx(ac.signal))).rejects.toBeTruthy();
    });
});
