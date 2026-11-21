/**
 * Running ffmpeg.wasm from the plugin: download the core on first use (model base,
 * verified, Cache API, `modelDownload` progress), start the ffmpeg worker, and run
 * jobs one at a time. A cancelled node terminates the worker (the next job starts a
 * fresh one from the cached core). Where no nested worker can be started, the core
 * runs in the plugin worker itself.
 */
import type { EdgeContext } from "../context.js";
import { fetchModelFile } from "../models/hub.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { FFMPEG_CORE } from "./core.js";
import { type FfmpegCore, loadCore, runJob } from "./host.js";
import type { FfmpegJob, FfmpegResult, FromWorker } from "./protocol.js";

const WORKER_ASSET = "ffmpeg-worker.js";

interface Engine {
    run(job: FfmpegJob, onProgress: (p: number) => void, signal: AbortSignal): Promise<FfmpegResult>;
    dispose(): void;
}

let engine: Promise<Engine> | null = null;
/** Jobs run strictly one after another (one core, one MEMFS). */
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function ownBuffer(b: Uint8Array): ArrayBuffer {
    return (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer) as ArrayBuffer;
}

async function loadBytes(ctx: EdgeContext): Promise<[Uint8Array, Uint8Array]> {
    ctx.onProgress({ message: "loading ffmpeg.wasm" });
    return Promise.all([fetchModelFile(ctx, FFMPEG_CORE, FFMPEG_CORE.files.js), fetchModelFile(ctx, FFMPEG_CORE, FFMPEG_CORE.files.wasm)]);
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

async function startWorker(ctx: EdgeContext, js: Uint8Array, wasm: Uint8Array): Promise<Engine> {
    const worker = new Worker(ctx.resolveAsset(WORKER_ASSET), { type: "module", name: "ffmpeg.wasm" });
    await new Promise<void>((resolve, reject) => {
        const onMsg = (e: MessageEvent<FromWorker>) => {
            if (e.data.type === "ready") done(), resolve();
            else if (e.data.type === "init-error") done(), reject(new EdgeError(`ffmpeg.wasm failed to start: ${e.data.message}`));
        };
        const onErr = (e: ErrorEvent) => (done(), reject(new EdgeError(`the ffmpeg worker failed to load: ${e.message || "error"}`)));
        const done = () => {
            worker.removeEventListener("message", onMsg);
            worker.removeEventListener("error", onErr);
        };
        worker.addEventListener("message", onMsg);
        worker.addEventListener("error", onErr);
        const coreJs = ownBuffer(js);
        const wasmBuf = wasm.slice().buffer as ArrayBuffer; // keep the caller's copy intact
        worker.postMessage({ type: "init", coreJs, wasm: wasmBuf }, [wasmBuf]);
    }).catch((e) => {
        worker.terminate();
        throw e;
    });
    return {
        run(job, onProgress, signal) {
            const id = ++seq;
            return new Promise<FfmpegResult>((resolve, reject) => {
                const onMsg = (e: MessageEvent<FromWorker>) => {
                    const m = e.data;
                    if (!("id" in m) || m.id !== id) return;
                    if (m.type === "progress") return onProgress(m.progress);
                    cleanup();
                    if (m.type === "done") resolve({ ret: m.ret, files: m.files, stdout: m.stdout, log: m.log });
                    else if (m.type === "failed") reject(new EdgeError(`ffmpeg.wasm: ${m.message}`));
                };
                const onErr = (e: ErrorEvent) => {
                    cleanup();
                    reset();
                    reject(new EdgeError(`the ffmpeg worker crashed: ${e.message || "error"}`));
                };
                const onAbort = () => {
                    cleanup();
                    // ffmpeg cannot be interrupted from outside: drop the whole worker.
                    reset();
                    reject(abortError(signal));
                };
                const cleanup = () => {
                    worker.removeEventListener("message", onMsg);
                    worker.removeEventListener("error", onErr);
                    signal.removeEventListener("abort", onAbort);
                };
                worker.addEventListener("message", onMsg);
                worker.addEventListener("error", onErr);
                signal.addEventListener("abort", onAbort, { once: true });
                worker.postMessage({ type: "job", id, ...job });
            });
        },
        dispose: () => worker.terminate(),
    };
}

async function inProcess(js: Uint8Array, wasm: Uint8Array): Promise<Engine> {
    const core: FfmpegCore = await loadCore(js, wasm.slice());
    return {
        async run(job, onProgress, signal) {
            throwIfAborted(signal);
            return runJob(core, job, onProgress);
        },
        dispose() {},
    };
}

function reset(): void {
    const e = engine;
    engine = null;
    void e?.then((x) => x.dispose()).catch(() => {});
}

function getEngine(ctx: EdgeContext): Promise<Engine> {
    if (!engine) {
        const p = (async () => {
            const [js, wasm] = await loadBytes(ctx);
            throwIfAborted(ctx.signal);
            if (typeof Worker === "function") return startWorker(ctx, js, wasm);
            return inProcess(js, wasm);
        })();
        engine = p;
        p.catch(() => {
            if (engine === p) engine = null;
        });
    }
    return engine;
}

/**
 * Run one ffmpeg (or ffprobe) job. `onFraction` gets ffmpeg's 0..1 progress.
 * Resolves with the exit code and outputs; a non-zero exit is not an exception here.
 */
export function runFfmpeg(ctx: EdgeContext, job: FfmpegJob, onFraction?: (f: number) => void): Promise<FfmpegResult> {
    const next = queue.then(async () => {
        throwIfAborted(ctx.signal);
        const eng = await getEngine(ctx);
        return eng.run(job, (p) => onFraction?.(Math.max(0, Math.min(1, p))), ctx.signal);
    });
    queue = next.catch(() => {});
    return next;
}

/** The last meaningful log lines, for an error message. */
export function logTail(log: string[], n = 3): string {
    const lines = log.map((l) => l.trim()).filter((l) => l && !/^(frame|size)=|^\s*(Stream|Duration|Input|Output|Metadata|encoder|major_brand|minor_version|compatible_brands|Press)/.test(l));
    return lines.slice(-n).join(" | ") || "no output";
}

/** Run an ffmpeg job that must succeed and produce `outputs[0]`; returns those bytes. */
export async function ffmpegOut(ctx: EdgeContext, job: FfmpegJob, onFraction?: (f: number) => void): Promise<Uint8Array> {
    const res = await runFfmpeg(ctx, job, onFraction);
    const out = res.files[job.outputs[0]!];
    if (res.ret !== 0 || !out?.length) throw new EdgeError(`ffmpeg failed (exit ${res.ret}): ${logTail(res.log)}`);
    return out;
}
