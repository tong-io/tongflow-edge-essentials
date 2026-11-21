/**
 * The T1 vision models' files, read from `models.json` (repo, per-file size + SHA-256)
 * and fetched through the shared model hub (`models/hub.ts`): from
 * `<modelBase><org>/<repo>/<path>`, verified before they are cached, with progress.
 */
import type { EdgeContext } from "../context.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import MODELS from "../../models.json";
import { fetchModelFile as fetchHub } from "../models/hub.js";
import type { ModelFile, ModelSpec } from "../models/registry.js";

/** One entry of the repo-root `models.json` (the weights-hosting manifest). */
export interface ModelEntry {
    id: string;
    /** `modelscope:<org>/<repo>`: also the path under the model base. */
    source: string;
    files: string[];
    checksums?: Record<string, { size: number; sha256: string }>;
    approxMB: number;
    license: string;
    slots?: string[];
}

export const MODEL_ENTRIES = MODELS as unknown as ModelEntry[];

export function modelEntry(id: string): ModelEntry {
    const m = MODEL_ENTRIES.find((e) => e.id === id);
    if (!m) throw new EdgeError(`unknown model ${id}`);
    return m;
}

/** `<org>/<repo>` of a model entry. */
export function repoOf(m: ModelEntry): string {
    const i = m.source.indexOf(":");
    return i >= 0 ? m.source.slice(i + 1) : m.source;
}

function spec(id: string, path: string): { spec: ModelSpec; file: ModelFile } {
    const m = modelEntry(id);
    const c = m.checksums?.[path];
    if (!c) throw new EdgeError(`models.json has no checksum for ${id}/${path}`);
    const file = { path, size: c.size, sha256: c.sha256 };
    return { spec: { id, repo: repoOf(m), files: { [path]: file } }, file };
}

/** One model file's bytes (Cache API first, else the model base; size + SHA-256 checked). */
export async function fetchModelFile(ctx: EdgeContext, id: string, path: string): Promise<Uint8Array> {
    const s = spec(id, path);
    const bytes = await fetchHub(ctx, s.spec, s.file);
    throwIfAborted(ctx.signal);
    return bytes;
}

export async function fetchModelText(ctx: EdgeContext, id: string, path: string): Promise<string> {
    return new TextDecoder().decode(await fetchModelFile(ctx, id, path));
}

/**
 * A per-key memo for loaded sessions / pipelines: concurrent callers share one load,
 * and a failed load is forgotten so the next call retries.
 */
export function memo<T>(): (key: string, load: () => Promise<T>) => Promise<T> {
    const m = new Map<string, Promise<T>>();
    return (key, load) => {
        let p = m.get(key);
        if (!p) {
            p = load();
            m.set(key, p);
            p.catch(() => m.delete(key));
        }
        return p;
    };
}
