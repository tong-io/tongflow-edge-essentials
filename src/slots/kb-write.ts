import type { SlotImpl } from "../types.js";
import { EdgeError } from "../util/errors.js";
import { guard, readAsset } from "./common.js";
import { textList } from "./chunk-text.js";

/** The JSON in kb-write's `text` output. The host checks it against what it commits. */
export interface KbWriteSummary {
    source: string;
    chunkCount: number;
    dims: number;
    /** Hex SHA-256 of the TFV1 bytes kb-write validated. */
    vectorsSha256: string;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `kb-write`: validates what the host is about to store and summarizes it. The plugin
 * owns no storage: the host (scanall, through `@scanall/kb`) commits the chunks and
 * vectors it fed this node once the whole run succeeded (see the README, "Knowledge base").
 */
export const kbWrite: SlotImpl<"kb-write"> = (input, ctx) =>
    guard(ctx, async () => {
        const source = typeof input.source === "string" ? input.source.trim() : "";
        if (!source) throw new EdgeError("source (the file name) is empty");
        const chunks = textList(input.chunks, "chunks");
        if (!chunks.length) throw new EdgeError("no chunks: a file without chunks is not stored (the current knowledge base is kept)");
        const empty = chunks.findIndex((c) => !c.trim());
        if (empty >= 0) throw new EdgeError(`chunks[${empty}] is empty`);
        const bytes = readAsset(input.vectors, "vectors");
        const { isPackedVectors, unpackVectors } = await import("../kb/tfv1.js");
        if (!isPackedVectors(bytes)) throw new EdgeError("vectors is not a TFV1 vector file (embed-text output)");
        let unpacked;
        try {
            unpacked = unpackVectors(bytes);
        } catch (e) {
            throw new EdgeError(`vectors is a corrupt TFV1 file: ${(e as Error).message}`);
        }
        const { dims, count, vectors } = unpacked;
        if (count !== chunks.length) {
            throw new EdgeError(`${chunks.length} chunks but ${count} vectors: they must come from the same chunk list`);
        }
        for (let i = 0; i < count; i++) {
            const v = vectors[i]!;
            for (let j = 0; j < dims; j++) {
                if (!Number.isFinite(v[j]!)) throw new EdgeError(`vector ${i} has a non-finite value`);
            }
        }
        const summary: KbWriteSummary = { source, chunkCount: count, dims, vectorsSha256: await sha256Hex(bytes) };
        ctx.onProgress({ fraction: 1, message: `${count} chunks ready for ${source}` });
        return { success: true, text: JSON.stringify(summary) };
    });
