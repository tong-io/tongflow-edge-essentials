import { toMarkdownTable } from "../util/markdown.js";
import { decodeText } from "../util/text.js";

/** CSV/TSV (PapaParse, delimiter auto-detected; UTF-8 or GBK) → one Markdown table. */
export async function parseCsv(bytes: Uint8Array): Promise<string> {
    const mod = await import("papaparse");
    const Papa = (mod as unknown as { default?: typeof mod }).default ?? mod;
    const text = decodeText(bytes);
    const res = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    return toMarkdownTable(res.data);
}
