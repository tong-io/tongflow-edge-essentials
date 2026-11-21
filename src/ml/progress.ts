/**
 * Progress plumbing between transformers.js and the engine ctx. Pure (a clock is
 * injected), so the throttling is unit tested in Node.
 */

import type { EdgeContext } from "../context.js";

type Clock = () => number;

/**
 * Streams generation progress: every new token updates the node's status with
 * the token count and the tail of the text so far; the fraction is tokens over
 * `max_new_tokens` (generation usually stops earlier, at end of sequence).
 * Throttled so a fast decoder does not flood the worker channel.
 */
export class TokenProgress {
    private tokens = 0;
    private text = "";
    private last = -Infinity;

    constructor(
        private readonly onProgress: EdgeContext["onProgress"],
        private readonly maxNewTokens: number,
        private readonly label = "generating",
        private readonly everyMs = 200,
        private readonly now: Clock = Date.now,
    ) {}

    get count(): number {
        return this.tokens;
    }

    /** Called once per generated token (ids from the streamer). */
    token(n = 1): void {
        this.tokens += n;
        this.flush(false);
    }

    /** Called with each decoded text piece. */
    append(piece: string): void {
        this.text += piece;
    }

    /** Report now if the throttle allows (or always, with `force`). */
    flush(force: boolean): void {
        const t = this.now();
        if (!force && this.tokens > 1 && t - this.last < this.everyMs) return;
        this.last = t;
        const tail = this.text.replace(/\s+/g, " ").trim().slice(-40);
        const fraction = Math.min(0.99, this.tokens / Math.max(1, this.maxNewTokens));
        this.onProgress({
            fraction,
            message: `${this.label}: ${this.tokens} token${this.tokens === 1 ? "" : "s"}${tail ? ` · …${tail}` : ""}`,
        });
    }
}

/** What transformers.js passes to `progress_callback` (the fields we read). */
export interface TransformersProgress {
    status: string;
    name?: string;
    file?: string;
    loaded?: number;
    total?: number;
    progress?: number;
}

/**
 * Maps transformers.js loading events to `ctx.onDownload`. The aggregate
 * `progress_total` event (all files of one model) is preferred; per-file
 * `progress` events are used for loads that have no aggregate (tokenizer,
 * processor). Reports at most every `everyMs`, plus the final 100 %.
 */
export class DownloadProgress {
    private last = -Infinity;
    private file = "";
    private sawTotal = false;

    constructor(
        private readonly onDownload: EdgeContext["onDownload"],
        private readonly model: string,
        private readonly everyMs = 250,
        private readonly now: Clock = Date.now,
    ) {}

    handle(p: TransformersProgress): void {
        if (p.file && (p.status === "progress" || p.status === "initiate" || p.status === "download")) this.file = p.file;
        let loaded: number | undefined;
        let total: number | undefined;
        if (p.status === "progress_total") {
            this.sawTotal = true;
            loaded = p.loaded;
            total = p.total;
        } else if (p.status === "progress" && !this.sawTotal) {
            loaded = p.loaded;
            total = p.total;
        } else {
            return;
        }
        if (typeof loaded !== "number") return;
        const done = typeof total === "number" && total > 0 && loaded >= total;
        const t = this.now();
        if (!done && t - this.last < this.everyMs) return;
        this.last = t;
        const label = this.file ? `${this.model} · ${this.file}` : this.model;
        this.onDownload({ loaded, ...(typeof total === "number" && total > 0 ? { total } : {}), label });
    }
}
