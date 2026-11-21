/** Messages between the plugin and its ffmpeg.wasm worker (`src/ffmpeg-worker.ts`). */

export interface FfmpegJob {
    /** ffmpeg's arguments; `inputs` are under `/w/`. (No ffprobe: the core's is not re-entrant.) */
    args: string[];
    inputs: { name: string; data: Uint8Array }[];
    /** Files to read back from `/w/` after the run (missing ones are left out). */
    outputs: string[];
}

export interface FfmpegResult {
    /** ffmpeg's exit code (0 = success). */
    ret: number;
    files: Record<string, Uint8Array>;
    /** stdout lines. */
    stdout: string[];
    /** stderr lines (ffmpeg's log). */
    log: string[];
}

export type ToWorker =
    | { type: "init"; coreJs: ArrayBuffer; wasm: ArrayBuffer }
    | ({ type: "job"; id: number } & FfmpegJob);

export type FromWorker =
    | { type: "ready" }
    | { type: "init-error"; message: string }
    | { type: "progress"; id: number; progress: number; time: number }
    | ({ type: "done"; id: number } & FfmpegResult)
    | { type: "failed"; id: number; message: string };
