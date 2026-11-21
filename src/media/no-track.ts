import { EdgeError, MediaUnsupportedError } from "../util/errors.js";

/**
 * Containers whose Mediabunny demuxer leaves out streams it has no codec for (MPEG-TS
 * drops MPEG-2 video, stream type 0x02; Ogg drops Theora) instead of listing them with
 * an unknown codec, as MP4 / Matroska do.
 */
const DROPS_UNKNOWN_STREAMS = new Set(["MPEG Transport Stream", "Ogg"]);

/**
 * The error for "Mediabunny found no `kind` track": a plain answer ({@link EdgeError}),
 * unless the container may hold a stream Mediabunny skipped, then the browser path
 * cannot tell and ffmpeg is asked ({@link MediaUnsupportedError}).
 */
export async function noTrack(input: { getFormat(): Promise<{ name: string }> }, kind: string, what = "this file"): Promise<EdgeError> {
    const format = await input.getFormat().catch(() => null);
    if (format && DROPS_UNKNOWN_STREAMS.has(format.name)) {
        return new MediaUnsupportedError(`the browser found no ${kind} track it can read in ${what} (${format.name})`);
    }
    return new EdgeError(`${what} has no ${kind} track`);
}
