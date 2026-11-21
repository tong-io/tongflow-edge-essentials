/**
 * The media slots: `extract-audio`, `get-first-frame`, `get-last-frame`,
 * `remove-video-audio`, `merge-video-audio`, `concat-videos`.
 *
 * Default: Mediabunny demuxes and muxes (stream copy, no re-encoding where the
 * containers allow), WebCodecs decodes frames. Files the browser cannot read (AVI,
 * WMV/WMA, RealMedia, AMR, MPEG-2, …) fall back to ffmpeg.wasm automatically, and the
 * node's model `ffmpeg-wasm` ("换实现") forces it; see `ffmpeg/select.ts`. The ffmpeg
 * side mirrors the Python `tongflow-modal-ffmpeg` plugin (`ffmpeg/ops.ts`): MP4 for
 * video outputs, PNG for frames, `-shortest` + AAC for merging, stream-copy concat when
 * every clip matches and H.264/AAC at the largest size when they do not.
 *
 * Lazy chunk: `slots/media.ts` are the thin wrappers in the plugin entry.
 */
import type { EdgeContext } from "../context.js";
import { withFfmpegFallback } from "../ffmpeg/select.js";
import type { SlotImpl } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, MAX_ASSET_BYTES, MediaUnsupportedError, errorMessage } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { guard, readAsset } from "../slots/common.js";
import { noTrack } from "./no-track.js";

type MB = typeof import("mediabunny");
type Input = import("mediabunny").Input;
type VideoTrack = import("mediabunny").InputVideoTrack;
type AudioTrack = import("mediabunny").InputAudioTrack;
type Conversion = import("mediabunny").Conversion;
type Packet = import("mediabunny").EncodedPacket;

const ffmpeg = () => import("../ffmpeg/ops.js");

async function openInput(bytes: Uint8Array) {
    const mb: MB = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
    return { mb, input };
}

/** The primary track of `kind`; a file Mediabunny cannot demux is {@link MediaUnsupportedError}. */
async function primary(input: Input, kind: "video", what?: string): Promise<VideoTrack>;
async function primary(input: Input, kind: "audio", what?: string): Promise<AudioTrack>;
async function primary(input: Input, kind: "video" | "audio", what = "this file"): Promise<VideoTrack | AudioTrack> {
    let track: VideoTrack | AudioTrack | null;
    try {
        track = kind === "video" ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    } catch (e) {
        throw new MediaUnsupportedError(`the browser cannot read ${what} (${errorMessage(e)})`);
    }
    if (!track) throw await noTrack(input, kind, what);
    return track;
}

/**
 * Container for an audio-only copy of `codec`, chosen so the samples are remuxed
 * as-is (no decode, no quality loss). Anything else is transcoded to AAC in .m4a by
 * WebCodecs.
 */
function containerFor(mb: MB, codec: string | null) {
    switch (codec) {
        case "aac":
        case "ac3":
        case "eac3":
            return { format: new mb.Mp4OutputFormat(), ext: "m4a", mime: "audio/mp4", codec: undefined };
        case "mp3":
            return { format: new mb.Mp3OutputFormat(), ext: "mp3", mime: "audio/mpeg", codec: undefined };
        case "opus":
        case "vorbis":
            // WebM → audio-only WebM is a straight remux (WebM → Ogg needs a decode).
            return { format: new mb.WebMOutputFormat(), ext: "webm", mime: "audio/webm", codec: undefined };
        case "flac":
            return { format: new mb.FlacOutputFormat(), ext: "flac", mime: "audio/flac", codec: undefined };
        default:
            if (codec?.startsWith("pcm-") || codec === "ulaw" || codec === "alaw") {
                return { format: new mb.WavOutputFormat(), ext: "wav", mime: "audio/wav", codec: undefined };
            }
            return { format: new mb.Mp4OutputFormat(), ext: "m4a", mime: "audio/mp4", codec: "aac" as const };
    }
}

function onAbortCancel(ctx: EdgeContext, cancel: () => unknown) {
    const fn = () => void cancel();
    ctx.signal.addEventListener("abort", fn, { once: true });
    return () => ctx.signal.removeEventListener("abort", fn);
}

/** Run a Mediabunny conversion; one it cannot do (no decoder/encoder for a track) is {@link MediaUnsupportedError}. */
async function runConversion(ctx: EdgeContext, conversion: Conversion, what: string, message: string): Promise<void> {
    if (!conversion.isValid) {
        const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join("; ");
        throw new MediaUnsupportedError(`the browser cannot ${what}${why ? ` (${why})` : ""}`);
    }
    conversion.onProgress = (p) => ctx.onProgress({ fraction: p, message });
    const off = onAbortCancel(ctx, () => conversion.cancel());
    try {
        await conversion.execute();
    } finally {
        off();
    }
}

const mp4 = (mb: MB) => new mb.Mp4OutputFormat({ fastStart: "in-memory" });

function mp4Copyable(mb: MB, codec: string | null): codec is NonNullable<VideoTrack["codec"]> {
    return !!codec && (mp4(mb).getSupportedCodecs() as string[]).includes(codec);
}

// ---------- extract-audio ----------

async function extractAudioInBrowser(bytes: Uint8Array, ctx: EdgeContext): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
    const { mb, input: media } = await openInput(bytes);
    try {
        const track = await primary(media, "audio");
        const out = containerFor(mb, track.codec);
        const output = new mb.Output({ format: out.format, target: new mb.BufferTarget() });
        const conversion = await mb.Conversion.init({
            input: media,
            output,
            tracks: "primary",
            video: { discard: true },
            audio: out.codec ? { codec: out.codec } : {},
            // Opus/AAC streams usually start a few ms before zero (encoder pre-skip);
            // allow a small shift so they are copied instead of transcoded.
            copy: { shiftTolerance: 1 },
            showWarnings: false,
        });
        await runConversion(ctx, conversion, `extract this audio track (${track.codec ?? "unknown codec"})`, "extracting audio");
        const buf = output.target.buffer;
        if (!buf) throw new EdgeError("audio extraction produced no output");
        return { bytes: new Uint8Array(buf), ext: out.ext, mime: out.mime };
    } finally {
        media.dispose();
    }
}

/** `extract-audio`: the primary audio track of a video, remuxed without re-encoding when possible. */
export const extractAudio: SlotImpl<"extract-audio"> = (input, ctx) =>
    guard(ctx, async () => {
        const video = input.video;
        const bytes = readAsset(video, "video");
        const r = await withFfmpegFallback(
            ctx,
            "extracting audio",
            () => extractAudioInBrowser(bytes, ctx),
            async () => (await ffmpeg()).extractAudio(ctx, bytes, video.filename),
        );
        return {
            success: true,
            audio: { bytesBase64: encodeBase64(r.bytes), mime: r.mime, filename: `${fileStem(video.filename, "audio")}.${r.ext}` },
        };
    });

// ---------- get-first-frame / get-last-frame ----------

async function canvasPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
    let blob: Blob;
    if ("convertToBlob" in canvas) {
        blob = await canvas.convertToBlob({ type: "image/png" });
    } else {
        blob = await new Promise<Blob>((res, rej) =>
            (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new EdgeError("PNG encoding failed"))), "image/png"),
        );
    }
    return new Uint8Array(await blob.arrayBuffer());
}

/** First (`last = false`) or last frame as PNG with Mediabunny + WebCodecs. */
async function frameInBrowser(bytes: Uint8Array, last: boolean): Promise<Uint8Array> {
    if (typeof VideoDecoder === "undefined" || typeof OffscreenCanvas === "undefined") {
        throw new MediaUnsupportedError("this browser has no WebCodecs / OffscreenCanvas");
    }
    const { mb, input: media } = await openInput(bytes);
    try {
        const track = await primary(media, "video");
        if (!(await track.canDecode())) throw new MediaUnsupportedError(`this browser cannot decode ${track.codec ?? "this"} video`);
        const sink = new mb.CanvasSink(track, { poolSize: 1 });
        let at: number;
        if (last) {
            // The last packet in presentation order: the frame shown at the end.
            const pkt = await new mb.EncodedPacketSink(track).getPacket(Infinity, { metadataOnly: true });
            if (!pkt) throw new EdgeError("no decodable frame found");
            at = pkt.timestamp;
        } else {
            at = await track.getFirstTimestamp();
        }
        const wrapped = await sink.getCanvas(at);
        if (!wrapped) throw new EdgeError("no decodable frame found");
        return await canvasPng(wrapped.canvas);
    } finally {
        media.dispose();
    }
}

function frameSlot(last: boolean): SlotImpl<"get-first-frame"> {
    return (input, ctx) =>
        guard(ctx, async () => {
            const video = input.video;
            const bytes = readAsset(video, "video");
            const png = await withFfmpegFallback(
                ctx,
                `getting the ${last ? "last" : "first"} frame`,
                () => frameInBrowser(bytes, last),
                async () => (await ffmpeg()).frame(ctx, bytes, video.filename, last),
            );
            return {
                success: true,
                image: { bytesBase64: encodeBase64(png), mime: "image/png", filename: `${fileStem(video.filename, "frame")}-${last ? "last" : "first"}.png` },
            };
        });
}

/** `get-first-frame`: the first decodable frame as PNG (WebCodecs; ffmpeg.wasm fallback). */
export const getFirstFrame: SlotImpl<"get-first-frame"> = frameSlot(false);

/** `get-last-frame`: the last frame (presentation order) as PNG (WebCodecs; ffmpeg.wasm fallback). */
export const getLastFrame: SlotImpl<"get-last-frame"> = frameSlot(true) as SlotImpl<"get-last-frame">;

// ---------- remove-video-audio ----------

async function removeAudioInBrowser(bytes: Uint8Array, ctx: EdgeContext): Promise<Uint8Array> {
    const { mb, input: media } = await openInput(bytes);
    try {
        const track = await primary(media, "video");
        if (!mp4Copyable(mb, track.codec)) throw new MediaUnsupportedError(`the browser cannot copy ${track.codec ?? "this"} video into MP4`);
        const output = new mb.Output({ format: mp4(mb), target: new mb.BufferTarget() });
        const conversion = await mb.Conversion.init({
            input: media,
            output,
            tracks: "primary",
            audio: { discard: true },
            // Copy the video as-is, like `ffmpeg -an -vcodec copy`.
            copy: { mode: "forced", shiftTolerance: Infinity },
            showWarnings: false,
        });
        await runConversion(ctx, conversion, "copy this video", "removing audio");
        const buf = output.target.buffer;
        if (!buf) throw new EdgeError("removing the audio produced no output");
        return new Uint8Array(buf);
    } finally {
        media.dispose();
    }
}

/** `remove-video-audio`: the video stream copied into a silent MP4 (`-an -vcodec copy`). */
export const removeVideoAudio: SlotImpl<"remove-video-audio"> = (input, ctx) =>
    guard(ctx, async () => {
        const video = input.video;
        const bytes = readAsset(video, "video");
        const out = await withFfmpegFallback(
            ctx,
            "removing the audio",
            () => removeAudioInBrowser(bytes, ctx),
            async () => (await ffmpeg()).removeAudio(ctx, bytes, video.filename),
        );
        return {
            success: true,
            video: { bytesBase64: encodeBase64(out), mime: "video/mp4", filename: `${fileStem(video.filename, "video")}-noaudio.mp4` },
        };
    });

// ---------- packet copying (merge, concat) ----------

function sameBytes(a: AllowSharedBufferSource | undefined, b: AllowSharedBufferSource | undefined): boolean {
    if (!a || !b) return !a && !b;
    const x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
    const y = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** End time of a track: the latest packet end, in presentation order. */
async function trackEnd(mb: MB, track: VideoTrack | AudioTrack): Promise<number> {
    const last = await new mb.EncodedPacketSink(track).getPacket(Infinity, { metadataOnly: true });
    return last ? last.timestamp + last.duration : 0;
}

/** Copy `track`'s packets (decode order) at `pts - from + offset`, leaving out those at or after `until` (source time). */
async function copyPackets(
    mb: MB,
    track: VideoTrack | AudioTrack,
    add: (p: Packet, first: boolean) => Promise<void>,
    from: number,
    offset: number,
    until: number,
    signal: AbortSignal,
): Promise<void> {
    let first = true;
    for await (const p of new mb.EncodedPacketSink(track).packets()) {
        if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        if (p.timestamp >= until) continue;
        await add(p.clone({ timestamp: Math.max(0, p.timestamp - from + offset) }), first);
        first = false;
    }
}

// ---------- merge-video-audio ----------

/**
 * The audio input as AAC packets: copied when it is AAC already, else decoded and
 * re-encoded to AAC by WebCodecs (the Modal plugin's `-c:a aac`) into a temporary M4A.
 */
async function aacTrack(mb: MB, audioIn: Input, ctx: EdgeContext): Promise<{ track: AudioTrack; dispose(): void }> {
    const track = await primary(audioIn, "audio", "the audio input");
    if (track.codec === "aac") return { track, dispose() {} };
    if (typeof AudioEncoder === "undefined" || !(await track.canDecode()) || !(await mb.canEncodeAudio("aac"))) {
        throw new MediaUnsupportedError(`the browser cannot re-encode ${track.codec ?? "this"} audio to AAC`);
    }
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({
        input: audioIn,
        output,
        tracks: "primary",
        video: { discard: true },
        audio: { codec: "aac", bitrate: 128e3 },
        showWarnings: false,
    });
    await runConversion(ctx, conversion, "encode the audio to AAC", "encoding the audio to AAC");
    const buf = output.target.buffer;
    if (!buf) throw new EdgeError("encoding the audio produced no output");
    const m4a = new mb.Input({ source: new mb.BufferSource(new Uint8Array(buf)), formats: mb.ALL_FORMATS });
    return { track: await primary(m4a, "audio", "the encoded audio"), dispose: () => m4a.dispose() };
}

async function mergeInBrowser(videoBytes: Uint8Array, audioBytes: Uint8Array, ctx: EdgeContext): Promise<Uint8Array> {
    const mb: MB = await import("mediabunny");
    const vIn = new mb.Input({ source: new mb.BufferSource(videoBytes), formats: mb.ALL_FORMATS });
    const aIn = new mb.Input({ source: new mb.BufferSource(audioBytes), formats: mb.ALL_FORMATS });
    try {
        const vt = await primary(vIn, "video", "the video input");
        const vCodec = vt.codec;
        if (!mp4Copyable(mb, vCodec)) throw new MediaUnsupportedError(`the browser cannot copy ${vCodec ?? "this"} video into MP4`);
        const vConfig = await vt.getDecoderConfig();
        if (!vConfig) throw new MediaUnsupportedError("the browser cannot read this video's decoder configuration");
        const aac = await aacTrack(mb, aIn, ctx);
        try {
            const at = aac.track;
            const aConfig = await at.getDecoderConfig();
            if (!aConfig) throw new MediaUnsupportedError("the browser cannot read the audio's decoder configuration");
            const vStart = await vt.getFirstTimestamp();
            const aStart = await at.getFirstTimestamp();
            // `-shortest`: the output ends with the shorter stream.
            const length = Math.min((await trackEnd(mb, vt)) - vStart, (await trackEnd(mb, at)) - aStart);
            const output = new mb.Output({ format: mp4(mb), target: new mb.BufferTarget() });
            const vSrc = new mb.EncodedVideoPacketSource(vCodec);
            const aSrc = new mb.EncodedAudioPacketSource("aac");
            output.addVideoTrack(vSrc, { rotation: vt.rotation });
            output.addAudioTrack(aSrc);
            await output.start();
            ctx.onProgress({ fraction: 0.5, message: "merging video and audio" });
            await copyPackets(mb, vt, (p, first) => vSrc.add(p, first ? { decoderConfig: vConfig } : undefined), vStart, 0, vStart + length, ctx.signal);
            await copyPackets(mb, at, (p, first) => aSrc.add(p, first ? { decoderConfig: aConfig } : undefined), aStart, 0, aStart + length, ctx.signal);
            vSrc.close();
            aSrc.close();
            await output.finalize();
            const buf = output.target.buffer;
            if (!buf) throw new EdgeError("merging produced no output");
            return new Uint8Array(buf);
        } finally {
            aac.dispose();
        }
    } finally {
        vIn.dispose();
        aIn.dispose();
    }
}

/** `merge-video-audio`: the video stream copied, the audio as AAC, cut to the shorter one (MP4). */
export const mergeVideoAudio: SlotImpl<"merge-video-audio"> = (input, ctx) =>
    guard(ctx, async () => {
        const video = readAsset(input.video, "video");
        const audio = readAsset(input.audio, "audio");
        const out = await withFfmpegFallback(
            ctx,
            "merging video and audio",
            () => mergeInBrowser(video, audio, ctx),
            async () =>
                (await ffmpeg()).mergeAudio(ctx, { bytes: video, filename: input.video.filename }, { bytes: audio, filename: input.audio.filename }),
        );
        return {
            success: true,
            video: { bytesBase64: encodeBase64(out), mime: "video/mp4", filename: `${fileStem(input.video.filename, "video")}-merged.mp4` },
        };
    });

// ---------- concat-videos ----------

interface Clip {
    input: Input;
    video: VideoTrack;
    audio: AudioTrack | null;
    vConfig: VideoDecoderConfig;
    aConfig: AudioDecoderConfig | null;
    start: number;
    end: number;
}

async function openClip(mb: MB, input: Input, i: number): Promise<Clip> {
    const video = await primary(input, "video", `video ${i + 1}`);
    const audio = await input.getPrimaryAudioTrack();
    const vConfig = await video.getDecoderConfig();
    if (!video.codec || !vConfig) throw new MediaUnsupportedError(`the browser cannot read video ${i + 1}'s codec`);
    const aConfig = audio ? await audio.getDecoderConfig() : null;
    if (audio && (!audio.codec || !aConfig)) throw new MediaUnsupportedError(`the browser cannot read video ${i + 1}'s audio codec`);
    const tracks = audio ? [video, audio] : [video];
    const start = Math.min(...(await Promise.all(tracks.map((t) => t.getFirstTimestamp()))));
    const end = Math.max(...(await Promise.all(tracks.map((t) => trackEnd(mb, t)))));
    return { input, video, audio, vConfig, aConfig, start, end };
}

/** Whether `c` can be stream-copied after `c0`: same codecs, size and codec setup (description). */
function matches(c: Clip, c0: Clip): "video" | "audio" | null {
    const v = c.vConfig;
    const v0 = c0.vConfig;
    if (c.video.codec !== c0.video.codec || v.codec !== v0.codec || v.codedWidth !== v0.codedWidth || v.codedHeight !== v0.codedHeight || !sameBytes(v.description, v0.description)) return "video";
    const a = c.aConfig;
    const a0 = c0.aConfig;
    if (!a !== !a0) return "audio";
    if (a && a0 && (a.codec !== a0.codec || a.sampleRate !== a0.sampleRate || a.numberOfChannels !== a0.numberOfChannels || !sameBytes(a.description, a0.description))) return "audio";
    return null;
}

/** Stream-copy concatenation: only when every clip has the same codecs, size and codec setup. */
async function concatInBrowser(clips: Uint8Array[], ctx: EdgeContext): Promise<Uint8Array> {
    const mb: MB = await import("mediabunny");
    const inputs = clips.map((b) => new mb.Input({ source: new mb.BufferSource(b), formats: mb.ALL_FORMATS }));
    try {
        const opened: Clip[] = [];
        for (let i = 0; i < inputs.length; i++) opened.push(await openClip(mb, inputs[i]!, i));
        const c0 = opened[0]!;
        if (!mp4Copyable(mb, c0.video.codec)) throw new MediaUnsupportedError(`the browser cannot copy ${c0.video.codec} video into MP4`);
        opened.forEach((c, i) => {
            const diff = matches(c, c0);
            if (diff) throw new MediaUnsupportedError(`video ${i + 1} differs from video 1 in ${diff} codec, size or setup, so the clips must be re-encoded`);
        });
        const output = new mb.Output({ format: mp4(mb), target: new mb.BufferTarget() });
        const vSrc = new mb.EncodedVideoPacketSource(c0.video.codec);
        output.addVideoTrack(vSrc, { rotation: c0.video.rotation });
        const aSrc = c0.audio?.codec ? new mb.EncodedAudioPacketSource(c0.audio.codec) : null;
        if (aSrc) output.addAudioTrack(aSrc);
        await output.start();
        let offset = 0;
        let vMeta: EncodedVideoChunkMetadata | undefined = { decoderConfig: c0.vConfig };
        let aMeta: EncodedAudioChunkMetadata | undefined = c0.aConfig ? { decoderConfig: c0.aConfig } : undefined;
        for (const [i, c] of opened.entries()) {
            ctx.onProgress({ fraction: i / opened.length, message: `concatenating ${i + 1}/${opened.length}` });
            await copyPackets(mb, c.video, (p) => vSrc.add(p, vMeta).finally(() => (vMeta = undefined)), c.start, offset, Infinity, ctx.signal);
            if (aSrc && c.audio) await copyPackets(mb, c.audio, (p) => aSrc.add(p, aMeta).finally(() => (aMeta = undefined)), c.start, offset, Infinity, ctx.signal);
            offset += c.end - c.start;
        }
        vSrc.close();
        aSrc?.close();
        await output.finalize();
        const buf = output.target.buffer;
        if (!buf) throw new EdgeError("concatenation produced no output");
        return new Uint8Array(buf);
    } finally {
        for (const input of inputs) input.dispose();
    }
}

/** `concat-videos`: the clips end to end as one MP4; stream copy when they match, else re-encoded by ffmpeg.wasm. */
export const concatVideos: SlotImpl<"concat-videos"> = (input, ctx) =>
    guard(ctx, async () => {
        const list = Array.isArray(input.videos) ? input.videos : [];
        if (!list.length) throw new EdgeError("missing videos: expected a non-empty Asset[]");
        const clips = list.map((v, i) => readAsset(v, `videos[${i}]`));
        if (clips.reduce((a, c) => a + c.byteLength, 0) > MAX_ASSET_BYTES) {
            throw new EdgeError("the videos add up to more than 100 MB, the edge runtime's per-file limit for the result");
        }
        const out = await withFfmpegFallback(
            ctx,
            "concatenating",
            () => concatInBrowser(clips, ctx),
            async () => (await ffmpeg()).concat(ctx, clips.map((bytes, i) => ({ bytes, filename: list[i]!.filename }))),
        );
        return {
            success: true,
            video: { bytesBase64: encodeBase64(out), mime: "video/mp4", filename: `${fileStem(list[0]!.filename, "video")}-concat.mp4` },
        };
    });
