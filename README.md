# tongflow-edge-essentials

[English](#english) | [中文](#中文)

## English

Official [TongFlow](https://github.com/tong-io/tongflow) **browser edge plugin**. It parses
documents, renders PDF pages, pulls audio and first frames out of videos, and detects the
language of a text. All of it runs inside the user's browser, in a Web Worker, through TongFlow's
browser engine. Files never leave the device, and no model is downloaded: these are the
**T0 (zero-model)** nodes.

### Slots

| Slot | Method | What it does | Library |
|---|---|---|---|
| `parse-document` | `parseDocument` | Any supported document → Markdown-flavoured `text`. `images` is always `[]` for now. | see below |
| `render-pages` | `renderPages` | PDF → one PNG per page (`pages`, `x-expand-each`), 150 DPI, longest side capped at 4096 px. Browser only (OffscreenCanvas). | pdf.js 6.5.438 |
| `extract-audio` | `extractAudio` | The primary audio track of a video, **remuxed without re-encoding** when possible: AAC/AC-3 → `.m4a`, Opus/Vorbis → audio-only `.webm`, MP3 → `.mp3`, FLAC → `.flac`, PCM → `.wav`; anything else is transcoded to AAC with WebCodecs. | Mediabunny 1.66.2 |
| `get-first-frame` | `getFirstFrame` | First decodable video frame as PNG (rotation applied). Browser only (WebCodecs); the codecs are whatever the browser decodes. | Mediabunny 1.66.2 |
| `detect-language` | `detectLanguage` | Text → ISO 639-1 code (60 languages). Text without letters fails with a clear error. | eld 2.1.1 (`medium` n-grams) |

`parse-document` dispatches by MIME type, then file extension, then the leading bytes (so a
nameless upload still works):

| Format | How | Output |
|---|---|---|
| PDF | pdf.js text layer, page by page, with CJK CMaps | Text per page. A PDF without a text layer returns **success with empty text**; deciding to OCR it is the host's call. Look-alike CJK radicals that some fonts emit (⼆, ⻓) are folded back to the ideographs. |
| .docx/.docm/.dotx | mammoth → HTML → Markdown (defuddle's converter, turndown) | Headings, lists, tables |
| .xlsx/.xlsm/.xlsb/.xls/.ods | SheetJS CE 0.20.3 (with code pages for legacy .xls) | `## <sheet>` + a Markdown table per sheet |
| .csv/.tsv | PapaParse 5.7.1; UTF-8, UTF-16 or GBK/GB18030 | One Markdown table |
| .pptx/.ppsx | pptxtojson 3.0.0 | `## Slide N`, text in reading order, tables, `> Notes:` |
| .eml/.mht | postal-mime 4.2.1 | `# Subject`, From/To/Cc/Date, body, attachment list |
| .msg | msgreader 1.29.0 | Same layout as .eml |
| .html/.xhtml | defuddle 0.19.13 main-content extraction + turndown 7.2.5, on linkedom | Article Markdown; falls back to the whole body when extraction keeps too little |
| .md, .txt, .json, .xml, .yaml, … | decoded as text (UTF-8, BOM-aware, GBK fallback) | Passed through |
| .epub | zip.js 2.25.0 + linkedom: container → OPF → spine XHTML → Markdown | Book title + chapters in spine order |
| Legacy / long tail: .doc .ppt .rtf .odt .odp .pages .key .numbers .hwp .pst .fb2 .rst .tex .ipynb … | xberg-wasm 1.4.2, **loaded only when such a file arrives** (≈41 MB wasm, ≈17 MB gzip) | Markdown |
| Archives, images, audio/video, anything unknown | — | `success: false` with a clear error (archives are unpacked by the host; images go to `ocr-image`) |

### Using it from the engine

The entry `dist/index.js` default-exports `defineEdgePlugin({ methods })` from
`tongflow/engine/worker`. Loaded in a dedicated module worker it answers the engine's worker
protocol (v1); imported directly (the in-process executor) it is just the definition. Method
names are the `method` values in `tongflow.plugin.json`.

- **Context.** Each method receives the engine's ctx (`signal`, `progress(message, percent)`,
  `modelDownload({loaded, total, file})`) and adapts it to a small internal `EdgeContext`
  (`src/context.ts`): fractions become percents, and lazy asset downloads (the xberg wasm) are
  reported through `modelDownload` with `file: "xberg-wasm"`.
- **Assets.** The engine ctx has no asset resolver, so binary assets are resolved against the
  entry module: `new URL("assets/…", import.meta.url)`, i.e. `dist/assets/` next to
  `dist/index.js`. **A host must serve the whole `dist/` directory from the same origin it loads
  the entry from** (`.wasm` as `application/wasm`). Nothing is fetched from a third-party CDN:
  pdf.js CMaps, standard fonts and decoders, and the xberg wasm all ship in `dist/assets/`.
- **Failures and cancellation.** A failure returns `{ success: false, error }`, so only this
  node's branch stops. A cancelled run (`signal` aborted) rejects with the abort error instead.
- Inputs over 100 MB are refused (the edge runtime's per-file cap). Binary outputs are returned
  as inline `Asset`s (`bytesBase64`); the engine stores them and hands file refs downstream.

### Bundle

Every library is a lazy dynamic import, so the entry is 9 kB and each format loads only what it
needs. Gzip transfer on first use, chunks included:

| First use of | Loads (gzip) |
|---|---|
| any slot | `index.js` 3.7 kB |
| PDF text / render | pdf.js + its in-thread worker ≈ 495 kB (+ CMaps on demand, ≤ 1.6 MB raw total) |
| .docx | mammoth, xmldom, defuddle, linkedom ≈ 496 kB |
| .xlsx/.xls/.ods | SheetJS + code pages ≈ 326 kB |
| .csv | PapaParse ≈ 9 kB |
| .pptx | pptxtojson ≈ 124 kB |
| .eml / .msg | postal-mime 30 kB / msgreader 14 kB, + the HTML path for HTML-only bodies |
| .html | defuddle, linkedom, xmldom ≈ 426 kB |
| .epub | zip.js + the HTML path ≈ 514 kB |
| legacy formats | xberg glue 91 kB + wasm ≈ 17.3 MB (41 MB raw) |
| extract-audio / get-first-frame | Mediabunny ≈ 192 kB |
| detect-language | eld medium ≈ 558 kB |

`dist/` is committed: the scanner requires the manifest's `entry` to exist, and hosts load the
plugin straight from a clone. Rebuild it after any source change.

### Build and test

```bash
npm install
npm run build          # tsdown → dist/, then copies wasm/CMaps/fonts into dist/assets/
npm test               # vitest in Node: every parser, the slots, and an end-to-end run
                       # through the real engine (createInProcessEdgeExecutor + runWorkflow)
npm run test:browser   # build, then vitest browser mode (Playwright Chromium):
                       # dist/index.js as a module worker over protocol v1, plus
                       # createWorkerEdgeExecutor + runWorkflow
npm run fixtures       # regenerate test/fixtures (needs LibreOffice, ffmpeg, Playwright)
```

Node covers pdf.js (legacy build), docx, xlsx/xls/ods, csv, pptx, eml, msg, html, md/txt, epub,
the xberg legacy formats, `extract-audio` (remux needs no WebCodecs) and `detect-language`.
`render-pages` and `get-first-frame` need a browser and run in the browser project. Run
`npx playwright install chromium` once.

**The `tongflow` dependency** is a `file:` link to a TongFlow checkout at
`../../tongflow/packages/tongflow` (that is, `tongflow` cloned next to the directory holding this
repo), built so that its `dist/` has the `engine` entries. The published npm `tongflow@1.0.0`
predates the edge slots and `tongflow/engine/worker`; switch the dependency to a semver range
once a release that carries them is on npm. Only `defineEdgePlugin`/`edgeMethod` (0.26 kB) are
bundled; the ABI types are type-only.

**SheetJS** is installed from the vendored `vendor/xlsx-0.20.3.tgz`, downloaded from
`cdn.sheetjs.com` (SHA-256 `8dc73fc3…99fe8`). The `xlsx` on npm is stuck at 0.18.5.

### Design notes and deviations

- **EPUB** does not use foliate-js: it parses with `DOMParser` and builds `Blob` URLs for its
  renderer, which a DOM-less worker cannot host. zip.js + linkedom + the shared HTML → Markdown
  path cover text extraction.
- **Markdown** files pass through unchanged (they already are the output format), so marked is
  not bundled.
- **turndown** in a worker: its browser build parses HTML strings with `window.DOMParser`.
  Strings are parsed with linkedom first and handed to turndown as an element.
- **msgreader** imports `iconv-lite`, which needs Node's `Buffer`; a `TextDecoder` shim replaces
  it in the bundle.
- `parse-document` does not open attachments of e-mails; it lists them.

### Licenses

This plugin is AGPL-3.0, like TongFlow and its official plugins. No bundled library is AGPL,
and none is GPL-only.

| Library | Version | License | Note |
|---|---|---|---|
| pdfjs-dist (pdf.js) | 6.5.438 | Apache-2.0 | Its wasm decoders are PDFium JBIG2 (BSD-3), OpenJPEG (BSD-2), QCMS (MIT) and QuickJS (MIT). Its standard fonts are Foxit (BSD) and Liberation (OFL-1.1). |
| mammoth | 1.13.0 | BSD-2-Clause | Plus lop, option, dingbat-to-unicode (BSD-2), underscore, xmlbuilder, base64-js (MIT) |
| **jszip** (inside mammoth and pptxtojson) | 3.10.2 | **MIT OR GPL-3.0-or-later** | ⚠️ Dual-licensed; used under MIT |
| xlsx (SheetJS CE) | 0.20.3 | Apache-2.0 | Self-hosted tgz |
| papaparse | 5.7.1 | MIT | |
| pptxtojson | 3.0.0 | MIT | Plus txml, tinycolor2 (MIT); jszip's pako (MIT AND Zlib) |
| postal-mime | 4.2.1 | MIT-0 | |
| @kenjiuno/msgreader | 1.29.0 | Apache-2.0 | Plus @kenjiuno/decompressrtf (BSD-2-Clause) |
| defuddle | 0.19.13 | MIT | Plus mathml-to-latex, temml (MIT) |
| turndown | 7.2.5 | MIT | |
| linkedom | 0.18.15 | ISC | Plus htmlparser2, css-select, domutils … (MIT / BSD-2 / ISC) and cssomnom (Apache-2.0) |
| @xmldom/xmldom | 0.8.15 | MIT | |
| @zip.js/zip.js | 2.25.0 | BSD-3-Clause | |
| @xberg-io/xberg-wasm | 1.4.2 | MIT | |
| **mediabunny** | 1.66.2 | **MPL-2.0** | ⚠️ File-level copyleft. It is bundled unmodified, and its source is on npm and GitHub. Changes to its files would have to be published under MPL-2.0. |
| eld | 2.1.1 | Apache-2.0 | |
| tongflow (engine/worker) | 1.0.0 (monorepo) | AGPL-3.0 | First-party; `defineEdgePlugin` and `edgeMethod` |

Avoided on purpose: MuPDF.js and scribe.js (AGPL-3.0), the ffmpeg.wasm core (GPL-2.0+) and the
Ultralytics models (AGPL-3.0).

Test fixture `test/fixtures/hello-cjk.msg` comes from the msgreader test suite (Apache-2.0).

---

## 中文

[TongFlow](https://github.com/tong-io/tongflow) 官方**浏览器端边缘插件**。它在用户浏览器的 Web Worker 里,通过 TongFlow
浏览器引擎完成以下工作:解析文档、把 PDF 渲染成页面图、从视频中抽取音轨和首帧、识别文本语种。文件不出设备,也不下载任何模型,即
**T0(零模型)** 节点。

### 实现的 slot

| Slot | 方法 | 作用 | 库 |
|---|---|---|---|
| `parse-document` | `parseDocument` | 各类文档转成 Markdown 风格的 `text`;`images` 暂时恒为 `[]` | 见下表 |
| `render-pages` | `renderPages` | PDF 每页输出一张 PNG(`pages`,`x-expand-each`)。分辨率 150 DPI,最长边不超过 4096 px。仅限浏览器(需要 OffscreenCanvas) | pdf.js 6.5.438 |
| `extract-audio` | `extractAudio` | 抽取视频的主音轨,能不重编码就直接转封装:AAC/AC-3 转 `.m4a`,Opus/Vorbis 转纯音频 `.webm`,MP3 转 `.mp3`,FLAC 转 `.flac`,PCM 转 `.wav`。其它编码用 WebCodecs 转成 AAC | Mediabunny 1.66.2 |
| `get-first-frame` | `getFirstFrame` | 视频第一帧可解码画面,输出 PNG(已按旋转信息校正)。仅限浏览器(WebCodecs),能解哪些编码取决于浏览器 | Mediabunny 1.66.2 |
| `detect-language` | `detectLanguage` | 输出文本的 ISO 639-1 语种代码,支持 60 种语言。没有字母的文本会明确报错 | eld 2.1.1(medium 词典) |

`parse-document` 按以下顺序判断格式:先看 MIME,再看扩展名,最后看文件头字节。没有文件名的上传也能识别。

| 格式 | 做法 | 输出 |
|---|---|---|
| PDF | pdf.js 文本层,逐页抽取,带 CJK CMap | 按页输出文本。没有文本层的 PDF **返回成功、文本为空**,是否 OCR 由宿主的体检决定。部分字体会把汉字映射成部首码位(⼆、⻓),这里会还原成正常汉字 |
| .docx/.docm/.dotx | mammoth 转 HTML,再转 Markdown(defuddle 的转换器 + turndown) | 保留标题、列表、表格 |
| .xlsx/.xlsm/.xlsb/.xls/.ods | SheetJS CE 0.20.3(含老 .xls 的代码页) | 每个工作表一个 `## 表名` 加一张 Markdown 表格 |
| .csv/.tsv | PapaParse 5.7.1;支持 UTF-8、UTF-16、GBK/GB18030 | 一张 Markdown 表格 |
| .pptx/.ppsx | pptxtojson 3.0.0 | `## Slide N`,文本按阅读顺序排列,含表格和 `> Notes:` 演讲者备注 |
| .eml/.mht | postal-mime 4.2.1 | `# 主题`、发件人/收件人/抄送/日期、正文、附件清单 |
| .msg | msgreader 1.29.0 | 版式同 .eml |
| .html/.xhtml | linkedom 上运行 defuddle 0.19.13 抽正文,再用 turndown 7.2.5 转换 | 正文 Markdown。抽取保留的内容过少时,改为转换整个 body |
| .md、.txt、.json、.xml、.yaml 等 | 按文本解码(识别 BOM,非 UTF-8 时回退到 GBK) | 原样输出 |
| .epub | zip.js 2.25.0 + linkedom:container → OPF → 按 spine 顺序读 XHTML → Markdown | 书名加各章正文 |
| 老格式和长尾格式:.doc .ppt .rtf .odt .odp .pages .key .numbers .hwp .pst .fb2 .rst .tex .ipynb 等 | xberg-wasm 1.4.2,**遇到这类文件才加载**(wasm 约 41 MB,gzip 后约 17 MB) | Markdown |
| 压缩包、图片、音视频、无法识别的格式 | — | `success: false` 并给出明确原因(压缩包由宿主在上传时解开;图片请走 `ocr-image`) |

### 与引擎对接

入口 `dist/index.js` 的默认导出是 `defineEdgePlugin({ methods })`,来自 `tongflow/engine/worker`。在专用 module worker 里加载时,它按
引擎的 worker 协议(v1)应答;被直接 import 时(in-process executor),它只是插件定义。方法名与 `tongflow.plugin.json` 里的 `method`
一致。

- **上下文**:每个方法收到引擎的 ctx(`signal`、`progress(message, percent)`、`modelDownload({loaded, total, file})`),再适配成内部的
  `EdgeContext`(`src/context.ts`)。进度比例会换算成百分比;按需下载的资源(xberg wasm)通过 `modelDownload` 上报,`file` 为 `"xberg-wasm"`。
- **静态资源**:引擎的 ctx 不提供资源解析,所以资源 URL 相对入口模块计算:`new URL("assets/…", import.meta.url)`,即 `dist/index.js`
  旁边的 `dist/assets/`。**宿主必须用加载入口的同一个源提供整个 `dist/` 目录**,`.wasm` 的 Content-Type 要设为 `application/wasm`。
  运行时不访问任何第三方 CDN:pdf.js 的 CMap、标准字体、解码器以及 xberg wasm 都随 `dist/assets/` 发布。
- **失败与取消**:失败时返回 `{ success: false, error }`,只中止本节点所在的支路。运行被取消(`signal` 触发 abort)时直接抛出 abort 错误。
- 超过 100 MB 的输入会被拒绝(边缘运行时的单文件上限)。二进制输出以内联 `Asset`(`bytesBase64`)返回,由引擎存储,再以文件引用传给下游。

### 包体

所有库都是懒加载的动态 import:入口只有 9 kB,每种格式只加载自己需要的部分。首次使用时的 gzip 传输量(含依赖的 chunk)见上方英文表格。
主要数字:

- PDF 约 495 kB;
- docx 约 496 kB;
- 表格类约 326 kB;
- csv 约 9 kB;
- pptx 约 124 kB;
- html 约 426 kB;
- epub 约 514 kB;
- 音视频约 192 kB;
- 语种识别约 558 kB;
- 老格式 91 kB,另加 wasm 约 17.3 MB。

`dist/` 会提交进仓库:scanner 要求 manifest 的 `entry` 文件存在,宿主也是克隆仓库后直接加载。改动源码后要重新构建。

### 构建与测试

```bash
npm install
npm run build          # tsdown 输出到 dist/,再把 wasm/CMap/字体复制到 dist/assets/
npm test               # Node 下的 vitest:各解析器、各 slot,以及经真实引擎的端到端测试
                       # (createInProcessEdgeExecutor + runWorkflow)
npm run test:browser   # 先构建,再跑 vitest 浏览器模式(Playwright Chromium):
                       # 把 dist/index.js 当 module worker 按协议 v1 调用,
                       # 并用 createWorkerEdgeExecutor + runWorkflow 跑一遍
npm run fixtures       # 重新生成 test/fixtures(需要 LibreOffice、ffmpeg、Playwright)
```

**`tongflow` 依赖**是 `file:` 链接,指向 `../../tongflow/packages/tongflow`,也就是与本仓库上级目录并列克隆的 TongFlow,并且需要先构建,
让 `dist/` 里有 engine 入口。npm 上的 `tongflow@1.0.0` 早于边缘 slot 和 `tongflow/engine/worker`,等带这些内容的版本发布后改成版本号依赖。
打进包里的只有 `defineEdgePlugin`/`edgeMethod`(0.26 kB),ABI 类型只在编译期使用。

**SheetJS** 从仓库内的 `vendor/xlsx-0.20.3.tgz` 安装,该文件下载自 `cdn.sheetjs.com`。npm 上的 `xlsx` 停在 0.18.5,不要用。

### 设计说明与偏离

- **EPUB** 没用 foliate-js:它依赖 `DOMParser`,还要为渲染器生成 `Blob` URL,没有 DOM 的 worker 承载不了。改用 zip.js + linkedom,
  再走统一的 HTML → Markdown 流程。
- **Markdown** 文件原样输出(它本身就是输出格式),所以没有打包 marked。
- **turndown** 的浏览器版用 `window.DOMParser` 解析 HTML 字符串,worker 里没有这个对象。插件先用 linkedom 解析,再把元素交给 turndown。
- **msgreader** 依赖的 `iconv-lite` 需要 Node 的 `Buffer`,打包时换成了基于 `TextDecoder` 的垫片。
- 邮件附件只列出清单,不展开解析。

### 许可证

本插件采用 AGPL-3.0,与 TongFlow 及其官方插件一致。打包的第三方库中没有 AGPL,也没有仅限 GPL 的库。
需要注意的有两个:

- **jszip**:MIT 或 GPL-3.0 双许可,这里按 MIT 使用;
- **Mediabunny**:MPL-2.0,属于文件级 copyleft。插件未修改其源码,若修改则须按 MPL-2.0 公开改动的文件。

完整列表见英文部分的表格。以下项目刻意未用:MuPDF.js 和 scribe.js(AGPL-3.0)、ffmpeg.wasm core(GPL-2.0+)、Ultralytics 系模型(AGPL-3.0)。
