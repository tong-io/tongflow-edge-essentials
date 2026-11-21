/**
 * The ffmpeg.wasm core: the official `@ffmpeg/core` build (single-threaded, ESM),
 * GPL-2.0-or-later (FFmpeg built with --enable-gpl, x264, x265, libvpx, LAME, …).
 * It is not bundled in `dist/`: like model weights it is fetched on first use from
 * the model base, under a path that mirrors the npm package,
 * `<modelBase>npm/@ffmpeg/core@<version>/dist/esm/ffmpeg-core.{js,wasm}`,
 * verified (size + SHA-256) and kept in the Cache API by `models/hub.ts`.
 *
 * Corresponding source (GPL §3): ffmpegwasm/ffmpeg.wasm at the release commit below
 * (tag v12.15, "RELEASE: @ffmpeg/core and @ffmpeg/core-mt v0.12.10"), whose Dockerfile
 * pins FFmpeg n5.1.4 and every library branch. `models.json` and `licenses/` repeat it.
 */
import type { ModelSpec } from "../models/registry.js";

export const FFMPEG_CORE_VERSION = "0.12.10";
export const FFMPEG_CORE_SOURCE_COMMIT = "71aa99d37c02a7b4c435275ca9ef50e612f6efa1";

export const FFMPEG_CORE = {
    id: "ffmpeg-wasm",
    repo: `npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}`,
    files: {
        js: {
            path: "dist/esm/ffmpeg-core.js",
            size: 111804,
            sha256: "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3",
        },
        wasm: {
            path: "dist/esm/ffmpeg-core.wasm",
            size: 32232419,
            sha256: "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
        },
    },
} as const satisfies ModelSpec;
