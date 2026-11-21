import type { EdgeContext } from "../context.js";
import type { SlotImpl } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError } from "../util/errors.js";
import { fileStem } from "../util/text.js";
import { guard, readAsset } from "./common.js";

type MB = typeof import("mediabunny");

async function openInput(bytes: Uint8Array) {
    const mb: MB = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
    return { mb, input };
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

/** `extract-audio`: the primary audio track of a video, remuxed without re-encoding when possible. */
export const extractAudio: SlotImpl<"extract-audio"> = (input, ctx) =>
    guard(ctx, async () => {
        const video = input.video;
        const bytes = readAsset(video, "video");
        const { mb, input: media } = await openInput(bytes);
        try {
            const track = await media.getPrimaryAudioTrack();
            if (!track) throw new EdgeError("this file has no audio track");
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
            if (!conversion.isValid) {
                const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join("; ");
                throw new EdgeError(`cannot extract this audio track (${track.codec ?? "unknown codec"}${why ? `; ${why}` : ""})`);
            }
            conversion.onProgress = (p) => ctx.onProgress({ fraction: p, message: "extracting audio" });
            const off = onAbortCancel(ctx, () => conversion.cancel());
            try {
                await conversion.execute();
            } finally {
                off();
            }
            const buf = output.target.buffer;
            if (!buf) throw new EdgeError("audio extraction produced no output");
            return {
                success: true,
                audio: {
                    bytesBase64: encodeBase64(new Uint8Array(buf)),
                    mime: out.mime,
                    filename: `${fileStem(video.filename, "audio")}.${out.ext}`,
                },
            };
        } finally {
            media.dispose();
        }
    });

/** `get-first-frame`: the first decodable frame as PNG (WebCodecs; browser only). */
export const getFirstFrame: SlotImpl<"get-first-frame"> = (input, ctx) =>
    guard(ctx, async () => {
        const video = input.video;
        const bytes = readAsset(video, "video");
        if (typeof VideoDecoder === "undefined" || typeof OffscreenCanvas === "undefined") {
            throw new EdgeError("get-first-frame needs WebCodecs and OffscreenCanvas (a browser)");
        }
        const { mb, input: media } = await openInput(bytes);
        try {
            const track = await media.getPrimaryVideoTrack();
            if (!track) throw new EdgeError("this file has no video track");
            if (!(await track.canDecode())) {
                throw new EdgeError(`this browser cannot decode ${track.codec ?? "this"} video`);
            }
            const sink = new mb.CanvasSink(track, { poolSize: 1 });
            const start = await track.getFirstTimestamp();
            const wrapped = await sink.getCanvas(start);
            if (!wrapped) throw new EdgeError("no decodable frame found");
            const canvas = wrapped.canvas;
            let blob: Blob;
            if ("convertToBlob" in canvas) {
                blob = await canvas.convertToBlob({ type: "image/png" });
            } else {
                blob = await new Promise<Blob>((res, rej) =>
                    (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new EdgeError("PNG encoding failed"))), "image/png"),
                );
            }
            const png = new Uint8Array(await blob.arrayBuffer());
            return {
                success: true,
                image: {
                    bytesBase64: encodeBase64(png),
                    mime: "image/png",
                    filename: `${fileStem(video.filename, "frame")}-first.png`,
                },
            };
        } finally {
            media.dispose();
        }
    });
