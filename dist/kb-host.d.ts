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
import { NodeExecutor } from "tongflow/engine";
import { t as KbWriteSummary } from "./chunks/kb-write-COu0Ml-F.js";
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
export declare function tapKbWrite(inner: NodeExecutor): KbWriteTap;
export type { KbWriteSummary };