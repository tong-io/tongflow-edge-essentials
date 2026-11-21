/**
 * Decode any audio (or the primary audio track of a video) to 16 kHz mono
 * Float32 inside the worker: Mediabunny demuxes and decodes (WebCodecs
 * `AudioDecoder` for compressed codecs, its own PCM path for WAV/AIFF), the
 * channels are averaged and {@link Resampler} converts the rate. There is no
 * AudioContext in a worker, so nothing here depends on Web Audio.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
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
 * Decode `bytes` to 16 kHz mono. `onFraction` gets 0..1 decode progress.
 * Throws {@link EdgeError} for files without audio or with a codec the browser
 * cannot decode.
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
            throw new EdgeError(`unsupported or damaged media file (${e instanceof Error ? e.message : String(e)})`);
        }
        if (!track) throw new EdgeError("this file has no audio track");
        if (!(await track.canDecode())) {
            throw new EdgeError(`this browser cannot decode ${track.codec ?? "this"} audio`);
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
