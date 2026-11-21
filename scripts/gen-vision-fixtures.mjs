#!/usr/bin/env node
// Fixtures for the T1 vision tests (run once; outputs are committed):
//   test/fixtures/paper.pdf  a two-column report page with a title, headings, a table and a chart (Chromium print)
//   test/fixtures/shots.mp4 / shots-gop.webm  three 2 s shots (testsrc2, mandelbrot, cellauto) + a 440 Hz tone;
//     the MP4 has key frames at the cuts (copy path), the WebM only at 0 s (re-encode path). Needs ffmpeg.
//   test/fixtures/cat.jpg, astronaut.jpg  scikit-image sample photos (chelsea: CC0 by Stefan van der Walt;
//     astronaut: NASA, public domain), converted from the scikit-image wheel's skimage/data/*.png.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test/fixtures");

const para = (n) =>
    "本季度公司持续推进数字化转型，各业务线保持稳定增长。华东区受益于新渠道拓展，销售额同比增长百分之十二；华北区在原材料价格上涨的情况下仍实现小幅增长。".repeat(n);
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:18mm}
body{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif;font-size:10.5pt;line-height:1.6;color:#111}
h1{text-align:center;font-size:20pt;margin:0 0 6pt}
.meta{text-align:center;color:#444;margin-bottom:10pt}
.abs{border-top:1px solid #999;border-bottom:1px solid #999;padding:6pt 0;margin-bottom:10pt}
.cols{column-count:2;column-gap:18pt}
h2{font-size:13pt;margin:8pt 0 4pt}
table{border-collapse:collapse;width:100%;margin:6pt 0;break-inside:avoid}
td,th{border:1px solid #333;padding:3pt 5pt;text-align:center}
.cap{text-align:center;font-size:9pt;color:#333}
.foot{position:fixed;bottom:0;width:100%;text-align:center;font-size:9pt;color:#555}
</style></head><body>
<h1>二〇二六年第三季度经营分析报告</h1>
<div class="meta">经营管理部 · 2026年10月</div>
<div class="abs"><b>摘要：</b>${para(1)}</div>
<div class="cols">
<h2>一、总体情况</h2><p>${para(2)}</p>
<h2>二、分区域销售</h2><p>${para(1)}</p>
<table><tr><th>地区</th><th>销售额（万元）</th><th>同比</th><th>占比</th></tr>
<tr><td>华东</td><td>1200</td><td>+12%</td><td>38%</td></tr>
<tr><td>华北</td><td>800</td><td>+3%</td><td>25%</td></tr>
<tr><td>华南</td><td>650</td><td>+8%</td><td>21%</td></tr>
<tr><td>西部</td><td>510</td><td>-2%</td><td>16%</td></tr></table>
<div class="cap">表1 分区域销售额</div>
<h2>三、产品结构</h2><p>${para(2)}</p>
<svg width="300" height="150" viewBox="0 0 300 150"><rect x="0" y="0" width="300" height="150" fill="#fff" stroke="#999"/>
<rect x="30" y="40" width="40" height="100" fill="#4a7"/><rect x="100" y="70" width="40" height="70" fill="#47a"/>
<rect x="170" y="85" width="40" height="55" fill="#a74"/><rect x="240" y="100" width="40" height="40" fill="#777"/></svg>
<div class="cap">图1 各产品线收入</div>
<h2>四、下季度计划</h2><p>${para(2)}</p>
</div>
<div class="foot">第 1 页</div>
</body></html>`;

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
writeFileSync(join(out, "paper.pdf"), await page.pdf({ format: "A4", printBackground: true, pageRanges: "1" }));
await browser.close();
console.log("wrote paper.pdf");

const ff = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });
ff([
    ...["-f", "lavfi", "-i", "testsrc2=size=240x136:rate=25:duration=2"],
    ...["-f", "lavfi", "-i", "mandelbrot=size=240x136:rate=25:end_pts=2"],
    ...["-f", "lavfi", "-i", "cellauto=size=240x136:rate=25:rule=110,format=yuv420p"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=6"],
    "-filter_complex",
    "[1:v]trim=duration=2,setpts=PTS-STARTPTS,format=yuv420p[b];[2:v]trim=duration=2,setpts=PTS-STARTPTS,hue=h=120:s=3[c];[0:v]format=yuv420p[a];[a][b][c]concat=n=3:v=1:a=0[v]",
    ...["-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "34", "-pix_fmt", "yuv420p"],
    ...["-force_key_frames", "0,2,4", "-sc_threshold", "0", "-g", "250", "-c:a", "aac", "-b:a", "32k", "-shortest"],
    ...["-movflags", "+faststart", join(out, "shots.mp4")],
]);
ff(["-i", join(out, "shots.mp4"), "-c:v", "libvpx-vp9", "-b:v", "200k", "-g", "300", "-keyint_min", "300", "-c:a", "libopus", "-b:a", "24k", join(out, "shots-gop.webm")]);
console.log("wrote shots.mp4, shots-gop.webm");
