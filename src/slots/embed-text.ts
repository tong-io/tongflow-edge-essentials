import { ORT_ASSET_DIR, type MlRuntime } from "../ml/transformers.js";
import { resolveEmbedModel } from "../ml/models.js";
import type { EdgeContext } from "../context.js";
import type { SlotImpl } from "../types.js";
import { encodeBase64 } from "../util/base64.js";
import { EdgeError, MAX_ASSET_BYTES } from "../util/errors.js";
import { guard } from "./common.js";
import { textList } from "./chunk-text.js";

export const VECTORS_MIME = "application/octet-stream";
export const VECTORS_FILENAME = "vectors.tfv1";

export function mlRuntime(ctx: EdgeContext): MlRuntime {
    return {
        modelBase: ctx.modelBase,
        ortBase: ctx.resolveAsset(ORT_ASSET_DIR),
        signal: ctx.signal,
        onDownload: (p) => ctx.onDownload(p),
    };
}

/**
 * `embed-text`: texts → one L2-normalized vector each (bge-small-zh-v1.5 q8 by default,
 * bge-base-zh-v1.5 as the alternative model), packed as TFV1 in the `vectors` file.
 * Documents get no instruction prefix (BGE uses one for queries only).
 */
export const embedText: SlotImpl<"embed-text"> = (input, ctx) =>
    guard(ctx, async () => {
        const texts = textList(input.texts, "texts");
        if (!texts.length) throw new EdgeError("texts is empty: nothing to embed");
        const model = resolveEmbedModel(ctx.model);
        if (12 + 4 * model.dims * texts.length > MAX_ASSET_BYTES) {
            throw new EdgeError(`too many texts (${texts.length}): the vectors would exceed the 100 MB file limit`);
        }
        const [{ embedTexts, rows }, { packVectors }] = await Promise.all([import("../ml/bge.js"), import("../kb/tfv1.js")]);
        ctx.onProgress({ fraction: 0, message: `loading ${model.id}` });
        const result = await embedTexts(texts, model, mlRuntime(ctx), (done, total) =>
            ctx.onProgress({ fraction: done / total, message: `embedded ${done}/${total}` }),
        );
        const bytes = packVectors(rows(result.data, result.dims), result.dims);
        return {
            success: true,
            vectors: { bytesBase64: encodeBase64(bytes), mime: VECTORS_MIME, filename: VECTORS_FILENAME },
        };
    });
