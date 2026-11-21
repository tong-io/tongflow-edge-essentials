/**
 * Integrity for the model files transformers.js downloads itself (it caches them in the
 * Cache API with no checksum of its own). `verifiedFetch` is installed as transformers.js'
 * `env.fetch`: a full GET of a file that `models.json` lists with a checksum is passed
 * through chunk by chunk (download progress keeps flowing) while it is hashed; when the
 * last byte has arrived and the size or SHA-256 does not match, the body errors instead
 * of ending. transformers.js reads the whole body before it caches a file, so a corrupt
 * or substituted file fails the node and is never cached. Range probes, other files and
 * repos without checksums pass through untouched.
 */
import MODELS from "../../models.json";
import { Sha256 } from "../util/sha256.js";

interface Checksum {
    size: number;
    sha256: string;
}

type Entry = { source: string; checksums?: Record<string, Checksum> };

let index: Map<string, Checksum> | undefined;

/** `<org>/<repo>/<path>` → checksum, over every models.json entry that has checksums. */
export function checksumIndex(entries: readonly Entry[] = MODELS as unknown as Entry[]): Map<string, Checksum> {
    const out = new Map<string, Checksum>();
    for (const e of entries) {
        const i = e.source.indexOf(":");
        const repo = i >= 0 ? e.source.slice(i + 1) : e.source;
        for (const [path, c] of Object.entries(e.checksums ?? {})) out.set(`${repo}/${path}`, c);
    }
    return out;
}

/**
 * The checksum for a model URL (`…/<org>/<repo>/<path>` under any model base), or
 * undefined. The longest matching `<org>/<repo>/<path>` suffix of the URL path wins.
 */
export function checksumFor(url: string, idx: Map<string, Checksum> = (index ??= checksumIndex())): (Checksum & { key: string }) | undefined {
    let path: string;
    try {
        path = decodeURIComponent(new URL(url, "http://x/").pathname);
    } catch {
        return undefined;
    }
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 2; i++) {
        const key = parts.slice(i).join("/");
        const hit = idx.get(key);
        if (hit) return { ...hit, key };
    }
    return undefined;
}

/** The body of `res`, hashed as it streams; it errors at the end on a size or SHA-256 mismatch. */
export function verifyingBody(res: Response, want: Checksum, label: string): Response {
    if (!res.body) return res;
    const hash = new Sha256();
    let size = 0;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (!done) {
                hash.update(value);
                size += value.byteLength;
                controller.enqueue(value);
                return;
            }
            if (size !== want.size) {
                controller.error(new Error(`model file ${label} has ${size} bytes, expected ${want.size}`));
                return;
            }
            const got = hash.hex();
            if (got !== want.sha256) {
                controller.error(new Error(`model file ${label} failed its SHA-256 check (got ${got.slice(0, 12)}…)`));
                return;
            }
            controller.close();
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function hasRange(input: string | URL | Request, init?: RequestInit): boolean {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    return h.has("range");
}

/** `fetch`, with models.json checksums enforced on full downloads (see the module comment). */
export async function verifiedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const res = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (res.status !== 200 || method !== "GET" || hasRange(input, init)) return res;
    const want = checksumFor(url);
    if (!want) return res;
    return verifyingBody(res, want, want.key);
}
