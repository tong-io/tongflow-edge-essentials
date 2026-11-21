/**
 * `split-video`: shot boundaries with TransNetV2 (onnxruntime-web) on frames sampled at a
 * low rate by Mediabunny, refined to the exact frame, then one file per shot, remuxed
 * without re-encoding whenever the cut falls on a key frame. Without the model (not
 * mirrored, fails to load) a colour-histogram frame-difference detector is used.
 */
import type { EdgeContext } from "../context.js";
import type { Asset, EdgeSlotOutput, SlotInput } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { readAsset } from "../slots/common.js";
import { fetchModelFile, memo } from "../ml/model-files.js";
import { type LoadedSession, createDeviceSession, run, tensor } from "../ml/ort.js";
import {
    TNV2_H,
    TNV2_W,
    TNV2_WINDOW,
    boundariesFromScenes,
    diffBoundaries,
    predictionsToScenes,
    sharpestCut,
    sigmoid,
    stitch,
    transnetThreshold,
    windowIndices,
} from "./shots.js";

type MB = typeof import("mediabunny");
type Input = import("mediabunny").Input;
type VideoTrack = import("mediabunny").InputVideoTrack;

const TRANSNET = "transnetv2";
const sessions = memo<LoadedSession>();

/** Default sampling rate for detection (frames per second): at 4 fps TransNetV2 misses and invents cuts on fast-moving content; 10 fps was clean in tests. */
export const SAMPLE_FPS = 10;
/** Shots shorter than this are merged into the previous one. */
const MIN_SHOT_S = 0.3;

function rgbOf(canvas: OffscreenCanvas | HTMLCanvasElement): Uint8Array {
    const g = (canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    if (!g) throw new EdgeError("could not read video frame pixels");
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const out = new Uint8Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        out[j] = d[i]!;
        out[j + 1] = d[i + 1]!;
        out[j + 2] = d[i + 2]!;
    }
    return out;
}

async function sampleFrames(mb: MB, track: VideoTrack, times: number[], ctx: EdgeContext, span: [number, number]): Promise<Uint8Array[]> {
    const sink = new mb.CanvasSink(track, { width: TNV2_W, height: TNV2_H, fit: "fill", poolSize: 2 });
    const frames: Uint8Array[] = [];
    let last: Uint8Array | undefined;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
        throwIfAborted(ctx.signal);
        const px = wc ? rgbOf(wc.canvas) : (last ?? new Uint8Array(TNV2_W * TNV2_H * 3));
        frames.push(px);
        last = px;
        if (frames.length % 20 === 0) {
            ctx.onProgress({ fraction: span[0] + (span[1] - span[0]) * (frames.length / times.length), message: `sampled ${frames.length}/${times.length} frames` });
        }
    }
    return frames;
}

/**
 * Per-sample transition probability from TransNetV2's single-frame head. The model takes
 * `[1, 100, 27, 48, 3]` float32 RGB in 0..255 (it scales internally; fed 0..1, every
 * output stays below 0.15 and no cut is found). The community export's two outputs
 * (single-frame, then many-hot) already end in a sigmoid; a logit export is detected
 * and squashed.
 */
async function transnet(ctx: EdgeContext, frames: Uint8Array[], span: [number, number]): Promise<Float32Array> {
    const s = await sessions(TRANSNET, async () => createDeviceSession(ctx, await fetchModelFile(ctx, TRANSNET, "transnetv2.onnx"), "wasm"));
    const wins = windowIndices(frames.length);
    const per = TNV2_W * TNV2_H * 3;
    const outs: Float32Array[] = [];
    const outName = s.session.outputNames[0]!;
    for (let w = 0; w < wins.length; w++) {
        throwIfAborted(ctx.signal);
        const data = new Float32Array(TNV2_WINDOW * per);
        wins[w]!.forEach((fi, k) => {
            const f = frames[fi]!;
            for (let i = 0; i < per; i++) data[k * per + i] = f[i]!;
        });
        const out = await run(s, { [s.session.inputNames[0]!]: await tensor(ctx, data, [1, TNV2_WINDOW, TNV2_H, TNV2_W, 3]) });
        const raw = out[outName]!.data as Float32Array;
        const isLogit = raw.some((v) => v < 0 || v > 1);
        outs.push(isLogit ? raw.map(sigmoid) : raw.slice());
        ctx.onProgress({ fraction: span[0] + (span[1] - span[0]) * ((w + 1) / wins.length), message: `shot detection ${w + 1}/${wins.length}` });
    }
    return stitch(outs, frames.length);
}

/** Exact cut time between two samples: the sharpest change among the full-rate frames in between. */
async function refineCut(mb: MB, track: VideoTrack, t0: number, t1: number): Promise<number> {
    const sink = new mb.CanvasSink(track, { width: TNV2_W, height: TNV2_H, fit: "fill", poolSize: 2 });
    const frames: Uint8Array[] = [];
    const stamps: number[] = [];
    for await (const wc of sink.canvases(t0, t1 + 1e-3)) {
        frames.push(rgbOf(wc.canvas));
        stamps.push(wc.timestamp);
        if (frames.length > 400) break;
    }
    if (frames.length < 2) return t1;
    return stamps[sharpestCut(frames)]!;
}

function outputFor(mb: MB, formatName: string, mime: string) {
    const n = formatName.toLowerCase();
    if (n.includes("webm")) return { format: new mb.WebMOutputFormat(), ext: "webm", mime: "video/webm" };
    if (n.includes("matroska")) return { format: new mb.MkvOutputFormat(), ext: "mkv", mime: "video/x-matroska" };
    if (n.includes("quicktime")) return { format: new mb.MovOutputFormat(), ext: "mov", mime: "video/quicktime" };
    if (n.includes("mp4") || mime.includes("mp4")) return { format: new mb.Mp4OutputFormat(), ext: "mp4", mime: "video/mp4" };
    return { format: new mb.Mp4OutputFormat(), ext: "mp4", mime: "video/mp4" };
}

async function cutPart(
    mb: MB,
    media: Input,
    formatName: string,
    mime: string,
    start: number,
    end: number,
    tolerance: number,
    ctx: EdgeContext,
): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
    const attempt = async (copy: import("mediabunny").ConversionCopyOptions) => {
        const o = outputFor(mb, formatName, mime);
        const output = new mb.Output({ format: o.format, target: new mb.BufferTarget() });
        const conv = await mb.Conversion.init({ input: media, output, trim: { start, end }, copy, showWarnings: false });
        if (!conv.isValid) throw new EdgeError(conv.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join("; ") || "invalid conversion");
        const cancel = () => void conv.cancel();
        ctx.signal.addEventListener("abort", cancel, { once: true });
        try {
            await conv.execute();
        } finally {
            ctx.signal.removeEventListener("abort", cancel);
        }
        const buf = output.target.buffer;
        if (!buf) throw new EdgeError("cutting produced no output");
        return { bytes: new Uint8Array(buf), ext: o.ext, mime: o.mime };
    };
    try {
        // Precise cut: copy when the start is (within a frame of) a key frame, else re-encode.
        return await attempt({ mode: "preferred", boundaryTolerance: tolerance, shiftTolerance: tolerance });
    } catch (e) {
        if (ctx.signal.aborted) throw e;
        // No encoder for this codec: copy from the key frame at or before the cut.
        return attempt({ mode: "forced", boundaryPolicy: "expand", boundaryTolerance: Infinity, shiftTolerance: Infinity });
    }
}

export interface ShotInfo {
    start: number;
    end: number;
}

export async function splitVideo(input: SlotInput<"split-video">, ctx: EdgeContext): Promise<EdgeSlotOutput<"split-video">> {
    const video = input.video;
    const bytes = readAsset(video, "video");
    if (typeof VideoDecoder === "undefined" || typeof OffscreenCanvas === "undefined") {
        throw new EdgeError("split-video needs WebCodecs and OffscreenCanvas (a browser)");
    }
    const mb: MB = await import("mediabunny");
    const media = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
    try {
        const track = await media.getPrimaryVideoTrack();
        if (!track) throw new EdgeError("this file has no video track");
        if (!(await track.canDecode())) throw new EdgeError(`this browser cannot decode ${track.codec ?? "this"} video`);
        const format = await media.getFormat();
        const start = await track.getFirstTimestamp();
        const duration = await media.computeDuration();
        const stats = await track.computePacketStats(200);
        const nativeFps = stats.averagePacketRate || 25;
        const fps = Math.max(1, Math.min(nativeFps, Number(ctx.params?.fps) || SAMPLE_FPS));
        const times: number[] = [];
        for (let t = start; t < duration - 1e-6; t += 1 / fps) times.push(t);
        if (times.length < 2) throw new EdgeError("the video is too short to split");

        ctx.onProgress({ fraction: 0, message: `sampling ${times.length} frames at ${fps} fps` });
        const frames = await sampleFrames(mb, track, times, ctx, [0, 0.35]);

        let boundaries: number[];
        let method = "transnetv2";
        try {
            const pred = await transnet(ctx, frames, [0.35, 0.6]);
            const threshold = transnetThreshold(input.threshold);
            boundaries = boundariesFromScenes(predictionsToScenes(pred, threshold));
        } catch (e) {
            if (ctx.signal.aborted) throw e;
            method = "frame-difference";
            ctx.onProgress({ fraction: 0.6, message: `TransNetV2 unavailable (${e instanceof Error ? e.message : String(e)}); using frame differences` });
            boundaries = diffBoundaries(frames);
        }

        // Exact cut frames, snapped to a key frame when one is within a frame.
        const packets = new mb.EncodedPacketSink(track);
        const frameDur = 1 / nativeFps;
        const cuts: number[] = [];
        for (const k of boundaries) {
            throwIfAborted(ctx.signal);
            let t = await refineCut(mb, track, times[k - 1]!, times[k]!);
            const key = await packets.getKeyPacket(t + frameDur * 0.5);
            if (key && Math.abs(key.timestamp - t) <= frameDur * 1.01) t = key.timestamp;
            if (t - (cuts.at(-1) ?? start) >= MIN_SHOT_S && duration - t >= MIN_SHOT_S) cuts.push(t);
        }
        const shots: ShotInfo[] = [];
        let s0 = start;
        for (const c of cuts) {
            shots.push({ start: s0, end: c });
            s0 = c;
        }
        shots.push({ start: s0, end: duration });
        ctx.onProgress({ fraction: 0.65, message: `${shots.length} shots (${method})` });

        const stem = fileStem(video.filename, "video");
        const pad = String(shots.length).length;
        const parts: Asset[] = [];
        if (shots.length === 1) {
            const o = outputFor(mb, format.name, format.mimeType);
            parts.push({ bytesBase64: video.bytesBase64, mime: video.mime ?? o.mime, filename: `${stem}-shot${"1".padStart(pad, "0")}.${o.ext}` });
        } else {
            for (let i = 0; i < shots.length; i++) {
                const sh = shots[i]!;
                const r = await cutPart(mb, media, format.name, format.mimeType, sh.start, sh.end, Math.max(0.05, frameDur * 1.5), ctx);
                parts.push({ bytesBase64: encodeBase64(r.bytes), mime: r.mime, filename: `${stem}-shot${String(i + 1).padStart(pad, "0")}.${r.ext}` });
                ctx.onProgress({ fraction: 0.65 + 0.35 * ((i + 1) / shots.length), message: `shot ${i + 1}/${shots.length}` });
            }
        }
        return { success: true, video_parts: parts };
    } finally {
        media.dispose();
    }
}
