/** Native browser output is PCM16 little-endian, mono, 24 kHz. The engine's
 * string hello is the authoritative declaration; absent channel fields mean
 * the native mono contract, not an inferred device or receipt-segment rate. */
export class OmniBrowserAudioContract {
  ready = false;
  reset() { this.ready = false; }
  /** @param {Record<string, unknown>} frame */
  control(frame) {
    if (!["hello", "configured", "audio_segment_start"].includes(String(frame.event))) return true;
    let valid = true;
    for (const [key, expected] of Object.entries({
      format: "pcm16", audio_format: "pcm16", audio_out_format: "pcm16",
      sample_rate: 24000, audio_out_sample_rate: 24000,
      channels: 1, audio_channels: 1, audio_out_channels: 1,
    })) {
      if (key in frame && frame[key] !== expected) valid = false;
    }
    if ("audio_in" in frame && frame.audio_in !== "pcm16@24000") valid = false;
    if ("audio_out" in frame && frame.audio_out !== "pcm16@24000") valid = false;
    if (frame.event === "hello") valid = valid && frame.audio_out === "pcm16@24000";
    else valid = valid && this.ready;
    if (frame.event === "audio_segment_start") valid = valid && frame.sample_rate === 24000;
    if (!valid) { this.reset(); return false; }
    if (frame.event === "hello") this.ready = true;
    return true;
  }
  /** @param {number} byteLength */
  pcm(byteLength) {
    return this.ready && Number.isSafeInteger(byteLength) && byteLength > 0 && byteLength % 2 === 0;
  }
}
