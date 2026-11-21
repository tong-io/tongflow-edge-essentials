/**
 * Media slots (thin wrappers; the bodies are the lazy chunk `media/impl.ts`, so the
 * entry stays small): Mediabunny + WebCodecs by default, ffmpeg.wasm for files the
 * browser cannot read or when the node's model is `ffmpeg-wasm`.
 */
import type { NodeSlot, SlotImpl } from "../types.js";

type Impl = typeof import("../media/impl.js");
const impl = (): Promise<Impl> => import("../media/impl.js");

function lazy<S extends NodeSlot>(pick: (m: Impl) => SlotImpl<S>): SlotImpl<S> {
    return async (input, ctx) => pick(await impl())(input, ctx);
}

/** `extract-audio`: the primary audio track, remuxed without re-encoding when possible. */
export const extractAudio = lazy<"extract-audio">((m) => m.extractAudio);
/** `get-first-frame`: the first decodable frame as PNG. */
export const getFirstFrame = lazy<"get-first-frame">((m) => m.getFirstFrame);
/** `get-last-frame`: the last frame as PNG. */
export const getLastFrame = lazy<"get-last-frame">((m) => m.getLastFrame);
/** `concat-videos`: the clips end to end as one MP4. */
export const concatVideos = lazy<"concat-videos">((m) => m.concatVideos);
/** `remove-video-audio`: the video stream copied into a silent MP4. */
export const removeVideoAudio = lazy<"remove-video-audio">((m) => m.removeVideoAudio);
/** `merge-video-audio`: video copied, audio as AAC, cut to the shorter one (MP4). */
export const mergeVideoAudio = lazy<"merge-video-audio">((m) => m.mergeVideoAudio);
