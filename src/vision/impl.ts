/**
 * Bodies of the T1 vision/document slots (loaded lazily by `slots/vision.ts`):
 * `ocr-image`, `image-orient`, `layout-detect`, `table-recognize`.
 */
import type { EdgeContext } from "../context.js";
import type { Asset, EdgeSlotOutput, SlotInput } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { readAsset } from "../slots/common.js";
import { IMAGENET, type Source, crop, decodeImage, drawToRgba, needCanvas, rgbaToChw, rotate, toCanvas, toPng } from "../ml/canvas.js";
import { fetchModelFile, fetchModelText, memo } from "../ml/model-files.js";
import { type LoadedSession, createDeviceSession, pickDevice, loadOrt, run, tensor } from "../ml/ort.js";
import { DOCLAYOUT_LABELS, DOCLAYOUT_V3_LABELS, layoutRegions, regionFilename, regionLabelOf } from "./layout-post.js";
import { ocrModel, ocrText, readingOrder, recognizeText } from "./ocr.js";
import { yamlList } from "./ocr-post.js";
import { decodeTable, matchCells, tableDictionary, tableHtml } from "./table-post.js";

const sessions = memo<LoadedSession>();
function session(ctx: EdgeContext, id: string): Promise<LoadedSession> {
    return pickDevice(ctx).then((device) =>
        sessions(`${id}@${device}`, async () => createDeviceSession(ctx, await fetchModelFile(ctx, id, "inference.onnx"), device)),
    );
}

async function readImage(asset: Asset | undefined, slot: string): Promise<{ bmp: ImageBitmap; asset: Asset }> {
    needCanvas(slot);
    const bytes = readAsset(asset, "image");
    return { bmp: await decodeImage(bytes, asset!.mime), asset: asset! };
}

function num(v: unknown, fallback: number): number {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ ocr-image */

export async function ocrImage(input: SlotInput<"ocr-image">, ctx: EdgeContext): Promise<EdgeSlotOutput<"ocr-image">> {
    const model = ocrModel(ctx.model);
    const { bmp } = await readImage(input.image, "ocr-image");
    try {
        const items = await recognizeText(ctx, bmp, model, {
            detMaxSide: num(ctx.params?.det_max_side, 2048),
            dropScore: num(ctx.params?.drop_score, 0.5),
            textlineOrientation: ctx.params?.textline_orientation === true,
        });
        ctx.onProgress({ fraction: 1, message: `${items.length} text lines` });
        return { success: true, text: ocrText(items) };
    } finally {
        bmp.close();
    }
}

/* ---------------------------------------------------------------- image-orient */

const DOC_ORI = "pp-lcnet-doc-ori";
/** doc_ori labels: index → degrees the page content is turned clockwise (verified on rotated pages). */
export const DOC_ORI_ANGLES = [0, 90, 180, 270] as const;

/** Classify page orientation: resize short side to 256, centre-crop 224, ImageNet norm (RGB). */
export async function classifyOrientation(ctx: EdgeContext, src: Source): Promise<{ angle: 0 | 90 | 180 | 270; score: number }> {
    const s = await session(ctx, DOC_ORI);
    const scale = 256 / Math.min(src.width, src.height);
    const rw = Math.max(224, Math.round(src.width * scale)), rh = Math.max(224, Math.round(src.height * scale));
    // Centre 224×224 of the resized image = this part of the source:
    const sw = (224 / rw) * src.width, sh = (224 / rh) * src.height;
    const part = { sx: (src.width - sw) / 2, sy: (src.height - sh) / 2, sw, sh };
    const rgba = drawToRgba(src, 224, 224, part);
    const x = rgbaToChw(rgba, 224, 224, IMAGENET);
    const out = Object.values(await run(s, { x: await tensor(ctx, x, [1, 3, 224, 224]) }))[0]!;
    const p = Array.from(out.data as Float32Array);
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i]! > p[best]!) best = i;
    return { angle: DOC_ORI_ANGLES[best] ?? 0, score: p[best]! };
}

export async function imageOrient(input: SlotInput<"image-orient">, ctx: EdgeContext): Promise<EdgeSlotOutput<"image-orient">> {
    const { bmp, asset } = await readImage(input.image, "image-orient");
    try {
        ctx.onProgress({ fraction: 0, message: "loading orientation model" });
        const { angle, score } = await classifyOrientation(ctx, bmp);
        ctx.onProgress({ fraction: 0.6, message: `page turned ${angle}° (p=${score.toFixed(2)})` });
        const name = `${fileStem(asset.filename, "image")}-oriented.png`;
        if (angle === 0 && (asset.mime === "image/png" || /\.png$/i.test(asset.filename ?? ""))) {
            return { success: true, image: { bytesBase64: asset.bytesBase64, mime: "image/png", filename: name } };
        }
        // The content is turned `angle`° clockwise: turn it back.
        const back = ((360 - angle) % 360) as 0 | 90 | 180 | 270;
        const fixed = back === 0 ? toCanvas(bmp) : rotate(bmp, back);
        const png = await toPng(fixed);
        ctx.onProgress({ fraction: 1, message: angle ? `rotated ${back}° clockwise` : "already upright" });
        return { success: true, image: { bytesBase64: encodeBase64(png), mime: "image/png", filename: name } };
    } finally {
        bmp.close();
    }
}

/* --------------------------------------------------------------- layout-detect */

/** Default first. `pp-doclayoutv3` (130 MB) is the alternative for photographed, skewed or curved pages. */
export const LAYOUT_MODELS = ["pp-doclayout-s", "pp-doclayout-m", "pp-doclayoutv3"] as const;
const LAYOUT_SIZE: Record<(typeof LAYOUT_MODELS)[number], number> = { "pp-doclayout-s": 480, "pp-doclayout-m": 640, "pp-doclayoutv3": 800 };

export function layoutModel(model: string | undefined): (typeof LAYOUT_MODELS)[number] {
    if (!model) return LAYOUT_MODELS[0];
    const m = model.trim().toLowerCase();
    const hit = LAYOUT_MODELS.find((id) => id === m || m.endsWith(id.slice(-2)));
    if (!hit) throw new EdgeError(`unknown layout model "${model}" (use ${LAYOUT_MODELS.join(" or ")})`);
    return hit;
}

const layoutLabels = memo<string[]>();

export async function detectLayout(ctx: EdgeContext, src: Source, id: (typeof LAYOUT_MODELS)[number], threshold: number) {
    const [s, labels] = await Promise.all([
        session(ctx, id),
        layoutLabels(id, async () => {
            const l = yamlList(await fetchModelText(ctx, id, "inference.yml"), "label_list");
            return l.length ? l : id === "pp-doclayoutv3" ? DOCLAYOUT_V3_LABELS : DOCLAYOUT_LABELS;
        }),
    ]);
    if (id === "pp-doclayoutv3") return detectLayoutV3(ctx, s, labels, src, threshold);
    const S = LAYOUT_SIZE[id];
    const rgba = drawToRgba(src, S, S);
    const x = rgbaToChw(rgba, S, S, IMAGENET);
    const ort = await loadOrt(ctx);
    const feeds = {
        image: new ort.Tensor("float32", x, [1, 3, S, S]),
        scale_factor: new ort.Tensor("float32", new Float32Array([S / src.height, S / src.width]), [1, 2]),
    };
    const out = await run(s, feeds);
    const vals = Object.values(out);
    const rows = vals.find((t) => t.dims.length === 2 && t.dims[1] === 6) ?? vals[0]!;
    const countT = vals.find((t) => t !== rows);
    const count = countT ? Number(countT.data[0]) : rows.dims[0]!;
    return layoutRegions(rows.data as Float32Array, Math.min(count, rows.dims[0]!), labels, src.width, src.height, threshold);
}

/**
 * PP-DocLayoutV3 (RT-DETR with mask and reading-order heads, the official ONNX): the page
 * resized to 800² (no aspect kept) and scaled to 0..1, `im_shape` + `scale_factor` in; rows of
 * `[class, score, x1, y1, x2, y2, order]` in source pixels out (plus per-box masks, unused:
 * regions are the boxes, as with S/M). Reading order is the model's own.
 */
async function detectLayoutV3(ctx: EdgeContext, s: LoadedSession, labels: string[], src: Source, threshold: number) {
    const S = LAYOUT_SIZE["pp-doclayoutv3"];
    const x = rgbaToChw(drawToRgba(src, S, S), S, S, { mean: [0, 0, 0], std: [1, 1, 1] });
    const ort = await loadOrt(ctx);
    const out = await run(s, {
        im_shape: new ort.Tensor("float32", new Float32Array([S, S]), [1, 2]),
        image: new ort.Tensor("float32", x, [1, 3, S, S]),
        scale_factor: new ort.Tensor("float32", new Float32Array([S / src.height, S / src.width]), [1, 2]),
    });
    const vals = Object.values(out);
    const rows = vals.find((t) => t.dims.length === 2 && t.dims[1] === 7);
    if (!rows) throw new EdgeError(`PP-DocLayoutV3: unexpected outputs ${vals.map((t) => `[${t.dims.join(",")}]`).join(" ")}`);
    const countT = vals.find((t) => t.dims.length === 1);
    const count = countT ? Number(countT.data[0]) : rows.dims[0]!;
    return layoutRegions(rows.data as Float32Array, Math.min(count, rows.dims[0]!), labels, src.width, src.height, threshold, {
        stride: 7,
        modelOrder: true,
    });
}

export async function layoutDetect(input: SlotInput<"layout-detect">, ctx: EdgeContext): Promise<EdgeSlotOutput<"layout-detect">> {
    const id = layoutModel(ctx.model);
    const { bmp, asset } = await readImage(input.image, "layout-detect");
    try {
        ctx.onProgress({ fraction: 0, message: id === "pp-doclayoutv3" ? "loading PP-DocLayoutV3 (130 MB on first use)" : "loading layout model" });
        const layout = await detectLayout(ctx, bmp, id, num(ctx.params?.threshold, 0.5));
        ctx.onProgress({ fraction: 0.5, message: `${layout.length} regions` });
        const stem = fileStem(asset.filename, "page");
        const regions: Asset[] = [];
        for (let i = 0; i < layout.length; i++) {
            throwIfAborted(ctx.signal);
            const r = layout[i]!;
            const c = crop(bmp, r.box[0], r.box[1], r.box[2], r.box[3]);
            regions.push({
                bytesBase64: encodeBase64(await toPng(c)),
                mime: "image/png",
                filename: regionFilename(stem, i, layout.length, r.label),
            });
            c.width = c.height = 0;
            ctx.onProgress({ fraction: 0.5 + 0.5 * ((i + 1) / layout.length), message: `cropped ${i + 1}/${layout.length}` });
        }
        return { success: true, layout: JSON.stringify(layout), regions };
    } finally {
        bmp.close();
    }
}

/* ------------------------------------------------------------- table-recognize */

const SLANET = "slanet-plus";
const TABLE_MAX = 488;
const tableDict = memo<string[]>();

/**
 * `table-recognize`. A `layout-detect` region whose filename names another label
 * (`page1-r04-text.png`, see {@link regionFilename}) is not a table: it succeeds with empty
 * `html` at once, without loading a model. A name without a layout label runs as usual.
 */
export async function tableRecognize(input: SlotInput<"table-recognize">, ctx: EdgeContext): Promise<EdgeSlotOutput<"table-recognize">> {
    const label = regionLabelOf(input.image?.filename);
    if (label && label !== "table") {
        ctx.onProgress({ fraction: 1, message: `skipped: layout region "${label}" is not a table` });
        return { success: true, html: "" };
    }
    const { bmp } = await readImage(input.image, "table-recognize");
    try {
        ctx.onProgress({ fraction: 0, message: "loading table model" });
        const [s, dict] = await Promise.all([
            session(ctx, SLANET),
            tableDict(SLANET, async () => tableDictionary(yamlList(await fetchModelText(ctx, SLANET, "inference.yml"), "character_dict"))),
        ]);
        const W = bmp.width, H = bmp.height;
        const ratio = TABLE_MAX / Math.max(W, H);
        const rw = Math.max(1, Math.round(W * ratio)), rh = Math.max(1, Math.round(H * ratio));
        const rgba = drawToRgba(bmp, rw, rh);
        const data = new Float32Array(3 * TABLE_MAX * TABLE_MAX); // zero padding right/bottom
        rgbaToChw(rgba, rw, rh, { ...IMAGENET, bgr: true }, data, TABLE_MAX, TABLE_MAX);
        const out = await run(s, { x: await tensor(ctx, data, [1, 3, TABLE_MAX, TABLE_MAX]) });
        const vals = Object.values(out);
        const loc = vals.find((t) => t.dims[2] === 8)!;
        const struct = vals.find((t) => t !== loc)!;
        const [, L, V] = struct.dims as number[];
        const side = Math.max(W, H); // locations are relative to the padded square
        const table = decodeTable(struct.data as Float32Array, loc.data as Float32Array, L!, V!, 8, dict, side, side);
        if (!table.tokens.length) throw new EdgeError("no table structure recognized in this image");
        ctx.onProgress({ fraction: 0.3, message: `${table.cells.length} cells; reading cell text` });
        const items = readingOrder(
            await recognizeText(ctx, bmp, ocrModel(undefined), { progress: [0.3, 0.95], detMaxSide: num(ctx.params?.det_max_side, 2048) }),
        );
        const matched = matchCells(items.map((i) => i.box), table.cells);
        const html = tableHtml(table.tokens, matched, items.map((i) => i.text));
        ctx.onProgress({ fraction: 1, message: `${table.cells.length} cells` });
        return { success: true, html };
    } finally {
        bmp.close();
    }
}
