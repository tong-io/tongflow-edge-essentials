import { createReadStream, existsSync, mkdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Shared with tsdown.config.ts: defuddle's Markdown converter is not in its exports map. */
const defuddleMarkdown = { find: /^defuddle\/dist\/markdown\.js$/, replacement: r("./node_modules/defuddle/dist/markdown.js") };

/**
 * The built plugin must reach the browser byte-for-byte (a worker loads
 * /dist/index.js and its chunks, exactly as a host would serve them). Vite would
 * transform it, so it is exposed through a public dir, which Vite serves raw.
 */
function rawPublicDir(): string {
    const dir = r("./node_modules/.edge-public");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(`${dir}/dist`)) symlinkSync(r("./dist"), `${dir}/dist`, "dir");
    return dir;
}

/**
 * Real-model browser tests: `EDGE_MODELS_DIR=/path/to/.models-cache npm run test:browser`
 * serves that directory at `/models/` (layout `<org>/<repo>/<path>`, like the model base).
 * Unset, those tests skip. Every request is logged for the test to assert on.
 */
const modelsDir = process.env.EDGE_MODELS_DIR ? realpathSync(process.env.EDGE_MODELS_DIR) : "";
const modelRequests: string[] = [];
/** `/__corrupt-graphs?repo=<org>/<repo>`: that repo's `.onnx` graphs are served as garbage until reset (empty repo). */
let corruptRepo = "";
/** Requests for the plugin's onnxruntime-web assets (`/dist/assets/ort/…`), to check the wasm is fetched once. */
const ortRequests: string[] = [];
if (!modelsDir && !process.argv.includes("node")) {
    console.info("[edge] EDGE_MODELS_DIR is not set: the real-model browser tests (test/browser/kb-models.test.ts) skip");
}
function serveModels() {
    return {
        name: "edge-models-dir",
        configureServer(server: { middlewares: { use(fn: (req: any, res: any, next: () => void) => void): void } }) {
            server.middlewares.use((req, res, next) => {
                const url: string = req.url ?? "";
                if (url === "/__model-requests") {
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify(modelRequests));
                    return;
                }
                if (url === "/__ort-requests") {
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify(ortRequests));
                    return;
                }
                if (url.startsWith("/dist/assets/ort/")) ortRequests.push(`${req.method} ${url.slice("/dist/assets/ort/".length).split("?")[0]}`);
                if (url.startsWith("/__corrupt-graphs")) {
                    corruptRepo = new URLSearchParams(url.split("?")[1] ?? "").get("repo") ?? "";
                    res.end("ok");
                    return;
                }
                if (!url.startsWith("/models/")) return next();
                const rel = normalize(decodeURIComponent(url.slice("/models/".length).split("?")[0]!));
                modelRequests.push(`${req.method} ${rel}${req.headers.range ? ` range=${req.headers.range}` : ""}`);
                if (corruptRepo && rel.startsWith(`${corruptRepo}/`) && rel.endsWith(".onnx")) {
                    // Not a protobuf: onnxruntime-web fails inside InferenceSession.create.
                    const junk = Buffer.from("this is not an ONNX graph");
                    res.setHeader("content-type", "application/octet-stream");
                    res.setHeader("content-length", String(junk.length));
                    res.end(junk);
                    return;
                }
                const file = join(modelsDir, rel);
                if (!modelsDir || rel.startsWith("..") || !existsSync(file) || !statSync(file).isFile()) {
                    res.statusCode = 404;
                    res.end("not found");
                    return;
                }
                const size = statSync(file).size;
                res.setHeader("content-type", "application/octet-stream");
                res.setHeader("accept-ranges", "bytes");
                // transformers.js probes sizes with `Range: bytes=0-0`; answer it like a real static host.
                const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
                if (m) {
                    const start = Number(m[1]);
                    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
                    res.statusCode = 206;
                    res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
                    res.setHeader("content-length", String(end - start + 1));
                    createReadStream(file, { start, end }).pipe(res);
                    return;
                }
                res.setHeader("content-length", String(size));
                createReadStream(file).pipe(res);
            });
        },
    };
}

/**
 * Headless Chromium exposes a real GPU adapter only with these flags (on macOS:
 * Metal through ANGLE). Used for the real-model tests, or with EDGE_WEBGPU=1.
 */
const WEBGPU = !!modelsDir || process.env.EDGE_WEBGPU === "1";
const WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])];

/** The host-side knowledge base (`@scanall/kb`), for the end-to-end ingest test; optional. */
const scanallKb = process.env.SCANALL_KB_DIR ?? r("../../../ctsource/scanall/packages/kb");

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "node",
                    environment: "node",
                    include: ["test/node/**/*.test.ts"],
                    testTimeout: 60_000,
                },
                resolve: {
                    alias: [
                        defuddleMarkdown,
                        // Node would pick pptxtojson's UMD "main"; use the ESM build bundlers use.
                        { find: /^pptxtojson$/, replacement: r("./node_modules/pptxtojson/dist/index.js") },
                        // Node runs pdf.js's legacy build (no DOM, no canvas needed for text).
                        { find: /^pdfjs-dist$/, replacement: r("./node_modules/pdfjs-dist/legacy/build/pdf.mjs") },
                        {
                            find: /^pdfjs-dist\/build\/pdf\.worker\.mjs$/,
                            replacement: r("./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
                        },
                    ],
                },
            },
            {
                // `tongflow` is a file: link to the TongFlow monorepo; let Vite serve it.
                server: {
                    // EDGE_COI=1: serve cross-origin isolated, so onnxruntime-web can use threads.
                    ...(process.env.EDGE_COI
                        ? { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } }
                        : {}),
                    fs: {
                        allow: [r("./"), realpathSync(r("./node_modules/tongflow")), ...(existsSync(scanallKb) ? [scanallKb] : [])],
                    },
                },
                publicDir: rawPublicDir(),
                plugins: [serveModels()],
                define: {
                    __EDGE_MODELS__: JSON.stringify(modelsDir),
                    __EDGE_WEBGPU__: JSON.stringify(WEBGPU),
                    __SCANALL_KB__: JSON.stringify(existsSync(`${scanallKb}/src/index.ts`) ? `/@fs${scanallKb}/src/index.ts` : ""),
                },
                test: {
                    name: "browser",
                    include: ["test/browser/**/*.test.ts"],
                    testTimeout: 120_000,
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright(WEBGPU ? { launchOptions: { args: WEBGPU_ARGS } } : {}),
                        instances: [{ browser: "chromium" }],
                    },
                },
            },
        ],
    },
});
