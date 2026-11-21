/**
 * Hosting the ffmpeg.wasm core: instantiate it from verified bytes and run one job.
 * Used inside the dedicated ffmpeg worker (`src/ffmpeg-worker.ts`) and, where a
 * worker cannot start a nested worker, in the plugin worker itself.
 *
 * The core is Emscripten's MODULARIZE/EXPORT_ES6 factory. It is imported from a blob
 * URL of the bytes the plugin fetched and verified; `wasmBinary` hands it the wasm so
 * it never fetches anything itself, and `locateFile` keeps it from resolving a URL
 * against the (blob) script URL. Files live in MEMFS under `/w/` for one job only.
 */
import type { FfmpegJob, FfmpegResult } from "./protocol.js";

export interface FfmpegCore {
    FS: {
        writeFile(path: string, data: Uint8Array): void;
        readFile(path: string): Uint8Array;
        unlink(path: string): void;
        mkdir(path: string): void;
        readdir(path: string): string[];
    };
    exec(...args: string[]): number;
    ret: number;
    reset(): void;
    setLogger(fn: (l: { type: "stdout" | "stderr"; message: string }) => void): void;
    setProgress(fn: (p: { progress: number; time: number }) => void): void;
    setTimeout(ms: number): void;
}

type Factory = (opts: Record<string, unknown>) => Promise<FfmpegCore>;

export const WORK_DIR = "/w";

export async function loadCore(coreJs: ArrayBuffer | Uint8Array, wasm: ArrayBuffer | Uint8Array): Promise<FfmpegCore> {
    const url = URL.createObjectURL(new Blob([coreJs as BlobPart], { type: "text/javascript" }));
    let factory: Factory;
    try {
        factory = ((await import(/* @vite-ignore */ url)) as { default: Factory }).default;
    } finally {
        URL.revokeObjectURL(url);
    }
    if (typeof factory !== "function") throw new Error("the ffmpeg.wasm core has no default export");
    const core = await factory({ wasmBinary: wasm, locateFile: (p: string) => p });
    core.FS.mkdir(WORK_DIR);
    return core;
}

/** Run one job; `onProgress` gets ffmpeg's own 0..1 estimate. Never throws for a non-zero exit. */
export function runJob(core: FfmpegCore, job: FfmpegJob, onProgress?: (p: number, time: number) => void): FfmpegResult {
    const stdout: string[] = [];
    const log: string[] = [];
    core.setLogger(({ type, message }) => (type === "stdout" ? stdout : log).push(message));
    core.setProgress(({ progress, time }) => onProgress?.(progress, time));
    try {
        for (const f of job.inputs) core.FS.writeFile(`${WORK_DIR}/${f.name}`, f.data);
        core.setTimeout(-1);
        core.exec(...job.args);
        const ret = core.ret;
        const files: Record<string, Uint8Array> = {};
        for (const name of job.outputs) {
            try {
                files[name] = core.FS.readFile(`${WORK_DIR}/${name}`);
            } catch {
                // not written
            }
        }
        // The core reports its exit through Emscripten's abort; that line is noise.
        return { ret, files, stdout, log: log.filter((l) => l !== "Aborted()") };
    } finally {
        core.reset();
        core.setLogger(() => {});
        core.setProgress(() => {});
        // Everything in /w/ belongs to this job: inputs, outputs, scratch files.
        for (const name of core.FS.readdir(WORK_DIR)) {
            if (name === "." || name === "..") continue;
            try {
                core.FS.unlink(`${WORK_DIR}/${name}`);
            } catch {
                // a directory or already gone
            }
        }
    }
}
