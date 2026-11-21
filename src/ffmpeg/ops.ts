/**
 * The media operations on ffmpeg.wasm (lazy chunk). Each one mirrors the browser
 * path it backs up, and the commands of the Python `tongflow-modal-ffmpeg` plugin for
 * the same slots, so the two implementations are interchangeable in a graph:
 *
 * | slot | ffmpeg here | Modal plugin |
 * |---|---|---|
 * | extract-audio | stream copy into a matching container, else MP3 (libmp3lame) | `-vn -acodec libmp3lame` → .mp3 |
 * | get-first-frame / get-last-frame | first / last decoded frame → PNG | frame at t=0 / duration − ½ frame → PNG |
 * | remove-video-audio | `-an -c:v copy` → MP4 (H.264 if the codec cannot go in MP4) | `-an -vcodec copy` → .mp4 |
 * | merge-video-audio | `-c:v copy -c:a aac -shortest` → MP4 | same |
 * | concat-videos | concat demuxer `-c copy` when all streams match, else H.264/AAC (CRF 23) at the largest size | same (preset fast; moviepy "compose") |
 *
 * Re-encoding is H.264 CRF 23 with preset `veryfast`: the single-threaded wasm x264 is
 * ≈7 fps at 720p with `fast`, and the preset changes speed and file size, not the
 * quality target.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import type { FfmpegJob } from "./protocol.js";
import { ffmpegOut, logTail, runFfmpeg } from "./runner.js";

export interface StreamInfo {
    index: number;
    type: "video" | "audio" | string;
    codec: string;
    width?: number;
    height?: number;
    sampleRate?: number;
    channels?: number;
    fps?: number;
    duration?: number;
    /** Cover art (`attached pic`), not a video. */
    attachedPic?: boolean;
}

export interface Probe {
    /** Seconds (0 when unknown). */
    duration: number;
    format: string;
    video?: StreamInfo;
    audio?: StreamInfo;
    streams: StreamInfo[];
}

const W = "/w/";
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "128k"];
const MP4 = ["-movflags", "+faststart"];
/** ffmpeg's banner and per-frame stats only cost log lines. */
const QUIET = ["-hide_banner", "-nostats", "-y"];

/** `in0.avi`: the input's name inside MEMFS, keeping a sane extension as a demuxer hint. */
export function inputName(filename: string | undefined, i = 0): string {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(filename ?? "")?.[1]?.toLowerCase() ?? "bin";
    return `in${i}.${ext}`;
}

function hms(v: string | undefined): number | undefined {
    const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v ?? "");
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/**
 * Stream information from ffmpeg's own input dump (`ffmpeg -i <file>`): the core's
 * ffprobe entry point is not re-entrant (it keeps option state between calls and
 * corrupts the next `exec`), so the plugin never calls it.
 */
export function parseProbe(log: string[]): Probe {
    const streams: StreamInfo[] = [];
    let duration = 0;
    let format = "";
    for (const line of log) {
        const input = /^Input #0, (.+?), from /.exec(line);
        if (input) format = input[1]!;
        const d = /^\s*Duration: ([\d:.]+|N\/A)/.exec(line);
        if (d) duration = hms(d[1]) ?? 0;
        const st = /^\s*Stream #0:(\d+)[^:]*: (Video|Audio|Subtitle|Data|Attachment): ([\w-]+)(.*)$/.exec(line);
        if (!st) continue;
        const rest = st[4]!;
        const size = /,\s*(\d{1,5})x(\d{1,5})\b/.exec(rest);
        const fps = /,\s*([\d.]+)(k?) fps\b/.exec(rest) ?? /,\s*([\d.]+)(k?) tbr\b/.exec(rest);
        const hz = /,\s*(\d+) Hz\b/.exec(rest);
        const ch = /Hz, (mono|stereo|(\d+) channels|[\d.]+(?:\(\w+\))?)/.exec(rest);
        streams.push({
            index: Number(st[1]),
            type: st[2]!.toLowerCase(),
            codec: st[3]!,
            attachedPic: /\(attached pic\)/.test(rest),
            width: size ? Number(size[1]) : undefined,
            height: size ? Number(size[2]) : undefined,
            fps: fps ? Number(fps[1]) * (fps[2] ? 1000 : 1) : undefined,
            sampleRate: hz ? Number(hz[1]) : undefined,
            channels: ch ? (ch[1] === "mono" ? 1 : ch[1] === "stereo" ? 2 : ch[2] ? Number(ch[2]) : undefined) : undefined,
        });
    }
    if (!format && !streams.length) throw new EdgeError("ffmpeg found no readable streams in this file");
    const video = streams.find((s) => s.type === "video" && !s.attachedPic);
    const audio = streams.find((s) => s.type === "audio");
    return { duration, format, video, audio, streams };
}

export async function probe(ctx: EdgeContext, bytes: Uint8Array, filename?: string): Promise<Probe> {
    const name = inputName(filename);
    // No output file: ffmpeg prints the input dump and exits with 1, which is expected here.
    const res = await runFfmpeg(ctx, { args: ["-hide_banner", "-i", W + name], inputs: [{ name, data: bytes }], outputs: [] });
    if (!res.log.some((l) => l.startsWith("Input #0"))) throw new EdgeError(`ffmpeg cannot read this file: ${logTail(res.log)}`);
    return parseProbe(res.log);
}

function job(args: string[], inputs: FfmpegJob["inputs"], output: string): FfmpegJob {
    return { args: [...QUIET, ...args, W + output], inputs, outputs: [output] };
}

function progress(ctx: EdgeContext, message: string, from = 0, to = 1) {
    return (f: number) => ctx.onProgress({ fraction: from + (to - from) * f, message });
}

// ---------- extract-audio ----------

/** Stream-copy target for an audio codec (ffprobe names), or undefined → MP3. */
function audioCopyTarget(codec: string): { ext: string; mime: string; format: string } | undefined {
    if (codec === "aac") return { ext: "m4a", mime: "audio/mp4", format: "ipod" };
    if (codec === "mp3") return { ext: "mp3", mime: "audio/mpeg", format: "mp3" };
    if (codec === "flac") return { ext: "flac", mime: "audio/flac", format: "flac" };
    if (codec === "opus" || codec === "vorbis") return { ext: "webm", mime: "audio/webm", format: "webm" };
    if (/^pcm_(s16le|s24le|s32le|u8|f32le|mulaw|alaw)$/.test(codec)) return { ext: "wav", mime: "audio/wav", format: "wav" };
    return undefined;
}

export async function extractAudio(ctx: EdgeContext, bytes: Uint8Array, filename?: string): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
    const info = await probe(ctx, bytes, filename);
    if (!info.audio) throw new EdgeError("this file has no audio track");
    const name = inputName(filename);
    const inputs = [{ name, data: bytes }];
    const on = progress(ctx, "extracting audio (ffmpeg.wasm)");
    const copy = audioCopyTarget(info.audio.codec);
    if (copy) {
        const out = `out.${copy.ext}`;
        try {
            const b = await ffmpegOut(ctx, job(["-i", W + name, "-map", "0:a:0", "-vn", "-c:a", "copy", "-f", copy.format], inputs, out), on);
            return { bytes: b, ext: copy.ext, mime: copy.mime };
        } catch (e) {
            if (ctx.signal.aborted) throw e;
        }
    }
    const b = await ffmpegOut(ctx, job(["-i", W + name, "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-f", "mp3"], inputs, "out.mp3"), on);
    return { bytes: b, ext: "mp3", mime: "audio/mpeg" };
}

// ---------- frames ----------

/** The first (`last = false`) or last decodable frame as PNG. */
export async function frame(ctx: EdgeContext, bytes: Uint8Array, filename: string | undefined, last: boolean): Promise<Uint8Array> {
    const name = inputName(filename);
    const inputs = [{ name, data: bytes }];
    const on = progress(ctx, `${last ? "last" : "first"} frame (ffmpeg.wasm)`);
    const png = ["-map", "0:v:0", "-an", "-sn", "-f", "image2", "-c:v", "png"];
    if (!last) return ffmpegOut(ctx, job(["-i", W + name, ...png, "-frames:v", "1"], inputs, "frame.png"), on);
    // Decode only the last seconds, overwriting one PNG per frame; the survivor is the last frame.
    // Files without a usable duration or index (seeking fails) are decoded from the start.
    for (const seek of [["-sseof", "-3"], []]) {
        try {
            return await ffmpegOut(ctx, job([...seek, "-i", W + name, ...png, "-update", "1"], inputs, "frame.png"), on);
        } catch (e) {
            if (ctx.signal.aborted || !seek.length) throw e;
        }
    }
    throw new EdgeError("no decodable frame found");
}

// ---------- audio decoding (transcribe / vad / diarize / tag) ----------

/** Decode the primary audio track to `rate` Hz mono float32. */
export async function decodePcm(
    ctx: EdgeContext,
    bytes: Uint8Array,
    filename: string | undefined,
    rate: number,
    onFraction?: (f: number) => void,
): Promise<{ samples: Float32Array; codec: string | null }> {
    const name = inputName(filename);
    const res = await runFfmpeg(
        ctx,
        job(["-i", W + name, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(rate), "-c:a", "pcm_f32le", "-f", "f32le"], [{ name, data: bytes }], "audio.pcm"),
        onFraction,
    );
    const out = res.files["audio.pcm"];
    if (res.ret !== 0 || !out) {
        const tail = logTail(res.log);
        if (/matches no streams|does not contain any stream/i.test(tail)) throw new EdgeError("this file has no audio track");
        throw new EdgeError(`ffmpeg could not decode the audio: ${tail}`);
    }
    if (!out.byteLength) throw new EdgeError("the audio track is empty");
    const codec = /Audio: ([\w-]+)/.exec(res.log.join("\n"))?.[1] ?? null;
    const samples = new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4));
    return { samples: out.byteOffset % 4 === 0 ? samples : new Float32Array(samples), codec };
}

// ---------- remove-video-audio / merge-video-audio ----------

export async function removeAudio(ctx: EdgeContext, bytes: Uint8Array, filename?: string): Promise<Uint8Array> {
    const name = inputName(filename);
    const inputs = [{ name, data: bytes }];
    const on = progress(ctx, "removing audio (ffmpeg.wasm)");
    try {
        return await ffmpegOut(ctx, job(["-i", W + name, "-map", "0:v:0", "-an", "-sn", "-c:v", "copy", ...MP4, "-f", "mp4"], inputs, "out.mp4"), on);
    } catch (e) {
        if (ctx.signal.aborted) throw e;
        // The video codec cannot go into MP4 (WMV, MPEG-2 in some muxers): H.264.
        ctx.onProgress({ message: "re-encoding the video to H.264 (ffmpeg.wasm)" });
        return ffmpegOut(ctx, job(["-i", W + name, "-map", "0:v:0", "-an", "-sn", ...X264, ...MP4, "-f", "mp4"], inputs, "out.mp4"), on);
    }
}

export async function mergeAudio(ctx: EdgeContext, video: { bytes: Uint8Array; filename?: string }, audio: { bytes: Uint8Array; filename?: string }): Promise<Uint8Array> {
    const v = inputName(video.filename, 0);
    const a = inputName(audio.filename, 1);
    const inputs = [
        { name: v, data: video.bytes },
        { name: a, data: audio.bytes },
    ];
    const on = progress(ctx, "merging video and audio (ffmpeg.wasm)");
    const base = ["-i", W + v, "-i", W + a, "-map", "0:v:0", "-map", "1:a:0"];
    try {
        return await ffmpegOut(ctx, job([...base, "-c:v", "copy", ...AAC, "-shortest", ...MP4, "-f", "mp4"], inputs, "out.mp4"), on);
    } catch (e) {
        if (ctx.signal.aborted) throw e;
        ctx.onProgress({ message: "re-encoding the video to H.264 (ffmpeg.wasm)" });
        return ffmpegOut(ctx, job([...base, ...X264, ...AAC, "-shortest", ...MP4, "-f", "mp4"], inputs, "out.mp4"), on);
    }
}

// ---------- concat-videos ----------

const even = (n: number) => Math.max(2, Math.ceil(n / 2) * 2);

function sameStreams(probes: Probe[]): boolean {
    const [p0] = probes;
    if (!p0?.video) return false;
    return probes.every(
        (p) =>
            !!p.video &&
            p.video.codec === p0.video!.codec &&
            p.video.width === p0.video!.width &&
            p.video.height === p0.video!.height &&
            !!p.audio === !!p0.audio &&
            (!p.audio || (p.audio.codec === p0.audio!.codec && p.audio.sampleRate === p0.audio!.sampleRate && p.audio.channels === p0.audio!.channels)),
    );
}

export async function concat(ctx: EdgeContext, videos: { bytes: Uint8Array; filename?: string }[]): Promise<Uint8Array> {
    const probes: Probe[] = [];
    for (let i = 0; i < videos.length; i++) {
        throwIfAborted(ctx.signal);
        ctx.onProgress({ fraction: (0.1 * i) / videos.length, message: `reading video ${i + 1}/${videos.length} (ffmpeg.wasm)` });
        const p = await probe(ctx, videos[i]!.bytes, videos[i]!.filename);
        if (!p.video) throw new EdgeError(`video ${i + 1} has no video track`);
        probes.push(p);
    }
    const names = videos.map((v, i) => inputName(v.filename, i));
    const inputs = videos.map((v, i) => ({ name: names[i]!, data: v.bytes }));
    const on = progress(ctx, "concatenating (ffmpeg.wasm)", 0.1, 1);
    if (sameStreams(probes)) {
        const list = new TextEncoder().encode(names.map((n) => `file '${W}${n}'`).join("\n") + "\n");
        try {
            return await ffmpegOut(
                ctx,
                job(["-f", "concat", "-safe", "0", "-i", `${W}list.txt`, "-map", "0:v:0", ...(probes[0]!.audio ? ["-map", "0:a:0"] : []), "-c", "copy", ...MP4, "-f", "mp4"], [...inputs, { name: "list.txt", data: list }], "out.mp4"),
                on,
            );
        } catch (e) {
            if (ctx.signal.aborted) throw e;
        }
    }
    // Re-encode: every clip scaled into the largest frame (centred, like moviepy's
    // "compose"), at the highest frame rate, audio resampled; silence for clips without.
    const w = even(Math.max(...probes.map((p) => p.video!.width ?? 0)));
    const h = even(Math.max(...probes.map((p) => p.video!.height ?? 0)));
    const fps = Math.min(60, Math.max(...probes.map((p) => p.video!.fps ?? 0)) || 25);
    const withAudio = probes.some((p) => p.audio);
    const parts: string[] = [];
    const pads: string[] = [];
    probes.forEach((p, i) => {
        parts.push(`[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps.toFixed(3)},format=yuv420p[v${i}]`);
        pads.push(`[v${i}]`);
        if (withAudio) {
            const dur = (p.video!.duration ?? p.duration) || 0.001;
            parts.push(
                p.audio
                    ? `[${i}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)}[a${i}]`
                    : `anullsrc=r=44100:cl=stereo,atrim=0:${dur.toFixed(3)}[a${i}]`,
            );
            pads.push(`[a${i}]`);
        }
    });
    parts.push(`${pads.join("")}concat=n=${probes.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`);
    ctx.onProgress({ message: `re-encoding ${videos.length} videos to H.264 ${w}x${h} (ffmpeg.wasm)` });
    return ffmpegOut(
        ctx,
        job(
            [
                ...names.flatMap((n) => ["-i", W + n]),
                "-filter_complex",
                parts.join(";"),
                "-map",
                "[v]",
                ...(withAudio ? ["-map", "[a]", ...AAC] : []),
                ...X264,
                ...MP4,
                "-f",
                "mp4",
            ],
            inputs,
            "out.mp4",
        ),
        on,
    );
}

// ---------- split-video ----------

/**
 * Frames at `fps` (or all frames between `from` and `to`), scaled to `w`×`h` RGB24,
 * with their presentation times (from `showinfo`).
 */
export async function rgbFrames(
    ctx: EdgeContext,
    bytes: Uint8Array,
    filename: string | undefined,
    opts: { w: number; h: number; fps?: number; from?: number; to?: number },
    onFraction?: (f: number) => void,
): Promise<{ frames: Uint8Array[]; times: number[] }> {
    const name = inputName(filename);
    const seek = opts.from !== undefined ? ["-ss", opts.from.toFixed(3)] : [];
    const len = opts.from !== undefined && opts.to !== undefined ? ["-t", Math.max(0.001, opts.to - opts.from).toFixed(3)] : [];
    const vf = [...(opts.fps ? [`fps=${opts.fps}`] : []), `scale=${opts.w}:${opts.h}:flags=area`, "showinfo"].join(",");
    const res = await runFfmpeg(
        ctx,
        {
            args: ["-hide_banner", "-nostats", "-y", ...seek, "-i", W + name, ...len, "-map", "0:v:0", "-an", "-sn", "-vf", vf, "-pix_fmt", "rgb24", "-f", "rawvideo", `${W}frames.rgb`],
            inputs: [{ name, data: bytes }],
            outputs: ["frames.rgb"],
        },
        onFraction,
    );
    const raw = res.files["frames.rgb"];
    if (res.ret !== 0 || !raw) throw new EdgeError(`ffmpeg could not decode the video: ${logTail(res.log)}`);
    const per = opts.w * opts.h * 3;
    const frames: Uint8Array[] = [];
    for (let o = 0; o + per <= raw.length; o += per) frames.push(raw.subarray(o, o + per));
    const shown = res.log.flatMap((l) => {
        const m = /\bpts_time:\s*(-?[\d.]+)/.exec(l);
        return m && /showinfo/i.test(l) && /\bn:\s*\d+/.test(l) ? [Number(m[1])] : [];
    });
    const base = opts.from ?? 0;
    const times = frames.map((_, i) => base + (shown[i] ?? (opts.fps ? i / opts.fps : i / 25)));
    return { frames, times };
}

/**
 * Presentation times of the key frames of the primary video stream, on ffmpeg's output
 * timeline (starting at 0, like {@link rgbFrames}): only key frames are decoded
 * (`-skip_frame nokey`) and `showinfo` reports them.
 */
export async function keyframeTimes(ctx: EdgeContext, bytes: Uint8Array, filename?: string): Promise<number[]> {
    const name = inputName(filename);
    const res = await runFfmpeg(ctx, {
        args: ["-hide_banner", "-nostats", "-skip_frame", "nokey", "-i", W + name, "-map", "0:v:0", "-an", "-sn", "-vf", "showinfo", "-f", "null", "-"],
        inputs: [{ name, data: bytes }],
        outputs: [],
    });
    if (res.ret !== 0) return [];
    return res.log
        .flatMap((l) => {
            const m = /showinfo.*\bpts_time:\s*(-?[\d.]+).*\biskey:1/.exec(l);
            return m ? [Number(m[1])] : [];
        })
        .sort((a, b) => a - b);
}

/**
 * One shot as MP4: stream copy from `start` when it is a key frame and the codecs fit
 * MP4 (like PySceneDetect's `-c copy`), else re-encoded to H.264/AAC from the exact time.
 */
export async function cutPart(
    ctx: EdgeContext,
    bytes: Uint8Array,
    filename: string | undefined,
    start: number,
    end: number,
    onKeyframe: boolean,
    hasAudio: boolean,
): Promise<Uint8Array> {
    const name = inputName(filename);
    const inputs = [{ name, data: bytes }];
    const range = ["-ss", start.toFixed(3), "-i", W + name, "-t", Math.max(0.001, end - start).toFixed(3), "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0?"] : []), "-sn"];
    if (onKeyframe) {
        try {
            return await ffmpegOut(ctx, job([...range, "-c", "copy", "-avoid_negative_ts", "make_zero", ...MP4, "-f", "mp4"], inputs, "part.mp4"));
        } catch (e) {
            if (ctx.signal.aborted) throw e;
        }
    }
    return ffmpegOut(ctx, job([...range, ...X264, ...(hasAudio ? AAC : []), ...MP4, "-f", "mp4"], inputs, "part.mp4"));
}
