/**
 * Silero VAD v5 (MIT, snakers4/silero-vad) on onnxruntime-web, and the speech
 * timestamp logic of silero's own `get_speech_timestamps` (thresholds with
 * hysteresis, minimum speech/silence, maximum segment length split at the
 * last long pause, padding).
 */
import type { EdgeContext } from "../context.js";
import { createSession, loadOrt, type OrtSession, type OrtTensor } from "../ml/ort.js";
import { fetchModelFile } from "../models/hub.js";
import { SILERO_VAD } from "../models/registry.js";
import { checkpoint } from "./checkpoint.js";

export const VAD_WINDOW = 512; // samples at 16 kHz
const CONTEXT = 64;

export interface VadOptions {
    threshold: number;
    minSpeechMs: number;
    minSilenceMs: number;
    speechPadMs: number;
    /** Longer speech is split, preferably at a pause of ≥ 98 ms. */
    maxSpeechS: number;
}

export const VAD_DEFAULTS: VadOptions = {
    threshold: 0.5,
    minSpeechMs: 250,
    minSilenceMs: 500,
    speechPadMs: 200,
    maxSpeechS: 30,
};

/** A speech span in samples, [start, end). */
export interface Span {
    start: number;
    end: number;
}

/** Turn per-window speech probabilities into padded speech spans (silero's algorithm). */
export function speechSpans(probs: ArrayLike<number>, numSamples: number, o: VadOptions, sr = 16000): Span[] {
    const w = VAD_WINDOW;
    const neg = Math.max(o.threshold - 0.15, 0.01);
    const minSpeech = (sr * o.minSpeechMs) / 1000;
    const pad = Math.floor((sr * o.speechPadMs) / 1000);
    const maxSpeech = sr * o.maxSpeechS - w - 2 * pad;
    const minSilence = (sr * o.minSilenceMs) / 1000;
    const minSilenceAtMax = (sr * 98) / 1000;
    const spans: Span[] = [];
    let triggered = false;
    let curStart = 0;
    let tempEnd = 0;
    let prevEnd = 0;
    let nextStart = 0;
    for (let i = 0; i < probs.length; i++) {
        const p = probs[i]!;
        const pos = w * i;
        if (p >= o.threshold && tempEnd) {
            tempEnd = 0;
            if (nextStart < prevEnd) nextStart = pos;
        }
        if (p >= o.threshold && !triggered) {
            triggered = true;
            curStart = pos;
            continue;
        }
        if (triggered && pos - curStart > maxSpeech) {
            if (prevEnd) {
                spans.push({ start: curStart, end: prevEnd });
                if (nextStart < prevEnd) triggered = false;
                else curStart = nextStart;
                prevEnd = nextStart = tempEnd = 0;
            } else {
                spans.push({ start: curStart, end: pos });
                prevEnd = nextStart = tempEnd = 0;
                triggered = false;
                continue;
            }
        }
        if (p < neg && triggered) {
            if (!tempEnd) tempEnd = pos;
            if (pos - tempEnd > minSilenceAtMax) prevEnd = tempEnd;
            if (pos - tempEnd < minSilence) continue;
            if (tempEnd - curStart > minSpeech) spans.push({ start: curStart, end: tempEnd });
            prevEnd = nextStart = tempEnd = 0;
            triggered = false;
        }
    }
    if (triggered && numSamples - curStart > minSpeech) spans.push({ start: curStart, end: numSamples });
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i]!;
        if (i === 0) s.start = Math.max(0, s.start - pad);
        if (i < spans.length - 1) {
            const next = spans[i + 1]!;
            const silence = next.start - s.end;
            if (silence < 2 * pad) {
                s.end += Math.floor(silence / 2);
                next.start = Math.max(0, next.start - Math.floor(silence / 2));
            } else {
                s.end = Math.min(numSamples, s.end + pad);
                next.start = Math.max(0, next.start - pad);
            }
        } else {
            s.end = Math.min(numSamples, s.end + pad);
        }
    }
    return spans;
}

/** Merge consecutive spans while the merged span stays within `maxSamples` (gaps included). */
export function mergeSpans(spans: Span[], maxSamples: number): Span[] {
    const out: Span[] = [];
    for (const s of spans) {
        const last = out[out.length - 1];
        if (last && s.end - last.start <= maxSamples) last.end = s.end;
        else out.push({ ...s });
    }
    return out;
}

let sessionPromise: Promise<OrtSession> | null = null;

async function session(ctx: EdgeContext): Promise<OrtSession> {
    sessionPromise ??= (async () => createSession(ctx, await fetchModelFile(ctx, SILERO_VAD, SILERO_VAD.files.model)))();
    sessionPromise.catch(() => {
        sessionPromise = null;
    });
    return sessionPromise;
}

/** Load the VAD model (downloads it once). */
export async function loadVad(ctx: EdgeContext): Promise<void> {
    await session(ctx);
}

/** Speech probability per 512-sample window of 16 kHz audio. */
export async function vadProbabilities(
    samples: Float32Array,
    ctx: EdgeContext,
    onFraction?: (f: number) => void,
): Promise<Float32Array> {
    const sess = await session(ctx);
    const ort = await loadOrt(ctx);
    const n = Math.ceil(samples.length / VAD_WINDOW);
    const probs = new Float32Array(n);
    let state: OrtTensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new ort.Tensor("int64", BigInt64Array.of(16000n), []);
    const buf = new Float32Array(CONTEXT + VAD_WINDOW);
    for (let i = 0; i < n; i++) {
        if ((i & 255) === 0) {
            await checkpoint(ctx.signal);
            onFraction?.(i / n);
        }
        // [64 samples of context | 512 new samples], zero-padded at the end.
        buf.copyWithin(0, VAD_WINDOW, VAD_WINDOW + CONTEXT);
        if (i === 0) buf.fill(0, 0, CONTEXT);
        const chunk = samples.subarray(i * VAD_WINDOW, (i + 1) * VAD_WINDOW);
        buf.set(chunk, CONTEXT);
        if (chunk.length < VAD_WINDOW) buf.fill(0, CONTEXT + chunk.length);
        const input = new ort.Tensor("float32", buf.slice(), [1, CONTEXT + VAD_WINDOW]);
        const out = await sess.run({ input, state, sr });
        probs[i] = (out.output!.data as Float32Array)[0]!;
        state.dispose();
        input.dispose();
        out.output!.dispose();
        state = out.stateN!;
    }
    state.dispose();
    onFraction?.(1);
    return probs;
}

/** Speech spans of 16 kHz audio. */
export async function detectSpeech(
    samples: Float32Array,
    ctx: EdgeContext,
    options: Partial<VadOptions> = {},
    onFraction?: (f: number) => void,
): Promise<Span[]> {
    const probs = await vadProbabilities(samples, ctx, onFraction);
    return speechSpans(probs, samples.length, { ...VAD_DEFAULTS, ...options });
}
