/**
 * The ffmpeg.wasm worker: a dedicated module worker the plugin starts (nested in its
 * own worker) the first time a media node needs ffmpeg. A job runs synchronously in
 * here, so the plugin worker stays responsive, and cancelling a node terminates this
 * worker instead of waiting for ffmpeg. Built as its own entry (`dist/ffmpeg-worker.js`),
 * with no imports beyond `ffmpeg/host.ts`: the core arrives as bytes in `init`.
 */
import { type FfmpegCore, loadCore, runJob } from "./ffmpeg/host.js";
import type { FromWorker, ToWorker } from "./ffmpeg/protocol.js";

let core: FfmpegCore | undefined;
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    if (m.type === "init") {
        try {
            core = await loadCore(m.coreJs, m.wasm);
            post({ type: "ready" });
        } catch (err) {
            post({ type: "init-error", message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }
    if (m.type !== "job") return;
    if (!core) return post({ type: "failed", id: m.id, message: "ffmpeg.wasm is not loaded" });
    try {
        let last = -1;
        const res = runJob(core, m, (progress, time) => {
            if (progress - last < 0.01 && progress < 1) return;
            last = progress;
            post({ type: "progress", id: m.id, progress, time });
        });
        post({ type: "done", id: m.id, ...res }, Object.values(res.files).map((f) => f.buffer as ArrayBuffer));
    } catch (err) {
        post({ type: "failed", id: m.id, message: err instanceof Error ? err.message : String(err) });
    }
};
