import { tidyText } from "../util/text.js";

/**
 * HTML → Markdown, DOM-free so it runs in a worker:
 *
 * - `article` (web pages saved as .html): defuddle's main-content extraction over a
 *   linkedom document, then its Markdown conversion. Navigation, footers and other
 *   page chrome are dropped.
 * - `document` (HTML we produced from a document: docx, e-mail bodies, EPUB
 *   chapters): defuddle's Markdown converter (turndown + its table/code rules) only.
 *   Nothing is boilerplate there, and defuddle's article heuristics would demote or
 *   drop the first heading.
 */
export type HtmlMode = "article" | "document";

type Deps = {
    parseHTML: typeof import("linkedom").parseHTML;
    Defuddle: typeof import("defuddle/node").Defuddle;
    createMarkdownContent: (html: string, url: string) => string;
};
let depsPromise: Promise<Deps> | undefined;

async function loadDeps(): Promise<Deps> {
    depsPromise ??= (async () => {
        const [{ parseHTML }, turndownMod] = await Promise.all([import("linkedom"), import("turndown")]);
        patchTurndown((turndownMod as unknown as { default: TurndownCtor }).default, parseHTML);
        const [{ Defuddle }, md] = await Promise.all([import("defuddle/node"), import("defuddle/dist/markdown.js")]);
        const createMarkdownContent =
            (md as { createMarkdownContent?: Deps["createMarkdownContent"] }).createMarkdownContent ??
            (md as { default: { createMarkdownContent: Deps["createMarkdownContent"] } }).default.createMarkdownContent;
        return { parseHTML, Defuddle, createMarkdownContent };
    })();
    depsPromise.catch(() => {
        depsPromise = undefined;
    });
    return depsPromise;
}

type TurndownCtor = { prototype: { turndown(input: unknown): string; __edgePatched?: boolean } };

/**
 * turndown's browser build parses HTML strings with `window.DOMParser` or
 * `document.implementation`, neither of which exists in a worker. Parse strings with
 * linkedom first and hand turndown the element, exactly as its own
 * `<x-turndown id="turndown-root">` wrapper would.
 */
function patchTurndown(TurndownService: TurndownCtor, parseHTML: typeof import("linkedom").parseHTML) {
    const proto = TurndownService?.prototype;
    if (!proto || proto.__edgePatched) return;
    if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === "function" && typeof document !== "undefined") return;
    const original = proto.turndown;
    proto.turndown = function (input: unknown) {
        if (typeof input === "string") {
            const { document: doc } = parseHTML(
                `<!doctype html><html><body><x-turndown id="turndown-root">${input}</x-turndown></body></html>`,
            );
            input = doc.getElementById("turndown-root");
        }
        return original.call(this, input);
    };
    proto.__edgePatched = true;
}

/** The <body> content of a full document (or the fragment itself), without images or scripts. */
function bodyOf(html: string): string {
    const m = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(html);
    const body = m ? m[1]! : html.replace(/<\?xml[^>]*>/i, "").replace(/<head[\s\S]*?<\/head>/i, "");
    return body
        .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<img\b[^>]*>/gi, "")
        .replace(/<\/?(html|body)[^>]*>/gi, "");
}

const SACRIFICE = "tongflow-edge-title";
const SACRIFICE_LINE = /^# tongflow-edge-title\n+/;

export async function htmlToMarkdown(html: string, mode: HtmlMode): Promise<{ markdown: string; title?: string }> {
    const { parseHTML, Defuddle, createMarkdownContent } = await loadDeps();
    // createMarkdownContent always strips a leading "# …" line (it assumes the title
    // is shown elsewhere); a sacrificial <h1> keeps the document's own first heading.
    const whole = () => tidyText(createMarkdownContent(`<h1>${SACRIFICE}</h1>` + bodyOf(html), "about:blank").replace(SACRIFICE_LINE, ""));
    if (mode === "document") return { markdown: whole() };

    const full = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
    const { document: doc } = parseHTML(full);
    const visible = (doc.body?.textContent ?? "").replace(/\s+/g, "").length;
    const res = await Defuddle(doc as unknown as Document, "about:blank", {
        markdown: true,
        useAsync: false, // never call third-party APIs
        removeImages: true, // images are not text; the `images` output is a later ticket
    });
    const markdown = tidyText(res.content ?? "");
    const title = res.title?.trim() || undefined;
    // Main-content extraction can be too eager on short or unusual pages: if it kept
    // well under half of the visible text, convert the whole body instead.
    const kept = markdown.replace(/[\s#*_>`|\-[\]()]+/g, "").length;
    if (!markdown || (visible > 200 && kept < visible * 0.4)) return { markdown: whole(), title };
    return { markdown, title };
}

/** A saved web page: its main content, with the page title as the top heading. */
export async function parseHtml(text: string): Promise<string> {
    const { markdown, title } = await htmlToMarkdown(text, "article");
    if (title && !/^#\s/.test(markdown) && !markdown.slice(0, 300).includes(title)) {
        return `# ${title}\n\n${markdown}`;
    }
    return markdown;
}
