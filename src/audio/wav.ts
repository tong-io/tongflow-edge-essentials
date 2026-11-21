/** 16-bit PCM mono WAV (RIFF) encoder for audio segments. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
    const dataBytes = samples.length * 2;
    const out = new Uint8Array(44 + dataBytes);
    const v = new DataView(out.buffer);
    const ascii = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
    };
    ascii(0, "RIFF");
    v.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    ascii(36, "data");
    v.setUint32(40, dataBytes, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return out;
}
