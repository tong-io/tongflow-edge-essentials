/**
 * T2 audio slots: `transcribe` (SenseVoiceSmall), `vad-segment` (Silero VAD),
 * `diarize-speakers` (pyannote segmentation-3.0 + 3D-Speaker CAM++) and
 * `audio-tag` (CED-tiny). The work lives in a lazy chunk (src/audio/pipeline.ts)
 * so the plugin entry stays small; onnxruntime-web is a second lazy chunk.
 */
import type { SlotImpl } from "../types.js";
import { guard, readAsset } from "./common.js";

const pipeline = () => import("../audio/pipeline.js");

export const transcribe: SlotImpl<"transcribe"> = (input, ctx) =>
    guard(ctx, async () => {
        const bytes = readAsset(input.audio, "audio");
        const text = await (await pipeline()).transcribe(bytes, input.language, ctx);
        return { success: true, text };
    });

export const vadSegment: SlotImpl<"vad-segment"> = (input, ctx) =>
    guard(ctx, async () => {
        const bytes = readAsset(input.audio, "audio");
        const segments = await (await pipeline()).vadSegment(bytes, input.audio.filename, ctx);
        return { success: true, segments };
    });

export const diarizeSpeakers: SlotImpl<"diarize-speakers"> = (input, ctx) =>
    guard(ctx, async () => {
        const bytes = readAsset(input.audio, "audio");
        const segments = await (await pipeline()).diarizeSpeakers(bytes, ctx);
        return { success: true, segments };
    });

export const audioTag: SlotImpl<"audio-tag"> = (input, ctx) =>
    guard(ctx, async () => {
        const bytes = readAsset(input.audio, "audio");
        const tags = await (await pipeline()).audioTag(bytes, ctx);
        return { success: true, tags };
    });
