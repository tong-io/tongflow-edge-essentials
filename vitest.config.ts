import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
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
                server: { fs: { allow: [r("./"), realpathSync(r("./node_modules/tongflow"))] } },
                publicDir: rawPublicDir(),
                test: {
                    name: "browser",
                    include: ["test/browser/**/*.test.ts"],
                    testTimeout: 120_000,
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright(),
                        instances: [{ browser: "chromium" }],
                    },
                },
            },
        ],
    },
});
