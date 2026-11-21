import { toMarkdownTable } from "../util/markdown.js";

/** .xlsx/.xlsm/.xlsb/.xls/.ods (SheetJS CE): one `## sheet` heading + Markdown table per sheet. */
export async function parseSheet(bytes: Uint8Array): Promise<string> {
    const [XLSX, cptable] = await Promise.all([import("xlsx"), import("xlsx/dist/cpexcel.full.mjs")]);
    // Code pages for legacy .xls strings (GBK/Big5/Shift-JIS …).
    XLSX.set_cptable(cptable);
    const wb = XLSX.read(bytes, { type: "array", cellDates: true, cellHTML: false, cellStyles: false });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: false });
        const table = toMarkdownTable(rows);
        parts.push(`## ${name}\n\n${table || "_(empty sheet)_"}`);
    }
    return parts.join("\n\n");
}
