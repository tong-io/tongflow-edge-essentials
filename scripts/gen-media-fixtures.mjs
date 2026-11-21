#!/usr/bin/env node
// Regenerate test/fixtures/media/: real files in the containers and codecs the browser
// cannot handle (for the ffmpeg.wasm fallback tests) plus MP4s for concat / merge.
// Needs `ffmpeg` on PATH; the files are committed, so the tests need nothing.
//
//   npm run fixtures:media
//
// Every video is 160x120: 0.6 s solid red, then 0.9 s solid blue (first frame red,
// last frame blue), with the spoken test/fixtures/audio/hello-zh.wav as its audio.
// AMR-NB needs an encoder Homebrew's ffmpeg lacks (libopencore_amrnb); with one,
// `hello-zh.amr` is written too and the AMR test runs, otherwise it is skipped.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test/fixtures/media");
mkdirSync(out, { recursive: true });
const speech = join(root, "test/fixtures/audio/hello-zh.wav");
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: out });

/** Red then blue, `size`, 25 fps, 1.5 s. */
const redBlue = (size = "160x120") => [
    "-f", "lavfi", "-i", `color=c=red:s=${size}:r=25:d=0.6`,
    "-f", "lavfi", "-i", `color=c=blue:s=${size}:r=25:d=0.9`,
    "-i", speech,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "2:a",
];

// AVI: MPEG-4 Part 2 (Xvid tag) + MP3. Mediabunny has no AVI demuxer.
ff([...redBlue(), "-c:v", "mpeg4", "-vtag", "xvid", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "64k", "talk.avi"]);
// WMV (ASF): WMV2 + WMA2. No ASF demuxer, no WMV/WMA decoder in WebCodecs.
ff([...redBlue(), "-c:v", "wmv2", "-b:v", "300k", "-c:a", "wmav2", "-b:a", "64k", "talk.wmv"]);
// MPEG-TS (.m2t, not .ts: that is TypeScript to the tooling): MPEG-2 video + MP2. Mediabunny demuxes TS, but WebCodecs decodes neither codec.
ff([...redBlue(), "-c:v", "mpeg2video", "-q:v", "4", "-c:a", "mp2", "-b:a", "64k", "-f", "mpegts", "talk-mpeg2.m2t"]);
// WMA audio only: the speech, for transcribe / vad / diarize / tag decoding.
ff(["-i", speech, "-c:a", "wmav2", "-b:a", "64k", "hello-zh.wma"]);
try {
    ff(["-i", speech, "-ar", "8000", "-ac", "1", "-c:a", "libopencore_amrnb", "-b:a", "12.2k", "hello-zh.amr"]);
} catch {
    console.warn("no AMR-NB encoder (libopencore_amrnb) in this ffmpeg: hello-zh.amr not written");
}

// H.264 + AAC MP4s with identical encoder settings (concat by stream copy), red/blue
// and green/yellow, and a 240x136 one (concat must re-encode to one size).
const x264 = ["-c:v", "libx264", "-preset", "medium", "-g", "25", "-bf", "0", "-c:a", "aac", "-ar", "44100", "-ac", "1", "-b:a", "64k", "-shortest", "-movflags", "+faststart"];
ff([...redBlue(), ...x264, "red-blue.mp4"]);
ff([
    "-f", "lavfi", "-i", "color=c=green:s=160x120:r=25:d=0.6",
    "-f", "lavfi", "-i", "color=c=yellow:s=160x120:r=25:d=0.6",
    "-i", speech,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "2:a", ...x264, "green-yellow.mp4",
]);
ff([...redBlue("240x136"), ...x264, "red-blue-240.mp4"]);
// Video only (for merge-video-audio) and MP3 audio only.
ff([...redBlue(), "-an", "-c:v", "libx264", "-g", "25", "-bf", "0", "-movflags", "+faststart", "-map", "-2:a", "video-only.mp4"]);
ff(["-i", speech, "-c:a", "libmp3lame", "-b:a", "64k", "speech.mp3"]);
console.log("media fixtures written to", out);
