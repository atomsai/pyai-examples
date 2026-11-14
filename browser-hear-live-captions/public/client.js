export function captureContext(AudioContext) {
  const context = new AudioContext({ sampleRate: 16000 });
  if (context.sampleRate !== 16000) {
    context.close();
    throw new Error("This browser did not provide 16 kHz capture. Use a supported browser or add an anti-aliasing resampler before connecting.");
  }
  return context;
}

export function applyTranscript(finals, msg) {
  const text = (msg.text ?? "").trim();
  if (msg.type === "final") {
    if (text) finals.set(msg.utterance_id, text);
    return "";
  }
  if (["partial", "partial_stable", "speech_final"].includes(msg.type)) return text;
  return null;
}
