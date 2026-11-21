/**
 * onnxruntime-web for the nodes that run ONNX models directly (the audio models).
 * It is the same module and the same wasm binary transformers.js uses
 * (`onnxruntime-web/webgpu`, pinned once in package.json): the binary comes from the
 * plugin's own `dist/assets/ort/` through {@link ensureOrtWasm}, never from a CDN.
 * Only the CPU (wasm) execution provider is used here.
 */
import type { EdgeContext } from "../context.js";
import { ensureOrtWasm, ORT_ASSET_DIR } from "./transformers.js";

type Ort = typeof import("onnxruntime-web");
export type OrtSession = import("onnxruntime-web").InferenceSession;
export type OrtTensor = import("onnxruntime-web").Tensor;

let ortPromise: Promise<Ort> | null = null;

/** onnxruntime-web, configured for this plugin's assets on first use. */
export function loadOrt(ctx: Pick<EdgeContext, "resolveAsset" | "modelBase" | "signal" | "onDownload">): Promise<Ort> {
    ortPromise ??= (async () => {
        const ort = (await import("onnxruntime-web/webgpu")) as unknown as Ort;
        const ortBase = ctx.resolveAsset(ORT_ASSET_DIR);
        const wasm = ort.env.wasm;
        wasm.wasmPaths ??= ortBase;
        // Threads need cross-origin isolation (SharedArrayBuffer); otherwise one thread.
        if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) wasm.numThreads = 1;
        await ensureOrtWasm(wasm, { modelBase: ctx.modelBase, ortBase, signal: ctx.signal, onDownload: ctx.onDownload });
        return ort;
    })();
    ortPromise.catch(() => {
        ortPromise = null;
    });
    return ortPromise;
}

/** An inference session (CPU / wasm EP) for a model held in memory. */
export async function createSession(ctx: Pick<EdgeContext, "resolveAsset" | "modelBase" | "signal" | "onDownload">, model: Uint8Array): Promise<OrtSession> {
    const ort = await loadOrt(ctx);
    return ort.InferenceSession.create(model, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    });
}
