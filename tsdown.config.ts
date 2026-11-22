import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * transformers.js ships HuggingFace and jsDelivr as defaults. The plugin always sets
 * `env.remoteHost` (the model base) and onnxruntime-web's `wasmPaths`/`wasmBinary` (its
 * own dist/assets/ort/) before use, so these are dead code; rewrite them anyway so no
 * third-party host is reachable from the bundle.
 */
const noThirdPartyHosts = {
    name: "no-third-party-hosts",
    transform(code: string, id: string) {
        // @embedpdf/pdfium's default wasm URL (unused: the plugin passes the wasm bytes from dist/assets/pdfium/).
        if (/[\\/]@embedpdf[\\/]pdfium[\\/]/.test(id)) return code.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@embedpdf\/pdfium@[^"'`]*/g, "assets/pdfium/pdfium.wasm");
        if (!/[\\/]@huggingface[\\/]transformers[\\/]/.test(id)) return null;
        return code
            .replaceAll('remoteHost: "https://huggingface.co/"', 'remoteHost: "/models/"')
            .replaceAll("https://cdn.jsdelivr.net/npm/onnxruntime-web@", "/models/onnxruntime-web@");
    },
};

/**
 * transformers.js 4.3.2 serializes onnxruntime-web session creation and runs in the
 * browser through module-level promise chains (`webInitChain = webInitChain.then(load)`).
 * One rejected link poisons the chain: every later session / run in the worker rejects
 * with the first error without even trying (one model failing to load made every
 * other transformers.js model in the worker fail with that model's error). Let each
 * link run whatever the previous one did; the caller still gets its own error.
 */
export const CHAINS = [
    ["webInitChain = webInitChain.then(load)", "webInitChain = webInitChain.catch(() => {}).then(load)"],
    ["webInferenceChain = webInferenceChain.then(run)", "webInferenceChain = webInferenceChain.catch(() => {}).then(run)"],
] as const;
let chainsPatched = false;
export const unpoisonedOrtChains = {
    name: "unpoisoned-ort-chains",
    buildStart() {
        chainsPatched = false;
    },
    transform(code: string, id: string) {
        if (!/[\\/]@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.web\.js$/.test(id)) return null;
        for (const [from, to] of CHAINS) {
            if (!code.includes(from)) throw new Error(`unpoisoned-ort-chains: "${from}" not found in ${id}; re-check the patch for this transformers.js version`);
            code = code.replace(from, to);
        }
        chainsPatched = true;
        return code;
    },
    buildEnd() {
        if (!chainsPatched) throw new Error("unpoisoned-ort-chains: transformers.web.js was not bundled; the patch did not apply");
    },
};

/**
 * MuPDF.js imports `node:fs` and `module` only behind a "running in Node" check (so an
 * in-process Node host can still use it). Keep both as external imports, on purpose and
 * without a warning; a browser never evaluates them.
 */
const mupdfNodeOnly = {
    name: "mupdf-node-only",
    resolveId(id: string, importer?: string) {
        if ((id === "node:fs" || id === "module") && importer && /[\\/]node_modules[\\/]mupdf[\\/]/.test(importer)) return { id, external: true };
        return null;
    },
};

export default defineConfig({
    plugins: [noThirdPartyHosts, unpoisonedOrtChains, mupdfNodeOnly],
    // `ffmpeg-worker` is the nested worker ffmpeg.wasm runs in (dist/ffmpeg-worker.js).
    entry: ["src/index.ts", "src/ffmpeg-worker.ts"],
    format: "esm",
    platform: "browser",
    target: "es2022",
    outDir: "dist",
    clean: true,
    dts: true,
    minify: true,
    sourcemap: false,
    hash: true,
    fixedExtension: false,
    // Everything ships inside dist/: the browser loads the plugin as plain ESM.
    deps: { alwaysBundle: [/.*/], dts: { neverBundle: ["tongflow", /^tongflow\//] } },
    alias: {
        // msgreader's iconv-lite needs Node's Buffer; TextDecoder does the job.
        "iconv-lite": r("./src/shims/iconv-lite.ts"),
        // One turndown instance for us and for defuddle (we patch its string parser).
        turndown: r("./node_modules/turndown/lib/turndown.browser.es.js"),
        // defuddle's Markdown converter is not in its exports map.
        "defuddle/dist/markdown.js": r("./node_modules/defuddle/dist/markdown.js"),
        // pdf2md reaches pdf.js through unpdf, which is always given the plugin's pdf.js (src/formats/pdf2md.ts).
        "unpdf/pdfjs": r("./src/shims/unpdf-pdfjs.ts"),
        // One unpdf instance: pdf2md `require`s it (the CJS build would be a second copy, which
        // the plugin's `definePDFJSModule` call would not reach).
        unpdf: r("./node_modules/unpdf/dist/index.mjs"),
    },
    outputOptions: {
        chunkFileNames: "chunks/[name]-[hash].js",
        // One named chunk per library, so each format loads only what it needs
        // and the sizes are easy to audit.
        codeSplitting: {
            groups: [
                { name: "pdfjs-worker", test: /node_modules[\\/]pdfjs-dist[\\/]build[\\/]pdf\.worker/ },
                { name: "pdfjs", test: /node_modules[\\/]pdfjs-dist[\\/]/ },
                { name: "xmldom", test: /node_modules[\\/]@xmldom[\\/]/ },
                { name: "mammoth", test: /node_modules[\\/](mammoth|underscore|lop|dingbat-to-unicode|xmlbuilder|bluebird|base64-js|argparse|option)[\\/]/ },
                { name: "jszip", test: /node_modules[\\/](jszip|pako|lie|immediate|setimmediate|readable-stream|inherits|core-util-is|isarray|process-nextick-args|safe-buffer|string_decoder|util-deprecate)[\\/]/ },
                { name: "xlsx-cptable", test: /node_modules[\\/]xlsx[\\/]dist[\\/]cpexcel/ },
                { name: "xlsx", test: /node_modules[\\/]xlsx[\\/]/ },
                { name: "papaparse", test: /node_modules[\\/]papaparse[\\/]/ },
                { name: "pptxtojson", test: /node_modules[\\/](pptxtojson|txml|tinycolor2)[\\/]/ },
                { name: "postal-mime", test: /node_modules[\\/]postal-mime[\\/]/ },
                { name: "msgreader", test: /node_modules[\\/]@kenjiuno[\\/]|src[\\/]shims[\\/]iconv-lite/ },
                { name: "defuddle", test: /node_modules[\\/](defuddle|mathml-to-latex)[\\/]/ },
                { name: "turndown", test: /node_modules[\\/]turndown[\\/]/ },
                { name: "linkedom", test: /node_modules[\\/](linkedom|htmlparser2|domhandler|domutils|domelementtype|dom-serializer|entities|css-select|css-what|nth-check|boolbase|cssomnom|uhyphen|html-escaper)[\\/]/ },
                { name: "zipjs", test: /node_modules[\\/]@zip\.js[\\/]/ },
                { name: "xberg", test: /node_modules[\\/]@xberg-io[\\/]/ },
                { name: "mediabunny", test: /node_modules[\\/]mediabunny[\\/]/ },
                { name: "eld", test: /node_modules[\\/]eld[\\/]/ },
                // parse-document alternatives (each loaded only when picked).
                { name: "pdfium", test: /node_modules[\\/]@embedpdf[\\/]/ },
                { name: "pdf2md", test: /node_modules[\\/](@opendocsg[\\/]pdf2md|unpdf|enumify)[\\/]/ },
                { name: "officeparser", test: /node_modules[\\/]officeparser[\\/]/ },
                { name: "readability", test: /node_modules[\\/]@mozilla[\\/]readability[\\/]/ },
                // MuPDF.js (AGPL-3.0-or-later): the `mupdf` implementation of parse-document / render-pages.
                { name: "mupdf", test: /node_modules[\\/]mupdf[\\/]/ },
                // T3 (WebGPU) runtime: transformers.js + onnxruntime-web (one pinned version).
                { name: "onnxruntime-web", test: /node_modules[\\/](onnxruntime-web|onnxruntime-common)[\\/]/ },
                { name: "transformers", test: /node_modules[\\/]@huggingface[\\/]transformers[\\/]/ },
                { name: "structured-output", test: /node_modules[\\/]@huggingface[\\/]transformers-structured-output[\\/]/ },
            ],
        },
    },
});
