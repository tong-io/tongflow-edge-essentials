// MuPDF.js (model `mupdf`) for parse-document and render-pages in the built worker, next to the
// pdf.js default. No model weights: the MuPDF wasm ships in dist/assets/mupdf/.
import { describe, expect, it } from "vitest";
import { call, fixture, fromBase64, imageSize, meanColor, startWorker } from "./harness.js";

describe("MuPDF.js in the plugin worker", () => {
    it("parse-document (mupdf): Markdown headings, paragraphs and a table; the wasm comes from dist/assets/mupdf/", async () => {
        const w = startWorker("/dist/index.js");
        try {
            const mu = await call("parseDocument", { document: await fixture("paper.pdf", "application/pdf") }, { worker: w, model: "mupdf" });
            expect(mu.out.error).toBeUndefined();
            expect(mu.out.text).toMatch(/^# 二〇二六年第三季度经营分析报告/);
            expect(mu.out.text).toContain("\n## 一、总体情况\n");
            expect(mu.out.text).toContain("| 地区 | 销售额（万元） | 同比 | 占比 |");
            expect(mu.out.images).toEqual([]);
            const wasm = mu.downloads.filter((d) => d.file === "MuPDF wasm");
            expect(wasm.at(-1)?.loaded).toBeGreaterThan(5e6);
            // loaded once per worker
            const again = await call("parseDocument", { document: await fixture("report.pdf", "application/pdf") }, { worker: w, model: "mupdf" });
            expect(again.out.text).toMatch(/^# 季度报告 Quarterly Report/);
            expect(again.downloads.filter((d) => d.file === "MuPDF wasm")).toEqual([]);
            // the default is still pdf.js
            const pdfjs = await call("parseDocument", { document: await fixture("paper.pdf", "application/pdf") }, { worker: w });
            expect(pdfjs.out.text).not.toMatch(/^#/);
            expect(pdfjs.out.text).toContain("二〇二六年第三季度经营分析报告");
        } finally {
            w.worker.terminate();
        }
    });

    it("render-pages (mupdf): the same page size as pdf.js, with ink on it", async () => {
        const doc = await fixture("report.pdf", "application/pdf");
        const mu = await call("renderPages", { document: doc }, { model: "mupdf" });
        const pj = await call("renderPages", { document: doc });
        expect(mu.out.error).toBeUndefined();
        expect(mu.out.pages).toHaveLength(pj.out.pages.length);
        const a = fromBase64(mu.out.pages[0].bytesBase64);
        const b = fromBase64(pj.out.pages[0].bytesBase64);
        const sa = await imageSize(a, "image/png");
        const sb = await imageSize(b, "image/png");
        expect(Math.abs(sa.width - sb.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(sa.height - sb.height)).toBeLessThanOrEqual(2);
        const ca = await meanColor(a, "image/png");
        const cb = await meanColor(b, "image/png");
        expect(ca.darkFraction).toBeGreaterThan(0.002);
        expect(Math.abs(ca.darkFraction - cb.darkFraction)).toBeLessThan(0.01);
        expect(mu.out.pages[0].filename).toBe(pj.out.pages[0].filename);
    });

    it("an unknown implementation fails clearly", async () => {
        const r = await call("renderPages", { document: await fixture("report.pdf", "application/pdf") }, { model: "pdfium" });
        expect(r.out).toMatchObject({ success: false, error: expect.stringMatching(/unknown model "pdfium" for render-pages; available: pdfjs, mupdf/) });
    });
});
