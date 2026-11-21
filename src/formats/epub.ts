import type { EdgeContext } from "../context.js";
import { EdgeError, throwIfAborted } from "../util/errors.js";
import { htmlToMarkdown } from "./html.js";

/**
 * EPUB without foliate-js: foliate-js parses with `DOMParser` and builds `Blob`
 * URLs for a renderer, which a DOM-less worker cannot host. Instead: zip.js reads the
 * container, linkedom parses container.xml / the OPF package, and each spine XHTML
 * document goes through the same HTML → Markdown path as everything else.
 */
export async function parseEpub(bytes: Uint8Array, ctx: EdgeContext): Promise<string> {
    const [zip, { DOMParser }] = await Promise.all([import("@zip.js/zip.js"), import("linkedom")]);
    zip.configure({ useWebWorkers: false });
    const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes));
    try {
        const entries = await reader.getEntries({ filenameEncoding: "utf-8" });
        const byName = new Map(entries.map((e) => [e.filename, e]));
        const read = async (name: string): Promise<string | undefined> => {
            const entry = byName.get(name) ?? byName.get(decodeURIComponent(name));
            if (!entry || entry.directory || !("getData" in entry) || !entry.getData) return undefined;
            return entry.getData(new zip.TextWriter("utf-8"));
        };
        const xml = (s: string) => new DOMParser().parseFromString(s, "text/xml");

        const container = await read("META-INF/container.xml");
        if (!container) throw new EdgeError("not an EPUB: META-INF/container.xml is missing");
        const rootPath = xml(container).querySelector("rootfile")?.getAttribute("full-path");
        if (!rootPath) throw new EdgeError("not an EPUB: container.xml names no rootfile");
        const opfText = await read(rootPath);
        if (!opfText) throw new EdgeError(`EPUB package document ${rootPath} is missing`);
        const opf = xml(opfText);
        const base = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/") + 1) : "";

        const manifest = new Map<string, { href: string; type: string }>();
        for (const item of Array.from(opf.querySelectorAll("manifest > item")) as Element[]) {
            const id = item.getAttribute("id");
            const href = item.getAttribute("href");
            if (id && href) manifest.set(id, { href, type: item.getAttribute("media-type") ?? "" });
        }
        const title = (opf.getElementsByTagName("dc:title")[0]?.textContent ?? "").trim();
        const spine = (Array.from(opf.querySelectorAll("spine > itemref")) as Element[])
            .filter((r) => r.getAttribute("linear") !== "no")
            .map((r) => manifest.get(r.getAttribute("idref") ?? ""))
            .filter((m): m is { href: string; type: string } => !!m && /html|xml/.test(m.type || "xhtml"));

        const parts: string[] = [];
        if (title) parts.push(`# ${title}`);
        for (let i = 0; i < spine.length; i++) {
            throwIfAborted(ctx.signal);
            const href = resolvePath(base, spine[i]!.href.split("#")[0]!);
            const html = await read(href);
            if (html) {
                const { markdown } = await htmlToMarkdown(html, "document");
                if (markdown) parts.push(markdown);
            }
            ctx.onProgress({ fraction: (i + 1) / spine.length, message: `chapter ${i + 1}/${spine.length}` });
        }
        return parts.join("\n\n");
    } finally {
        await reader.close();
    }
}

function resolvePath(base: string, href: string): string {
    const out: string[] = [];
    for (const seg of (base + href).split("/")) {
        if (seg === "..") out.pop();
        else if (seg !== "." && seg !== "") out.push(seg);
    }
    return out.join("/");
}
