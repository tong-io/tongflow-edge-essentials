import type { EdgeContext } from "../context.js";
import type { Asset } from "../types.js";
import { decodeBase64 } from "../util/base64.js";
import { EdgeError, MAX_ASSET_BYTES, errorMessage } from "../util/errors.js";

/** Decode an input Asset, enforcing presence and the host's 100 MB cap. */
export function readAsset(asset: Asset | undefined, field: string): Uint8Array {
    if (!asset || typeof asset.bytesBase64 !== "string" || !asset.bytesBase64) {
        throw new EdgeError(`missing ${field}: expected an Asset with bytesBase64`);
    }
    // Base64 is 4/3 of the payload: reject before decoding a huge string.
    if (asset.bytesBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4) {
        throw new EdgeError(`${field} is larger than 100 MB, the edge runtime's per-file limit`);
    }
    const bytes = decodeBase64(asset.bytesBase64);
    if (!bytes.length) throw new EdgeError(`${field} is empty`);
    return bytes;
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (e instanceof Error && e.name === "AbortError");
}

/**
 * Run a slot body: failures become `{ success: false, error }` so only this node's
 * branch stops. Cancellation is not a failure: an abort is rethrown for the engine.
 */
export async function guard<T extends { success: boolean; error?: string }>(
    ctx: EdgeContext,
    body: () => Promise<T>,
): Promise<T> {
    try {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
        return await body();
    } catch (e) {
        if (isAbort(e, ctx.signal)) throw e;
        return { success: false, error: errorMessage(e) } as T;
    }
}
