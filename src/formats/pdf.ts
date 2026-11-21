import type { EdgeContext } from "../context.js";
import { throwIfAborted } from "../util/errors.js";
import { tidyText } from "../util/text.js";
import { openPdf } from "./pdfjs.js";

interface TextItemLike {
    str: string;
    hasEOL?: boolean;
}

/**
 * Some CJK fonts (PingFang among them) map ideographs to look-alike radical code
 * points in their ToUnicode tables: 二 → ⼆ (Kangxi Radicals), 长 → ⻓ (CJK Radicals
 * Supplement). Kangxi radicals fold back with NFKC; the supplement's simplified-form
 * radicals have no decomposition, so the ones that are whole characters are mapped
 * here. Applied per character, so full-width punctuation (，（）) is left alone.
 */
const SUPPLEMENT_RADICALS: Record<string, string> = {
    "\u2E9F": "母", "\u2EC4": "西", "\u2EC5": "见", "\u2EC6": "角", "\u2EC9": "贝",
    "\u2ECB": "车", "\u2ED0": "钅", "\u2ED3": "长", "\u2ED4": "门", "\u2ED9": "韦",
    "\u2EDA": "页", "\u2EDB": "风", "\u2EDC": "飞", "\u2EE0": "饣", "\u2EE2": "马",
    "\u2EE5": "鱼", "\u2EE6": "鸟", "\u2EE7": "卤", "\u2EE8": "麦", "\u2EE9": "黄",
    "\u2EEA": "黾", "\u2EEC": "齐", "\u2EEE": "齿", "\u2EF0": "龙", "\u2EF3": "龟",
};

export function normalizeRadicals(s: string): string {
    return s.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (c) => SUPPLEMENT_RADICALS[c] ?? c.normalize("NFKC"));
}

/**
 * Text layer of every page, pages separated by a blank line. A scanned PDF with no
 * text layer yields empty (or near-empty) text with success: deciding to OCR it is
 * the host's call, not this parser's.
 */
export async function parsePdf(bytes: Uint8Array, ctx: EdgeContext): Promise<string> {
    const doc = await openPdf(bytes, ctx);
    try {
        const pages: string[] = [];
        const n = doc.numPages;
        for (let i = 1; i <= n; i++) {
            throwIfAborted(ctx.signal);
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            let s = "";
            for (const item of content.items as TextItemLike[]) {
                if (typeof item.str !== "string") continue;
                s += item.str;
                if (item.hasEOL) s += "\n";
            }
            pages.push(tidyText(normalizeRadicals(s)));
            page.cleanup();
            ctx.onProgress({ fraction: i / n, message: `page ${i}/${n}` });
        }
        return pages.filter(Boolean).join("\n\n");
    } finally {
        await doc.loadingTask.destroy();
    }
}
