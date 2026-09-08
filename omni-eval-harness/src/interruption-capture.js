// Opt-in instrumentation for the interruption pack. No model/VAD attribution:
// energy windows and client-monotonic timestamps are observations only.
import { createHash } from "node:crypto";

export const INTERRUPTION_LIMITS = Object.freeze({ maxDurationMs: 120000,
  maxPackets: 12000, maxFrames: 6000, maxSegments: 12, energyWindowMs: 10, rmsFloor: 160,
  earlyFrameToleranceMs: 2 });
const sha256 = (pcm) => createHash("sha256").update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest("hex");

export function energyIntervals(pcm, rate, atMs) {
  const intervals = [];
  const width = Math.max(1, Math.round(rate / 100));
  for (let off = 0; off < pcm.length; off += width) {
    const end = Math.min(off + width, pcm.length);
    let energy = 0;
    for (let i = off; i < end; i++) energy += pcm[i] ** 2;
    if (Math.sqrt(energy / (end - off)) < INTERRUPTION_LIMITS.rmsFloor) continue;
    const from = atMs + off / rate * 1000;
    const to = atMs + end / rate * 1000;
    const last = intervals.at(-1);
    if (last && Math.abs(last.endMs - from) < 0.001) last.endMs = to;
    else intervals.push({ startMs: from, endMs: to });
  }
  return intervals;
}

export async function prepareInterruptionCaller(segments, rate, synthesize) {
  if (![8000, 24000].includes(rate) || !Array.isArray(segments)
    || segments.length < 2 || segments.length > INTERRUPTION_LIMITS.maxSegments) {
    throw new Error("Invalid interruption caller plan");
  }
  const chunks = [];
  const layout = [];
  let samples = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (typeof segment?.text !== "string" || !segment.text.trim() || segment.text.length > 1000
      || !Number.isInteger(segment.pauseAfterMs) || segment.pauseAfterMs < 0 || segment.pauseAfterMs > 2000
      || (index === segments.length - 1 && segment.pauseAfterMs !== 0)) {
      throw new Error("Invalid interruption caller segment");
    }
    const pcm = await synthesize(segment.text);
    if (!(pcm instanceof Int16Array) || !pcm.length || !energyIntervals(pcm, rate, 0).length) {
      throw new Error("Interruption segment has no audible PCM");
    }
    const silenceSamples = Math.round(rate * segment.pauseAfterMs / 1000);
    if ((samples + pcm.length + silenceSamples) / rate * 1000 > INTERRUPTION_LIMITS.maxDurationMs) {
      throw new Error("Interruption caller exceeds capture duration");
    }
    layout.push({ index, startSample: samples, endSample: samples + pcm.length,
      pauseSamples: silenceSamples, pcmSha256: sha256(pcm) });
    // Preserve synthesized bytes, including their own leading/trailing silence.
    // Deliberate gaps are additional digital silence, not an inferred word edit.
    chunks.push(pcm.slice(), new Int16Array(silenceSamples));
    samples += pcm.length + silenceSamples;
  }
  const pcm = new Int16Array(samples);
  let at = 0;
  for (const chunk of chunks) { pcm.set(chunk, at); at += chunk.length; }
  return { pcm, layout, pcmSha256: sha256(pcm) };
}

export function newInterruptionCapture(inputRate) {
  const callerFrames = [];
  const agentPackets = [];
  const issues = [];
  const offsets = new Map();
  let lastAgentArrival = -Infinity;
  const issue = (code) => { if (!issues.includes(code)) issues.push(code); };
  return {
    callerFrame(pcm, atMs, turnIndex) {
      if (callerFrames.length >= INTERRUPTION_LIMITS.maxFrames) { issue("caller_frame_limit"); return; }
      if (!(pcm instanceof Int16Array) || !pcm.length || !Number.isFinite(atMs) || atMs < 0
        || atMs > INTERRUPTION_LIMITS.maxDurationMs) { issue("caller_frame_invalid"); return; }
      const sampleOffset = offsets.get(turnIndex) ?? 0;
      offsets.set(turnIndex, sampleOffset + pcm.length);
      callerFrames.push({ turnIndex, sampleOffset, samples: pcm.length, atMs,
        endMs: atMs + pcm.length / inputRate * 1000,
        energy: energyIntervals(pcm, inputRate, atMs) });
    },
    agentPacket(pcm, atMs, playbackAtMs, rate, turnIndex) {
      if (agentPackets.length >= INTERRUPTION_LIMITS.maxPackets) { issue("agent_packet_limit"); return; }
      if (!(pcm instanceof Int16Array) || !pcm.length || ![8000, 24000].includes(rate)
        || !Number.isFinite(atMs) || !Number.isFinite(playbackAtMs) || atMs < lastAgentArrival
        || atMs < 0 || atMs > INTERRUPTION_LIMITS.maxDurationMs || playbackAtMs < atMs
        || playbackAtMs + pcm.length / rate * 1000 > INTERRUPTION_LIMITS.maxDurationMs) {
        issue("agent_packet_invalid"); return;
      }
      lastAgentArrival = atMs;
      agentPackets.push({ sequence: agentPackets.length, turnIndex, atMs, playbackAtMs,
        endMs: playbackAtMs + pcm.length / rate * 1000, samples: pcm.length, rate,
        pcmSha256: sha256(pcm), energy: energyIntervals(pcm, rate, playbackAtMs) });
    },
    finish() {
      return { schema: "pyai.interruption-capture.v1", complete: issues.length === 0,
        issues: [...issues], inputRate, callerFrames, agentPackets,
        bounds: INTERRUPTION_LIMITS,
        method: "client-monotonic-all-packets-and-10ms-energy-windows",
        playback: "estimated-uninterrupted-FIFO; flush and barge_in cancellation is not simulated",
        limitation: "Packet receipt is observed; energy is not semantic speech detection and estimated playout is not device playback acknowledgement." };
    },
  };
}
