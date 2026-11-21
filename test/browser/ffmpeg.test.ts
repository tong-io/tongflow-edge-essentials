// Media slots in Chromium, through the built plugin worker. The browser path
// (Mediabunny stream copy) always runs; the ffmpeg.wasm fallback runs only with
// EDGE_MODELS_DIR set, which must hold the core at npm/@ffmpeg/core@0.12.10/dist/esm/
// (served at /models/, the plugin's default model base). Fixtures: test/fixtures/media/
// (scripts/gen-media-fixtures.mjs): every video is 0.6 s red, then 0.9 s blue, 160x120.
import * as mb from "mediabunny";
import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { call, type CallResult, fixture, fromBase64, meanColor, pluginWorker } from "./harness.js";

const media = (name: string, mime?: string) => fixture(`media/${name}`, mime);

async function inspect(b64: string) {
    const input = new mb.Input({ source: new mb.BufferSource(fromBase64(b64)), formats: mb.ALL_FORMATS });
    try {
        const v = await input.getPrimaryVideoTrack();
        const a = await input.getPrimaryAudioTrack();
        return {
            format: (await input.getFormat()).name,
            duration: await input.computeDuration(),
            video: v ? { codec: v.codec, width: v.displayWidth, height: v.displayHeight } : null,
            audio: a ? { codec: a.codec } : null,
        };
    } finally {
        input.dispose();
    }
}

const usedFfmpeg = (r: CallResult) => r.progress.some((p) => /ffmpeg\.wasm/.test(p.message));
const isRed = (c: { r: number; g: number; b: number }) => c.r > 180 && c.b < 80 && c.g < 80;
const isBlue = (c: { r: number; g: number; b: number }) => c.b > 180 && c.r < 80 && c.g < 80;
async function color(r: CallResult) {
    expect(r.out.error).toBeUndefined();
    expect(r.out.image.mime).toBe("image/png");
    return meanColor(fromBase64(r.out.image.bytesBase64), "image/png");
}

describe("media slots on the browser path (Mediabunny stream copy, no ffmpeg)", () => {
    it("concat-videos: two matching H.264/AAC MP4s → one MP4 by stream copy", async () => {
        const r = await call("concatVideos", { videos: [await media("red-blue.mp4", "video/mp4"), await media("green-yellow.mp4", "video/mp4")] });
        expect(r.out.error).toBeUndefined();
        expect(Object.keys(r.out).sort()).toEqual(["success", "video"]);
        expect(r.out.video).toMatchObject({ mime: "video/mp4", filename: "red-blue-concat.mp4" });
        expect(usedFfmpeg(r)).toBe(false);
        const info = await inspect(r.out.video.bytesBase64);
        expect(info).toMatchObject({ video: { codec: "avc", width: 160, height: 120 }, audio: { codec: "aac" } });
        expect(info.duration).toBeGreaterThan(2.6); // 1.5 s + 1.2 s
        expect(info.duration).toBeLessThan(2.9);
        await commands.writeFile("test-results/concat-copy.mp4.b64", r.out.video.bytesBase64);
    });

    it("remove-video-audio: H.264 copied into a silent MP4", async () => {
        const r = await call("removeVideoAudio", { video: await media("red-blue.mp4", "video/mp4") });
        expect(r.out.error).toBeUndefined();
        expect(r.out.video).toMatchObject({ mime: "video/mp4", filename: "red-blue-noaudio.mp4" });
        expect(usedFfmpeg(r)).toBe(false);
        const info = await inspect(r.out.video.bytesBase64);
        expect(info.video).toEqual({ codec: "avc", width: 160, height: 120 });
        expect(info.audio).toBeNull();
        expect(info.duration).toBeGreaterThan(1.4);
    });

    it("merge-video-audio: video copied, AAC audio copied, cut to the shorter stream (-shortest)", async () => {
        // green-yellow.mp4 (1.2 s) as the video, red-blue.mp4's AAC (1.49 s) as the audio.
        const r = await call("mergeVideoAudio", { video: await media("video-only.mp4", "video/mp4"), audio: await media("green-yellow.mp4", "video/mp4") });
        expect(r.out.error).toBeUndefined();
        expect(r.out.video).toMatchObject({ mime: "video/mp4", filename: "video-only-merged.mp4" });
        expect(usedFfmpeg(r)).toBe(false);
        const info = await inspect(r.out.video.bytesBase64);
        expect(info).toMatchObject({ video: { codec: "avc", width: 160, height: 120 }, audio: { codec: "aac" } });
        expect(info.duration).toBeGreaterThan(1.1);
        expect(info.duration).toBeLessThan(1.35);
    });

    it("get-first-frame / get-last-frame: red, then blue (when this Chromium decodes H.264)", async () => {
        const first = await call("getFirstFrame", { video: await media("red-blue.mp4", "video/mp4") });
        if (usedFfmpeg(first)) {
            console.warn("H.264 decode unavailable in this Chromium; the frames came from ffmpeg.wasm or failed:", first.out.error);
            return;
        }
        expect(isRed(await color(first))).toBe(true);
        const last = await call("getLastFrame", { video: await media("red-blue.mp4", "video/mp4") });
        expect(last.out.image.filename).toBe("red-blue-last.png");
        expect(isBlue(await color(last))).toBe(true);
        expect(usedFfmpeg(last)).toBe(false);
    });

    it("get-last-frame on VP9 WebM (the frame shown at the end)", async () => {
        const r = await call("getLastFrame", { video: await fixture("clip.webm", "video/webm") });
        expect(r.out.error).toBeUndefined();
        expect(r.out.image.filename).toBe("clip-last.png");
        const c = await color(r);
        expect(c.r + c.g + c.b).toBeGreaterThan(60);
    });

    it("input errors are node failures, not fallbacks", async () => {
        const empty = await call("concatVideos", { videos: [] });
        expect(empty.out).toEqual({ success: false, error: "missing videos: expected a non-empty Asset[]" });
        const silent = await call("mergeVideoAudio", { video: await media("red-blue.mp4"), audio: await fixture("silent.webm") });
        expect(silent.out).toEqual({ success: false, error: "the audio input has no audio track" });
    });
});

declare const __EDGE_MODELS__: string;
const haveModels = Boolean(__EDGE_MODELS__);
if (!haveModels) console.warn("[ffmpeg] EDGE_MODELS_DIR is not set: skipping the ffmpeg.wasm tests");

describe.skipIf(!haveModels)("ffmpeg.wasm fallback and selection (core from EDGE_MODELS_DIR)", () => {
    const timings: string[] = [];
    const time = async <T>(label: string, f: () => Promise<T>) => {
        const t = performance.now();
        const v = await f();
        timings.push(`${label}: ${Math.round(performance.now() - t)} ms`);
        console.warn(`[ffmpeg] ${timings.at(-1)}`);
        return v;
    };
    // Kept for the record: test-results/ is gitignored.
    afterAll(() => commands.writeFile("test-results/ffmpeg-timings.txt", `${timings.join("\n")}\n`));
    const fellBack = (r: CallResult) => r.progress.some((p) => /falling back to ffmpeg\.wasm/.test(p.message));

    it("extract-audio: AVI (MPEG-4 Part 2 + MP3) → MP3 by stream copy; the core download is reported", async () => {
        const r = await time("extract-audio talk.avi (first ffmpeg use)", async () => call("extractAudio", { video: await media("talk.avi", "video/x-msvideo") }));
        expect(r.out.error).toBeUndefined();
        expect(r.out.audio).toMatchObject({ mime: "audio/mpeg", filename: "talk.mp3" });
        expect(fellBack(r)).toBe(true);
        expect(r.progress.find((p) => /falling back/.test(p.message))!.message).toMatch(/^the browser cannot read this file .*: falling back to ffmpeg\.wasm for extracting audio$/);
        const files = new Set(r.downloads.map((d) => d.file));
        expect(files).toContain("npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm");
        expect(files).toContain("npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js");
        expect(r.downloads.filter((d) => d.file?.endsWith(".wasm")).at(-1)!.loaded).toBe(32232419);
        const ac = new OfflineAudioContext(1, 48000, 48000);
        const buf = await ac.decodeAudioData(fromBase64(r.out.audio.bytesBase64).buffer as ArrayBuffer);
        expect(buf.duration).toBeGreaterThan(1.3);
    });

    it("extract-audio: WMV (WMA2) → MP3 transcoded (libmp3lame), decodable by the browser", async () => {
        const r = await time("extract-audio talk.wmv", async () => call("extractAudio", { video: await media("talk.wmv") }));
        expect(r.out.error).toBeUndefined();
        expect(r.out.audio).toMatchObject({ mime: "audio/mpeg", filename: "talk.mp3" });
        const ac = new OfflineAudioContext(1, 48000, 48000);
        const buf = await ac.decodeAudioData(fromBase64(r.out.audio.bytesBase64).buffer as ArrayBuffer);
        expect(buf.duration).toBeGreaterThan(1.3);
    });

    it.each([
        ["talk.avi", "demux"],
        ["talk.wmv", "demux"],
        ["talk-mpeg2.m2t", "decode"],
    ])("get-first-frame / get-last-frame: %s (browser cannot %s) → red / blue PNG", async (name) => {
        const first = await time(`first frame ${name}`, async () => call("getFirstFrame", { video: await media(name) }));
        expect(fellBack(first)).toBe(true);
        expect(first.out.image.filename).toBe(`${name.replace(/\.[^.]+$/, "")}-first.png`);
        expect(isRed(await color(first))).toBe(true);
        const last = await time(`last frame ${name}`, async () => call("getLastFrame", { video: await media(name) }));
        expect(fellBack(last)).toBe(true);
        expect(isBlue(await color(last))).toBe(true);
    });

    it("MPEG-TS: Mediabunny drops the MPEG-2 video stream, which is a reason to ask ffmpeg, not \"no video track\"", async () => {
        const r = await call("getFirstFrame", { video: await media("talk-mpeg2.m2t") });
        expect(r.progress.find((p) => /falling back/.test(p.message))!.message).toBe(
            "the browser found no video track it can read in this file (MPEG Transport Stream): falling back to ffmpeg.wasm for getting the first frame",
        );
    });

    it("换实现: model ffmpeg-wasm forces ffmpeg on a file the browser handles", async () => {
        const r = await call("extractAudio", { video: await fixture("clip.webm", "video/webm") }, { model: "ffmpeg-wasm" });
        expect(r.out.error).toBeUndefined();
        expect(r.progress[0]!.message).toBe("extracting audio with ffmpeg.wasm (selected implementation)");
        expect(fellBack(r)).toBe(false);
        expect(r.out.audio).toMatchObject({ mime: "audio/webm", filename: "clip.webm" }); // Opus copied
        const f = await call("getLastFrame", { video: await fixture("clip.webm", "video/webm") }, { model: "ffmpeg-wasm" });
        expect(f.out.error).toBeUndefined();
        expect(f.progress[0]!.message).toBe("getting the last frame with ffmpeg.wasm (selected implementation)");
    });

    it("remove-video-audio: AVI → MPEG-4 Part 2 copied into MP4; WMV → H.264 (WMV2 cannot go into MP4)", async () => {
        const a = await time("remove audio talk.avi", async () => call("removeVideoAudio", { video: await media("talk.avi") }));
        expect(a.out.error).toBeUndefined();
        expect(a.out.video).toMatchObject({ mime: "video/mp4", filename: "talk-noaudio.mp4" });
        const ai = await inspect(a.out.video.bytesBase64);
        expect(ai.format).toBe("MP4");
        expect(ai.audio).toBeNull();
        expect(ai.video).not.toBeNull();
        const w = await time("remove audio talk.wmv", async () => call("removeVideoAudio", { video: await media("talk.wmv") }));
        expect(w.out.error).toBeUndefined();
        const wi = await inspect(w.out.video.bytesBase64);
        expect(wi).toMatchObject({ video: { codec: "avc", width: 160, height: 120 }, audio: null });
        expect(w.progress.some((p) => /re-encoding the video to H\.264/.test(p.message))).toBe(true);
    });

    it("merge-video-audio: WMV video + MP3 → MP4 (H.264 + AAC, -shortest)", async () => {
        const r = await time("merge talk.wmv + speech.mp3", async () => call("mergeVideoAudio", { video: await media("talk.wmv"), audio: await media("speech.mp3", "audio/mpeg") }));
        expect(r.out.error).toBeUndefined();
        expect(fellBack(r)).toBe(true);
        const info = await inspect(r.out.video.bytesBase64);
        expect(info).toMatchObject({ format: "MP4", video: { codec: "avc" }, audio: { codec: "aac" } });
        expect(info.duration).toBeGreaterThan(1.3);
        expect(info.duration).toBeLessThan(1.7);
    });

    it("concat-videos: different sizes → re-encoded by ffmpeg to H.264/AAC at the largest size", async () => {
        const r = await time("concat 160x120 + 240x136", async () =>
            call("concatVideos", { videos: [await media("red-blue.mp4", "video/mp4"), await media("red-blue-240.mp4", "video/mp4")] }),
        );
        expect(r.out.error).toBeUndefined();
        expect(r.progress.find((p) => /falling back/.test(p.message))!.message).toMatch(/video 2 differs from video 1 in video codec, size or setup/);
        const info = await inspect(r.out.video.bytesBase64);
        expect(info).toMatchObject({ format: "MP4", video: { codec: "avc", width: 240, height: 136 }, audio: { codec: "aac" } });
        expect(info.duration).toBeGreaterThan(2.8);
        expect(info.duration).toBeLessThan(3.3);
        await commands.writeFile("test-results/concat-reencode.mp4.b64", r.out.video.bytesBase64);
    });

    it("concat-videos: AVI + WMV (nothing the browser can demux) → one MP4", async () => {
        const r = await time("concat talk.avi + talk.wmv", async () => call("concatVideos", { videos: [await media("talk.avi"), await media("talk.wmv")] }));
        expect(r.out.error).toBeUndefined();
        const info = await inspect(r.out.video.bytesBase64);
        expect(info).toMatchObject({ video: { codec: "avc", width: 160, height: 120 }, audio: { codec: "aac" } });
        expect(info.duration).toBeGreaterThan(2.9);
    });

    it("transcribe: WMA speech decoded by ffmpeg, then SenseVoice", async () => {
        const r = await time("transcribe hello-zh.wma", async () => call("transcribe", { audio: await media("hello-zh.wma", "audio/x-ms-wma") }));
        expect(r.out.error).toBeUndefined();
        expect(fellBack(r)).toBe(true);
        expect(r.out.text).toMatch(/你好/);
        // The same speech as WAV through the browser path gives the same text.
        const wav = await call("transcribe", { audio: await fixture("audio/hello-zh.wav", "audio/wav") });
        expect(r.out.text).toBe(wav.out.text);
        // 换实现: sensevoice-small+ffmpeg-wasm decodes even a WAV with ffmpeg.
        const forced = await call("transcribe", { audio: await fixture("audio/hello-zh.wav", "audio/wav") }, { model: "sensevoice-small+ffmpeg-wasm" });
        expect(forced.progress.some((p) => p.message === "decoding audio with ffmpeg.wasm (selected implementation)")).toBe(true);
        expect(forced.out.text).toBe(wav.out.text);
    });

    it("transcribe: AMR-NB (only when test/fixtures/media/hello-zh.amr was generated)", async (t) => {
        const res = await fetch("/test/fixtures/media/hello-zh.amr");
        if (!res.ok) {
            console.warn("[ffmpeg] hello-zh.amr not generated (no AMR-NB encoder in the fixture machine's ffmpeg): skipped");
            t.skip();
            return;
        }
        const r = await call("transcribe", { audio: await media("hello-zh.amr", "audio/amr") });
        expect(r.out.error).toBeUndefined();
        expect(fellBack(r)).toBe(true);
        expect(r.out.text).toMatch(/你好/);
    });

    it("vad-segment and audio-tag decode WMA through the fallback too", async () => {
        const v = await call("vadSegment", { audio: await media("hello-zh.wma") });
        expect(v.out.error).toBeUndefined();
        expect(v.out.segments.length).toBeGreaterThan(0);
        expect(fellBack(v)).toBe(true);
        const t = await call("audioTag", { audio: await media("hello-zh.wma") });
        expect(t.out.error).toBeUndefined();
        expect(JSON.parse(t.out.tags)[0].label).toMatch(/Speech/);
    });

    it("split-video: AVI → TransNetV2 on ffmpeg frames → 2 MP4 shots at the red/blue cut", async () => {
        const r = await time("split-video talk.avi", async () => call("splitVideo", { video: await media("talk.avi") }));
        expect(r.out.error).toBeUndefined();
        expect(fellBack(r)).toBe(true);
        expect(r.out.video_parts.map((p: { filename: string }) => p.filename)).toEqual(["talk-shot1.mp4", "talk-shot2.mp4"]);
        const [a, b] = await Promise.all(r.out.video_parts.map((p: { bytesBase64: string }) => inspect(p.bytesBase64)));
        expect(a.duration).toBeGreaterThan(0.45);
        expect(a.duration).toBeLessThan(0.8);
        expect(b.duration).toBeGreaterThan(0.75);
        expect(r.progress.some((p) => /shots \(transnetv2, ffmpeg\.wasm\)/.test(p.message))).toBe(true);
    });

    it("cancelling a running ffmpeg job rejects it, and the next job starts a fresh core", async () => {
        await pluginWorker().ready;
        const cancelled = call("concatVideos", { videos: [await media("talk.avi"), await media("talk.wmv"), await media("talk.avi")] }, {
            cancelOn: (m) => m.type === "progress" && /re-encoding|concatenating \(ffmpeg/.test(m.message ?? ""),
        });
        await expect(cancelled).rejects.toThrow();
        const after = await call("getFirstFrame", { video: await media("talk.avi") });
        expect(after.out.error).toBeUndefined();
    });
});
