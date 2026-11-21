/**
 * onnxruntime-web for the nodes that run ONNX models directly (the audio models).
 * It is the same module and the same wasm binary transformers.js uses
 * (`onnxruntime-web/webgpu`, pinned once in package.json): the binary comes from the
 * plugin's own `dist/assets/ort/` through {@link ensureOrtWasm}, never from a CDN.
 * Only the CPU (wasm) execution provider is used here.
 */
import type { EdgeContext } from "../context.js";
import { ensureOrtWasm, type MlRuntime, ORT_ASSET_DIR } from "./transformers.js";

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

/* ---- Device-aware sessions (T1 vision nodes): WebGPU when the worker has an adapter, else WASM ---- */

export function mlRuntimeOf(ctx: EdgeContext): MlRuntime {
    return { modelBase: ctx.modelBase, ortBase: ctx.resolveAsset(ORT_ASSET_DIR), signal: ctx.signal, onDownload: (p) => ctx.onDownload(p) };
}

let adapterPromise: Promise<boolean> | undefined;

/** True when this worker can get a WebGPU adapter. */
export function hasWebGpu(): Promise<boolean> {
    adapterPromise ??= (async () => {
        const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
        if (!gpu) return false;
        try {
            return !!(await gpu.requestAdapter());
        } catch {
            return false;
        }
    })();
    return adapterPromise;
}

export type Device = "webgpu" | "wasm";

/**
 * The device a vision node uses: WASM by default; `_params.device: "webgpu"` uses WebGPU
 * when the worker has an adapter. WebGPU is opt-in because in our headless-Chromium runs
 * (Metal through ANGLE) WebGPU sessions created inside the module worker never settled,
 * while the same sessions worked on the main thread; these models are small enough that
 * WASM is fast.
 */
export async function pickDevice(ctx: EdgeContext): Promise<Device> {
    const want = ctx.params?.device;
    if (want === "webgpu" || want === "gpu") return (await hasWebGpu()) ? "webgpu" : "wasm";
    return "wasm";
}

export interface LoadedSession {
    session: OrtSession;
    device: Device;
}

const QUIET = { logSeverityLevel: 3 as const, graphOptimizationLevel: "all" as const };

/** A session on the preferred device, falling back to WASM when WebGPU cannot build the graph. */
export async function createDeviceSession(ctx: EdgeContext, model: Uint8Array, device?: Device): Promise<LoadedSession> {
    const ort = await loadOrt(ctx);
    const dev = device ?? (await pickDevice(ctx));
    if (dev === "webgpu") {
        try {
            return { session: await ort.InferenceSession.create(model, { ...QUIET, executionProviders: ["webgpu", "wasm"] }), device: "webgpu" };
        } catch {
            // fall through to WASM
        }
    }
    return { session: await ort.InferenceSession.create(model, { ...QUIET, executionProviders: ["wasm"] }), device: "wasm" };
}

/** One vision ORT run at a time in this worker (runs of concurrent nodes queue up). */
let chain: Promise<unknown> = Promise.resolve();
export function runSerial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
}

export async function run(s: LoadedSession, feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>> {
    return runSerial(() => s.session.run(feeds) as Promise<Record<string, OrtTensor>>);
}

/** A float32 tensor (dims as given). */
export async function tensor(ctx: EdgeContext, data: Float32Array, dims: number[]): Promise<OrtTensor> {
    const ort = await loadOrt(ctx);
    return new ort.Tensor("float32", data, dims);
}
