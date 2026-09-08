import { INTERRUPTION_LIMITS } from "./interruption-capture.js";

const finite = (n) => Number.isFinite(n) && n >= 0 && n <= INTERRUPTION_LIMITS.maxDurationMs;
const close = (a, b) => Math.abs(a - b) < 0.02;
const sha = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const total = (ranges) => ranges.reduce((n, r) => n + r.endMs - r.startMs, 0);
const rounded = (n) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;

function union(ranges) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    const last = result.at(-1);
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else result.push({ ...range });
  }
  return result;
}
function intersect(a, b) {
  const intersections = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    const startMs = Math.max(x.startMs, y.startMs), endMs = Math.min(x.endMs, y.endMs);
    if (endMs > startMs) intersections.push({ startMs, endMs });
    if (x.endMs <= y.endMs) i++;
    else j++;
  }
  return union(intersections);
}
function validEnergy(ranges, start, end) {
  if (!Array.isArray(ranges) || ranges.length > Math.ceil((end - start) / 10) + 1) return false;
  let previous = start;
  for (const r of ranges) {
    if (!finite(r?.startMs) || !finite(r?.endMs) || r.startMs < previous - 0.001
      || r.endMs <= r.startMs || r.endMs > end + 0.001) return false;
    previous = r.endMs;
  }
  return true;
}

function validateEvidence(run) {
  const c = run?.interruptionCapture;
  if (run?.captureIntegrity?.valid !== true) return "live_capture_invalid";
  if (c?.schema !== "pyai.interruption-capture.v1" || c.complete !== true
    || !Array.isArray(c.issues) || c.issues.length || ![8000, 24000].includes(c.inputRate)
    || c.method !== "client-monotonic-all-packets-and-10ms-energy-windows") return "packet_capture_missing_or_invalid";
  if (!Array.isArray(run.turns) || run.turns.length !== 1) return "turn_count_invalid";
  const t = run.turns[0];
  const frames = c.callerFrames, packets = c.agentPackets;
  if (!Array.isArray(frames) || !frames.length || frames.length > INTERRUPTION_LIMITS.maxFrames
    || !Array.isArray(packets) || !packets.length || packets.length > INTERRUPTION_LIMITS.maxPackets) return "packet_count_invalid";
  let sampleOffset = 0, previousEnd = null;
  for (const f of frames) {
    if (f.turnIndex !== 0 || !Number.isInteger(f.samples) || f.samples < 1 || f.samples > c.inputRate / 50
      || f.sampleOffset !== sampleOffset || !finite(f.atMs) || !finite(f.endMs)
      || !close(f.endMs, f.atMs + f.samples / c.inputRate * 1000)
      || (previousEnd != null && (f.atMs < previousEnd - INTERRUPTION_LIMITS.earlyFrameToleranceMs || f.atMs - previousEnd > 100))
      || !validEnergy(f.energy, f.atMs, f.endMs)) return "caller_timing_invalid";
    sampleOffset += f.samples;
    previousEnd = f.endMs;
  }
  const layout = t.callerAudioPlan?.layout;
  if (!Array.isArray(layout) || layout.length < 2 || layout.length > INTERRUPTION_LIMITS.maxSegments
    || !sha(t.callerAudioPlan.pcmSha256)) return "caller_layout_missing";
  let next = 0;
  for (let i = 0; i < layout.length; i++) {
    const s = layout[i];
    if (s.index !== i || s.startSample !== next || !Number.isSafeInteger(s.endSample) || s.endSample <= next
      || !Number.isSafeInteger(s.pauseSamples) || s.pauseSamples < 0 || s.pauseSamples > c.inputRate * 2
      || !sha(s.pcmSha256)) return "caller_layout_invalid";
    next = s.endSample + s.pauseSamples;
  }
  if (next !== sampleOffset || layout.at(-1).pauseSamples !== 0) return "caller_samples_incomplete";
  let previousAt = -Infinity, samples = 0, previousPlaybackEnd = -Infinity;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    if (p.sequence !== i || ![null, 0].includes(p.turnIndex) || ![8000, 24000].includes(p.rate)
      || p.rate !== run.captureMethod?.outputRate || !Number.isSafeInteger(p.samples) || p.samples < 1
      || !finite(p.atMs) || !finite(p.playbackAtMs) || !finite(p.endMs) || p.atMs < previousAt
      || p.playbackAtMs < p.atMs || !close(p.endMs, p.playbackAtMs + p.samples / p.rate * 1000)
      || (p.turnIndex === 0 && previousPlaybackEnd > p.playbackAtMs + 0.02)
      || !sha(p.pcmSha256) || !validEnergy(p.energy, p.playbackAtMs, p.endMs)) return "agent_timing_invalid";
    previousAt = p.atMs;
    if (p.turnIndex === 0) { samples += p.samples; previousPlaybackEnd = p.endMs; }
  }
  if (!Number.isFinite(t.agentAudioMs) || Math.abs(t.agentAudioMs - samples / run.captureMethod.outputRate * 1000) > 1) return "agent_samples_incomplete";
  if (!Array.isArray(t.engineCallerTranscriptEvents) || !t.engineCallerTranscriptEvents.length
    || t.engineCallerTranscriptEvents.length > 10000) return "engine_caller_transcript_missing";
  let assembled = "", transcriptAt = -Infinity;
  for (const e of t.engineCallerTranscriptEvents) {
    if (!finite(e?.atMs) || e.atMs < transcriptAt || typeof e.text !== "string" || e.text.length > 100000
      || !["delta", "replace"].includes(e.mode)) return "engine_caller_transcript_invalid";
    assembled = e.mode === "replace" ? e.text : assembled + e.text;
    transcriptAt = e.atMs;
  }
  if (assembled !== t.engineCallerText) return "engine_caller_transcript_rewritten";
  if (!Array.isArray(t.turnBegins) || !t.turnBegins.length
    || t.turnBegins.some(e => !finite(e?.atMs))) return "turn_begin_evidence_missing";
  return null;
}

/** Narrow timing and lexical checks, never a human/naturalness certification. */
export function scoreInterruptionRun(specification, run) {
  const checks = [];
  const check = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });
  const specificationValid = Array.isArray(specification?.criticalInput) && specification.criticalInput.length > 0
    && specification.criticalInput.length <= 12 && specification.criticalInput.every(item =>
      /^[a-z_]{1,64}$/.test(item?.id) && typeof item.pattern === "string" && item.pattern.length <= 1000)
    && Number.isFinite(specification.maxResponseLatencyMs) && specification.maxResponseLatencyMs > 0
    && specification.maxResponseLatencyMs <= 25000;
  let invalid = specificationValid ? validateEvidence(run) : "interruption_specification_invalid";
  if (!invalid) {
    try { for (const item of specification.criticalInput) new RegExp(item.pattern, "i"); }
    catch { invalid = "interruption_pattern_invalid"; }
  }
  check("capture_complete", invalid ? "FAIL" : "PASS", invalid ?? "Complete bounded packet, frame, layout and raw transcript evidence.");
  const result = (metrics = {}) => ({ verdict: invalid || checks.some(c => c.captureFailure)
    ? "INVALID_CAPTURE" : checks.some(c => c.status === "FAIL") ? "FAIL" : "REVIEW",
  checks, metrics, humanReviewRequired: true, naturalnessCertified: false,
  subjectiveRatings: { turnTaking: null, inputUnderstanding: null, naturalness: null },
  limitations: ["Every audible output packet is checked, including cues; packet receipt is not device playback.",
    "Estimated FIFO overlap does not simulate flush/barge_in cancellation or an acoustic echo path.",
    "Ten-millisecond energy windows are not semantic speech detection.",
    "Critical text checks establish literal retention/occurrence, not correct interpretation or factual entailment.",
    "Audio after turn_begin is a timing observation, not certification of a substantive reply."] });
  if (invalid) return result();
  const t = run.turns[0], c = run.interruptionCapture;
  const voiced = union(c.callerFrames.flatMap(f => f.energy));
  if (!voiced.length) {
    check("caller_energy_present", "FAIL", "Caller audio has no measured energy.", { captureFailure: true });
    return result();
  }
  const floor = { startMs: voiced[0].startMs, endMs: voiced.at(-1).endMs };
  const output = c.agentPackets.filter(p => p.turnIndex === 0 && p.energy.length);
  const estimated = union(output.flatMap(p => p.energy));
  const receivedDuringFloor = output.filter(p => p.atMs >= floor.startMs && p.atMs < floor.endMs);
  check("no_audible_output_received_during_caller_floor", receivedDuringFloor.length ? "FAIL" : "PASS",
    "The floor spans the first through final caller energy, including intentional pauses; cue packets are never excluded.",
    { packetSequences: receivedDuringFloor.map(p => p.sequence) });
  const overlap = intersect(estimated, voiced);
  const floorOverlap = intersect(estimated, [floor]);
  const cancellation = t.events?.some(e => ["flush", "barge_in"].includes(e.event)) === true;
  check("estimated_playout_overlap", overlap.length || floorOverlap.length ? "REVIEW" : "PASS",
    "Estimated playback overlap is diagnostic only; device playback and cancellation are unobserved.");
  let inputVerified = true;
  for (const critical of specification.criticalInput) {
    const pattern = new RegExp(critical.pattern, "i");
    const sourcePresent = typeof t.asrHypothesis === "string" && pattern.test(t.asrHypothesis);
    inputVerified &&= sourcePresent;
    check(`caller_audio_contains_${critical.id}`, sourcePresent ? "PASS" : "FAIL",
      "Independent pre-call Hear must recognize the critical detail in the synthesized caller PCM.", { captureFailure: !sourcePresent });
    check(`engine_retains_${critical.id}`, pattern.test(t.engineCallerText) ? "PASS" : "FAIL",
      "Check the unmodified serving-engine caller transcript, without token deduplication or expected-word repair.");
    if (critical.checkReply !== false) check(`reply_contains_${critical.id}`, pattern.test(t.agentText ?? "") ? "PASS" : "FAIL",
      "Literal occurrence in post-call Hear of captured agent PCM; correctness in context still requires review.");
  }
  const postEndBegin = t.turnBegins.filter(e => e.atMs >= floor.endMs).at(-1);
  const response = postEndBegin && output.find(p => p.atMs >= postEndBegin.atMs);
  const responseLatency = response ? response.energy[0].startMs - floor.endMs : null;
  const maxLatencyMs = specification.maxResponseLatencyMs;
  check("audio_after_final_caller_end_within_budget", responseLatency != null && responseLatency <= maxLatencyMs ? "PASS" : "FAIL",
    `First energy after the latest post-caller-end turn_begin must arrive within the explicit ${maxLatencyMs} ms budget. This is not a semantic response label.`);
  const layout = t.callerAudioPlan.layout;
  const segmentStarts = layout.map(s => {
    const frame = c.callerFrames.find(f => f.sampleOffset <= s.startSample && f.sampleOffset + f.samples > s.startSample);
    return frame ? frame.atMs + (s.startSample - frame.sampleOffset) / c.inputRate * 1000 : null;
  });
  const segmentSpeechStarts = layout.map(s => {
    for (const frame of c.callerFrames) for (const range of frame.energy) {
      const firstSample = frame.sampleOffset + (range.startMs - frame.atMs) * c.inputRate / 1000;
      const lastSample = frame.sampleOffset + (range.endMs - frame.atMs) * c.inputRate / 1000;
      if (firstSample < s.endSample && lastSample > s.startSample) {
        return range.startMs + Math.max(0, s.startSample - firstSample) / c.inputRate * 1000;
      }
    }
    return null;
  });
  const firstOutput = output[0];
  return result({ callerFloor: floor, receivedAudiblePacketsDuringFloor: receivedDuringFloor.length,
    estimatedVoicedOverlapMs: rounded(total(overlap)), estimatedFloorOverlapMs: rounded(total(floorOverlap)),
    estimatedPauseOnlyOverlapMs: rounded(total(floorOverlap) - total(overlap)), cancellationObserved: cancellation,
    firstAudiblePacketReceivedFromCallerEndMs: firstOutput ? rounded(firstOutput.atMs - floor.endMs) : null,
    firstEstimatedAudioFromCallerEndMs: firstOutput ? rounded(firstOutput.energy[0].startMs - floor.endMs) : null,
    postTurnBeginAudioFromCallerEndMs: rounded(responseLatency), maxResponseLatencyMs: maxLatencyMs,
    segmentStartsMs: segmentStarts, segmentSpeechStartsMs: segmentSpeechStarts,
    callerFrameGapsMs: c.callerFrames.slice(1).map((frame, i) => rounded(frame.atMs - c.callerFrames[i].endMs)),
    earlyFrameToleranceMs: INTERRUPTION_LIMITS.earlyFrameToleranceMs,
    callerAudioCriticalDetailsVerified: inputVerified,
    resumedBeforeFirstOutput: specification.resumeSegmentIndex == null || !firstOutput
      || segmentSpeechStarts[specification.resumeSegmentIndex] == null ? null
      : firstOutput.atMs >= segmentSpeechStarts[specification.resumeSegmentIndex] && firstOutput.atMs < floor.endMs,
    delayedCueIdentityVerified: false });
}
