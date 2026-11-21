import { throwIfAborted } from "../util/errors.js";

/**
 * Yield to the worker's event loop, then stop if the run was cancelled.
 * onnxruntime-web's wasm `run()` settles through microtasks only, so a long loop of
 * inferences would never let the engine's `cancel` message in without this.
 */
export async function checkpoint(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
}
