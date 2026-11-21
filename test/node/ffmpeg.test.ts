import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FFMPEG_CORE, FFMPEG_CORE_VERSION } from "../../src/ffmpeg/core.js";
import { inputName, parseProbe } from "../../src/ffmpeg/ops.js";
import { baseModel, FFMPEG_MODEL, forcesFfmpeg, withFfmpegFallback } from "../../src/ffmpeg/select.js";
import { impls, methods, slots } from "../../src/index.js";
import { EdgeError, MediaUnsupportedError } from "../../src/util/errors.js";
import { fixture, nodeCtx } from "../helpers/node-ctx.js";

const root = new URL("../../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const abi = JSON.parse(readFileSync(new URL("node_modules/tongflow/abi/tongflow.abi.json", root), "utf8")) as {
    nodes: { nodeSlot: string; inputs: { properties: Record<string, unknown>; required?: string[] }; outputs: { properties: Record<string, unknown> } }[];
};

const MEDIA = ["extract-audio", "get-first-frame", "get-last-frame", "concat-videos", "remove-video-audio", "merge-video-audio"] as const;

describe("implementation choice (ctx.model)", () => {
    it("ffmpeg-wasm and <model>+ffmpeg-wasm force ffmpeg; anything else is the browser default", () => {
        expect(forcesFfmpeg(FFMPEG_MODEL)).toBe(true);
        expect(forcesFfmpeg("sensevoice-small+ffmpeg-wasm")).toBe(true);
        expect(forcesFfmpeg("mediabunny")).toBe(false);
        expect(forcesFfmpeg("sensevoice-small")).toBe(false);
        expect(forcesFfmpeg(undefined)).toBe(false);
        expect(baseModel("transnetv2+ffmpeg-wasm")).toBe("transnetv2");
        expect(baseModel("ffmpeg-wasm")).toBeUndefined();
        expect(baseModel("transnetv2")).toBe("transnetv2");
    });

    const ctx = (model?: string) => ({ ...nodeCtx(undefined, model ? { model } : {}) });

    it("falls back on MediaUnsupportedError and library errors, and says so", async () => {
        const c = ctx();
        const r = await withFfmpegFallback(c, "doing x", async () => { throw new MediaUnsupportedError("this browser cannot decode wmv2 video"); }, async () => "ff");
        expect(r).toBe("ff");
        expect(c.rec.progress.at(-1)?.message).toBe("this browser cannot decode wmv2 video: falling back to ffmpeg.wasm for doing x");
        const c2 = ctx();
        expect(await withFfmpegFallback(c2, "doing x", async () => { throw new TypeError("demuxer exploded"); }, async () => "ff")).toBe("ff");
    });

    it("does not fall back on its own answers (EdgeError) or a cancel", async () => {
        await expect(withFfmpegFallback(ctx(), "x", async () => { throw new EdgeError("this file has no audio track"); }, async () => "ff")).rejects.toThrow(
            "this file has no audio track",
        );
        const ac = new AbortController();
        ac.abort();
        const c = nodeCtx(ac.signal);
        await expect(withFfmpegFallback(c, "x", async () => { throw new DOMException("Aborted", "AbortError"); }, async () => "ff")).rejects.toThrow("Aborted");
    });

    it("forced: the browser path is not tried; both failing reports both", async () => {
        const c = ctx("ffmpeg-wasm");
        let tried = false;
        expect(await withFfmpegFallback(c, "x", async () => ((tried = true), "browser"), async () => "ff")).toBe("ff");
        expect(tried).toBe(false);
        expect(c.rec.progress[0]?.message).toBe("x with ffmpeg.wasm (selected implementation)");
        await expect(
            withFfmpegFallback(ctx(), "x", async () => { throw new MediaUnsupportedError("no AVI demuxer"); }, async () => { throw new EdgeError("core not hosted"); }),
        ).rejects.toThrow("no AVI demuxer; the ffmpeg.wasm fallback failed too: core not hosted");
    });
});

describe("ffprobe output", () => {
    it("reads streams, frame rate and duration from ffmpeg's input dump (real core output)", () => {
        const p = parseProbe([
            "Input #0, avi, from '/w/in0.avi':",
            "  Metadata:",
            "    software        : Lavf63.1.101",
            "  Duration: 00:00:01.60, start: 0.000000, bitrate: 140 kb/s",
            "  Stream #0:0: Video: mpeg4 (Simple Profile) (xvid / 0x64697678), yuv420p, 160x120 [SAR 1:1 DAR 4:3], 25 fps, 25 tbr, 25 tbn",
            "  Stream #0:1: Audio: mp3 (U[0][0][0] / 0x0055), 22050 Hz, mono, fltp, 64 kb/s",
            "At least one output file must be specified",
        ]);
        expect(p).toMatchObject({ duration: 1.6, format: "avi", video: { codec: "mpeg4", width: 160, height: 120, fps: 25 }, audio: { codec: "mp3", sampleRate: 22050, channels: 1 } });
        const m = parseProbe([
            "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/w/in0.m4a':",
            "  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s",
            "  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)",
            "  Stream #0:1[0x0]: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500, 90k tbr, 90k tbn (attached pic)",
        ]);
        expect(m).toMatchObject({ duration: 3723.5, audio: { codec: "aac", channels: 2, sampleRate: 44100 } });
        expect(m.video).toBeUndefined(); // cover art is not a video
        expect(() => parseProbe(["/w/in0.bin: Invalid data found when processing input"])).toThrow(/no readable streams/);
    });

    it("names inputs by their extension (a demuxer hint), never by the user's file name", () => {
        expect(inputName("家庭录像 (1).AVI")).toBe("in0.avi");
        expect(inputName("clip.wmv", 2)).toBe("in2.wmv");
        expect(inputName(undefined)).toBe("in0.bin");
        expect(inputName("weird.name.with.dots.toolongext")).toBe("in0.bin");
    });
});

describe("Mediabunny cannot demux the exotic fixtures (so the fallback tests mean something)", () => {
    it.each(["talk.avi", "talk.wmv", "hello-zh.wma"])("%s", async (name) => {
        const mb = await import("mediabunny");
        const input = new mb.Input({ source: new mb.BufferSource(readFileSync(new URL(`test/fixtures/media/${name}`, root))), formats: mb.ALL_FORMATS });
        await expect(input.getPrimaryAudioTrack()).rejects.toThrow();
        input.dispose();
    });

    it("talk-mpeg2.m2t demuxes, but neither MPEG-2 video nor MP2 audio is a codec Mediabunny can hand to WebCodecs", async () => {
        const mb = await import("mediabunny");
        const input = new mb.Input({ source: new mb.BufferSource(readFileSync(new URL("test/fixtures/media/talk-mpeg2.m2t", root))), formats: mb.ALL_FORMATS });
        const v = await input.getPrimaryVideoTrack();
        expect(v?.codec ?? null).toBeNull();
        input.dispose();
    });

    it("extract-audio in Node: the AVI falls back to ffmpeg, and without a hosted core the node fails with both reasons", async () => {
        const out = await impls.extractAudio({ video: await fixture("media/talk.avi", "video/x-msvideo") }, { ...nodeCtx(), modelBase: "file:///nonexistent-models/" });
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/^the browser cannot read this file .*; the ffmpeg.wasm fallback failed too: could not download model npm\/@ffmpeg\/core@0\.12\.10\/dist\/esm\/ffmpeg-core\.(js|wasm)/);
    });
});

describe("manifest, ABI and models.json", () => {
    const manifest = json("tongflow.plugin.json") as { slots: { nodeSlot: string; method: string; models?: string[] }[] };

    it("the media slots exist in the ABI with the fields the implementation reads and writes", () => {
        const byId = new Map(abi.nodes.map((n) => [n.nodeSlot, n]));
        const io: Record<(typeof MEDIA)[number], [string[], string]> = {
            "extract-audio": [["video"], "audio"],
            "get-first-frame": [["video"], "image"],
            "get-last-frame": [["video"], "image"],
            "concat-videos": [["videos"], "video"],
            "remove-video-audio": [["video"], "video"],
            "merge-video-audio": [["video", "audio"], "video"],
        };
        for (const slot of MEDIA) {
            const n = byId.get(slot);
            expect(n, slot).toBeDefined();
            const [ins, out] = io[slot];
            expect(Object.keys(n!.inputs.properties).sort(), slot).toEqual([...ins].sort());
            expect(Object.keys(n!.outputs.properties).sort(), slot).toEqual(["error", out, "success"].sort());
        }
    });

    it("every media slot: one manifest entry, browser default first, ffmpeg-wasm selectable, wired to a method", () => {
        for (const slot of MEDIA) {
            const entries = manifest.slots.filter((s) => s.nodeSlot === slot);
            expect(entries, slot).toHaveLength(1);
            expect(entries[0]!.models).toEqual(["mediabunny", "ffmpeg-wasm"]);
            expect(slots[slot]).toBe(entries[0]!.method);
            expect(typeof methods[entries[0]!.method as keyof typeof methods]).toBe("function");
        }
        for (const [slot, model] of [
            ["transcribe", "sensevoice-small"],
            ["vad-segment", "silero-vad-v5"],
            ["diarize-speakers", "pyannote-campplus-zh"],
            ["audio-tag", "ced-tiny"],
            ["split-video", "transnetv2"],
        ]) {
            expect(manifest.slots.find((s) => s.nodeSlot === slot)!.models).toEqual([model, `${model}+ffmpeg-wasm`]);
        }
    });

    it("models.json registers the core like a model: npm source, checksums, GPL license and corresponding source", () => {
        const entry = (json("models.json") as Record<string, any>[]).find((m) => m.id === "ffmpeg-wasm")!;
        expect(entry.source).toBe(`npm:@ffmpeg/core@${FFMPEG_CORE_VERSION}`);
        expect(FFMPEG_CORE.repo).toBe(`npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}`);
        const files = Object.values(FFMPEG_CORE.files);
        expect(entry.files).toEqual(files.map((f) => f.path));
        expect(entry.checksums).toEqual(Object.fromEntries(files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }])));
        expect(Math.abs(entry.approxMB - files.reduce((a, f) => a + f.size, 0) / 1e6)).toBeLessThan(0.1);
        expect(entry.license).toBe("GPL-2.0-or-later");
        expect(entry.corresponding_source.commit).toMatch(/^[0-9a-f]{40}$/);
        for (const f of entry.licenseFiles) expect(readFileSync(new URL(f, root), "utf8").length).toBeGreaterThan(1000);
        expect(readFileSync(new URL("licenses/GPL-2.0.txt", root), "utf8")).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/);
        // Every slot that can run ffmpeg says so, so the hosting side knows who needs the core.
        expect(new Set(entry.slots)).toEqual(new Set([...MEDIA, "split-video", "transcribe", "vad-segment", "diarize-speakers", "audio-tag"]));
    });

    it("the registered checksums are the pinned npm package's bytes", () => {
        const pkg = json("node_modules/@ffmpeg/core/package.json");
        expect(pkg.version).toBe(FFMPEG_CORE_VERSION);
        for (const f of Object.values(FFMPEG_CORE.files)) {
            const bytes = readFileSync(new URL(`node_modules/@ffmpeg/core/${f.path}`, root));
            expect(bytes.byteLength, f.path).toBe(f.size);
            expect(createHash("sha256").update(bytes).digest("hex"), f.path).toBe(f.sha256);
        }
    });

    it("the core is not bundled into dist/", () => {
        expect(JSON.stringify(json("package.json").dependencies)).not.toContain("@ffmpeg");
    });
});
