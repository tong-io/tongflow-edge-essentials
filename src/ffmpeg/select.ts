/**
 * Choosing between the browser path (Mediabunny + WebCodecs, the default) and
 * ffmpeg.wasm for the media slots. Tiny on purpose: the slots import it eagerly,
 * ffmpeg itself is a lazy chunk (`ffmpeg/ops.ts`).
 *
 * - **Forced.** The node's model (`ctx.model`, the manifest `models` list, "换实现")
 *   is `ffmpeg-wasm`, or `<model>+ffmpeg-wasm` for slots whose model list names an ML
 *   model (`sensevoice-small+ffmpeg-wasm`: SenseVoice, audio decoded by ffmpeg).
 * - **Automatic.** The browser path throws {@link MediaUnsupportedError} (unknown
 *   container, codec WebCodecs rejects, decoder error) or a library error that is not
 *   one of our own {@link EdgeError}s: the slot retries with ffmpeg and says so in the
 *   progress message. Our own EdgeErrors ("this file has no audio track") are answers,
 *   not failures of the browser path, and are not retried.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError, MediaUnsupportedError, errorMessage } from "../util/errors.js";

export const FFMPEG_MODEL = "ffmpeg-wasm";
export const FFMPEG_SUFFIX = `+${FFMPEG_MODEL}`;

/** True when the node asked for ffmpeg (`ffmpeg-wasm` or `<model>+ffmpeg-wasm`). */
export function forcesFfmpeg(model: string | undefined): boolean {
    return model === FFMPEG_MODEL || (!!model && model.endsWith(FFMPEG_SUFFIX));
}

/** The ML model part of `<model>+ffmpeg-wasm` (`undefined` for plain `ffmpeg-wasm` / none). */
export function baseModel(model: string | undefined): string | undefined {
    if (!model || model === FFMPEG_MODEL) return undefined;
    return model.endsWith(FFMPEG_SUFFIX) ? model.slice(0, -FFMPEG_SUFFIX.length) || undefined : model;
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (e instanceof Error && e.name === "AbortError");
}

/** Whether a failure of the browser path should be retried with ffmpeg. */
export function shouldFallBack(e: unknown): boolean {
    return e instanceof MediaUnsupportedError || !(e instanceof EdgeError);
}

/**
 * Run `browser`, or `ffmpeg` when the node forces it or the browser path cannot
 * handle the file. `what` names the step for the progress message ("extracting audio").
 */
export async function withFfmpegFallback<T>(
    ctx: Pick<EdgeContext, "signal" | "onProgress" | "model">,
    what: string,
    browser: () => Promise<T>,
    ffmpeg: () => Promise<T>,
    force = forcesFfmpeg(ctx.model),
): Promise<T> {
    if (force) {
        ctx.onProgress({ message: `${what} with ffmpeg.wasm (selected implementation)` });
        return ffmpeg();
    }
    try {
        return await browser();
    } catch (e) {
        if (isAbort(e, ctx.signal) || !shouldFallBack(e)) throw e;
        const why = errorMessage(e);
        ctx.onProgress({ message: `${why}: falling back to ffmpeg.wasm for ${what}` });
        try {
            return await ffmpeg();
        } catch (f) {
            if (isAbort(f, ctx.signal)) throw f;
            throw new EdgeError(`${why}; the ffmpeg.wasm fallback failed too: ${errorMessage(f)}`);
        }
    }
}
