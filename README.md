# tongflow-edge-essentials

[English](#english) | [中文](#中文)

## English

Official [TongFlow](https://github.com/tong-io/tongflow) **browser edge plugin**. It parses
documents, renders PDF pages, pulls audio and first frames out of videos, detects the language
of a text, and chunks and embeds text for an on-device knowledge base. All of it runs inside the
user's browser, in a Web Worker, through TongFlow's browser engine. Files never leave the device.
The document, media and language nodes are **T0 (zero-model)**; `embed-text` downloads a 24 MB
model from the host's model base on first use. Optional **T3 (WebGPU)** nodes add image
understanding, GLM-OCR, image embeddings and key-point extraction with 250–850 MB models; see
[T3 WebGPU nodes](#t3-webgpu-nodes).

### Slots

| Slot | Method | What it does | Library |
|---|---|---|---|
| `parse-document` | `parseDocument` | Any supported document → Markdown-flavoured `text`. `images` is always `[]` for now. | see below |
| `render-pages` | `renderPages` | PDF → one PNG per page (`pages`, `x-expand-each`), 150 DPI, longest side capped at 4096 px. Browser only (OffscreenCanvas). | pdf.js 6.5.438 |
| `extract-audio` | `extractAudio` | The primary audio track of a video, **remuxed without re-encoding** when possible: AAC/AC-3 → `.m4a`, Opus/Vorbis → audio-only `.webm`, MP3 → `.mp3`, FLAC → `.flac`, PCM → `.wav`; anything else is transcoded to AAC with WebCodecs. | Mediabunny 1.66.2 |
| `get-first-frame` | `getFirstFrame` | First decodable video frame as PNG (rotation applied). Browser only (WebCodecs); the codecs are whatever the browser decodes. | Mediabunny 1.66.2 |
| `detect-language` | `detectLanguage` | Text → ISO 639-1 code (60 languages). Text without letters fails with a clear error. | eld 2.1.1 (`medium` n-grams) |
| `chunk-text` | `chunkText` | Texts → chunks for the knowledge base (see [Knowledge base](#knowledge-base-chunk-text-embed-text-kb-write)) | own code |
| `embed-text` | `embedText` | Texts → TFV1 vectors, bge-small-zh-v1.5 (default) or bge-base-zh-v1.5 | transformers.js 4.3.2, onnxruntime-web 1.31.1 |
| `kb-write` | `kbWrite` | Validates chunks + vectors and summarizes them; the host stores them | own code |
| `transcribe` | `transcribe` | Audio → Chinese-first `text` with punctuation (SenseVoiceSmall) | onnxruntime-web 1.31.1, see [T2 audio nodes](#t2-audio-nodes) |
| `vad-segment` | `vadSegment` | Audio → speech segments as WAV `segments` (Silero VAD) | same |
| `diarize-speakers` | `diarizeSpeakers` | Audio → `segments` JSON `[{speaker,start,end}]` (pyannote + CAM++) | same |
| `audio-tag` | `audioTag` | Audio → `tags` JSON `[{label,score}]` (CED-tiny, AudioSet) | same |
| `ocr-image` | `ocrImage` | Image → reading-ordered `text` (PP-OCRv6 small; `tiny`, or `glm-ocr` on WebGPU) | onnxruntime-web 1.31.1, see [T1 vision/document nodes](#t1-visiondocument-nodes) |
| `image-orient` | `imageOrient` | Image → upright page PNG (PP-LCNet doc_ori) | same |
| `layout-detect` | `layoutDetect` | Page image → `layout` JSON + cropped `regions` in reading order (PP-DocLayout-S / -M) | same |
| `table-recognize` | `tableRecognize` | Table image → `html` (SLANet_plus + PP-OCRv6) | same |
| `split-video` | `splitVideo` | Video → one `video_parts` file per shot (TransNetV2; remuxed where the cut is a key frame) | same + Mediabunny 1.66.2 |
| `detect-objects` | `detectObjects` | Image → `objects` JSON (D-FINE nano, COCO) | transformers.js 4.3.2 |

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

### Knowledge base: `chunk-text`, `embed-text`, `kb-write`

The three nodes of an ingest pipeline: `text → chunk-text → embed-text → kb-write`, with
`kb-write` also reading `chunk-text`'s chunks. **The plugin owns no storage**: the knowledge base
lives in the host (scanall, `@scanall/kb`), which commits what `kb-write` validated.

| Slot | Method | Models (default first) | What it does |
|---|---|---|---|
| `chunk-text` | `chunkText` | — | Collected `texts` → `chunks`. The parts are joined with a blank line, then cut into blocks (paragraphs, Markdown tables, fenced code, headings) and packed into chunks of at most `max_chars` (default 500, clamped to 50..8000; UTF-16 units, one per CJK character). A block too long for a chunk is split at sentence ends (`。！？；…` with closing quotes, `! ? ;`, `. ` and line breaks), then hard-cut (preferring `，、：, :` and spaces). Consecutive prose chunks share ≈80 characters (`min(80, max_chars/5)`) of whole sentences; no overlap into or out of a table, code or a new heading. A table that fits is never split (it moves to the next chunk); a longer one is split between rows and every piece repeats the header. A heading never ends a chunk. Empty chunks are dropped; no text at all fails. |
| `embed-text` | `embedText` | `bge-small-zh-v1.5`, `bge-base-zh-v1.5` | `texts` → `vectors`: one TFV1 file (`vectors.tfv1`), one row per text in input order. q8 ONNX through transformers.js, **CLS pooling + L2 normalization** (what BGE prescribes), no instruction prefix for documents. Batches of 16 (small) / 8 (base), sorted by length to cut padding; progress `embedded i/N` after each batch; cancellation between batches. Model files and the ort wasm are reported through `modelDownload`. |
| `kb-write` | `kbWrite` | — | Validates `chunks` + `vectors` (TFV1) + `source`: at least one chunk, no empty chunk, a well-formed TFV1, as many vectors as chunks, finite values. Returns `text` = `{"source","chunkCount","dims","vectorsSha256"}` (JSON). Stores nothing. |

`embed-text`'s model is the node's `model` (manifest `models`, chosen on the canvas or swapped with
`replaceImplementation`); absent means `bge-small-zh-v1.5`. The `<org>/<repo>` is accepted too.

**TFV1** is a verbatim copy of `@scanall/kb/vectors` (`src/kb/tfv1.ts`): `"TFV1"`, u32 dims, u32
count, then `count × dims` float32, all little-endian. A Node test compares the file and its
output byte for byte with the scanall package when that checkout is present (`SCANALL_KB_DIR`).

#### Host side of `kb-write` (what scanall implements)

Contract (a): no worker-protocol change. The host wraps its executor with `tapKbWrite` from
`tongflow-edge-essentials/kb-host` (`dist/kb-host.js`, 0.6 kB, no ML code). The tap keeps a copy of
the materialized input of every **successful** `kb-write` call (exactly the chunks, TFV1 bytes and
source that `kb-write` validated) and the model of the run's `embed-text` calls.

```ts
import { createCompositeExecutor, runWorkflow, OpfsAssetStore } from "tongflow/engine";
import { createWorkerEdgeExecutor } from "tongflow/engine/browser";
import { tapKbWrite } from "tongflow-edge-essentials/kb-host";
import { openKb } from "@scanall/kb";

const edge = createWorkerEdgeExecutor({ registry, resolveModuleUrl /* see "Model hosting" */ });
const tap = tapKbWrite(createCompositeExecutor({ registry, edge }));      // 1. wrap
const result = await runWorkflow(ingestWorkflow, { executor: tap.executor, store, signal });
let payload = null;
try { payload = tap.take(); } catch (e) { /* 2+ kb-write successes or mixed models: treat as failed */ }
if (result.status === "success" && payload) {                            // 2. whole run succeeded
    const tx = kb.beginIngest({ fileName: payload.source, mime: file.type, size: file.size,
                                embedModel: payload.embedModel });       // e.g. "bge-small-zh-v1.5"
    tx.add(payload.chunks, payload.vectors);                             // TFV1 bytes as-is
    await tx.commit();                                                   // 3. atomic replace
    await kb.storeOriginal(file);
}                                                                        // otherwise: old KB untouched
tap.reset();                                                             // before reusing the tap
```

1. Use `tap.executor` for the run. One tap per run (or `reset()` between runs).
2. Commit **only** when `result.status === "success"` (not `partial`, `failed` or `cancelled`) and
   `take()` returned a payload. `take()` is `null` when no `kb-write` succeeded and throws when
   several did or the run used several embedding models; in all those cases keep the old KB.
3. `beginIngest` → `add(payload.chunks, payload.vectors)` → `commit()`. `@scanall/kb` checks counts
   and dims again; a rejected commit leaves the old KB in place. Use `payload.source` as the file
   name and `payload.embedModel` as `embedModel` (absent when the vectors did not come from an
   `embed-text` node of this run). `payload.summary` is `kb-write`'s JSON; `payload.dims` its dims.
4. Show `kb-write`'s `text` (or the commit's `KbInfo`) as the node result; errors of `kb-write`
   (e.g. "3 chunks but 2 vectors") already fail the node with a readable message.

A host that cannot wrap the executor can read the same data from the run instead: the `kb-write`
node's `chunks` binding points at `chunk-text`'s `chunks` output (`result.outputs[id].chunks`), its
`vectors` binding at `embed-text`'s `vectors` (`{file_key}` → `store.get(file_key)`), and
`source` is a `config` binding. Check the bytes against `vectorsSha256` before committing.

#### Query embedding for the host: `embedQuery`

`tongflow-edge-essentials/embed-query` (`dist/embed-query.js`, 0.65 kB; the ML code loads on first
use from the same `dist/chunks/`) embeds a search query with **the same model, file, pooling and
normalization** as `embed-text`, and prefixes the BGE query instruction
`为这个句子生成表示以用于检索相关文章：` (documents never get it; `instruction: ""` turns it off).

```ts
import { createQueryEmbedder } from "tongflow-edge-essentials/embed-query";
const q = createQueryEmbedder({ model: kb.current()?.embedModel });     // default bge-small-zh-v1.5
await q.warmup();                                                        // optional
const hits = await kb.search(text, await q.embed(text), { k: 20 });
```

Options: `model`, `modelBase` (default as below), `pluginBase` (where `dist/` is served; default
next to the module), `instruction`, `onDownload`. `embedQuery(text, options)` is the one-shot form.
It is a separate entry rather than a worker method because the host calls it outside a workflow
run, in its own code. **Run it in the host's own Web Worker** (an inference blocks its thread for
≈40 ms); on the main thread it also works. Served from the same origin, it shares the Cache API
entries with the plugin's worker, so the model is downloaded once. Its vectors match the worker's
to cosine ≈ 0.996 (q8 is dynamically quantized per call, so a vector varies slightly with its batch).

#### Model hosting (model base)

Model files are fetched only from the **model base**, laid out `<modelBase><org>/<repo>/<path>`
exactly like the ModelScope / Hugging Face repos (so they can be mirrored 1:1; `models.json` lists
the files). Resolution order: `ctx.modelBase` (if the engine ever passes one) →
`globalThis.__TONGFLOW_EDGE_CONFIG__.modelBase` → same-origin `/models/`. The worker executor
creates the worker itself, so a host sets the base **as a query parameter of the entry URL**:

```ts
createWorkerEdgeExecutor({
    registry,
    resolveModuleUrl: (_id, p) => `/plugins/${p.localSubdir}/${p.entryFile}?modelBase=${encodeURIComponent("https://oss.example.cn/models/")}`,
});
```

The entry copies it into `globalThis.__TONGFLOW_EDGE_CONFIG__` inside the worker (a value already
set there wins). In-process use sets `globalThis.__TONGFLOW_EDGE_CONFIG__ = { modelBase }` before the
first call; `embedQuery` takes `modelBase` as an option. Cross-origin bases need CORS
(`Access-Control-Allow-Origin`), and should answer `Range` requests: transformers.js probes file
sizes with `Range: bytes=0-0` and would otherwise download each file twice.

- transformers.js runs with `allowLocalModels = false`, `remoteHost = modelBase`,
  `remotePathTemplate = "{model}/"`; it caches model files in the Cache API (`transformers-cache`).
- onnxruntime-web's wasm (`ort-wasm-simd-threaded.asyncify.wasm`, 28.7 MB, 7.1 MB gzip) is served
  from `dist/assets/ort/`, fetched once with progress and cached in the Cache API
  (`tongflow-edge-assets`). Nothing is fetched from jsDelivr or huggingface.co. It is one
  onnxruntime-web instance and one wasm for every node (transformers.js and the nodes that run
  onnxruntime-web directly); a browser test asserts the wasm is requested once and no other ort build.
- Models with external weights (`.onnx` + `.onnx_data`, all T3 models): the plugin declares each
  graph's data file itself (`use_external_data_format`, from the model catalog) instead of trusting
  the repo's `config.json`. GLM-OCR's names only the fp32 graphs, so transformers.js 4.3.2 created
  the q4/q4f16 sessions without their weights and onnxruntime-web failed with
  `Module.MountedFiles is not available`.
- The build patches transformers.js' session-creation and run queues so one failed model load no
  longer makes every later model in the worker fail with the same error (`tsdown.config.ts`,
  `unpoisonedOrtChains`; the build fails if the pattern is not found after an upgrade).
- **Serve the page cross-origin isolated** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) if you can: onnxruntime-web then uses threads,
  ≈2.6× faster (see below). Without isolation it runs single-threaded.

#### Runtime and measured speed

transformers.js **4.3.2** on onnxruntime-web **1.31.1** (pinned for every ML node; transformers.js
4.3.2 itself asks for `1.31.0-dev.20260914`, an npm `overrides` entry forces 1.31.1), WASM EP.
Measured in headless Chromium (Playwright, Apple Silicon), model served locally from
`EDGE_MODELS_DIR`, `npm run test:browser`:

| bge-small-zh-v1.5 q8 | single-threaded | cross-origin isolated (threads) |
|---|---|---|
| Cold: ort wasm + model (24 MB) load, init, 3 short texts | 1.2 s | 1.5 s |
| 64 short texts (≈30 chars) | 2.7 s | 1.3 s |
| 16 chunks of ≈480 chars (default chunk size) | 11–18 s (≈0.7–1.2 s/chunk; two runs, the slower one on a loaded machine) | 4.2 s (≈260 ms/chunk) |
| `embedQuery` warm-up / one query | 0.75 s / 42 ms | 0.32 s / 43 ms |
| Whole ingest run (chunk → embed → kb-write), 3 chunks, warm cache | 0.78 s | 0.60 s |

A long document is dominated by embedding (≈4–20 minutes per 1000 default-size chunks); a smaller
`max_chars` is faster per character (attention grows with length). bge-base-zh-v1.5 is ≈4× the
compute of bge-small.

### Model manifest

`models.json` (repo root, also exported as `tongflow-edge-essentials/models.json`) lists every model
the plugin can download: `[{id, source: "modelscope:<org>/<repo>", files, approxMB, license,
attribution?}]`. The weights-hosting job mirrors exactly those files under the model base. The audio
entries also carry `checksums` (`{path: {size, sha256}}`, checked by the plugin before caching),
`licenseUrl`, `slots` and `upstream` (the GitHub release asset each mirror was verified against).
The T1 vision entries use the same format (`upstream` describes how each community conversion was
checked); their table is in [T1 vision/document nodes](#t1-visiondocument-nodes).

| id | Source | Files | Size | License |
|---|---|---|---|---|
| `bge-small-zh-v1.5` (default of `embed-text`) | `modelscope:Xenova/bge-small-zh-v1.5` | `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx` | 24 MB | MIT (BAAI; ONNX by Xenova) |
| `bge-base-zh-v1.5` | `modelscope:Xenova/bge-base-zh-v1.5` | same | 103 MB (98.1 MiB, within the 100 MiB per-file cap) | MIT (BAAI; ONNX by Xenova) |

Attribution: bge-*-zh-v1.5 by BAAI ([FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)),
MIT License. The Xenova conversions carry no license field and follow upstream; ship BAAI's MIT
notice with the weights.

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

### T1 vision/document nodes

Small models (2–31 MB each) on the shared onnxruntime-web **1.31.1** runtime (the same module and
wasm as transformers.js and the audio nodes). **WASM by default; `_params.device: "webgpu"` uses
WebGPU** when the worker has an adapter (a graph WebGPU cannot build falls back to WASM). WebGPU
is opt-in because in headless Chromium (Metal through ANGLE) the first WebGPU session created in
the module worker never settled, while it worked on the main thread and after a WASM session; at
these model sizes WASM is fast (timings below). All pre/post-processing is TypeScript on OffscreenCanvas /
ImageBitmap in the module worker: no OpenCV.js, no DOM. PaddleOCR.js was not used: it needs
OpenCV.js and a DOM canvas.

| Slot | Method | Models (`models`, default first) | Output |
|---|---|---|---|
| `ocr-image` | `ocrImage` | `pp-ocrv6-small`, `pp-ocrv6-tiny`, `glm-ocr` (T3, WebGPU) | `text`: lines in reading order (top→bottom, pieces of a line left→right; no space between CJK pieces) |
| `image-orient` | `imageOrient` | `pp-lcnet-doc-ori` | `image`: the page turned upright (0/90/180/270°), PNG. An upright PNG passes through unchanged. |
| `layout-detect` | `layoutDetect` | `pp-doclayout-s`, `pp-doclayout-m` | `layout`: JSON `[{label, score, box: [x1, y1, x2, y2]}]` in reading order; `regions`: one cropped PNG per entry, same order (`x-expand-each`) |
| `table-recognize` | `tableRecognize` | `slanet-plus` | `html`: `<table>…</table>`, structure from SLANet_plus, cell text from PP-OCRv6 small |
| `split-video` | `splitVideo` | `transnetv2` | `video_parts`: one video per shot, same container |
| `detect-objects` | `detectObjects` | `dfine-nano-fp16` (default), `dfine-nano` (int8) | `objects`: JSON `[{label, score, box: [x1, y1, x2, y2]}]` (COCO labels, pixels, best first) |

**`ocr-image`.** PP-OCRv6 det (DB) → crop → rec (CTC), as PaddleOCR/PaddleX do it: det input
scaled so the short side is ≥ 64 and the long side ≤ 2048 (`_params.det_max_side`), multiples of 32;
DB thresholds from the model's `inference.yml` (0.2 / 0.45 / unclip 1.4); 8-connected regions →
minimum-area rectangles (rotating calipers) → affine crop; boxes taller than 1.5× their width are
turned to horizontal; rec at height 48, batched by aspect ratio; the character dictionary is read
from the rec repo's `inference.yml`, so it always matches the weights. Lines below 0.5 confidence
are dropped (`_params.drop_score`). `_params.textline_orientation: true` adds the 1 MB
PP-LCNet text-line orientation classifier for upside-down lines; it is off by default because it
flipped short table cells ("+3%" → "%ε+") in tests, and page rotation is `image-orient`'s job.
`glm-ocr` routes to T3's GLM-OCR through `withModelAlternative`.

**`layout-detect`.** PP-DocLayout-S (480², default) or -M (640²), the Paddle graph with fused NMS
(`image` + `scale_factor` in, boxes in source pixels out), threshold 0.5 (`_params.threshold`),
cross-class duplicates dropped. Reading order: running headers first; wide boxes (titles,
abstracts) split the page into bands; inside a band columns are read left→right, each column
top→bottom; page numbers and footers last. Only a community ONNX conversion exists
(`Liyulingyue/PP-DocLayout-{S,M}-ONNX`); it was verified here on a rendered two-column A4 report
(title, abstract, headings, text, table 0.92, chart, figure caption, page number all found, boxes
on the content) and its sha256 is pinned in `models.json`.

**`table-recognize`.** SLANet_plus on the image scaled to a 488 px long side and padded to 488²;
structure tokens decoded with PaddleOCR's `merge_no_span_structure` dictionary; cell polygons are
normalized to the padded square. OCR boxes are assigned to cells by PaddleOCR's `TableMatch`
rule (best IoU, then corner distance). Feed it a table crop, e.g. a `layout-detect` region labelled
`table`.

**`split-video`.** Mediabunny decodes the primary video track and samples 48×27 frames at
**10 fps** (`_params.fps`; at 4 fps TransNetV2 missed one cut and invented others on fast-moving
test content), TransNetV2 runs over 100-frame windows (25-frame context, the reference padding),
the single-frame head is thresholded at `threshold` (ABI input, default 0.5). Each cut is then
refined to the exact frame by decoding the frames between the two samples, and snapped to a key
frame within one frame. Parts are cut with a Mediabunny `Conversion`: **copied without
re-encoding** when the cut is on a key frame (encoders usually place one at a scene change), else
re-encoded with WebCodecs from the cut; if the browser cannot encode the codec, the part is
copied from the preceding key frame instead. If TransNetV2 is not mirrored or fails to load, a
colour-histogram frame-difference detector runs instead (the progress message says so). One shot
returns the input unchanged as the single part.

**`detect-objects`.** D-FINE nano through transformers.js's `object-detection` pipeline (the shared
`ml/transformers.ts` runtime). Its sigmoid scores are modest (the cat test photo scores 0.6–0.7),
so the default threshold is 0.35 (`_params.threshold`); near-identical boxes of one label
(IoU ≥ 0.7) are merged. The default is `dfine-nano-fp16`: on WASM it is both faster and more accurate
than the int8 export, which missed obvious objects in the tests below. `dfine-nano` (int8, 3.4 MB
smaller) stays available as the alternative.

**Measured** (headless Chromium, Apple Silicon, WASM single-threaded, models served from
`EDGE_MODELS_DIR`; "cold" = first call in a fresh worker, including fetch + session creation):

| Call | Time |
|---|---|
| `ocr-image` small, 900×360 synthetic scan (4 lines), cold: ort wasm + 31 MB of models + sessions + run | 1.7 s |
| `ocr-image` small, same image, warm | 0.9 s |
| `ocr-image` tiny, same image, cold / warm | 0.3 s / 0.22 s |
| `ocr-image` small, A4 page rendered at 150 DPI (1240×1754, 13 lines), warm | 3.6 s |
| `image-orient`, A4 page, cold / warm | 70 ms / 40 ms |
| `layout-detect` S / M, A4 page, cold | 0.19 s / 0.84 s |
| `table-recognize`, 600×240 ruled table, cold (SLANet + OCR) | 0.9 s |
| `table-recognize` on the layout's 4×5 table crop | 1.8 s |
| `split-video`, 6 s 240×136 MP4, 3 shots, cold (TransNetV2 31 MB + decode + 3 remuxes) | 5.6 s |
| `split-video`, same as one-key-frame VP9 WebM (3 re-encoded parts) | 5.5 s |
| `detect-objects` int8, 451×300 photo, cold / 512×512 warm | 1.2 s / 0.65 s |
| `detect-objects` fp16, 451×300 photo, cold / 512×512 warm | 0.8 s / 0.28 s |

Recognition quality in these runs: the synthetic scan and the PDF page were read without errors by
`small` (`tiny` dropped one space); `table-recognize` reproduced every cell of both tables except
one OCR slip ("5%" read as "5%%"); D-FINE int8 found the cat (0.69) but not the astronaut that
fp16 finds (person 0.44), which is why `dfine-nano-fp16` is the default.

**Models** (all from ModelScope; mirror the repos 1:1 under the model base):

| Id (`models.json`) | Repo | Size | License |
|---|---|---|---|
| `pp-ocrv6-small-det` / `-rec` | `PaddlePaddle/PP-OCRv6_small_det_onnx`, `PaddlePaddle/PP-OCRv6_small_rec_onnx` | 9.9 + 21.3 MB | Apache-2.0 |
| `pp-ocrv6-tiny-det` / `-rec` | `PaddlePaddle/PP-OCRv6_tiny_det_onnx`, `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` | 1.8 + 4.6 MB | Apache-2.0 |
| `pp-lcnet-textline-ori` (optional) | `PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx` | 1.0 MB | Apache-2.0 |
| `pp-lcnet-doc-ori` | `PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx` | 6.8 MB | Apache-2.0 |
| `pp-doclayout-s` / `-m` | `Liyulingyue/PP-DocLayout-S-ONNX`, `Liyulingyue/PP-DocLayout-M-ONNX` (community conversions, sha256-pinned) | 4.9 / 23.5 MB | Apache-2.0 |
| `slanet-plus` | `PaddlePaddle/SLANet_plus_onnx` | 7.8 MB | Apache-2.0 |
| `transnetv2` | `q502892879/transnetv2-onnx` (community export) | 31.3 MB | MIT |
| `dfine-nano-fp16` (default) / `dfine-nano` | `onnx-community/dfine_n_coco-ONNX` (`onnx/model_fp16.onnx` / `onnx/model_int8.onnx` + configs) | 7.9 / 4.5 MB | Apache-2.0 |

Every T1 entry in `models.json` carries a `sha256` per file. Raw-ORT files are checked against it
on a fresh download and kept in the Cache API bucket `tongflow-edge-models`; transformers.js keeps
D-FINE in `transformers-cache`. A model base that answers a missing file with an HTML page (an SPA
fallback) is reported as "not mirrored", not parsed. Attribution: PP-OCRv6, PP-LCNet,
PP-DocLayout and SLANet_plus by PaddlePaddle ([PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE),
Apache-2.0), PP-DocLayout ONNX conversion by Liyulingyue; TransNetV2 © 2020 Tomáš Souček
([MIT](https://github.com/soCzech/TransNetV2/blob/master/LICENSE)), ONNX export by q502892879;
D-FINE by Peterande et al. ([Apache-2.0](https://github.com/Peterande/D-FINE/blob/master/LICENSE)),
ONNX by onnx-community.

### T3 WebGPU nodes

Optional nodes with real models, **only on WebGPU**. Each method first checks
`self.navigator.gpu` and a GPU adapter, and fails with a clear error (`this node needs WebGPU …`)
when either is missing; nothing is downloaded then. Hosts should keep them off by default, ask the
user before the first run (the size is in `models.json` / the exported `T3_MODELS`), and show the
storage quota.

| Slot | Method | Model (`models`) | What it does |
|---|---|---|---|
| `image-gen-text` | `imageGenText` | `qwen3.5-0.8b` | What the canvas `imageGenTextNode` runs. `text` (prompt, may be blank) + optional `image`; honours `system`, `max_new_tokens` (512), `enable_thinking` (off), `temperature` (0.7, 0 = greedy), `top_p` (0.8), `top_k` (20). Without a prompt it describes the image **in Simplified Chinese**; the default system prompt keeps answers in Chinese. Without an image it is a plain text chat. |
| `image-describe` | `imageGenText` (same method) | `qwen3.5-0.8b` | `image` + optional `text` / `userPrompt`; same behaviour. |
| `ocr-image` (alternative) | `ocrImageGlm` | `glm-ocr` | GLM-OCR page reading, Markdown out (tables included). Not the slot default: see [Alternative implementations](#alternative-implementations). |
| `embed-image` | `embedImage` | `embeddinggemma-2` | One L2-normalized 768-d vector per image, as a `vectors` file in the TFV1 format (below). Same space as EmbeddingGemma 2 text embeddings (query prefix `task: search result \| query: `). The audio encoder is never loaded. |
| `gen-text` | `genText` | `lfm2.5-350m` | Structured key-point extraction from `text`; `userPrompt` narrows it. The decoder is constrained to the JSON schema `{"key_points": string[]}` (transformers.js structured output) and `text` is that JSON. The instruction follows the document's language (a Chinese document gets a Chinese prompt and Chinese key points). |

Advanced params (`_params`): `max_new_tokens` everywhere; `max_pixels` for the vision models
(Qwen3.5 default 448², GLM-OCR 1024²: the image is resized to that pixel budget, keeping the
aspect ratio, because every 32 × 32 (Qwen) / 28 × 28 (GLM) square is one prompt token and prefill
dominates the latency); `dims` for `embed-image` (768, or the Matryoshka sizes 512 / 256 / 128);
`max_input_tokens` for `gen-text` (default 4096; longer text is cut).

**Behaviour.**
- *Streaming.* Generated tokens are streamed into `progress` (`extracting: 37 tokens · …tail`),
  after a `reading the input (N tokens)` message for the prefill.
- *Cancellation.* `cancel` aborts at the next generated token and the call rejects with the abort.
  A model download nobody waits for any more is cancelled too (several nodes waiting for the same
  model share one download).
- *Downloads and cache.* Weights are reported through `modelDownload` (`loaded` / `total` summed
  over the model's files, `file` = `"<model> · <file>"`) and stored by transformers.js in the
  Cache API bucket `transformers-cache`, so a model downloads once per browser profile. Before
  downloading, the plugin checks `navigator.storage.estimate()` and fails clearly if the quota
  cannot hold the model. `navigator.storage.persist()` is window-only: **the host page should
  call it** before the first T3 run so the browser does not evict the models.
- *GPU memory.* At most two models stay loaded; the least recently used idle one is disposed.
- *Precision.* With `shader-f16` the q4f16 weights load (fp16 vision tower for Qwen3.5); without it
  the q4 ones.

**Models** (first download, with `shader-f16` / without):

| Id | Repo (`<modelBase>/<org>/<repo>/`) | Download | License |
|---|---|---|---|
| `qwen3.5-0.8b` | `onnx-community/Qwen3.5-0.8B-ONNX` | 810 / 740 MB | Apache-2.0 |
| `glm-ocr` | `onnx-community/GLM-OCR-ONNX` | 660 / 745 MB | MIT |
| `embeddinggemma-2` | `onnx-community/embeddinggemma-2-ONNX` (text + vision only) | 290 / 316 MB | Apache-2.0; deployments must follow the [Gemma Prohibited Use Policy](https://gemma.ai/resources/prohibited-use/) |
| `lfm2.5-350m` | `LiquidAI/LFM2.5-350M-ONNX` | 259 / 297 MB | **LFM Open License v1.0** (below) |

**Runtime.** The shared transformers.js 4.3.2 / onnxruntime-web 1.31.1 runtime of `embed-text`
(`src/ml/transformers.ts`, same model base, same `dist/assets/ort/` wasm, same Cache API), with the
WebGPU device, plus `@huggingface/transformers-structured-output` 4.3.2 for constrained JSON.
Weights come from the [model base](#model-hosting-model-base) exactly like the embedding models,
and every file is listed in [`models.json`](#model-manifest) (`approxMB` = first download with
`shader-f16`; `files` cover both precision sets; a test keeps it in sync with
`src/ml/catalog.ts`). Several T3 weight files are larger than 100 MB (the Qwen3.5 decoder data is
437 MB), so a model host with a per-file cap must raise it for these repos. Put each model's
license next to its weights.

Measured on Apple Silicon (headless Chromium 159, `--enable-unsafe-webgpu --use-angle=metal`,
Metal adapter with `shader-f16`, model served locally), LFM2.5-350M q4f16, `gen-text` on a
≈200-character Chinese contract clause: first run 6–11 s (3.5–8 s of it loading 255 MB into the
Cache API and creating the session), ≈100 tokens of JSON at ≈45 tokens/s; the model resident:
2.3 s, first token after 0.24 s; a fresh worker with the model in the Cache API: 2.5 s; cancel
lands within one token. Same setup, the other T3 models (first run = download from the local model
base + session creation + inference): `image-gen-text` Qwen3.5-0.8B describing a 900×172 image,
128 new tokens, 19.6 s; `ocr-image` GLM-OCR q4f16 reading a two-line invoice image exactly, 4.1 s;
`embed-image` EmbeddingGemma 2 q4f16, 2.8 s.

#### Alternative implementations

The scanner accepts exactly one manifest entry per `nodeSlot` (a second entry for the same slot is
rejected: `nodeSlot … is declared more than once`), so an alternative implementation is an extra
**model** in the slot's entry, and the method picks by `ctx.model`. `ocr-image` is
`{"nodeSlot": "ocr-image", "method": "ocrImage", "models": ["pp-ocrv6-small", "pp-ocrv6-tiny", "glm-ocr"]}`:
the default method is PP-OCRv6, and `withModelAlternative(ocrImage, "glm-ocr", ocrImageGlm)` routes
`glm-ocr` here. `ocrImageGlm` stays exported as its own method and accepts only `glm-ocr` (or no model).

#### TFV1 vector files

`embed-image` (like `embed-text`) returns `vectors` as a file, `<image stem>.tfv1`,
`application/octet-stream`, little-endian: magic `"TFV1"`, `u32 dims`, `u32 count`, then
`count × dims` float32 row-major. It is the format scanall's `@scanall/kb` reads.

#### LFM2.5-350M license: revenue threshold

LFM2.5-350M is under the **LFM Open License v1.0**, whose full text ships in
[`licenses/LFM-Open-License-v1.0.txt`](licenses/LFM-Open-License-v1.0.txt) and must be given to
anyone the weights are redistributed to (a web demo that serves them to browsers redistributes
them). **Commercial use is licensed only while the user's Legal Entity — together with every
entity it controls, is controlled by or is under common control with — has annual revenue below
USD 10 million** (the license's "Threshold", §1 and §5). Use "for direct or indirect commercial
advantage" counts as commercial, so a free demo that promotes a company does too. Before enabling
`gen-text` in a deployment, confirm who operates it and that its group is under the threshold;
if it is not, leave the slot off or pick another model. Mark any modified weight files as modified
(§4(b)). The license grants no trademark rights.

### T2 audio nodes

Speech and sound, on the CPU (onnxruntime-web wasm EP, no WebGPU needed). Every slot first decodes
its input **inside the worker** to 16 kHz mono Float32: Mediabunny demuxes any container (m4a/mp4,
mp3, wav, webm, ogg, flac, video files too) and decodes with WebCodecs `AudioDecoder` (PCM without
it); channels are averaged and a port of Kaldi's windowed-sinc `LinearResample` converts the rate
(there is no AudioContext in a worker). Inputs over 100 MB are refused.

| Slot | Method | `models` | What it does |
|---|---|---|---|
| `transcribe` | `transcribe` | `sensevoice-small` | SenseVoiceSmall (int8): Chinese first (also en/ja/ko/yue), **with punctuation and ITN**. `language` is a hint (`zh`, `zh-CN`, `en`, `yue`/Cantonese/粤语, `ja`, `ko`; anything else = auto). Up to 30 s in one pass; longer audio is cut at pauses with Silero VAD into ≤ 25 s chunks, recognized one by one (progress `transcribing i/N`) and joined (no separator between CJK pieces). The ABI output has only `text`, so the detected language is not returned. `context` and `max_new_tokens` are ignored (CTC model). |
| `vad-segment` | `vadSegment` | `silero-vad-v5` | `segments`: one 16 kHz mono 16-bit WAV per speech span (`x-expand-each`), named `<stem>-001-1.09s-5.68s.wav`. Silero's own `get_speech_timestamps` logic; defaults threshold 0.5, min speech 250 ms, min silence 500 ms, pad 200 ms, max 30 s (split at the last ≥ 98 ms pause). `_params` may override `threshold`, `min_speech_ms`, `min_silence_ms`, `speech_pad_ms`, `max_speech_s`. |
| `diarize-speakers` | `diarizeSpeakers` | `pyannote-campplus-zh` | `segments` (JSON string): `[{"speaker":0,"start":0.976,"end":5.718}, …]`, seconds, sorted by start, speakers numbered by first appearance. pyannote segmentation-3.0 over 10 s windows (1 s step) → per-window local speakers → 3D-Speaker CAM++ (zh-cn) embedding of each → complete-linkage clustering on cosine distance (threshold 0.5) → pyannote reconstruction; segments < 0.3 s dropped, same-speaker gaps ≤ 0.5 s merged. A port of sherpa-onnx's `OfflineSpeakerDiarizationPyannoteImpl`. `_params`: `num_speakers` (exact count), `threshold`. |
| `audio-tag` | `audioTag` | `ced-tiny` | `tags` (JSON string): `[{"label":"Speech","score":0.7072}, …]`, AudioSet's 527 classes, the top 10 with score ≥ 0.1 (at least one). Long audio is tagged in 10 s windows (CED's training length) and each class keeps its maximum. `_params`: `top_k`, `min_score`. |

**Runtime choice: onnxruntime-web, not sherpa-onnx WASM.** The plan was sherpa-onnx's WASM build
with runtime-fetched models. It is not practical: the browser builds published with sherpa-onnx
2.0.2 bake their models in with `--preload-file` and cover only VAD/TTS/enhancement; the npm
`sherpa-onnx` wasm is built with `NODERAWFS` (it throws outside Node) and has no audio tagging; and
a custom emscripten build would add a 15.6 MB second wasm with its own onnxruntime that cannot be
shared. So the **same sherpa-onnx ONNX exports** run on the plugin's single onnxruntime-web
(1.31.1, the instance and asyncify wasm transformers.js uses; `src/ml/ort.ts`), and the front ends
are TypeScript ports of sherpa-onnx / kaldi-native-fbank (Apache-2.0): Kaldi fbank (povey/hamming/
hann windows, snip-edges, pre-emphasis, mel banks), SenseVoice LFR (7/6) + CMVN from the model
metadata + CTC greedy search, CED's fbank + AmplitudeToDB, CAM++ global-mean normalization, the
pyannote powerset/aggregation/clustering logic. ONNX custom metadata is read straight from the
protobuf (`src/ml/onnx-meta.ts`). The ports are checked against kaldi-native-fbank (golden
features in `test/fixtures/audio/fbank-golden.json`) and against sherpa-onnx 2.0.2 itself (Python)
on the same files: identical SenseVoice text, VAD spans within 0.05 s, the same diarization turns
(starts within 0.02 s), CED scores within 0.015.

**Model files and cache.** Fetched from the model base (`<modelBase><org>/<repo>/<path>`), verified
(size + SHA-256 from `src/models/registry.ts`, the same values as `models.json`), then kept in the
Cache API (`tongflow-edge-models-v1`); each download is reported through `modelDownload` with
`file` = `<org>/<repo>/<path>` and `model` = the model id. Models stay loaded in the worker. Long
audio is processed in chunks with progress, and cancellation is checked between chunks (the loops
yield to the event loop so the engine's `cancel` message gets in). In addition to `?modelBase=` on
the entry URL, a host may post `{type: "config", modelBase}` to the worker before its first invoke.

**Measured (MacBook, Chromium headless, single thread, no cross-origin isolation; 21 s two-voice
Chinese dialog):** transcribe 8.5 s warm (RTF 0.40; first call 13.5 s including loading the 239 MB
model from a local server), 63 s via VAD chunks 26 s; vad-segment 0.36 s; diarize-speakers 8.5 s;
audio-tag 0.2 s for 1.5 s. Phones are slower (research/09 cites RTF ≈ 0.7 for SenseVoice in
Android Chrome); cross-origin isolation lets onnxruntime-web use up to 4 threads.

| id | Source (ModelScope) | Files | Size | License |
|---|---|---|---|---|
| `sensevoice-small-int8` | `pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue` | `model.int8.onnx`, `tokens.txt` | 240 MB (one 228 MiB file) | [FunASR Model License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) (copy in `licenses/`) |
| `silero-vad-v5` | `pengzhendong/silero-vad` | `v5/silero_vad.onnx` | 2.3 MB | MIT |
| `pyannote-segmentation-3.0` | `pengzhendong/sherpa-onnx-pyannote-segmentation-3-0` | `model.onnx` | 6 MB | MIT |
| `3dspeaker-campplus-zh-cn-16k` | `lihuoo/3dspeaker-recognition-models` | `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` | 28 MB | Apache-2.0 |
| `ced-tiny-int8` | `k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19` | `model.int8.onnx`, `class_labels_indices.csv` | 6.2 MB | CC-BY-4.0 |

sherpa-onnx publishes these exports only on GitHub Releases; the ModelScope repos above are
mirrors, checked file by file against the GitHub assets on 2026-11-21 (details in `models.json`
`upstream`). SenseVoice, pyannote, Silero (vs. snakers4's v5.1.2) and CED are byte-identical. The
CAM++ file is the earlier export: the current GitHub asset was re-exported (PyTorch 2.14.1, one
AveragePool attribute changed with zero padding) and gives bit-identical embeddings; no
byte-identical mirror of it exists on ModelScope. `transcribe` downloads the VAD only for audio
longer than 30 s. **The SenseVoice file is 228 MiB, over the 100 MiB cap that applies to
assets in this repo; it is a model-base file, so the weight host must serve files that large.**

**Attribution (about / third-party licenses page):**
- **SenseVoiceSmall by FunASR/FunAudioLLM** — [model card](https://www.modelscope.cn/models/iic/SenseVoiceSmall),
  [FunASR Model License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE). The model
  name must be kept, and comparisons with other models must stay factual (§4.2). Commercial use is
  still pending in [SenseVoice#334](https://github.com/QwenAudio/SenseVoice/issues/334): re-check
  before launch (fallback: X-ASR, Apache-2.0).
- **CED-tiny** by Heinrich Dinkel, Yongqing Wang, Zhiyong Yan, Junbo Zhang and Yujun Wang (Xiaomi),
  [RicherMans/CED](https://github.com/RicherMans/CED); weights [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  ([Zenodo 8275347](https://zenodo.org/record/8275347)); converted to ONNX and int8-quantized by
  k2-fsa/sherpa-onnx. Only the weights are used: the CED training code is GPL-3.0 and is not bundled.
- pyannote/segmentation-3.0 by Hervé Bredin and pyannote.audio contributors (MIT); 3D-Speaker CAM++
  (iic/speech_campplus_sv_zh-cn_16k-common, Alibaba Tongyi Lab, Apache-2.0); Silero VAD by Silero Team
  (MIT); ONNX exports by k2-fsa/sherpa-onnx (Apache-2.0).

### Bundle

Every library is a lazy dynamic import, so the entry is 12 kB and each format loads only what it
needs. Gzip transfer on first use, chunks included:

| First use of | Loads (gzip) |
|---|---|
| any slot | `index.js` 5.3 kB |
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
| chunk-text / kb-write | 1.8 kB / 0.9 kB |
| embed-text (and `embedQuery`) | transformers.js 123 kB + onnxruntime-web 42 kB + glue 3 kB, ort wasm 7.1 MB (28.7 MB raw), + the model (24 MB, or 103 MB for bge-base) |
| `dist/kb-host.js` / `dist/embed-query.js` (host entries) | 0.6 kB / 0.65 kB |
| any T3 node (WebGPU) | slot glue ≈ 6 kB + the same transformers.js / onnxruntime-web / ort wasm, then the model (250–850 MB) |
| gen-text | + structured output ≈ 15 kB |
| any T1 vision node | slot glue 5.3 kB (`impl`) + geometry 2.6 kB + model registry 5.5 kB + hub 1.7 kB + onnxruntime-web 42 kB, ort wasm 7.1 MB (shared), then the model: OCR small 31 MB / tiny 6.3 MB, orientation 6.8 MB, layout 4.9 / 23.5 MB, table 7.8 MB + OCR small |
| split-video | + split glue 3 kB + Mediabunny 195 kB + TransNetV2 31 MB |
| detect-objects | glue 1 kB + transformers.js 123 kB + the shared runtime + D-FINE 7.9 MB (fp16, default) / 4.5 MB (int8) |
| any T2 audio node | audio pipeline 12 kB + Mediabunny 196 kB + onnxruntime-web 42 kB, ort wasm 7.1 MB (shared with transformers.js), then the models: SenseVoice 240 MB, VAD 2.3 MB, diarization 34 MB, CED 6.2 MB |

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

**Real-model tests** (`test/browser/kb-models.test.ts`) never download anything. They run only when
`EDGE_MODELS_DIR` points at a local model base (`<dir>/Xenova/bge-small-zh-v1.5/…`), which vitest
serves at `/models/` (with `Range` support); otherwise they skip with that message. `EDGE_COI=1`
serves the test page cross-origin isolated (threaded onnxruntime-web). Timings land in
`test-results/kb-timings.json`.

```bash
EDGE_MODELS_DIR=../.models-cache npm run test:browser   # files from modelscope.cn/models/<org>/<repo>/resolve/master/<path>
```

**T1 vision tests** (`test/browser/vision.test.ts`): without `EDGE_MODELS_DIR` they check only the
model-free paths (a model base that does not hold the files fails the node clearly; an unknown OCR
model is rejected) and print that the real-model part is skipped. With it they run every T1 slot
on real weights: OCR small/tiny on a synthetic Chinese/English scan and on a rendered PDF page,
upside-down text with `textline_orientation`, orientation of a page turned 90/180/270°, layout S/M
on a rendered two-column report (`test/fixtures/paper.pdf`, from `scripts/gen-vision-fixtures.mjs`)
chained into `table-recognize`, a ruled table, shot splitting of a key-framed MP4 (parts copied)
and a one-key-frame WebM (parts re-encoded), and D-FINE on two photos. Node tests
(`test/node/vision.test.ts`) cover the geometry, DB post-processing, CTC decoding, YAML dictionaries,
SLANet decoding and cell matching, TransNetV2 windows and scenes, the frame-difference fallback,
layout ordering, and that the manifest, `models.json` and the model catalog agree.

**T3 tests never download a model.** In Node they cover the pure parts (prompts, JSON salvage,
image sizing, TFV1, progress throttling, quota and WebGPU checks) and the runtime glue against a
fake transformers.js (shared loads, download cancel, eviction, streaming, cancel). The default
browser run checks that every T3 method fails with the WebGPU error (headless Chromium has no GPU
adapter). Real inference runs only with `EDGE_MODELS_DIR` (above), which also launches Chromium with `--enable-unsafe-webgpu`
(plus `--use-angle=metal` on macOS, which exposes the real GPU headless; `EDGE_WEBGPU=1` alone
adds the flags) and runs each model whose files are present; the others are skipped.

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
- **Alternative implementations** are a manifest `models` list on one slot entry
  (`embed-text`: `["bge-small-zh-v1.5", "bge-base-zh-v1.5"]`, default first), and the method picks
  by `ctx.model`. The scanner rejects a `nodeSlot` declared twice, so separate entries per
  implementation are not possible.
- transformers.js and onnxruntime-web contain their libraries' default hosts (huggingface.co,
  jsDelivr) as strings; both are overridden before any file is fetched, and a test asserts every
  model request goes to the model base.

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
| @huggingface/transformers (transformers.js) | 4.3.2 | Apache-2.0 | Plus @huggingface/jinja, @huggingface/tokenizers (Apache-2.0) |
| onnxruntime-web | 1.31.1 | MIT | Microsoft; the wasm ships in `dist/assets/ort/` |
| tongflow (engine/worker) | 1.0.0 (monorepo) | AGPL-3.0 | First-party; `defineEdgePlugin` and `edgeMethod` |
| @huggingface/transformers (transformers.js) | 4.3.2 | Apache-2.0 | T3 only; bundles @huggingface/jinja and @huggingface/tokenizers (Apache-2.0) |
| @huggingface/transformers-structured-output | 4.3.2 | Apache-2.0 | `gen-text` only |
| onnxruntime-web | 1.31.1 | MIT | Bundled JS + `dist/assets/ort/` wasm; notice in `licenses/onnxruntime-web-MIT.txt` |

Model weights are not part of this package; they are downloaded from the host's model base. Their
licenses are in the [T3 models table](#t3-webgpu-nodes) and the [T2 audio section](#t2-audio-nodes);
LFM2.5-350M's and the FunASR model license's full texts are in `licenses/`. Attribution for the about page: "Qwen3.5-0.8B by the Qwen team, Alibaba Cloud
(Apache-2.0)", "GLM-OCR by Zhipu AI (MIT)", "EmbeddingGemma 2 by Google DeepMind (Apache-2.0,
Gemma Prohibited Use Policy)", "LFM2.5-350M by Liquid AI, Inc. (LFM Open License v1.0)",
"PP-OCRv6, PP-LCNet, PP-DocLayout and SLANet_plus by PaddlePaddle (Apache-2.0)", "TransNetV2 © 2020
Tomáš Souček (MIT)", "D-FINE by Peterande et al. (Apache-2.0)"; the T1 entries are in the
[T1 models table](#t1-visiondocument-nodes).

Avoided on purpose: MuPDF.js and scribe.js (AGPL-3.0), the ffmpeg.wasm core (GPL-2.0+) and the
Ultralytics models (AGPL-3.0).

Test fixture `test/fixtures/hello-cjk.msg` comes from the msgreader test suite (Apache-2.0). The audio
fixtures in `test/fixtures/audio/` were synthesized for this repo with macOS `say` (voices Tingting and Reed). The
vision fixtures `cat.jpg` and `astronaut.jpg` are scikit-image sample photos (chelsea: CC0, Stefan van
der Walt; astronaut: NASA, public domain); `paper.pdf`, `shots.mp4` and `shots-gop.webm` are generated
by `scripts/gen-vision-fixtures.mjs` (Chromium print, ffmpeg test sources).

---

## 中文

[TongFlow](https://github.com/tong-io/tongflow) 官方**浏览器端边缘插件**。它在用户浏览器的 Web Worker 里,通过 TongFlow
浏览器引擎完成以下工作:解析文档、把 PDF 渲染成页面图、从视频中抽取音轨和首帧、识别文本语种,以及为端侧知识库切块和计算向量。
文件不出设备。文档、音视频、语种节点是 **T0(零模型)** 节点;`embed-text` 首次使用时从宿主的 model base 下载 24 MB 模型。另有可选的 **T3(WebGPU)** 节点:图像理解、GLM-OCR、图像向量、要点抽取,模型 250–850 MB,见下文「T3 WebGPU 节点」。

### 实现的 slot

| Slot | 方法 | 作用 | 库 |
|---|---|---|---|
| `parse-document` | `parseDocument` | 各类文档转成 Markdown 风格的 `text`;`images` 暂时恒为 `[]` | 见下表 |
| `render-pages` | `renderPages` | PDF 每页输出一张 PNG(`pages`,`x-expand-each`)。分辨率 150 DPI,最长边不超过 4096 px。仅限浏览器(需要 OffscreenCanvas) | pdf.js 6.5.438 |
| `extract-audio` | `extractAudio` | 抽取视频的主音轨,能不重编码就直接转封装:AAC/AC-3 转 `.m4a`,Opus/Vorbis 转纯音频 `.webm`,MP3 转 `.mp3`,FLAC 转 `.flac`,PCM 转 `.wav`。其它编码用 WebCodecs 转成 AAC | Mediabunny 1.66.2 |
| `get-first-frame` | `getFirstFrame` | 视频第一帧可解码画面,输出 PNG(已按旋转信息校正)。仅限浏览器(WebCodecs),能解哪些编码取决于浏览器 | Mediabunny 1.66.2 |
| `detect-language` | `detectLanguage` | 输出文本的 ISO 639-1 语种代码,支持 60 种语言。没有字母的文本会明确报错 | eld 2.1.1(medium 词典) |
| `chunk-text` | `chunkText` | 文本切成知识库片段(见下方「知识库节点」) | 自写 |
| `embed-text` | `embedText` | 文本转 TFV1 向量,默认 bge-small-zh-v1.5,可换 bge-base-zh-v1.5 | transformers.js 4.3.2、onnxruntime-web 1.31.1 |
| `kb-write` | `kbWrite` | 校验并汇总片段和向量,由宿主存储 | 自写 |
| `transcribe` | `transcribe` | 音频转中文优先、带标点的 `text`(SenseVoiceSmall) | onnxruntime-web 1.31.1,见下方「T2 音频节点」 |
| `vad-segment` | `vadSegment` | 音频切成语音段 WAV(`segments`,Silero VAD) | 同上 |
| `diarize-speakers` | `diarizeSpeakers` | 音频输出说话人分段 JSON `[{speaker,start,end}]`(pyannote + CAM++) | 同上 |
| `audio-tag` | `audioTag` | 音频输出事件标签 JSON `[{label,score}]`(CED-tiny,AudioSet) | 同上 |
| `ocr-image` | `ocrImage` | 图片转按阅读顺序的 `text`(PP-OCRv6 small;可换 `tiny`,WebGPU 下可换 `glm-ocr`) | onnxruntime-web 1.31.1,见下方「T1 视觉/文档节点」 |
| `image-orient` | `imageOrient` | 图片转正,输出 PNG(PP-LCNet doc_ori) | 同上 |
| `layout-detect` | `layoutDetect` | 页面图输出 `layout` JSON 和按阅读顺序裁好的 `regions`(PP-DocLayout-S/-M) | 同上 |
| `table-recognize` | `tableRecognize` | 表格图转 `html`(SLANet_plus + PP-OCRv6) | 同上 |
| `split-video` | `splitVideo` | 视频按镜头切成多个 `video_parts`(TransNetV2;切点在关键帧上时直接转封装) | 同上,加 Mediabunny 1.66.2 |
| `detect-objects` | `detectObjects` | 图片输出 `objects` JSON(D-FINE nano,COCO 类别) | transformers.js 4.3.2 |

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

### 知识库节点:`chunk-text`、`embed-text`、`kb-write`

入库流水线为 `文本 → chunk-text → embed-text → kb-write`,`kb-write` 同时读取 `chunk-text` 的片段。**插件本身不持有任何存储**:
知识库在宿主里(scanall 的 `@scanall/kb`),由宿主把 `kb-write` 校验过的数据写进去。

| Slot | 方法 | 模型(默认在前) | 作用 |
|---|---|---|---|
| `chunk-text` | `chunkText` | — | 收集到的 `texts` 输出 `chunks`。各部分以空行拼接,先分成块(段落、Markdown 表格、代码块、标题),再装进不超过 `max_chars` 的片段(默认 500,限制在 50..8000;按 UTF-16 计,一个汉字算 1)。单块放不下时按句末切(`。！？；…` 及后随引号、`! ? ;`、`. `、换行),仍放不下再硬切(优先在 `，、：, :` 和空格处)。相邻正文片段重叠约 80 字(`min(80, max_chars/5)`),取完整句子;表格、代码、新标题前后不加重叠。放得下的表格不拆(整体移到下一片段),超长表格按行拆,每段重复表头。标题不会落在片段末尾。空片段丢弃;完全没有文本时报错。 |
| `embed-text` | `embedText` | `bge-small-zh-v1.5`、`bge-base-zh-v1.5` | `texts` 输出 `vectors`:一个 TFV1 文件(`vectors.tfv1`),按输入顺序每条一行。transformers.js 加载 q8 ONNX,**CLS 池化 + L2 归一化**(BGE 的规定做法),文档不加指令前缀。small 每批 16 条、base 每批 8 条,按长度排序以减少补齐;每批后上报 `embedded i/N`;批间检查取消。模型文件和 ort wasm 的下载经 `modelDownload` 上报。 |
| `kb-write` | `kbWrite` | — | 校验 `chunks` + `vectors`(TFV1)+ `source`:至少一个片段、没有空片段、TFV1 格式正确、向量数等于片段数、数值有限。输出 `text` = `{"source","chunkCount","dims","vectorsSha256"}`(JSON)。不存储任何东西。 |

`embed-text` 用节点的 `model`(manifest 的 `models`,在画布上选择或用 `replaceImplementation` 切换);不设即 `bge-small-zh-v1.5`,
也接受 `<org>/<repo>` 写法。

**TFV1** 原样复制自 `@scanall/kb/vectors`(`src/kb/tfv1.ts`)。本机有 scanall 仓库时(或设 `SCANALL_KB_DIR`),Node 测试会逐字节比对
源文件和打包结果。

#### `kb-write` 的宿主侧步骤(scanall 前端照此实现)

采用方案 (a),不改 worker 协议。宿主用 `tongflow-edge-essentials/kb-host`(`dist/kb-host.js`,0.6 kB,不含 ML 代码)里的
`tapKbWrite` 包一层 executor。它会记下每次**成功**的 `kb-write` 调用拿到的输入(正是 `kb-write` 校验过的片段、TFV1 字节和来源),
以及本次运行里 `embed-text` 用的模型。代码见英文部分,步骤如下:

1. 本次运行用 `tap.executor`。一个 tap 对应一次运行,复用前调用 `reset()`。
2. **只有** `result.status === "success"`(不是 `partial`、`failed`、`cancelled`)且 `take()` 返回了数据时才提交。没有成功的
   `kb-write` 时 `take()` 返回 `null`;有多个成功的 `kb-write`、或混用了多个嵌入模型时 `take()` 抛错。以上情况一律保留旧库。
3. `beginIngest` → `add(payload.chunks, payload.vectors)` → `commit()`。`@scanall/kb` 会再查一遍数量和维度,提交失败则旧库原样保留。
   文件名用 `payload.source`,`embedModel` 用 `payload.embedModel`(向量不是本次运行的 `embed-text` 产出时为空)。
4. 节点结果显示 `kb-write` 的 `text`(或提交后的 `KbInfo`)。`kb-write` 的错误(如「3 chunks but 2 vectors」)本身就会让节点失败并给出原因。

不方便包 executor 的宿主,也可以从运行结果里取同样的数据:`kb-write` 的 `chunks` 绑定指向 `chunk-text` 的 `chunks` 输出
(`result.outputs[id].chunks`),`vectors` 绑定指向 `embed-text` 的 `vectors`(`{file_key}` → `store.get(file_key)`),`source` 是
`config` 绑定。提交前用 `vectorsSha256` 核对字节。

#### 宿主的查询向量:`embedQuery`

`tongflow-edge-essentials/embed-query`(`dist/embed-query.js`,0.65 kB;ML 代码首次使用时从同一个 `dist/chunks/` 加载)用与
`embed-text` **相同的模型、文件、池化和归一化**计算查询向量,并加上 BGE 查询指令 `为这个句子生成表示以用于检索相关文章：`(文档从不加;
`instruction: ""` 可关闭)。选项:`model`、`modelBase`、`pluginBase`、`instruction`、`onDownload`;一次性调用用 `embedQuery(text, options)`。

做成单独入口而不是 worker 方法,是因为宿主在工作流运行之外、在自己的代码里调用它。**建议放在宿主自己的 Web Worker 里**(一次推理会占住
所在线程约 40 ms),主线程也能用。同源部署时它与插件 worker 共用 Cache API,模型只下载一次。它算出的向量与 worker 的余弦约 0.996
(q8 是逐次动态量化,同一文本在不同批次里结果略有差别)。

#### 模型托管(model base)

模型文件只从 **model base** 下载,目录为 `<modelBase><org>/<repo>/<path>`,与 ModelScope / Hugging Face 仓库一致,可 1:1 镜像
(文件清单见 `models.json`)。取值顺序:`ctx.modelBase`(若引擎将来提供)→ `globalThis.__TONGFLOW_EDGE_CONFIG__.modelBase` → 同源
`/models/`。worker 由引擎的 executor 创建,宿主无法预先注入代码,所以**用入口 URL 的查询参数设置**:
`resolveModuleUrl` 返回 `…/dist/index.js?modelBase=<URL 编码的地址>`。入口会把它写进 worker 内的 `__TONGFLOW_EDGE_CONFIG__`
(已有值优先)。进程内使用时在首次调用前设置 `globalThis.__TONGFLOW_EDGE_CONFIG__ = { modelBase }`;`embedQuery` 通过选项传入。

- 跨域的 model base 需要 CORS,并且应支持 `Range` 请求:transformers.js 用 `Range: bytes=0-0` 探测文件大小,不支持时每个文件会下载两遍。
- transformers.js 设为 `allowLocalModels = false`、`remoteHost = modelBase`、`remotePathTemplate = "{model}/"`,模型文件缓存在
  Cache API(`transformers-cache`)。
- onnxruntime-web 的 wasm(`ort-wasm-simd-threaded.asyncify.wasm`,28.7 MB,gzip 7.1 MB)放在 `dist/assets/ort/`,带进度下载一次后缓存在
  Cache API(`tongflow-edge-assets`)。不访问 jsDelivr 或 huggingface.co。所有节点(transformers.js 与直接用 onnxruntime-web 的节点)共用
  一个 onnxruntime-web 实例和一份 wasm;浏览器测试断言 wasm 只请求一次、不会请求其它 ort 构建。
- 带外部权重的模型(`.onnx` + `.onnx_data`,所有 T3 模型):插件按模型目录自行声明每个计算图的数据文件(`use_external_data_format`),
  不依赖仓库的 `config.json`。GLM-OCR 的配置只写了 fp32 计算图的文件名,transformers.js 4.3.2 因此在创建 q4/q4f16 会话时没带上权重,
  onnxruntime-web 报 `Module.MountedFiles is not available`。
- 构建时给 transformers.js 的会话创建/推理队列打补丁:一个模型加载失败后,同一 worker 里后续的模型不再全部带着同一个错误失败
  (`tsdown.config.ts` 的 `unpoisonedOrtChains`;升级后找不到对应代码时构建直接报错)。
- **页面尽量开启跨源隔离**(`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp`):这样
  onnxruntime-web 能用多线程,约快 2.6 倍;否则单线程运行。

#### 运行时与实测速度

transformers.js **4.3.2** + onnxruntime-web **1.31.1**(所有 ML 节点共用这一个版本;transformers.js 4.3.2 自己依赖
`1.31.0-dev.20260914`,用 npm `overrides` 统一成 1.31.1),WASM 执行。headless Chromium(Playwright,Apple Silicon)实测,
模型从本地 `EDGE_MODELS_DIR` 提供:

- 冷启动(ort wasm + 24 MB 模型加载、初始化、3 条短文本):单线程 1.2 s;
- 16 个约 480 字的片段(默认片段大小):单线程 11–18 s(每片约 0.7–1.2 s,两次测量,慢的一次机器负载较高),跨源隔离多线程 4.2 s(每片约 260 ms);
- `embedQuery` 预热 0.75 s,单次查询 42 ms。

完整表格见英文部分。长文档的耗时主要在向量化(每 1000 个默认大小片段约 4–20 分钟)。

### 模型清单

`models.json`(仓库根目录,也以 `tongflow-edge-essentials/models.json` 导出)列出插件可能下载的全部模型:
`[{id, source: "modelscope:<org>/<repo>", files, approxMB, license, attribution?}]`,权重托管任务按它同步。

- `bge-small-zh-v1.5`(`embed-text` 默认):`modelscope:Xenova/bge-small-zh-v1.5`,24 MB,MIT;
- `bge-base-zh-v1.5`:`modelscope:Xenova/bge-base-zh-v1.5`,103 MB(98.1 MiB,未超过单文件 100 MiB 上限),MIT。

署名:bge-*-zh-v1.5 由 BAAI 发布([FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)),MIT 许可;Xenova 的 ONNX 转换件
未标许可,跟随上游。随权重附上 BAAI 的 MIT 声明。

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

### T1 视觉/文档节点

小模型(每个 2–31 MB),跑在共享的 onnxruntime-web **1.31.1** 上(与 transformers.js、音频节点同一模块、同一个 wasm)。
**默认 WASM;`_params.device: "webgpu"` 且 worker 有 GPU adapter 时用 WebGPU**(WebGPU 建不了的图自动退回 WASM)。WebGPU 需显式开启:
无头 Chromium(ANGLE/Metal)里,module worker 中第一个 WebGPU session 一直不返回(主线程正常,先建过 WASM session 后也正常);
这些模型在 WASM 上已经够快。前后处理全部是 TypeScript,在 module worker 里用
OffscreenCanvas/ImageBitmap 完成,不用 OpenCV.js,不碰 DOM。没有用 PaddleOCR.js,因为它依赖 OpenCV.js 和 DOM canvas。

| Slot | 方法 | 模型(`models`,默认在前) | 输出 |
|---|---|---|---|
| `ocr-image` | `ocrImage` | `pp-ocrv6-small`、`pp-ocrv6-tiny`、`glm-ocr`(T3,WebGPU) | `text`:按阅读顺序的文本行(自上而下,行内自左向右;中文片段之间不加空格) |
| `image-orient` | `imageOrient` | `pp-lcnet-doc-ori` | `image`:转正(0/90/180/270°)后的页面 PNG;本来就正的 PNG 原样返回 |
| `layout-detect` | `layoutDetect` | `pp-doclayout-s`、`pp-doclayout-m` | `layout`:JSON `[{label, score, box: [x1, y1, x2, y2]}]`,按阅读顺序;`regions`:每项一张裁剪 PNG,顺序相同(`x-expand-each`) |
| `table-recognize` | `tableRecognize` | `slanet-plus` | `html`:`<table>…</table>`,结构来自 SLANet_plus,单元格文字来自 PP-OCRv6 small |
| `split-video` | `splitVideo` | `transnetv2` | `video_parts`:每个镜头一个视频,容器不变 |
| `detect-objects` | `detectObjects` | `dfine-nano-fp16`(默认)、`dfine-nano`(int8) | `objects`:JSON `[{label, score, box: [x1, y1, x2, y2]}]`(COCO 类别,像素坐标,按分数降序) |

- **OCR**:检测(DB)→ 裁剪 → 识别(CTC),与 PaddleOCR/PaddleX 一致。检测输入短边 ≥ 64、长边 ≤ 2048(`_params.det_max_side`),
  取 32 的倍数;DB 阈值读自模型的 `inference.yml`;识别高 48,按宽高比分批;字典直接从识别模型仓库的 `inference.yml` 读取,保证与权重一致。
  `_params.textline_orientation: true` 才启用 1 MB 的文本行方向分类(默认关:测试中它把表格里的短单元格翻转了,整页方向交给 `image-orient`)。
  模型选 `glm-ocr` 时经 `withModelAlternative` 转给 T3 的 GLM-OCR。
- **版面**:PP-DocLayout-S(480²,默认)或 -M(640²),阈值 0.5(`_params.threshold`)。阅读顺序:页眉在前;宽块(标题、摘要)把页面分成横带,
  带内按栏从左到右、栏内自上而下;页码、页脚最后。S/M 只有社区 ONNX 转换件(`Liyulingyue/PP-DocLayout-{S,M}-ONNX`),已在渲染出的双栏 A4 报告上
  验证(标题、摘要、小标题、正文、表格 0.92、图、图题、页码都检出,框贴合内容),`models.json` 里钉死了 sha256。
- **表格**:SLANet_plus 输入长边缩放到 488 并补齐到 488²;结构 token 按 PaddleOCR 的 `merge_no_span_structure` 字典解码;单元格多边形相对补齐后的方图归一化。
  OCR 框按 PaddleOCR `TableMatch` 规则(IoU 优先,再看角点距离)分配到单元格。输入应是表格裁剪图,例如 `layout-detect` 标为 `table` 的区域。
- **切镜头**:Mediabunny 解码主视频轨,按 **10 fps** 采样 48×27 帧(`_params.fps`;4 fps 时 TransNetV2 在快速运动的测试素材上漏了一个切点、又多报了几个),
  TransNetV2 以 100 帧窗口推理,单帧头按 `threshold`(ABI 输入,默认 0.5)判定;再解码两个采样点之间的帧把切点精确到帧,并在一帧之内对齐关键帧。
  切点落在关键帧上时**直接转封装、不重编码**(编码器通常会在场景切换处放关键帧),否则用 WebCodecs 从切点重编码;浏览器编不了该编码时改为从前一个关键帧起拷贝。
  TransNetV2 未托管或加载失败时改用颜色直方图帧差检测(进度消息会说明)。只有一个镜头时原样返回输入。
- **目标检测**:D-FINE nano 走 transformers.js 的 `object-detection` pipeline(共享的 `ml/transformers.ts`)。它的 sigmoid 分数偏低(测试猫图 0.6–0.7),
  默认阈值 0.35(`_params.threshold`),同类且 IoU ≥ 0.7 的重复框合并。默认用 `dfine-nano-fp16`:在 WASM 上比 int8 更快也更准
(int8 漏检了宇航员图里的人,fp16 检出 0.44);`dfine-nano`(int8,小 3.4 MB)保留为备选。

实测耗时与模型清单见英文部分。T1 的每个 `models.json` 条目都给每个文件记了 `sha256`:直接用 ORT 的模型首次下载时校验,存进 Cache API 的
`tongflow-edge-models`;D-FINE 由 transformers.js 存进 `transformers-cache`。model base 对缺失文件返回 HTML 页(SPA 兜底)时,报"未托管"而不是去解析。
署名:PP-OCRv6、PP-LCNet、PP-DocLayout、SLANet_plus 由 PaddlePaddle 发布(Apache-2.0),PP-DocLayout 的 ONNX 转换由 Liyulingyue 完成;
TransNetV2 © 2020 Tomáš Souček(MIT),ONNX 导出者 q502892879;D-FINE 由 Peterande 等人发布(Apache-2.0),ONNX 由 onnx-community 转换。

### T3 WebGPU 节点

可选的真模型节点,**只在 WebGPU 下可用**。每个方法先检查 `self.navigator.gpu` 和 GPU adapter,缺任何一个就明确报错
(`this node needs WebGPU …`),不会下载任何东西。宿主应默认关闭这些节点,首次运行前提示用户下载体积(见 `models.json` 或导出的
`T3_MODELS`),并显示存储配额。

| Slot | 方法 | 模型(`models`) | 作用 |
|---|---|---|---|
| `image-gen-text` | `imageGenText` | `qwen3.5-0.8b` | 画布 `imageGenTextNode` 用的 slot。`text`(提示词,可为空)加可选 `image`;支持 `system`、`max_new_tokens`(512)、`enable_thinking`(默认关)、`temperature`(0.7,0 为贪心)、`top_p`(0.8)、`top_k`(20)。没有提示词时**用简体中文描述图片**,默认 system 提示也要求中文作答;没有图片时就是纯文本对话 |
| `image-describe` | `imageGenText`(同一方法) | `qwen3.5-0.8b` | `image` 加可选 `text`/`userPrompt`,行为相同 |
| `ocr-image`(备选实现) | `ocrImageGlm` | `glm-ocr` | GLM-OCR 整页识别,输出 Markdown(含表格)。不是该 slot 的默认实现,见下文「备选实现」 |
| `embed-image` | `embedImage` | `embeddinggemma-2` | 每张图一条 L2 归一化的 768 维向量,以 TFV1 格式的 `vectors` 文件输出;与 EmbeddingGemma 2 文本向量同一空间。不加载音频编码器 |
| `gen-text` | `genText` | `lfm2.5-350m` | 从 `text` 做结构化要点抽取,`userPrompt` 可限定范围。解码受 JSON schema `{"key_points": string[]}` 约束(transformers.js 结构化输出),输出 `text` 即该 JSON。提示词跟随原文语言:中文原文用中文指令、出中文要点 |

高级参数(`_params`):均支持 `max_new_tokens`;视觉模型支持 `max_pixels`(Qwen3.5 默认 448²,GLM-OCR 默认 1024²,按像素预算等比缩放,
因为每 32×32(Qwen)/28×28(GLM)像素就是一个提示 token,prefill 决定耗时);`embed-image` 支持 `dims`(768,或 Matryoshka 的
512/256/128);`gen-text` 支持 `max_input_tokens`(默认 4096,超出截断)。

**行为**

- 流式:生成的 token 实时写进 `progress`(`extracting: 37 tokens · …末尾文字`),之前先报 `reading the input (N tokens)`(prefill)。
- 取消:`cancel` 在下一个 token 处停止,调用以 abort 错误结束;没有任何节点再等待的模型下载也会被取消(多个节点等同一模型时共用一次下载)。
- 下载与缓存:通过 `modelDownload` 上报(`loaded`/`total` 为该模型所有文件之和,`file` 为 `"<模型> · <文件>"`);transformers.js 把文件存进
  Cache API 的 `transformers-cache`,同一浏览器配置只下载一次。下载前用 `navigator.storage.estimate()` 检查配额,装不下就明确报错。
  `navigator.storage.persist()` 只在页面里可用:**宿主页面应在首次运行 T3 前调用它**,避免浏览器回收模型。
- 显存:最多常驻两个模型,超出时释放最久未用的空闲模型。
- 精度:adapter 支持 `shader-f16` 时用 q4f16 权重(Qwen3.5 视觉塔用 fp16),否则用 q4。

**模型**(首次下载量,有 / 无 `shader-f16`):Qwen3.5-0.8B 810/740 MB(Apache-2.0);GLM-OCR 660/745 MB(MIT);EmbeddingGemma 2
文本+视觉 290/316 MB(Apache-2.0,另须遵守 Gemma 禁止使用政策);LFM2.5-350M 259/297 MB(**LFM Open License v1.0**)。

**运行时**:与 `embed-text` 共用 `src/ml/transformers.ts`(transformers.js 4.3.2 / onnxruntime-web 1.31.1、同一 model base、同一
`dist/assets/ort/` wasm、同一 Cache API),使用 WebGPU device;结构化输出用 `@huggingface/transformers-structured-output` 4.3.2。
权重同样从 model base 获取,全部文件列在 `models.json`(`approxMB` 为支持 `shader-f16` 时的首次下载量,`files` 覆盖两套精度,
由测试与 `src/ml/catalog.ts` 保持一致)。部分权重文件超过 100 MB(Qwen3.5 decoder 数据 437 MB),模型服务器若有单文件上限需对这些仓库放开。

实测(Apple Silicon,无头 Chromium 159 加 `--enable-unsafe-webgpu --use-angle=metal`,Metal adapter 支持 `shader-f16`,模型本地提供):
LFM2.5-350M q4f16 对约 200 字的中文合同条款做 `gen-text`,首次 6–11 s(其中 3.5–8 s 为把 255 MB 写入 Cache API 并创建 session),
约 100 个 token、约 45 token/s;模型常驻时 2.3 s,首个 token 0.24 s;新 worker 从 Cache API 加载 2.5 s;取消在一个 token 内生效。同样环境下其它 T3 模型(首次 = 从本地 model base 下载 + 创建 session + 推理):
`image-gen-text` Qwen3.5-0.8B 描述一张 900×172 图片、128 个新 token 19.6 s;`ocr-image` GLM-OCR q4f16 准确读出两行发票文字 4.1 s;
`embed-image` EmbeddingGemma 2 q4f16 2.8 s。

**备选实现**:scanner 规定每个 `nodeSlot` 只能有一条 manifest 记录(重复会被拒:`declared more than once`),所以备选实现是该 slot
记录里多一个**模型**,方法按 `ctx.model` 分派。`ocr-image` 现在是
`{"nodeSlot": "ocr-image", "method": "ocrImage", "models": ["pp-ocrv6-small", "pp-ocrv6-tiny", "glm-ocr"]}`:默认方法是 PP-OCRv6,
`withModelAlternative(ocrImage, "glm-ocr", ocrImageGlm)` 把 `glm-ocr` 转到 GLM-OCR。

**TFV1 向量文件**:`<图片名>.tfv1`,`application/octet-stream`,小端:魔数 `"TFV1"`、`u32 dims`、`u32 count`,之后是
`count × dims` 个 float32(行优先),即 scanall `@scanall/kb` 读取的格式。

**LFM2.5-350M 许可证的收入门槛**:LFM2.5-350M 采用 **LFM Open License v1.0**,全文见
[`licenses/LFM-Open-License-v1.0.txt`](licenses/LFM-Open-License-v1.0.txt),再分发权重时必须随附(网页 demo 把权重发给浏览器即属再分发)。
**只有当使用方的法律实体(连同其控制、受其控制或与其同受控制的所有关联实体)年收入低于 1000 万美元时,商业使用才在授权范围内**
(许可证的 "Threshold",§1、§5)。"直接或间接商业利益" 都算商业使用,替公司揽客的免费 demo 也算。启用 `gen-text` 前,必须由业务方确认运营主体
及其关联方收入低于门槛;否则不要开启该 slot,或改用其它模型。修改过的权重文件要标注已修改(§4(b));许可证不授予商标权。

### T2 音频节点

语音与声音节点,跑在 CPU 上(onnxruntime-web 的 wasm EP,不需要 WebGPU)。每个 slot 先**在 worker 内**把输入解码成
16 kHz 单声道 Float32:Mediabunny 解封装各种容器(m4a/mp4、mp3、wav、webm、ogg、flac,视频文件也可以),用 WebCodecs
`AudioDecoder` 解码(PCM 不需要它);多声道取平均,采样率用移植的 Kaldi 加窗 sinc `LinearResample` 转换(worker 里没有
AudioContext)。超过 100 MB 的输入会被拒绝。

| Slot | 方法 | `models` | 作用 |
|---|---|---|---|
| `transcribe` | `transcribe` | `sensevoice-small` | SenseVoiceSmall(int8):中文优先(也支持英/日/韩/粤),**带标点和 ITN**。`language` 是提示(`zh`、`zh-CN`、`en`、`yue`/粤语、`ja`、`ko`,其它按自动)。30 s 以内一次识别;更长的音频先用 Silero VAD 在停顿处切成不超过 25 s 的段,逐段识别(进度 `transcribing i/N`)再拼接(中文段之间不加分隔)。ABI 输出只有 `text`,识别出的语种不返回。`context`、`max_new_tokens` 不生效(CTC 模型) |
| `vad-segment` | `vadSegment` | `silero-vad-v5` | `segments`:每个语音段一个 16 kHz 单声道 16 位 WAV(`x-expand-each`),文件名形如 `<stem>-001-1.09s-5.68s.wav`。算法即 Silero 官方的 `get_speech_timestamps`;默认阈值 0.5、最短语音 250 ms、最短静音 500 ms、前后各补 200 ms、单段最长 30 s(在最后一个 ≥ 98 ms 的停顿处切开)。`_params` 可覆盖 `threshold`、`min_speech_ms`、`min_silence_ms`、`speech_pad_ms`、`max_speech_s` |
| `diarize-speakers` | `diarizeSpeakers` | `pyannote-campplus-zh` | `segments`(JSON 字符串):`[{"speaker":0,"start":0.976,"end":5.718}, …]`,单位秒,按开始时间排序,说话人按首次出现编号。pyannote segmentation-3.0 以 10 s 窗口、1 s 步长做局部分割 → 每个窗口内的局部说话人各取一个 3D-Speaker CAM++(中文)声纹 → 按余弦距离做全连接层次聚类(阈值 0.5)→ pyannote 的重建;短于 0.3 s 的段丢弃,同一说话人间隔 ≤ 0.5 s 的段合并。移植自 sherpa-onnx 的 `OfflineSpeakerDiarizationPyannoteImpl`。`_params`:`num_speakers`(指定人数)、`threshold` |
| `audio-tag` | `audioTag` | `ced-tiny` | `tags`(JSON 字符串):`[{"label":"Speech","score":0.7072}, …]`,AudioSet 527 类,取分数 ≥ 0.1 的前 10 个(至少一个)。长音频按 10 s 窗口(CED 的训练长度)分别打标,每类取最大值。`_params`:`top_k`、`min_score` |

**运行时选型:用 onnxruntime-web,不用 sherpa-onnx WASM。** 原计划用 sherpa-onnx 的 WASM 构建并在运行时拉模型,但不可行:
sherpa-onnx 2.0.2 发布的浏览器构建都用 `--preload-file` 把模型打进包里,而且只有 VAD/TTS/降噪;npm 上 `sherpa-onnx` 的 wasm
用 `NODERAWFS` 编译(在 Node 之外直接抛错),也没有音频标注;自己用 emscripten 构建则要多带一个 15.6 MB、自带 onnxruntime
且无法共享的 wasm。因此改为在插件唯一的 onnxruntime-web(1.31.1,与 transformers.js 共用同一实例和 asyncify wasm,见
`src/ml/ort.ts`)上运行**同一批 sherpa-onnx 导出的 ONNX**,前端处理用 TypeScript 移植 sherpa-onnx / kaldi-native-fbank
(Apache-2.0):Kaldi fbank(povey/hamming/hann 窗、snip-edges、预加重、mel 滤波器组)、SenseVoice 的 LFR(7/6)+ 模型
元数据里的 CMVN + CTC 贪心解码、CED 的 fbank + AmplitudeToDB、CAM++ 的全局均值归一化、pyannote 的 powerset/聚合/聚类。
ONNX 自定义元数据直接从 protobuf 读取(`src/ml/onnx-meta.ts`)。移植结果对照 kaldi-native-fbank(黄金特征
`test/fixtures/audio/fbank-golden.json`)以及 sherpa-onnx 2.0.2(Python)在同样文件上的输出:SenseVoice 文本完全一致,
VAD 段边界相差 0.05 s 以内,说话人分离得到相同的轮次(起点相差 0.02 s 以内),CED 分数相差 0.015 以内。

**模型文件与缓存**:从 model base(`<modelBase><org>/<repo>/<path>`)下载,按 `src/models/registry.ts` 里的大小和 SHA-256
(与 `models.json` 一致)校验后存入 Cache API(`tongflow-edge-models-v1`);每次下载都经 `modelDownload` 上报,`file` 为
`<org>/<repo>/<path>`,`model` 为模型 id。模型加载后常驻 worker。长音频分块处理并上报进度,块与块之间检查取消(循环会让出
事件循环,保证引擎的 `cancel` 消息能及时送达)。除了入口 URL 上的 `?modelBase=`,宿主也可以在第一次调用前向 worker 发
`{type: "config", modelBase}`。

**实测**(MacBook,Chromium 无头,单线程,未跨源隔离;21 s 的双人中文对话):transcribe 热态 8.5 s(RTF 0.40;首次 13.5 s,
含从本地服务器加载 239 MB 模型),63 s 音频走 VAD 分段共 26 s;vad-segment 0.36 s;diarize-speakers 8.5 s;audio-tag 处理 1.5 s
音频 0.2 s。手机会更慢(research/09 引用 Android Chrome 上 SenseVoice 的 RTF 约 0.7);跨源隔离后 onnxruntime-web 最多用 4 线程。

模型清单(id、来源、文件、大小、许可证)见英文部分的表格。sherpa-onnx 只在 GitHub Releases 发布这些导出,上表的 ModelScope
仓库是镜像,2026-11-21 已逐文件对照 GitHub 资产(详情见 `models.json` 的 `upstream`):SenseVoice、pyannote、Silero(对照
snakers4 的 v5.1.2)、CED 字节一致;CAM++ 是较早的导出,GitHub 上的当前文件已重新导出(PyTorch 2.14.1,一个 AveragePool
属性在零填充下改了值),两者声纹输出逐位相同,ModelScope 上没有与当前 GitHub 文件字节一致的镜像。`transcribe` 只有在音频超过
30 s 时才下载 VAD。**SenseVoice 单文件 228 MiB,超过本仓库资产的 100 MiB 上限;它属于 model base 上的文件,权重托管方要能提供
这么大的文件。**

**署名(关于/第三方许可页面):**
- **SenseVoiceSmall by FunASR/FunAudioLLM**,附[模型卡](https://www.modelscope.cn/models/iic/SenseVoiceSmall)和
  [FunASR 模型开源协议 v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)(全文见 `licenses/`)。须保留模型名,
  与其它模型的对比只写客观数据(§4.2)。商用口径仍在 [SenseVoice#334](https://github.com/QwenAudio/SenseVoice/issues/334)
  等待确认,上线前再查一次(备选:X-ASR,Apache-2.0)。
- **CED-tiny**,作者 Heinrich Dinkel、Yongqing Wang、Zhiyong Yan、Junbo Zhang、Yujun Wang(小米),
  [RicherMans/CED](https://github.com/RicherMans/CED);权重 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  ([Zenodo 8275347](https://zenodo.org/record/8275347));由 k2-fsa/sherpa-onnx 转为 ONNX 并做 int8 量化。只用权重,CED 的训练
  代码是 GPL-3.0,未打包。
- pyannote/segmentation-3.0(Hervé Bredin 及 pyannote.audio 贡献者,MIT);3D-Speaker CAM++(iic/speech_campplus_sv_zh-cn_16k-common,
  阿里通义实验室,Apache-2.0);Silero VAD(Silero Team,MIT);ONNX 导出来自 k2-fsa/sherpa-onnx(Apache-2.0)。

### 包体

所有库都是懒加载的动态 import:入口只有 12 kB,每种格式只加载自己需要的部分。首次使用时的 gzip 传输量(含依赖的 chunk)见上方英文表格。
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
- 向量化:transformers.js 123 kB + onnxruntime-web 42 kB,ort wasm gzip 7.1 MB(原始 28.7 MB),另加模型 24 MB(bge-base 为 103 MB);
- 切块 1.8 kB,kb-write 0.9 kB,宿主入口 `kb-host.js` / `embed-query.js` 各约 0.6 kB;
- 老格式 91 kB,另加 wasm 约 17.3 MB;
- T1 视觉节点:glue 约 15 kB 加共享的 onnxruntime-web 42 kB 与 ort wasm,再加模型(OCR small 31 MB/tiny 6.3 MB,方向 6.8 MB,版面 4.9/23.5 MB,表格 7.8 MB);
  切镜头另加 Mediabunny 195 kB 和 TransNetV2 31 MB;目标检测另加 transformers.js 123 kB 和 D-FINE 7.9 MB(默认 fp16;int8 4.5 MB);
- T3 节点:同一套 transformers.js / onnxruntime-web / ort wasm,再加模型本身(250–850 MB);`gen-text` 另加结构化输出约 15 kB。

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

**T3 测试从不下载模型。** Node 测试覆盖纯逻辑(提示词、JSON 修复、图片尺寸、TFV1、进度节流、配额与 WebGPU 检查)和基于假
transformers.js 的运行时胶水(共享加载、取消下载、显存回收、流式、取消)。默认浏览器测试检查每个 T3 方法都给出 WebGPU 错误(无头
Chromium 没有 GPU adapter)。真实推理只在设置本地模型目录时运行:`EDGE_MODELS_DIR=/path/to/models npm run test:browser`。目录结构同
model base,目录挂在 `/models/`,Chromium 加 `--enable-unsafe-webgpu` 启动(macOS 另加 `--use-angle=metal`,无头模式即可拿到真 GPU;
单独设 `EDGE_WEBGPU=1` 只加这些参数),目录里有哪个模型就跑哪个,其余跳过。

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
- **换实现**用同一个 slot 条目里的 `models` 列表表达(`embed-text`:`["bge-small-zh-v1.5", "bge-base-zh-v1.5"]`,默认在前),方法按
  `ctx.model` 选择。scanner 不允许同一个 `nodeSlot` 声明两次,所以无法每个实现各写一条。
- **真模型测试**(`test/browser/kb-models.test.ts`)不会联网下载:只有设置 `EDGE_MODELS_DIR` 指向本地 model base 时才运行,否则跳过并给出说明。

### 许可证

本插件采用 AGPL-3.0,与 TongFlow 及其官方插件一致。打包的第三方库中没有 AGPL,也没有仅限 GPL 的库。
需要注意的有两个:

- **jszip**:MIT 或 GPL-3.0 双许可,这里按 MIT 使用;
- **Mediabunny**:MPL-2.0,属于文件级 copyleft。插件未修改其源码,若修改则须按 MPL-2.0 公开改动的文件。

T3 运行时新增:transformers.js 4.3.2(Apache-2.0)、transformers-structured-output 4.3.2(Apache-2.0)、onnxruntime-web 1.31.1(MIT,
声明见 `licenses/onnxruntime-web-MIT.txt`)。模型权重不在本包内,由宿主的 model base 提供;LFM2.5-350M 的许可证全文在 `licenses/`。T1 视觉模型均为 Apache-2.0(PaddlePaddle 各模型、D-FINE)或 MIT(TransNetV2),署名见上文「T1 视觉/文档节点」。

完整列表见英文部分的表格。以下项目刻意未用:MuPDF.js 和 scribe.js(AGPL-3.0)、ffmpeg.wasm core(GPL-2.0+)、Ultralytics 系模型(AGPL-3.0)。
