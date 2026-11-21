/**
 * `tongflow-edge-essentials/kb-host` (`dist/kb-host.js`): the host side of `kb-write`.
 *
 * The plugin owns no storage. `kb-write` validates and summarizes; the host stores.
 * {@link tapKbWrite} wraps the host's `NodeExecutor` and keeps a copy of exactly what
 * the engine handed `kb-write` (chunks, TFV1 vectors, source) when the node succeeds,
 * plus the model the run's `embed-text` used. After `runWorkflow` resolves, the host
 * commits it to its knowledge base only if the run's status is `success`. No worker
 * protocol change is involved: this is ordinary executor composition.
 */
import type { InvokeRequest, InvokeTarget, NodeExecutor } from "tongflow/engine";
import { DEFAULT_EMBED_MODEL, resolveEmbedModel } from "./ml/models.js";
import type { KbWriteSummary } from "./slots/kb-write.js";
import { decodeBase64 } from "./util/base64.js";

export type { KbWriteSummary };

export interface KbWritePayload {
    /** The source file name (`kb-write`'s `source`, i.e. `IngestMeta.fileName`). */
    source: string;
    chunks: string[];
    /** TFV1 bytes, accepted as-is by `@scanall/kb`'s `IngestTx.add(chunks, vectors)`. */
    vectors: Uint8Array;
    dims: number;
    /**
     * `embed-text`'s model id in this run (`IngestMeta.embedModel`; query with the same one).
     * Absent when the vectors did not come from an `embed-text` node of this run.
     */
    embedModel?: string;
    /** kb-write's own summary (its `text` output, parsed). */
    summary: KbWriteSummary;
}

export interface KbWriteTap {
    /** Use this executor in `runWorkflow` instead of the wrapped one. */
    readonly executor: NodeExecutor;
    /**
     * What the successful `kb-write` stored for this run, or `null` when none succeeded.
     * Throws when several `kb-write` calls succeeded or the run mixed embedding models:
     * the knowledge base holds one file, so that run is ambiguous.
     */
    take(): KbWritePayload | null;
    /** Forget captured calls (before reusing the tap for another run). */
    reset(): void;
}

const KB_WRITE = "kb-write";
const EMBED_TEXT = "embed-text";

export function tapKbWrite(inner: NodeExecutor): KbWriteTap {
    let captured: KbWritePayload[] = [];
    let models = new Set<string>();

    const executor: NodeExecutor = {
        ...(inner.check ? { check: (t: InvokeTarget) => inner.check!(t) } : {}),
        async invoke(req: InvokeRequest) {
            const out = await inner.invoke(req);
            if (req.nodeSlot === EMBED_TEXT && out?.success === true) {
                models.add(resolveEmbedModel(req.model ?? DEFAULT_EMBED_MODEL).id);
            }
            if (req.nodeSlot === KB_WRITE && out?.success === true) {
                const p = req.prompt as { chunks?: unknown; vectors?: { bytesBase64?: unknown }; source?: unknown };
                const summary = JSON.parse(String(out.text)) as KbWriteSummary;
                const vectors = decodeBase64(String(p.vectors?.bytesBase64 ?? ""));
                const chunks = (p.chunks as string[]).slice();
                if (chunks.length !== summary.chunkCount) {
                    throw new Error(`kb-write reported ${summary.chunkCount} chunks but was given ${chunks.length}`);
                }
                captured.push({ source: summary.source, chunks, vectors, dims: summary.dims, summary });
            }
            return out;
        },
    };

    return {
        executor,
        take() {
            if (!captured.length) return null;
            if (captured.length > 1) throw new Error(`${captured.length} kb-write nodes succeeded in one run; the knowledge base holds one file`);
            if (models.size > 1) throw new Error(`the run embedded with several models (${[...models].join(", ")})`);
            const [only] = models;
            return { ...captured[0]!, ...(only ? { embedModel: only } : {}) };
        },
        reset() {
            captured = [];
            models = new Set();
        },
    };
}
