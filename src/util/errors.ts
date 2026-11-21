/** An error whose message is safe and useful to show on the node. */
export class EdgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EdgeError";
    }
}

export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message || e.name;
    return String(e);
}

export function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new EdgeError("aborted");
    }
}

/** Host cap from ADR-0001: a single file is at most 100 MB. */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
