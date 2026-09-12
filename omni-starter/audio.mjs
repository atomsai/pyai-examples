// Small, strict WAV boundary: the wire receives samples, never WAV headers.
export function readWav(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Expected a PCM16 mono WAV file");
  const end = b.readUInt32LE(4) + 8;
  if (end > b.length) throw new Error("Truncated WAV file");
  let rate, data;
  for (let at = 12; at + 8 <= end;) {
    const name = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > end) throw new Error("Truncated WAV chunk");
    if (name === "fmt ") {
      if (size < 16 || b.readUInt16LE(start) !== 1 || b.readUInt16LE(start + 2) !== 1 || b.readUInt16LE(start + 14) !== 16) throw new Error("Convert input to PCM16 mono WAV first");
      rate = b.readUInt32LE(start + 4);
    } else if (name === "data") data = b.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (rate !== 24000 || !data?.length || data.length % 2 || data.length > rate * 2 * 20) throw new Error("Use a non-empty 24 kHz PCM16 mono WAV, at most 20 seconds");
  return Int16Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2));
}

export function writeWav(chunks, rate) {
  const samples = chunks.reduce((n, pcm) => n + pcm.length, 0);
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  let at = 44;
  for (const pcm of chunks) for (const value of pcm) { b.writeInt16LE(value, at); at += 2; }
  return b;
}

export function assessAnswer(report, capturedTranscript) {
  // This checks this example's fixture, not general speech correctness.
  const text = String(capturedTranscript ?? "").toLowerCase();
  const expected = /\boffice\b/.test(text) && /\b(?:nine|9)\b/.test(text)
    && /\bopen(?:s|ing)?\b/.test(text) && /\b(?:a\.?\s*m\.?|morning)\b/.test(text);
  return {
    audio_received: report.reply_audio_bytes > 0,
    captured_answer: report.end_reason === "quiet_window" && report.tool_executions === 1 && expected ? "verified_by_hear" : "not_verified",
    capture_boundary: "bounded_quiet_window_no_protocol_reply_end",
    physical_playback: "not_tested",
    interruption: report.interruption_requested ? (report.flushes_after_interruption > 0 && report.cleared_queue_ms > 0 ? "simulated_queue_cleared" : "not_verified") : "not_tested",
  };
}
