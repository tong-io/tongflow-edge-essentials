#!/usr/bin/env node
// Regenerate test/fixtures/. Needs LibreOffice (`soffice`) and `ffmpeg` on PATH;
// the generated files are committed, so the tests themselves need neither.
//
//   npm run fixtures
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import PptxGenJS from "pptxgenjs";
import iconv from "iconv-lite";
import { BlobWriter, TextReader, ZipWriter, configure } from "@zip.js/zip.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test/fixtures");
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "tf-edge-fixtures-"));
const w = (name, data) => writeFileSync(join(out, name), data);

// ---------- Word-processor family (LibreOffice converts one HTML source) ----------
const reportHtml = `<!doctype html><html><head><meta charset="utf-8"><title>季度报告</title><style>body,h1,h2,p,li,td,th{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif}</style></head><body>
<h1>季度报告 Quarterly Report</h1>
<p>本报告总结了二〇二六年第三季度的销售情况。The quick brown fox jumps over the lazy dog.</p>
<h2>主要结论</h2>
<ul><li>华东区销售额增长百分之十二</li><li>新产品上市顺利</li></ul>
<table border="1"><tr><th>地区</th><th>销售额</th></tr><tr><td>华东</td><td>1200</td></tr><tr><td>华北</td><td>800</td></tr></table>
</body></html>`;
writeFileSync(join(work, "report.html"), reportHtml);
const soffice = (args) => execFileSync("soffice", ["--headless", "--norestore", ...args], { cwd: work, stdio: "pipe" });
soffice(["--infilter=HTML (StarWriter)", "--convert-to", "docx:MS Word 2007 XML", "report.html"]);
for (const [ext, filter] of [
    ["doc", "MS Word 97"],
    ["odt", "writer8"],
    ["rtf", "Rich Text Format"],
]) {
    soffice(["--convert-to", `${ext}:${filter}`, "report.docx"]);
}
for (const ext of ["docx", "doc", "odt", "rtf"]) copyFileSync(join(work, `report.${ext}`), join(out, `report.${ext}`));
// PDF via Chromium print (system CJK fonts, proper ToUnicode); Homebrew LibreOffice
// has no CJK font and emits tofu glyphs whose text survives only as /ActualText.
{
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(reportHtml.replace("<style>", "<style>@page{size:A4;margin:20mm} "));
    w("report.pdf", await page.pdf({ format: "A4", printBackground: true }));
    await browser.close();
}

// ---------- Scanned-style PDF: one page, a filled rectangle, no text layer ----------
{
    const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>",
    ];
    const stream = "0.2 0.4 0.8 rg 20 20 160 60 re f";
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    objs.forEach((o, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    w("no-text-layer.pdf", pdf);
}

// ---------- Spreadsheets (SheetJS writes xlsx / xls / ods) ----------
{
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
            ["产品", "数量", "单价"],
            ["苹果", 12, 3.5],
            ["香蕉", 7, 2.25],
        ]),
        "销售",
    );
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
            ["Name", "Note"],
            ["Alice", "a|b"],
        ]),
        "Notes",
    );
    for (const bookType of ["xlsx", "xls", "ods"]) {
        w(`sales.${bookType}`, XLSX.write(wb, { type: "buffer", bookType: bookType === "xls" ? "biff8" : bookType }));
    }
}

// ---------- CSV (UTF-8 and GBK) ----------
const csv = '城市,人口（万）,备注\n上海,2487,"直辖市, 东部"\n成都,2140,西部\n';
w("cities.csv", csv);
w("cities-gbk.csv", iconv.encode(csv, "gbk"));

// ---------- PowerPoint (pptxgenjs → pptx; LibreOffice → ppt) ----------
{
    const pptx = new PptxGenJS();
    const s1 = pptx.addSlide();
    s1.addText("产品发布会", { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 32 });
    s1.addText("第二行：欢迎各位来宾", { x: 0.5, y: 1.6, w: 9, h: 1, fontSize: 18 });
    s1.addNotes("演讲者备注：先介绍团队");
    const s2 = pptx.addSlide();
    s2.addText("价格表", { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 24 });
    s2.addTable(
        [
            [{ text: "型号" }, { text: "价格" }],
            [{ text: "A1" }, { text: "999" }],
        ],
        { x: 0.5, y: 1.4, w: 6 },
    );
    const buf = await pptx.write({ outputType: "nodebuffer" });
    writeFileSync(join(work, "launch.pptx"), buf);
    w("launch.pptx", buf);
    soffice(["--convert-to", "ppt:MS PowerPoint 97", "launch.pptx"]);
    copyFileSync(join(work, "launch.ppt"), join(out, "launch.ppt"));
}

// ---------- E-mail ----------
{
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const eml = [
        "From: =?UTF-8?B?" + b64("张三") + "?= <zhangsan@example.com>",
        "To: Li Si <lisi@example.com>",
        "Cc: wangwu@example.com",
        "Subject: =?UTF-8?B?" + b64("会议纪要：项目启动") + "?=",
        "Date: Mon, 16 Nov 2026 09:30:00 +0800",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        'Content-Type: multipart/alternative; boundary="alt"',
        "",
        "--alt",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64("各位好，\n\n项目于下周一正式启动，请准时参加。\n\nThanks"),
        "--alt",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64("<p>各位好，</p><p>项目于下周一<b>正式启动</b>，请准时参加。</p>"),
        "--alt--",
        "--mix",
        'Content-Type: text/plain; name="agenda.txt"',
        'Content-Disposition: attachment; filename="agenda.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        b64("1. 介绍\n2. 计划\n"),
        "--mix--",
        "",
    ].join("\r\n");
    w("meeting.eml", eml);
}
// Outlook .msg sample from msgreader's test suite (Apache-2.0, HiraokaHyperTools/msgreader).
try {
    const raw = execFileSync("gh", [
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        "repos/HiraokaHyperTools/msgreader/contents/test/Hello%20%2BCJK.msg",
    ]);
    w("hello-cjk.msg", raw);
} catch (e) {
    console.warn("could not fetch hello-cjk.msg (gh api); keeping the committed copy", e.message);
}

// ---------- HTML / Markdown / text ----------
w(
    "article.html",
    `<!doctype html><html><head><meta charset="utf-8"><title>城市更新的十年</title></head><body>
<nav><a href="/">首页</a> | <a href="/news">新闻</a> | <a href="/about">关于我们</a></nav>
<article><h1>城市更新的十年</h1>
<p>过去十年，城市更新从拆除重建转向微更新。老旧小区加装电梯、街道口袋公园、社区食堂等项目，让居民切实感受到变化。</p>
<p>专家指出，下一阶段的重点是存量空间的精细化运营，以及公众参与机制的完善。</p>
<h2>典型案例</h2>
<p>上海的“一江一河”滨水空间贯通工程，已向市民开放超过一百公里岸线。</p>
</article>
<footer>© 2026 某某日报 版权所有</footer>
</body></html>`,
);
w("notes.md", "# 读书笔记\n\n- 第一章：问题的提出\n- 第二章：方法\n\n> 引用：知行合一。\n");
w("plain.txt", "这是一个纯文本文件。\nSecond line.\n");

// ---------- EPUB (zip.js; mimetype stored first, uncompressed) ----------
{
    configure({ useWebWorkers: false });
    const zw = new ZipWriter(new BlobWriter("application/epub+zip"));
    await zw.add("mimetype", new TextReader("application/epub+zip"), { level: 0, extendedTimestamp: false, dataDescriptor: false });
    await zw.add(
        "META-INF/container.xml",
        new TextReader(
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        ),
    );
    await zw.add(
        "OEBPS/content.opf",
        new TextReader(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:1</dc:identifier><dc:title>山海小记</dc:title><dc:language>zh</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    );
    await zw.add("OEBPS/nav.xhtml", new TextReader('<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">一</a></li></ol></nav></body></html>'));
    const ch = (t, p) =>
        `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1><p>${p}</p></body></html>`;
    await zw.add("OEBPS/text/ch1.xhtml", new TextReader(ch("第一章 出发", "清晨，我们从山脚出发，雾气还没有散。")));
    await zw.add("OEBPS/text/ch2.xhtml", new TextReader(ch("第二章 海边", "傍晚到达海边，潮水正在退去。")));
    const blob = await zw.close();
    w("book.epub", Buffer.from(await blob.arrayBuffer()));
}

// ---------- Media (ffmpeg): H.264/AAC MP4, VP9/Opus WebM, silent WebM ----------
{
    const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: work });
    const src = ["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
    ff([...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-shortest", "-movflags", "+faststart", "clip.mp4"]);
    ff([...src, "-c:v", "libvpx-vp9", "-b:v", "100k", "-c:a", "libopus", "-b:a", "32k", "-shortest", "clip.webm"]);
    ff(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=1", "-c:v", "libvpx-vp9", "-b:v", "100k", "silent.webm"]);
    for (const f of ["clip.mp4", "clip.webm", "silent.webm"]) copyFileSync(join(work, f), join(out, f));
}

rmSync(work, { recursive: true, force: true });
console.log("fixtures written to", out);
console.log(
    readFileSync(join(out, "report.pdf")).subarray(0, 8).toString("latin1").startsWith("%PDF") ? "pdf ok" : "pdf missing",
);
