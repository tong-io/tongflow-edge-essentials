import type { EdgeContext } from "../context.js";
import { EdgeError } from "./errors.js";

/**
 * Fetch a plugin asset (resolved through `ctx.resolveAsset`) as bytes, reporting
 * download progress. Only same-origin URLs from the host are fetched; nothing here
 * talks to a third-party CDN.
 */
export async function fetchAssetBytes(ctx: EdgeContext, relPath: string, label: string): Promise<Uint8Array> {
    const url = ctx.resolveAsset(relPath);
    const res = await fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new EdgeError(`could not load ${label} (${res.status} ${res.statusText}) from ${url}`);
    const lenHeader = res.headers.get("content-length");
    const total = lenHeader ? Number(lenHeader) || undefined : undefined;
    if (!res.body) {
        const buf = new Uint8Array(await res.arrayBuffer());
        ctx.onDownload({ loaded: buf.byteLength, total: buf.byteLength, label });
        return buf;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let lastReport = 0;
    ctx.onDownload({ loaded: 0, total, label });
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (loaded - lastReport >= 256 * 1024) {
            lastReport = loaded;
            ctx.onDownload({ loaded, total, label });
        }
    }
    ctx.onDownload({ loaded, total: total ?? loaded, label });
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}
