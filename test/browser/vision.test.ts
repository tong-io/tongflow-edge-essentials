// T1 vision/document slots through the built worker. Real inference needs the model
// weights: run with EDGE_MODELS_DIR=<dir holding <org>/<repo>/<file>> (served as /models,
// the default model base). Without it only the model-free checks run.
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { call, fixture, fromBase64, imageSize } from "./harness.js";

declare const __EDGE_MODELS__: string;
if (!__EDGE_MODELS__) console.info("[edge] EDGE_MODELS_DIR is not set: the real-model T1 vision tests skip");

const PNG = [0x89, 0x50, 0x4e, 0x47];

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

async function canvasAsset(c: OffscreenCanvas, filename: string) {
    const blob = await c.convertToBlob({ type: "image/png" });
    return { bytesBase64: toBase64(new Uint8Array(await blob.arrayBuffer())), mime: "image/png", filename };
}

const FONT = `"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif`;
const LINES = ["发票号码 20261121", "合计金额 人民币 3,280.50 元", "The quick brown fox jumps", "收款单位：上海示例科技有限公司"];

/** A synthetic scan: four lines of Chinese/English text, black on white. */
function textImage(): OffscreenCanvas {
    const c = new OffscreenCanvas(900, 360);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#111";
    g.font = `34px ${FONT}`;
    LINES.forEach((t, i) => g.fillText(t, 40, 70 + i * 80));
    return c;
}

/** A ruled 3×3 table. */
const TABLE = [
    ["地区", "销售额", "增长"],
    ["华东", "1200", "12%"],
    ["华北", "800", "5%"],
];
function tableImage(): OffscreenCanvas {
    const c = new OffscreenCanvas(600, 240);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#000";
    g.lineWidth = 2;
    const x0 = 20, y0 = 20, cw = 186, ch = 66;
    for (let r = 0; r <= 3; r++) {
        g.beginPath();
        g.moveTo(x0, y0 + r * ch);
        g.lineTo(x0 + 3 * cw, y0 + r * ch);
        g.stroke();
    }
    for (let k = 0; k <= 3; k++) {
        g.beginPath();
        g.moveTo(x0 + k * cw, y0);
        g.lineTo(x0 + k * cw, y0 + 3 * ch);
        g.stroke();
    }
    g.fillStyle = "#000";
    g.font = `28px ${FONT}`;
    TABLE.forEach((row, r) => row.forEach((t, k) => g.fillText(t, x0 + k * cw + 20, y0 + r * ch + 44)));
    return c;
}

async function bitmapOf(asset: { bytesBase64: string; mime?: string }) {
    return createImageBitmap(new Blob([fromBase64(asset.bytesBase64) as BlobPart], { type: asset.mime ?? "image/png" }));
}

function rotated(src: ImageBitmap | OffscreenCanvas, deg: 90 | 180 | 270): OffscreenCanvas {
    const swap = deg !== 180;
    const c = new OffscreenCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
    const g = c.getContext("2d")!;
    g.translate(c.width / 2, c.height / 2);
    g.rotate((deg * Math.PI) / 180);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
}

/** Mean absolute pixel difference of two equally sized images (0..255). */
async function pixelDiff(a: ImageBitmap | OffscreenCanvas, b: ImageBitmap | OffscreenCanvas) {
    const read = (s: ImageBitmap | OffscreenCanvas) => {
        const c = new OffscreenCanvas(200, 280);
        const g = c.getContext("2d")!;
        g.drawImage(s, 0, 0, 200, 280);
        return g.getImageData(0, 0, 200, 280).data;
    };
    const x = read(a), y = read(b);
    let s = 0;
    for (let i = 0; i < x.length; i += 4) s += Math.abs(x[i]! - y[i]!);
    return s / (x.length / 4);
}

async function videoDuration(asset: { bytesBase64: string; mime?: string }) {
    const { Input, BufferSource, ALL_FORMATS } = await import("mediabunny");
    const input = new Input({ source: new BufferSource(fromBase64(asset.bytesBase64)), formats: ALL_FORMATS });
    const d = await input.computeDuration();
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const decodable = v ? await v.canDecode() : false;
    input.dispose();
    return { duration: d, hasVideo: !!v, hasAudio: !!a, decodable };
}

const timings: string[] = [];
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const r = await fn();
    const ms = Math.round(performance.now() - t0);
    timings.push(`${label}: ${ms} ms`);
    console.warn(`[timing] ${label}: ${ms} ms`);
    return r;
}

describe("T1 slots without model weights", () => {
    it("a model the host did not mirror fails the node with a clear error", async () => {
        const entry = new URL("/dist/index.js", location.origin);
        entry.searchParams.set("modelBase", "/no-such-model-mirror/");
        const w = new Worker(entry, { type: "module" });
        await new Promise<void>((res) => w.addEventListener("message", (e) => e.data?.type === "ready" && res(), { once: true }));
        const out = await new Promise<any>((res) => {
            w.addEventListener("message", (e) => {
                if (e.data?.type === "result") res(e.data.output);
                if (e.data?.type === "error") res({ thrown: e.data.message });
            });
            w.postMessage({ type: "invoke", id: 1, method: "imageOrient", nodeSlot: "image-orient", input: { image: { bytesBase64: "iVBORw0KGgo=", mime: "image/png" } } });
        });
        w.terminate();
        expect(out.success).toBe(false);
        expect(String(out.error)).toMatch(/decode the image|model base|not available|could not download/);
    });

    it("unknown OCR model id is rejected", async () => {
        const img = await canvasAsset(textImage(), "lines.png");
        const r = await call("ocrImage", { image: img }, { model: "pp-ocrv9-huge" });
        expect(r.out.success).toBe(false);
        expect(r.out.error).toMatch(/unknown OCR model/);
    });
});

describe.runIf(Boolean(__EDGE_MODELS__))("T1 slots with real models (EDGE_MODELS_DIR)", () => {
    it("ocr-image (PP-OCRv6 small, default): Chinese + English lines in reading order", async () => {
        const img = await canvasAsset(textImage(), "lines.png");
        const r = await timed("ocr-image small, 900×360, cold (download + session + run)", () => call("ocrImage", { image: img }));
        expect(r.out.error).toBeUndefined();
        const text: string = r.out.text;
        console.warn("OCR small:\n" + text);
        const lines = text.split("\n");
        expect(lines.length).toBe(4);
        expect(text).toContain("20261121");
        expect(text).toContain("3,280.50");
        expect(text).toContain("quick brown fox");
        expect(text).toContain("上海示例科技有限公司");
        expect(lines[0]).toContain("发票号码");
        // Downloads were reported per file, from the model base.
        const files = new Set(r.downloads.map((d) => d.file));
        expect([...files].some((f) => f?.includes("PP-OCRv6_small_det_onnx/inference.onnx"))).toBe(true);
        expect([...files].some((f) => f?.includes("PP-OCRv6_small_rec_onnx/inference.onnx"))).toBe(true);
        const warm = await timed("ocr-image small, 900×360, warm", () => call("ocrImage", { image: img }));
        expect(warm.out.text).toBe(text);
    });

    it("ocr-image (PP-OCRv6 tiny, the swap option)", async () => {
        const img = await canvasAsset(textImage(), "lines.png");
        const r = await timed("ocr-image tiny, 900×360, cold", () => call("ocrImage", { image: img }, { model: "pp-ocrv6-tiny" }));
        expect(r.out.error).toBeUndefined();
        console.warn("OCR tiny:\n" + r.out.text);
        expect(r.out.text).toContain("20261121");
        expect(r.out.text).toContain("quick brown fox");
        await timed("ocr-image tiny, 900×360, warm", () => call("ocrImage", { image: img }, { model: "pp-ocrv6-tiny" }));
    });

    it("ocr-image with _params.textline_orientation: an upside-down scan", async () => {
        const img = await canvasAsset(rotated(textImage(), 180), "upside-down.png");
        const r = await timed("ocr-image small + textline orientation, 900×360 upside down", () =>
            call("ocrImage", { image: img }, { params: { textline_orientation: true } }),
        );
        expect(r.out.error).toBeUndefined();
        console.warn("OCR upside down:\n" + r.out.text);
        expect(r.out.text).toContain("quick brown fox");
        expect(r.out.text).toContain("上海示例科技有限公司");
    });

    it("render-pages → ocr-image on a real PDF page (1240×1754)", async () => {
        const pages = await call("renderPages", { document: await fixture("report.pdf", "application/pdf") });
        const page = pages.out.pages[0];
        const r = await timed("ocr-image small, A4 page at 150 DPI, warm", () => call("ocrImage", { image: page }));
        expect(r.out.error).toBeUndefined();
        console.warn("OCR page:\n" + r.out.text);
        expect(r.out.text).toContain("华东区销售额增长百分之十二");
        expect(r.out.text).toContain("Quarterly Report");
        expect(r.out.text.indexOf("季度报告")).toBeLessThan(r.out.text.indexOf("主要结论"));
    });

    it("image-orient: a page turned 90/180/270° comes back upright", async () => {
        const pages = await call("renderPages", { document: await fixture("report.pdf", "application/pdf") });
        const upright = await bitmapOf(pages.out.pages[0]);
        const same = await timed("image-orient, upright page, cold", () => call("imageOrient", { image: pages.out.pages[0] }));
        expect(same.out.error).toBeUndefined();
        expect(same.out.image.mime).toBe("image/png");
        expect(await pixelDiff(await bitmapOf(same.out.image), upright)).toBeLessThan(2);
        for (const deg of [90, 180, 270] as const) {
            const turned = await canvasAsset(rotated(upright, deg), `page-${deg}.png`);
            const r = await timed(`image-orient, page turned ${deg}°`, () => call("imageOrient", { image: turned }));
            expect(r.out.error).toBeUndefined();
            const png = fromBase64(r.out.image.bytesBase64);
            expect(Array.from(png.subarray(0, 4))).toEqual(PNG);
            expect(r.out.image.filename).toBe(`page-${deg}-oriented.png`);
            const fixed = await bitmapOf(r.out.image);
            expect([fixed.width, fixed.height]).toEqual([upright.width, upright.height]);
            expect(await pixelDiff(fixed, upright)).toBeLessThan(2);
        }
    });

    it("layout-detect (PP-DocLayout-S): regions as JSON + cropped PNGs in reading order", async () => {
        // paper.pdf: centred title, abstract, then a two-column body (headings, text, a table, a chart).
        const pages = await call("renderPages", { document: await fixture("paper.pdf", "application/pdf") });
        const r = await timed("layout-detect S, A4 page, cold", () => call("layoutDetect", { image: pages.out.pages[0] }));
        expect(r.out.error).toBeUndefined();
        const layout = JSON.parse(r.out.layout) as { label: string; score: number; box: number[] }[];
        console.warn("layout S:\n" + layout.map((l) => `${l.label} ${l.score} ${l.box.join(",")}`).join("\n"));
        expect(layout.length).toBeGreaterThanOrEqual(8);
        expect(r.out.regions).toHaveLength(layout.length);
        const labels = layout.map((l) => l.label);
        expect(labels[0]).toBe("doc_title");
        for (const want of ["table", "image", "paragraph_title", "text"]) expect(labels).toContain(want);
        expect(layout.find((l) => l.label === "table")!.score).toBeGreaterThan(0.8);
        // Column order: every left-column block (x2 < page middle) comes before the right column's.
        const mid = 620;
        const body = layout.filter((l) => l.box[1]! > 380 && l.box[3]! < 1500);
        const firstRight = body.findIndex((l) => l.box[0]! > mid);
        expect(firstRight).toBeGreaterThan(0);
        expect(body.slice(firstRight).every((l) => l.box[0]! > mid)).toBe(true);
        for (const [i, l] of layout.entries()) {
            expect(l.box[2]!).toBeGreaterThan(l.box[0]!);
            const size = await imageSize(fromBase64(r.out.regions[i].bytesBase64), "image/png");
            expect(Math.abs(size.width - (l.box[2]! - l.box[0]!))).toBeLessThanOrEqual(1);
            expect(r.out.regions[i].filename).toContain(l.label);
        }
        // The table region chains into table-recognize.
        const ti = layout.findIndex((l) => l.label === "table");
        const t = await timed("table-recognize on the layout's table crop", () => call("tableRecognize", { image: r.out.regions[ti] }));
        expect(t.out.error).toBeUndefined();
        console.warn("table from PDF:", t.out.html);
        expect(t.out.html).toContain("<td>华东</td><td>1200</td><td>+12%</td><td>38%</td>");
        expect(t.out.html).toContain("<td>西部</td><td>510</td>");
    });

    it("layout-detect (PP-DocLayout-M, the swap option)", async () => {
        const pages = await call("renderPages", { document: await fixture("paper.pdf", "application/pdf") });
        const r = await timed("layout-detect M, A4 page, cold", () => call("layoutDetect", { image: pages.out.pages[0] }, { model: "pp-doclayout-m" }));
        expect(r.out.error).toBeUndefined();
        const layout = JSON.parse(r.out.layout) as { label: string }[];
        console.warn("layout M:", JSON.stringify(layout));
        expect(layout.map((l) => l.label)).toContain("table");
    });

    it("table-recognize (SLANet_plus + OCR): a ruled 3×3 table → HTML", async () => {
        const img = await canvasAsset(tableImage(), "table.png");
        const r = await timed("table-recognize, 600×240, cold", () => call("tableRecognize", { image: img }));
        expect(r.out.error).toBeUndefined();
        const html: string = r.out.html;
        console.warn("table:", html);
        expect(html.startsWith("<table>")).toBe(true);
        expect((html.match(/<tr>/g) ?? []).length).toBe(3);
        expect((html.match(/<td/g) ?? []).length).toBe(9);
        // Exact rows; the last cell is compared loosely (rec once read "5%" as "5%%").
        for (const row of TABLE) expect(html).toContain(row.slice(0, 2).map((t) => `<td>${t}</td>`).join("") + `<td>${row[2]}`);
    });

    it("split-video (TransNetV2): 3 shots of an H.264 MP4 with key frames at the cuts", async () => {
        const video = await fixture("shots.mp4", "video/mp4");
        const r = await timed("split-video, 6 s 240×136 MP4, cold", () => call("splitVideo", { video }));
        expect(r.out.error).toBeUndefined();
        const parts = r.out.video_parts;
        expect(parts).toHaveLength(3);
        for (const [i, p] of parts.entries()) {
            expect(p.mime).toBe("video/mp4");
            expect(p.filename).toBe(`shots-shot${i + 1}.mp4`);
            const info = await videoDuration(p);
            expect(info.hasVideo).toBe(true);
            expect(info.hasAudio).toBe(true);
            expect(Math.abs(info.duration - 2)).toBeLessThan(0.15);
        }
        // Remuxed, not re-encoded: the parts add up to about the original size.
        const total = parts.reduce((s: number, p: { bytesBase64: string }) => s + fromBase64(p.bytesBase64).length, 0);
        expect(total / fromBase64(video.bytesBase64).length).toBeGreaterThan(0.85);
        expect(total / fromBase64(video.bytesBase64).length).toBeLessThan(1.15);
        await commands.writeFile("test-results/shot2.mp4.b64", parts[1].bytesBase64);
    });

    it("split-video: a VP9 WebM whose cuts are not key frames (parts re-encoded or key-frame aligned)", async () => {
        const video = await fixture("shots-gop.webm", "video/webm");
        const r = await timed("split-video, 6 s 240×136 WebM (one key frame)", () => call("splitVideo", { video }));
        expect(r.out.error).toBeUndefined();
        const parts = r.out.video_parts;
        expect(parts).toHaveLength(3);
        const durs: number[] = [];
        for (const p of parts) {
            expect(p.mime).toBe("video/webm");
            const info = await videoDuration(p);
            expect(info.hasVideo && info.decodable).toBe(true);
            durs.push(info.duration);
        }
        console.warn("webm part durations:", durs.map((d) => d.toFixed(2)).join(", "));
        for (const d of durs) expect(d).toBeGreaterThan(1.5);
    });

    it("detect-objects (D-FINE nano fp16 by default, int8 as the alternative; transformers.js)", async () => {
        // Default (no model picked): fp16.
        const cat = await timed("detect-objects fp16 (default), 451×300 photo, cold", () => call("detectObjects", { image: fixtureSync.cat }));
        expect(cat.out.error).toBeUndefined();
        const objs = JSON.parse(cat.out.objects) as { label: string; score: number; box: number[] }[];
        console.warn("objects fp16 (cat.jpg):", cat.out.objects);
        expect(objs[0]!.label).toBe("cat");
        expect(objs.filter((o) => o.label === "cat")).toHaveLength(1); // duplicates merged
        expect(objs[0]!.score).toBeGreaterThan(0.4);
        expect(objs[0]!.box[2]).toBeGreaterThan(objs[0]!.box[0]!);
        expect(cat.downloads.some((d) => d.file?.includes("dfine_n_coco-ONNX/onnx/model_fp16.onnx"))).toBe(true);
        expect(cat.downloads.some((d) => d.file?.includes("model_int8.onnx"))).toBe(false);
        const a16 = await timed("detect-objects fp16 (default), 512×512 photo, warm", () => call("detectObjects", { image: fixtureSync.astronaut }));
        console.warn("objects fp16 (astronaut.jpg):", a16.out.objects);
        expect((JSON.parse(a16.out.objects) as { label: string }[]).map((o) => o.label)).toContain("person");

        // The int8 alternative, picked by model id.
        const int8 = await timed("detect-objects int8, 451×300 photo, cold", () => call("detectObjects", { image: fixtureSync.cat }, { model: "dfine-nano" }));
        expect(int8.out.error).toBeUndefined();
        console.warn("objects int8 (cat.jpg):", int8.out.objects);
        expect(JSON.parse(int8.out.objects)[0].label).toBe("cat");
        expect(int8.downloads.some((d) => d.file?.includes("dfine_n_coco-ONNX/onnx/model_int8.onnx"))).toBe(true);
        // The astronaut is a hard case for the int8 export (person ≈ 0.3–0.43 across runs): only logged.
        const astro = await timed("detect-objects int8, 512×512 photo, warm", () =>
            call("detectObjects", { image: fixtureSync.astronaut }, { model: "dfine-nano", params: { threshold: 0.25 } }),
        );
        console.warn("objects int8 (astronaut.jpg, threshold 0.25):", astro.out.objects);
    });

    it("raw-ORT nodes and transformers.js share one onnxruntime-web and one wasm download", async () => {
        // This worker has run both kinds above (PP-OCR / TransNetV2 on onnxruntime-web directly, D-FINE through transformers.js).
        const ort = (await (await fetch("/__ort-requests")).json()) as string[];
        console.warn("ort asset requests:", ort.join(", "));
        const wasm = ort.filter((r) => r.endsWith(".wasm"));
        // At most once (zero when an earlier file of this run already put it in the Cache API), and only the one build.
        expect(wasm.filter((r) => r === "GET ort-wasm-simd-threaded.asyncify.wasm").length).toBeLessThanOrEqual(1);
        expect(wasm.filter((r) => r !== "GET ort-wasm-simd-threaded.asyncify.wasm")).toEqual([]);
        expect(ort.filter((r) => r.endsWith(".mjs") && !r.endsWith("ort-wasm-simd-threaded.asyncify.mjs"))).toEqual([]);
        // transformers.js never reached for its own (rewritten CDN) copy.
        const models = (await (await fetch("/__model-requests")).json()) as string[];
        expect(models.filter((r) => r.includes("onnxruntime-web"))).toEqual([]);
    });

    it("timings", () => {
        console.warn("T1 timings (Chromium headless, WASM):\n" + timings.join("\n"));
    });
});

const fixtureSync = {
    cat: await fixture("cat.jpg", "image/jpeg"),
    astronaut: await fixture("astronaut.jpg", "image/jpeg"),
};
