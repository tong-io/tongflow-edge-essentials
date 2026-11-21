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
        if (!/[\\/]@huggingface[\\/]transformers[\\/]/.test(id)) return null;
        return code
            .replaceAll('remoteHost: "https://huggingface.co/"', 'remoteHost: "/models/"')
            .replaceAll("https://cdn.jsdelivr.net/npm/onnxruntime-web@", "/models/onnxruntime-web@");
    },
};

export default defineConfig({
    plugins: [noThirdPartyHosts],
    entry: ["src/index.ts", "src/embed-query.ts", "src/kb-host.ts"],
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
                // T3 (WebGPU) runtime: transformers.js + onnxruntime-web (one pinned version).
                { name: "onnxruntime-web", test: /node_modules[\\/](onnxruntime-web|onnxruntime-common)[\\/]/ },
                { name: "transformers", test: /node_modules[\\/]@huggingface[\\/]transformers[\\/]/ },
                { name: "structured-output", test: /node_modules[\\/]@huggingface[\\/]transformers-structured-output[\\/]/ },
            ],
        },
    },
});
