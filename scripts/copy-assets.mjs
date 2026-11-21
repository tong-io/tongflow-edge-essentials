#!/usr/bin/env node
// Copy the runtime binary assets the lazy chunks load through ctx.resolveAsset()
// into dist/assets/. Nothing is fetched from a CDN at runtime: the host serves
// these files from its own origin next to dist/index.js.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** A source starting with "/" is relative to the repo root, anything else to node_modules. */
const nm = (p) => (p.startsWith("/") ? join(root, p.slice(1)) : join(root, "node_modules", p));
const dist = join(root, "dist", "assets");

/** [source in node_modules, destination under dist/assets] — keep in sync with test/helpers/node-ctx.ts. */
const COPIES = [
    ["pdfjs-dist/cmaps", "pdfjs/cmaps"], // CJK CMaps (bcmap) for text extraction and rendering
    ["pdfjs-dist/standard_fonts", "pdfjs/standard_fonts"], // the 14 standard fonts (Foxit/Liberation)
    ["pdfjs-dist/wasm", "pdfjs/wasm"], // JBIG2 / OpenJPEG / QCMS decoders
    ["pdfjs-dist/iccs", "pdfjs/iccs"], // CMYK ICC profile
    ["pdfjs-dist/LICENSE", "pdfjs/LICENSE"],
    ["@xberg-io/xberg-wasm/pkg/web/xberg_wasm_bg.wasm", "xberg/xberg_wasm_bg.wasm"], // legacy formats (~41 MB)
    ["@xberg-io/xberg-wasm/LICENSE", "xberg/LICENSE"],
    ["@embedpdf/pdfium/dist/pdfium.wasm", "pdfium/pdfium.wasm"], // parse-document's `pdfium` alternative (~4.6 MB)
    ["@embedpdf/pdfium/LICENSE", "pdfium/LICENSE"],
    ["@embedpdf/pdfium/LICENSE.pdfium", "pdfium/LICENSE.pdfium"],
    // onnxruntime-web (the version pinned in package.json): the WebGPU-capable
    // wasm build transformers.js loads through env.backends.onnx.wasm.wasmPaths.
    ["onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", "ort/ort-wasm-simd-threaded.asyncify.wasm"], // ~29 MB
    ["onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", "ort/ort-wasm-simd-threaded.asyncify.mjs"],
    ["/licenses/onnxruntime-web-MIT.txt", "ort/LICENSE"], // the npm package ships no LICENSE file
];

const LIMIT = 100 * 1024 * 1024;
let total = 0;
for (const [src, dst] of COPIES) {
    const from = nm(src);
    if (!existsSync(from)) throw new Error(`missing ${from}; run npm install`);
    const to = join(dist, dst);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
}
const walk = (d) =>
    readdirSync(d).forEach((f) => {
        const p = join(d, f);
        const s = statSync(p);
        if (s.isDirectory()) return walk(p);
        if (s.size > LIMIT) throw new Error(`${p} is over 100 MB`);
        total += s.size;
    });
walk(dist);
console.log(`copied assets into dist/assets (${(total / 1024 / 1024).toFixed(1)} MB)`);
