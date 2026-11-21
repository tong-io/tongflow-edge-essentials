/**
 * `parse-document` alternative `readability` for HTML: Mozilla's Readability (the Firefox reader
 * view) picks the main article on a linkedom document (no DOM needed, worker-safe), then the
 * default parser's HTML → Markdown converter writes it. The page title is the top heading.
 * When Readability finds no article, the whole body is converted.
 */
import { tidyText } from "../util/text.js";
import { htmlToMarkdown } from "./html.js";

type Deps = { parseHTML: typeof import("linkedom").parseHTML; Readability: typeof import("@mozilla/readability").Readability };
let deps: Promise<Deps> | undefined;

function load(): Promise<Deps> {
    deps ??= Promise.all([import("linkedom"), import("@mozilla/readability")]).then(([l, r]) => ({
        parseHTML: l.parseHTML,
        Readability: (r as unknown as { Readability?: Deps["Readability"]; default?: { Readability: Deps["Readability"] } }).Readability ??
            (r as unknown as { default: { Readability: Deps["Readability"] } }).default.Readability,
    }));
    deps.catch(() => {
        deps = undefined;
    });
    return deps;
}

export async function parseHtmlReadability(html: string): Promise<string> {
    const { parseHTML, Readability } = await load();
    const full = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
    const { document } = parseHTML(full);
    const article = new Readability(document as unknown as Document, { keepClasses: false }).parse();
    if (!article?.content) return (await htmlToMarkdown(html, "document")).markdown;
    const { markdown } = await htmlToMarkdown(article.content, "document");
    const title = article.title?.trim();
    if (!title) return markdown;
    // Readability turns the article's <h1> into <h2>: the title goes back to the top level.
    if (markdown.startsWith(`## ${title}\n`) || markdown === `## ${title}`) return markdown.slice(1);
    if (!/^#\s/.test(markdown) && !markdown.slice(0, 300).includes(title)) return tidyText(`# ${title}\n\n${markdown}`);
    return markdown;
}
