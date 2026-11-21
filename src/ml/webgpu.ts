/**
 * WebGPU and storage checks for the T3 nodes. Runs in the worker:
 * `self.navigator.gpu` is exposed to dedicated workers in Chromium and Safari 26+.
 */

import { EdgeError } from "../util/errors.js";

export interface GpuInfo {
    /** The adapter supports `shader-f16` (fp16 activations: the q4f16 weights). */
    f16: boolean;
    vendor?: string;
    architecture?: string;
}

export const WEBGPU_MISSING =
    "this node needs WebGPU, and this browser does not provide it (navigator.gpu is missing). " +
    "Use a recent desktop Chrome or Edge (113+) or Safari 26+, with hardware acceleration turned on.";
export const WEBGPU_NO_ADAPTER =
    "this node needs WebGPU, but the browser found no usable GPU adapter " +
    "(hardware acceleration may be off, or this GPU is blocklisted).";

type GpuLike = { requestAdapter(opts?: { powerPreference?: string }): Promise<AdapterLike | null> };
type AdapterLike = { features: { has(f: string): boolean }; info?: { vendor?: string; architecture?: string } };

let adapter: Promise<GpuInfo> | undefined;

/** The `navigator.gpu` of this scope, if any (`self.navigator` in a worker). */
export function navigatorGpu(scope: unknown = globalThis): GpuLike | undefined {
    const nav = (scope as { navigator?: { gpu?: GpuLike } }).navigator;
    return nav?.gpu ?? undefined;
}

/**
 * Fail fast and clearly when WebGPU is missing; otherwise describe the adapter.
 * The adapter probe is cached (a failed probe is retried next time).
 */
export function requireWebGPU(scope: unknown = globalThis): Promise<GpuInfo> {
    const gpu = navigatorGpu(scope);
    if (!gpu) return Promise.reject(new EdgeError(WEBGPU_MISSING));
    adapter ??= gpu
        .requestAdapter({ powerPreference: "high-performance" })
        .then((a) => {
            if (!a) throw new EdgeError(WEBGPU_NO_ADAPTER);
            return {
                f16: a.features.has("shader-f16"),
                ...(a.info?.vendor ? { vendor: a.info.vendor } : {}),
                ...(a.info?.architecture ? { architecture: a.info.architecture } : {}),
            };
        })
        .catch((e) => {
            adapter = undefined;
            throw e instanceof EdgeError ? e : new EdgeError(`${WEBGPU_NO_ADAPTER} (${String(e)})`);
        });
    return adapter;
}

/** For tests: forget the cached adapter probe. */
export function resetWebGPUProbe(): void {
    adapter = undefined;
}

export interface StorageInfo {
    usage?: number;
    quota?: number;
}

/** `navigator.storage.estimate()`, or `{}` where the API is missing. */
export async function storageEstimate(scope: unknown = globalThis): Promise<StorageInfo> {
    const storage = (scope as { navigator?: { storage?: { estimate?: () => Promise<StorageInfo> } } }).navigator?.storage;
    if (!storage?.estimate) return {};
    try {
        const { usage, quota } = await storage.estimate();
        return { ...(usage !== undefined ? { usage } : {}), ...(quota !== undefined ? { quota } : {}) };
    } catch {
        return {};
    }
}

const MB = 1e6;

/**
 * Refuse to start a download the origin's storage quota cannot hold (the
 * browser would evict or fail half way). Unknown quota passes.
 */
export function checkQuota(neededMB: number, info: StorageInfo, modelName: string): void {
    if (info.quota === undefined) return;
    const freeMB = (info.quota - (info.usage ?? 0)) / MB;
    if (freeMB < neededMB * 1.05) {
        throw new EdgeError(
            `${modelName} needs about ${Math.round(neededMB)} MB of browser storage, but only ${Math.max(0, Math.round(freeMB))} MB ` +
                `of this site's ${Math.round(info.quota / MB)} MB quota is free. Free up space (or clear old cached models) and retry.`,
        );
    }
}

/** "123 MB free of 4567 MB" for status messages, or "" when unknown. */
export function describeQuota(info: StorageInfo): string {
    if (info.quota === undefined) return "";
    const free = Math.max(0, (info.quota - (info.usage ?? 0)) / MB);
    return `${Math.round(free)} MB free of ${Math.round(info.quota / MB)} MB storage`;
}
