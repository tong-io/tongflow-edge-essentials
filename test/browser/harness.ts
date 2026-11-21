type Msg = {
    type: "ready" | "progress" | "model-download" | "result" | "error";
    id?: number;
    protocol?: number;
    methods?: string[];
    output?: any;
    message?: string;
    percent?: number;
    loaded?: number;
    total?: number;
    file?: string;
};

let worker: Worker | undefined;
let ready: Promise<Msg> | undefined;
let seq = 0;

/**
 * The built plugin entry itself is the worker: its default export
 * (`defineEdgePlugin`) answers the engine's worker protocol (v1), so these tests
 * talk to it exactly as the engine's edge executor does.
 */
export function pluginWorker(): { worker: Worker; ready: Promise<Msg> } {
    if (!worker) {
        worker = new Worker(new URL("/dist/index.js", location.origin), { type: "module", name: "tongflow-edge-essentials" });
        const w = worker;
        ready = new Promise((resolve, reject) => {
            const onMessage = (e: MessageEvent<Msg>) => {
                if (e.data?.type !== "ready") return;
                w.removeEventListener("message", onMessage);
                resolve(e.data);
            };
            w.addEventListener("message", onMessage);
            w.addEventListener("error", (e) => reject(new Error(`worker failed to load: ${e.message}`)), { once: true });
        });
    }
    return { worker, ready: ready! };
}

export interface CallResult {
    out: any;
    progress: { message: string; percent?: number }[];
    downloads: { loaded: number; total?: number; file?: string }[];
}

const SLOT_OF: Record<string, string> = {
    parseDocument: "parse-document",
    renderPages: "render-pages",
    extractAudio: "extract-audio",
    getFirstFrame: "get-first-frame",
    detectLanguage: "detect-language",
};

/** Invoke one plugin method over the worker protocol. */
export async function call(method: string, input: Record<string, unknown>): Promise<CallResult> {
    const { worker: w, ready: r } = pluginWorker();
    await r;
    const id = ++seq;
    const progress: CallResult["progress"] = [];
    const downloads: CallResult["downloads"] = [];
    return new Promise((resolve, reject) => {
        const onMessage = (e: MessageEvent<Msg>) => {
            const m = e.data;
            if (m.id !== id) return;
            if (m.type === "progress") progress.push({ message: m.message ?? "", percent: m.percent });
            else if (m.type === "model-download") downloads.push({ loaded: m.loaded ?? 0, total: m.total, file: m.file });
            else {
                w.removeEventListener("message", onMessage);
                if (m.type === "error") reject(new Error(m.message));
                else resolve({ out: m.output, progress, downloads });
            }
        };
        w.addEventListener("message", onMessage);
        w.postMessage({ type: "invoke", id, method, nodeSlot: SLOT_OF[method] ?? method, input });
    });
}

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

export async function fixture(name: string, mime?: string) {
    const res = await fetch(`/test/fixtures/${name}`);
    if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytesBase64: toBase64(bytes), filename: name, ...(mime ? { mime } : {}) };
}

export function fromBase64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export async function imageSize(bytes: Uint8Array, mime: string) {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
}

/** Mean RGB of a decoded image, to tell a rendered page from a blank one. */
export async function meanColor(bytes: Uint8Array, mime: string) {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let r = 0, gg = 0, b = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
        r += d[i]!; gg += d[i + 1]!; b += d[i + 2]!;
        if (d[i]! + d[i + 1]! + d[i + 2]! < 300) dark++;
    }
    const n = d.length / 4;
    return { r: r / n, g: gg / n, b: b / n, darkFraction: dark / n };
}
