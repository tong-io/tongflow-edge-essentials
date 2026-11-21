// Pure logic of the T1 vision/document slots (no models, no browser).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Box, columnOrder, convexHull, groupLines, joinPieces, minAreaRect, rectCorners } from "../../src/vision/geometry.js";
import { DOCLAYOUT_LABELS, REGION_STEM_MAX_BYTES, layoutRegions, regionFilename, regionLabelOf } from "../../src/vision/layout-post.js";
import { tableRecognize } from "../../src/slots/vision.js";
import { nodeCtx } from "../helpers/node-ctx.js";
import { cropSize, ctcDecode, ctcDictionary, dbPostprocess, detResize, yamlList } from "../../src/vision/ocr-post.js";
import { ocrModel, ocrText } from "../../src/vision/ocr.js";
import { boundariesFromScenes, diffBoundaries, predictionsToScenes, stitch, transnetThreshold, windowIndices } from "../../src/vision/shots.js";
import { decodeTable, matchCells, tableDictionary, tableHtml } from "../../src/vision/table-post.js";
import { MANIFEST_MODELS } from "../../src/vision/catalog.js";
import { dedupeObjects } from "../../src/vision/detect-objects.js";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tongflow.plugin.json", root), "utf8")) as {
    slots: { nodeSlot: string; method: string; models?: string[] }[];
};
const models = JSON.parse(readFileSync(new URL("models.json", root), "utf8")) as {
    id: string;
    source: string;
    files: string[];
    checksums?: Record<string, { size: number; sha256: string }>;
    license: string;
    licenseUrl?: string;
    slots?: string[];
}[];

const B = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

describe("geometry", () => {
    it("convex hull and minimum-area rectangle of a rotated rectangle", () => {
        const pts: [number, number][] = [];
        const a = Math.PI / 6;
        for (let u = 0; u <= 40; u += 2) for (let v = 0; v <= 10; v += 2) {
            pts.push([100 + u * Math.cos(a) - v * Math.sin(a), 50 + u * Math.sin(a) + v * Math.cos(a)]);
        }
        // Only the outline survives (float noise may keep a few nearly collinear points).
        expect(convexHull(pts).length).toBeLessThan(pts.length / 3);
        expect(convexHull([[0, 0], [5, 0], [10, 0], [10, 4], [0, 4], [5, 2]])).toHaveLength(4);
        const r = minAreaRect(pts);
        expect(Math.max(r.w, r.h)).toBeCloseTo(40, 5);
        expect(Math.min(r.w, r.h)).toBeCloseTo(10, 5);
        const q = rectCorners(r);
        // tl has the smallest x of the two leftmost corners' upper one; corners are consistent.
        expect(q[0][0]).toBeLessThan(q[1][0]);
        expect(q[3][1]).toBeGreaterThan(q[0][1]);
    });

    it("groups boxes into lines, left to right", () => {
        const boxes = [B(200, 10, 300, 30), B(10, 12, 150, 32), B(10, 50, 120, 70), B(130, 52, 260, 71)];
        expect(groupLines(boxes)).toEqual([[1, 0], [2, 3]]);
    });

    it("joins CJK without spaces and Latin with spaces", () => {
        expect(joinPieces(["合计金额", "人民币", "3,280.50", "元"])).toBe("合计金额人民币3,280.50元");
        expect(joinPieces(["The quick", "brown fox"])).toBe("The quick brown fox");
    });

    it("column order: title, then the left column, then the right, footer last", () => {
        // A two-column page whose paragraph gaps line up across the columns (y 400–420).
        const boxes = [
            B(100, 50, 1100, 100), // 0 title (wide)
            B(100, 150, 590, 400), // 1 left top
            B(610, 150, 1100, 400), // 2 right top
            B(100, 420, 590, 800), // 3 left bottom
            B(610, 420, 1100, 800), // 4 right bottom
            B(580, 1600, 620, 1620), // 5 page number
        ];
        const last = [false, false, false, false, false, true];
        expect(columnOrder(boxes, [], last)).toEqual([0, 1, 3, 2, 4, 5]);
    });
});

describe("PP-OCR post-processing", () => {
    it("det resize keeps multiples of 32 and caps the long side", () => {
        expect(detResize(900, 360)).toEqual({ width: 896, height: 352 });
        const big = detResize(4000, 3000, 2048);
        expect(big.width).toBe(2048);
        expect(big.height % 32).toBe(0);
        expect(detResize(20, 10).height).toBeGreaterThanOrEqual(64);
    });

    it("DB post-processing finds two text regions and expands them", () => {
        const w = 200, h = 100;
        const pred = new Float32Array(w * h);
        const fill = (x0: number, y0: number, x1: number, y1: number) => {
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pred[y * w + x] = 0.9;
        };
        fill(20, 20, 120, 30);
        fill(30, 60, 180, 75);
        pred[5 * w + 5] = 0.9; // a speck: too small
        const boxes = dbPostprocess(pred, w, h, 400, 200);
        expect(boxes).toHaveLength(2);
        const sorted = boxes.sort((a, b) => a.quad[0][1] - b.quad[0][1]);
        const [first] = sorted;
        // Scaled ×2 to the source and grown by the unclip distance (area·1.4/perimeter ≈ 6.4 px).
        expect(first!.quad[0][0]).toBeLessThan(40);
        expect(first!.quad[1][0]).toBeGreaterThan(240);
        expect(first!.score).toBeGreaterThan(0.85);
        const size = cropSize(first!.quad);
        expect(size.w).toBeGreaterThan(size.h * 4);
    });

    it("CTC decode collapses repeats and drops blanks", () => {
        const dict = ctcDictionary(["a", "b", "中"]); // 0 blank, 1 a, 2 b, 3 中, 4 space
        const T = 6, C = dict.length;
        const seq = [1, 1, 0, 1, 3, 4];
        const probs = new Float32Array(T * C);
        seq.forEach((c, t) => (probs[t * C + c] = 0.9));
        expect(ctcDecode(probs, 0, T, C, dict)).toEqual({ text: "aa中 ", score: expect.closeTo(0.9, 5) });
    });

    it("reads character_dict / label_list blocks from inference.yml", () => {
        const yml = "PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - '!'\n  - ''''\n  - $\n  - 中\n  - ' colspan=\"2\"'\nPreProcess: {}\nlabel_list:\n- text\n- table\n";
        expect(yamlList(yml, "character_dict")).toEqual(["!", "'", "$", "中", ' colspan="2"']);
        expect(yamlList(yml, "label_list")).toEqual(["text", "table"]);
    });

    it("ocrText prints lines in reading order", () => {
        const item = (text: string, b: Box) => ({ text, box: b, score: 0.9, quad: [[0, 0], [0, 0], [0, 0], [0, 0]] as never });
        expect(ocrText([item("world", B(120, 10, 200, 30)), item("第二行", B(10, 50, 100, 70)), item("hello", B(10, 12, 100, 31))])).toBe(
            "hello world\n第二行",
        );
    });

    it("model ids: small by default, tiny on request, unknown rejected", () => {
        expect(ocrModel(undefined)).toBe("pp-ocrv6-small");
        expect(ocrModel("pp-ocrv6-tiny")).toBe("pp-ocrv6-tiny");
        expect(() => ocrModel("pp-ocrv9")).toThrow(/unknown OCR model/);
    });
});

describe("SLANet_plus decoding and cell matching", () => {
    const dict = tableDictionary(["<thead>", "</thead>", "<tbody>", "</tbody>", "<tr>", "</tr>", "<td>", "<td", ">", "</td>", ' colspan="2"']);

    it("builds the merged dictionary like PaddleOCR", () => {
        expect(dict[0]).toBe("sos");
        expect(dict.at(-1)).toBe("eos");
        expect(dict).toContain("<td></td>");
        expect(dict).not.toContain("<td>");
    });

    it("decodes tokens, cell boxes and fills the HTML", () => {
        const seq = ["<tr>", "<td></td>", "<td", ' colspan="2"', ">", "</td>", "</tr>", "eos"];
        const L = seq.length, V = dict.length;
        const structure = new Float32Array(L * V);
        seq.forEach((tok, t) => (structure[t * V + dict.indexOf(tok)] = 1));
        const loc = new Float32Array(L * 8);
        // cell 1 at x 0..0.25, cell 2 at 0.25..0.75 of the padded square (side 400 px).
        loc.set([0, 0, 0.25, 0, 0.25, 0.1, 0, 0.1], 1 * 8);
        loc.set([0.25, 0, 0.75, 0, 0.75, 0.1, 0.25, 0.1], 2 * 8);
        const t = decodeTable(structure, loc, L, V, 8, dict, 400, 400);
        expect(t.tokens.join("")).toBe('<tr><td></td><td colspan="2"></td></tr>');
        const round = (b: Box) => B(Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2));
        expect(t.cells.map(round)).toEqual([B(0, 0, 100, 40), B(100, 0, 300, 40)]);
        const matched = matchCells([B(110, 5, 200, 35), B(5, 5, 90, 35), B(210, 5, 290, 35)], t.cells);
        const html = tableHtml(t.tokens, matched, ["A&B", "名称", "<x>"]);
        expect(html).toBe('<table><tr><td>名称</td><td colspan="2">A&amp;B &lt;x&gt;</td></tr></table>');
    });
});

describe("TransNetV2 windows and scenes", () => {
    it("pads and tiles like the reference implementation", () => {
        const w = windowIndices(120);
        expect(w).toHaveLength(3);
        expect(w[0]!.slice(0, 26)).toEqual([...Array(25).fill(0), 0]);
        expect(w.every((x) => x.length === 100)).toBe(true);
        expect(w.at(-1)!.at(-1)).toBe(119);
        const preds = w.map((x) => Float32Array.from(x.map((i) => i)));
        expect(Array.from(stitch(preds, 120))).toEqual(Array.from({ length: 120 }, (_, i) => i));
    });

    it("predictions → scenes → boundaries", () => {
        const p = [0, 0, 0, 0.9, 0, 0, 0.8, 0.7, 0, 0];
        expect(predictionsToScenes(p)).toEqual([[0, 3], [4, 6], [8, 9]]);
        expect(boundariesFromScenes(predictionsToScenes(p))).toEqual([4, 8]);
        expect(predictionsToScenes([0.9, 0.9])).toEqual([[0, 1]]);
    });

    it("threshold: TransNetV2 probabilities as is, PySceneDetect's scale (the canvas default 20) mapped", () => {
        expect(transnetThreshold(undefined)).toBe(0.5);
        expect(transnetThreshold(0)).toBe(0.5);
        expect(transnetThreshold(-3)).toBe(0.5);
        expect(transnetThreshold(Number.NaN)).toBe(0.5);
        expect(transnetThreshold("0.3")).toBe(0.5);
        expect(transnetThreshold(0.3)).toBe(0.3);
        expect(transnetThreshold(1)).toBe(0.99);
        // The TongFlow canvas node fills in 20: before, nothing ever scored above 20 → one shot.
        expect(transnetThreshold(20)).toBe(0.5);
        expect(transnetThreshold(30)).toBeCloseTo(0.75);
        expect(transnetThreshold(10)).toBe(0.25);
        expect(transnetThreshold(2)).toBe(0.1);
        expect(transnetThreshold(255)).toBe(0.9);
        // The demo clip's three cuts score 1.0, 0.66 and 1.0: all found at the canvas default.
        const pred = new Float32Array(100);
        pred[20] = 0.998;
        pred[50] = 0.663;
        pred[80] = 1;
        expect(boundariesFromScenes(predictionsToScenes(pred, transnetThreshold(20)))).toEqual([21, 51, 81]);
        expect(boundariesFromScenes(predictionsToScenes(pred, 20))).toEqual([]);
    });

    it("frame-difference fallback finds a hard cut", () => {
        const frame = (r: number, g: number, b: number, noise = 0) =>
            Uint8Array.from({ length: 48 * 27 * 3 }, (_, i) => [r, g, b][i % 3]! + ((i * 7) % 5) * noise);
        const frames = [...Array(6)].map((_, i) => frame(200, 40, 40, i % 2)).concat([...Array(6)].map((_, i) => frame(30, 60, 220, i % 2)));
        expect(diffBoundaries(frames)).toEqual([6]);
    });
});

describe("layout regions", () => {
    it("thresholds, de-duplicates across classes and orders regions", () => {
        const rows = Float32Array.from([
            2, 0.9, 100, 200, 590, 600, // text, left column
            8, 0.95, 610, 200, 1100, 600, // table, right column
            2, 0.6, 612, 202, 1098, 598, // same box as the table, other class: dropped
            11, 0.8, 100, 50, 1100, 120, // doc_title
            1, 0.2, 0, 0, 50, 50, // below threshold
            3, 0.7, 580, 1600, 620, 1620, // page number: last
        ]);
        const r = layoutRegions(rows, 6, DOCLAYOUT_LABELS, 1200, 1700);
        expect(r.map((x) => x.label)).toEqual(["doc_title", "text", "table", "number"]);
        expect(r[2]!.box).toEqual([610, 200, 1100, 600]);
    });
});

describe("layout region filenames carry the label", () => {
    it("<stem>-r<NN>-<label>.png, NN 1-based and padded to the region count", () => {
        expect(regionFilename("page1", 2, 12, "table")).toBe("page1-r03-table.png");
        expect(regionFilename("page1", 0, 3, "paragraph_title")).toBe("page1-r1-paragraph_title.png");
        expect(regionFilename("a/b\\c", 0, 1, "text")).toBe("a_b_c-r1-text.png");
        expect(regionFilename("", 0, 1, "text")).toBe("page-r1-text.png");
        // A long CJK stem is cut on a character boundary; the label tail stays whole.
        const long = regionFilename("采购合同".repeat(20), 4, 120, "table");
        expect(long.endsWith("-r005-table.png")).toBe(true);
        expect(new TextEncoder().encode(long.slice(0, -"-r005-table.png".length)).length).toBeLessThanOrEqual(REGION_STEM_MAX_BYTES);
        for (const label of DOCLAYOUT_LABELS) expect(regionLabelOf(regionFilename("采购合同-扫描件-p1-oriented", 7, 30, label))).toBe(label);
    });

    it("parses only a known PP-DocLayout label at the end of the name", () => {
        expect(regionLabelOf("page1-r03-table.png")).toBe("table");
        expect(regionLabelOf("page1-r04-text.png")).toBe("text");
        expect(regionLabelOf("page1-r05-table_title.png")).toBe("table_title");
        expect(regionLabelOf("opfs://3f2a9c/page1-r03-table.png")).toBe("table");
        expect(regionLabelOf("mem://3f2a9c/采购合同-p1-r12-image.png")).toBe("image");
        expect(regionLabelOf("page1-r03-table.jpeg")).toBe("table");
        expect(regionLabelOf(undefined)).toBeUndefined();
        expect(regionLabelOf("")).toBeUndefined();
        expect(regionLabelOf("ec0e1fb1a2.png")).toBeUndefined(); // a store id: no label
        expect(regionLabelOf("table.png")).toBeUndefined();
        expect(regionLabelOf("report-r2-final.png")).toBeUndefined(); // not a layout class
        expect(regionLabelOf("page1-r03-table")).toBeUndefined(); // no extension
        expect(regionLabelOf("page1-r03-table.png.bak")).toBeUndefined();
    });

    it("table-recognize returns empty html for a non-table region without loading a model or decoding", async () => {
        for (const label of ["text", "paragraph_title", "table_title", "image"]) {
            const ctx = nodeCtx();
            // Not an image at all: decoding would fail, so a success proves nothing was read.
            const image = { bytesBase64: btoa("not a png"), mime: "image/png", filename: `page1-r04-${label}.png` };
            const r = await tableRecognize({ image }, ctx);
            expect(r).toEqual({ success: true, html: "" });
            expect(ctx.rec.downloads).toEqual([]);
            expect(ctx.rec.progress.at(-1)?.message).toBe(`skipped: layout region "${label}" is not a table`);
        }
    });

    it("table-recognize runs as before for a table region or a name without a label", async () => {
        // Node has no OffscreenCanvas, so "running" shows up as the canvas error, not a skip.
        for (const filename of ["page1-r03-table.png", "ec0e1fb1a2.png", "table.png", undefined]) {
            const r = await tableRecognize({ image: { bytesBase64: btoa("x"), mime: "image/png", ...(filename ? { filename } : {}) } }, nodeCtx());
            expect(r.success, String(filename)).toBe(false);
            expect(r.html).toBeUndefined();
        }
    });
});

describe("detect-objects post-processing", () => {
    it("merges near-identical boxes of one label, keeps different labels", () => {
        const o = (label: string, score: number, box: [number, number, number, number]) => ({ label, score, box });
        const out = dedupeObjects([o("cat", 0.5, [1, 1, 407, 299]), o("cat", 0.7, [0, 0, 410, 300]), o("dog", 0.4, [0, 0, 410, 300])]);
        expect(out).toEqual([o("cat", 0.7, [0, 0, 410, 300]), o("dog", 0.4, [0, 0, 410, 300])]);
    });
});

describe("manifest, models.json and the model catalog agree", () => {
    const T1 = ["ocr-image", "image-orient", "layout-detect", "table-recognize", "split-video", "detect-objects"];

    it("every T1 slot lists its models, default first, each mapped to models.json repos", () => {
        const ids = new Set(models.map((m) => m.id));
        for (const slot of T1) {
            const entry = manifest.slots.filter((s) => s.nodeSlot === slot);
            expect(entry, slot).toHaveLength(1);
            for (const m of entry[0]!.models ?? []) {
                if (m === "glm-ocr") continue; // T3's implementation behind the same slot
                if (m === "transnetv2+ffmpeg-wasm") continue; // same model, frames and shots by ffmpeg.wasm
                expect(MANIFEST_MODELS[m], m).toBeDefined();
                expect(MANIFEST_MODELS[m]!.slot).toBe(slot);
                for (const repo of MANIFEST_MODELS[m]!.repos) expect(ids.has(repo), repo).toBe(true);
            }
        }
        expect(manifest.slots.find((s) => s.nodeSlot === "ocr-image")!.models).toEqual(["pp-ocrv6-small", "pp-ocrv6-tiny", "glm-ocr"]);
    });

    it("T1 models.json entries are ModelScope repos with size + sha256 for every file", () => {
        const t1 = new Set(Object.values(MANIFEST_MODELS).flatMap((m) => m.repos).concat("pp-lcnet-textline-ori"));
        for (const m of models.filter((x) => t1.has(x.id))) {
            expect(m.source).toMatch(/^modelscope:[\w.-]+\/[\w.-]+$/);
            expect(m.license).toMatch(/Apache-2.0|MIT/);
            expect(m.licenseUrl).toMatch(/^https:\/\//);
            expect(m.slots?.length).toBeGreaterThan(0);
            for (const f of m.files) {
                expect(m.checksums?.[f]?.sha256, `${m.id}/${f}`).toMatch(/^[0-9a-f]{64}$/);
                expect(m.checksums?.[f]?.size).toBeGreaterThan(0);
            }
        }
        const layoutS = models.find((m) => m.id === "pp-doclayout-s")!;
        expect(layoutS.checksums!["inference.onnx"]!.sha256).toBe("c2336493a0a13cd9b9b457ca68aea370b327c362a4a7da4917c2bba96029bceb");
    });
});
