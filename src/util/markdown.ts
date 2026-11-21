function cell(v: unknown): string {
    if (v === null || v === undefined) return "";
    return String(v).replace(/\r\n?|\n/g, "<br>").replace(/\|/g, "\\|").trim();
}

/**
 * Rows to a GitHub-flavoured Markdown table; the first row is the header.
 * Trailing empty rows and columns are dropped, short rows padded.
 */
export function toMarkdownTable(rows: unknown[][]): string {
    const cells = rows.map((r) => r.map(cell));
    while (cells.length && cells[cells.length - 1]!.every((c) => c === "")) cells.pop();
    if (!cells.length) return "";
    let width = 0;
    for (const r of cells) {
        let w = r.length;
        while (w > 0 && r[w - 1] === "") w--;
        width = Math.max(width, w);
    }
    if (width === 0) return "";
    const norm = cells.map((r) => {
        const out = r.slice(0, width);
        while (out.length < width) out.push("");
        return out;
    });
    const line = (r: string[]) => `| ${r.join(" | ")} |`;
    const [head, ...body] = norm;
    return [line(head!), line(new Array(width).fill("---")), ...body.map(line)].join("\n");
}
