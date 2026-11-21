/**
 * Decode any audio (or the primary audio track of a video) to 16 kHz mono
 * Float32 inside the worker: Mediabunny demuxes and decodes (WebCodecs
 * `AudioDecoder` for compressed codecs, its own PCM path for WAV/AIFF), the
 * channels are averaged and {@link Resampler} converts the rate. There is no
 * AudioContext in a worker, so nothing here depends on Web Audio.
 *
 * A file the browser cannot demux or decode throws {@link MediaUnsupportedError};
 * {@link decodeAnyAudio} then decodes it with ffmpeg.wasm (AMR, WMA, RealAudio, …).
 */
import type { EdgeContext } from "../context.js";
import { withFfmpegFallback } from "../ffmpeg/select.js";
import { EdgeError, MediaUnsupportedError, throwIfAborted } from "../util/errors.js";
import { noTrack } from "../media/no-track.js";
import { Resampler } from "./resample.js";

export const SAMPLE_RATE = 16000;

export interface DecodedAudio {
    /** 16 kHz mono samples in [-1, 1]. */
    samples: Float32Array;
    sampleRate: typeof SAMPLE_RATE;
    /** Seconds. */
    duration: number;
    /** Source codec as Mediabunny names it (aac, opus, mp3, pcm-s16, …). */
    codec: string | null;
}

/** Growable Float32 buffer. */
class SampleBuffer {
    private buf: Float32Array;
    length = 0;
    constructor(capacity: number) {
        this.buf = new Float32Array(Math.max(1024, capacity));
    }
    push(chunk: Float32Array): void {
        if (this.length + chunk.length > this.buf.length) {
            const next = new Float32Array(Math.max(this.buf.length * 2, this.length + chunk.length));
            next.set(this.buf.subarray(0, this.length));
            this.buf = next;
        }
        this.buf.set(chunk, this.length);
        this.length += chunk.length;
    }
    take(): Float32Array {
        return this.length === this.buf.length ? this.buf : this.buf.slice(0, this.length);
    }
}

/**
 * Decode `bytes` to 16 kHz mono in the browser. `onFraction` gets 0..1 decode progress.
 * Throws {@link EdgeError} for files without audio and {@link MediaUnsupportedError}
 * for files or codecs the browser cannot handle.
 */
export async function decodeAudio(
    bytes: Uint8Array,
    ctx: Pick<EdgeContext, "signal">,
    onFraction?: (f: number) => void,
): Promise<DecodedAudio> {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
    try {
        let track;
        try {
            track = await input.getPrimaryAudioTrack();
        } catch (e) {
            throw new MediaUnsupportedError(`unsupported or damaged media file (${e instanceof Error ? e.message : String(e)})`);
        }
        if (!track) throw await noTrack(input, "audio");
        if (!(await track.canDecode())) {
            throw new MediaUnsupportedError(`this browser cannot decode ${track.codec ?? "this"} audio`);
        }
        const duration = await track.computeDuration().catch(() => 0);
        const out = new SampleBuffer(Math.ceil((duration || 1) * SAMPLE_RATE) + SAMPLE_RATE);
        const sink = new mb.AudioSampleSink(track);
        let resampler: Resampler | null = null;
        let mono = new Float32Array(0);
        let plane = new Float32Array(0);
        let lastReport = 0;
        for await (const sample of sink.samples()) {
            try {
                throwIfAborted(ctx.signal);
                const frames = sample.numberOfFrames;
                const channels = sample.numberOfChannels;
                if (!resampler || resampler.inRate !== Math.round(sample.sampleRate)) {
                    if (resampler) out.push(resampler.process(new Float32Array(0), true));
                    resampler = new Resampler(sample.sampleRate, SAMPLE_RATE);
                }
                if (mono.length < frames) {
                    mono = new Float32Array(frames);
                    plane = new Float32Array(frames);
                }
                const m = mono.subarray(0, frames);
                const p = plane.subarray(0, frames);
                m.fill(0);
                for (let c = 0; c < channels; c++) {
                    sample.copyTo(p, { planeIndex: c, format: "f32-planar" });
                    for (let i = 0; i < frames; i++) m[i] = m[i]! + p[i]!;
                }
                if (channels > 1) for (let i = 0; i < frames; i++) m[i] = m[i]! / channels;
                out.push(resampler.process(m));
                if (onFraction && duration > 0) {
                    const f = Math.min(1, (sample.timestamp + sample.duration) / duration);
                    if (f - lastReport >= 0.02) {
                        lastReport = f;
                        onFraction(f);
                    }
                }
            } finally {
                sample.close();
            }
        }
        if (resampler) out.push(resampler.process(new Float32Array(0), true));
        const samples = out.take();
        if (!samples.length) throw new EdgeError("the audio track is empty");
        onFraction?.(1);
        return { samples, sampleRate: SAMPLE_RATE, duration: samples.length / SAMPLE_RATE, codec: track.codec ?? null };
    } finally {
        input.dispose();
    }
}

/**
 * {@link decodeAudio}, falling back to ffmpeg.wasm (or forced to it with `force`, the
 * node's `<model>+ffmpeg-wasm`) for files the browser cannot decode.
 */
export async function decodeAnyAudio(
    bytes: Uint8Array,
    ctx: EdgeContext,
    onFraction?: (f: number) => void,
    opts: { filename?: string; force?: boolean } = {},
): Promise<DecodedAudio> {
    return withFfmpegFallback(
        ctx,
        "decoding audio",
        () => decodeAudio(bytes, ctx, onFraction),
        async () => {
            const ops = await import("../ffmpeg/ops.js");
            const { samples, codec } = await ops.decodePcm(ctx, bytes, opts.filename, SAMPLE_RATE, onFraction);
            onFraction?.(1);
            return { samples, sampleRate: SAMPLE_RATE, duration: samples.length / SAMPLE_RATE, codec };
        },
        opts.force,
    );
}
