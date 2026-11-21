/**
 * Manifest model ids (what a node's model picker shows, `tongflow.plugin.json`) → the
 * `models.json` entries (weight repos) each one downloads. The hosting ticket mirrors
 * every repo in models.json; a test keeps the three lists consistent.
 */
export const MANIFEST_MODELS: Record<string, { slot: string; repos: string[] }> = {
    // + pp-lcnet-textline-ori when `_params.textline_orientation` is true.
    "pp-ocrv6-small": { slot: "ocr-image", repos: ["pp-ocrv6-small-det", "pp-ocrv6-small-rec"] },
    "pp-ocrv6-tiny": { slot: "ocr-image", repos: ["pp-ocrv6-tiny-det", "pp-ocrv6-tiny-rec"] },
    "pp-lcnet-doc-ori": { slot: "image-orient", repos: ["pp-lcnet-doc-ori"] },
    "pp-doclayout-s": { slot: "layout-detect", repos: ["pp-doclayout-s"] },
    "pp-doclayout-m": { slot: "layout-detect", repos: ["pp-doclayout-m"] },
    "pp-doclayoutv3": { slot: "layout-detect", repos: ["pp-doclayoutv3"] },
    // Cell text comes from the default OCR model.
    "slanet-plus": { slot: "table-recognize", repos: ["slanet-plus", "pp-ocrv6-small-det", "pp-ocrv6-small-rec"] },
    transnetv2: { slot: "split-video", repos: ["transnetv2"] },
    "dfine-nano-fp16": { slot: "detect-objects", repos: ["dfine-nano-fp16"] },
    "dfine-nano": { slot: "detect-objects", repos: ["dfine-nano"] },
    yolo26n: { slot: "detect-objects", repos: ["yolo26n"] },
    "rf-detr-nano": { slot: "detect-objects", repos: ["rf-detr-nano"] },
    // embed-image's alternative (raw onnxruntime-web, like the T1 models; the default is T3's EmbeddingGemma 2).
    "chinese-clip-base": { slot: "embed-image", repos: ["chinese-clip-base"] },
};
