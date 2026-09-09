import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { energyIntervals, newInterruptionCapture, prepareInterruptionCaller } from "../src/interruption-capture.js";
import { scoreInterruptionRun } from "../src/interruption-scoring.js";
import { interruptionScenarios, parseInterruptionArgs, runInterruptionPack } from "../src/live-interruption.js";
import { runLive } from "../src/live.js";

function virtualClock() {
  let at = 0, nextId = 1;
  const timers = new Map();
  const clock = { now: () => at,
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { at: at + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    sleep(ms) { return new Promise(resolve => clock.setTimeout(resolve, ms)); },
    async complete(promise) {
      let done = false, result, error;
      promise.then(value => { result = value; done = true; }, err => { error = err; done = true; });
      for (let ticks = 0; !done && ticks < 100000; ticks++) {
        for (let i = 0; i < 30; i++) await Promise.resolve();
        if (done) break;
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        assert.ok(next, "operation waiting without timers");
        timers.delete(next[0]); at = next[1].at; next[1].fn();
      }
      assert.ok(done, "virtual call must finish");
      if (error) throw error;
      return result;
    } };
  return clock;
}
const tone = (ms, rate = 24000) => new Int16Array(Math.round(rate * ms / 1000)).fill(1000);
const replyFor = spec => spec.id.includes("correction") ? "The corrected number is five one three."
  : spec.id.includes("resume") ? "The final day is Friday." : "Thursday at five thirty.";

function fixture(spec = interruptionScenarios()[0], { cueAt = null, cueMs = 100,
  flush = false, earlyBegin = false, transcript, responseDelay = 400, responseBeginDelay = 200,
  lateCallerTranscripts = [], profile = true, leadingMsBySegment = [], configuredVoice = "stock_felix_en" } = {}) {
  const clock = virtualClock(), state = { connected: false, closed: false, inputs: [], synthesis: [], callerVoices: [], agentVoice: null };
  const end = profile ? spec.segments.length * 500 + spec.segments.reduce((n, s) => n + s.pauseAfterMs, 0) : 500;
  class PyAI {
    audio = { speech: async ({ input, voice }) => {
      assert.equal(state.connected, false, "synthesis must finish before socket opens");
      const pcm = tone(500);
      pcm.fill(0, 0, (leadingMsBySegment[state.synthesis.length] ?? 0) * 24);
      state.synthesis.push(input); state.callerVoices.push(voice); return pcm.buffer;
    }, transcriptions: { create: async ({ filename }) => {
      if (filename === "caller.wav") { assert.equal(state.connected, false); return { text: spec.scenario.turns[0].caller_says }; }
      assert.equal(state.closed, true, "agent Hear must run only after socket closes");
      return { text: replyFor(spec) };
    } } };
  }
  class OmniClient {
    constructor(options) {
      state.connected = true; this.options = options; this.started = false;
      state.agentVoice = options.voice;
      clock.setTimeout(() => { options.onReady(); options.onHello("pcm16@24000"); }, 10);
      clock.setTimeout(() => options.onEvent({ event: "configured", greeting: false, tools: 0, audio_out: "pcm16@24000", call_id: "fixture-call", voice_id: configuredVoice }), 50);
    }
    sendControl() {}
    sendAudio(pcm) {
      state.inputs.push({ at: clock.now(), pcm: pcm.slice() });
      if (this.started || !pcm.some(x => x)) return;
      this.started = true;
      if (earlyBegin) clock.setTimeout(() => this.options.onEvent({ event: "turn_begin", turn: 1 }), 520);
      if (cueAt != null) clock.setTimeout(() => {
        this.options.onAudio(tone(cueMs));
        if (flush) this.options.onEvent({ event: "flush" });
      }, cueAt);
      clock.setTimeout(() => this.options.onTranscript({ role: "user", mode: "replace", final: true,
        text: transcript ?? spec.scenario.turns[0].caller_says }), end + 40);
      for (const item of lateCallerTranscripts) clock.setTimeout(() =>
        this.options.onTranscript({ role: "user", mode: "delta", final: false, text: item.text }), end + item.delay);
      if (responseBeginDelay != null) clock.setTimeout(() => this.options.onEvent({ event: "turn_begin", turn: 2 }), end + responseBeginDelay);
      clock.setTimeout(() => {
        this.options.onAudio(tone(200));
        this.options.onTranscript({ role: "assistant", final: true, text: replyFor(spec) });
      }, end + responseDelay);
    }
    close() { state.closed = true; this.options.onClose(); }
  }
  const runtime = { clock, interruptionCapture: profile, dependencies: { sdk: { PyAI }, twilio: {
    OmniClient, bytesToPcm16: bytes => new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    makeResampler: (from, to) => from === to ? null : { process(pcm) {
      return Int16Array.from({ length: Math.round(pcm.length * to / from) }, (_, i) => pcm[Math.floor(i * from / to)]);
    } },
  } } };
  return { spec, state, runtime, clock,
    run: options => clock.complete(runLive(spec.scenario, { apiKey: "fake-key", mode: "voice", tools: [], voice: "alloy",
      ...(profile ? { agentVoice: "stock_felix_en" } : {}), ...options }, runtime)) };
}
const check = (score, id) => score.checks.find(c => c.id === id);

test("segment preparation preserves original samples and adds only requested silence", async () => {
  const a = new Int16Array([0, 1000, 1000, 0]);
  const prepared = await prepareInterruptionCaller([{ text: "five", pauseAfterMs: 20 }, { text: "one", pauseAfterMs: 0 }], 8000, async () => a);
  assert.deepEqual([...prepared.pcm], [...a, ...new Array(160).fill(0), ...a]);
  assert.equal(prepared.layout[1].startSample, 164);
  assert.equal(prepared.layout[0].pcmSha256, prepared.layout[1].pcmSha256);
  a.fill(2222);
  assert.equal(prepared.pcm[1], 1000, "caller PCM must not alias SDK buffers");
});
test("energy intervals preserve internal silence instead of spanning an entire packet", () => {
  const pcm = new Int16Array(800);
  pcm.fill(1000, 80, 240); pcm.fill(1000, 480, 560);
  assert.deepEqual(energyIntervals(pcm, 8000, 10), [{ startMs: 20, endMs: 40 }, { startMs: 70, endMs: 80 }]);
});
for (const bad of [[], [{ text: "x", pauseAfterMs: 0 }], [{ text: "x", pauseAfterMs: 2001 }, { text: "y", pauseAfterMs: 0 }]]) {
  test(`invalid segmented plan is rejected (${JSON.stringify(bad)})`, async () => {
    await assert.rejects(prepareInterruptionCaller(bad, 24000, async () => tone(500)));
  });
}
test("a complete quiet-floor capture remains REVIEW, with signed and post-end timings", async () => {
  const f = fixture(), run = await f.run(), score = scoreInterruptionRun(f.spec, run);
  assert.equal(run.captureIntegrity.valid, true);
  assert.equal(score.verdict, "REVIEW");
  assert.equal(score.metrics.postTurnBeginAudioFromCallerEndMs, 400);
  assert.equal(score.metrics.receivedAudiblePacketsDuringFloor, 0);
  assert.equal(score.metrics.estimatedVoicedOverlapMs, 0);
  assert.equal(score.naturalnessCertified, false);
  assert.deepEqual(f.state.synthesis, f.spec.segments.map(s => s.text));
  assert.ok(run.interruptionCapture.callerFrames.some(f => !f.energy.length), "explicit gap must be captured");
});
test("caller Speak voice stays alloy while Omni receives the explicit catalog agent voice", async () => {
  const f = fixture(), run = await f.run({ voice: "alloy", agentVoice: "stock_felix_en" });
  assert.deepEqual(f.state.callerVoices, f.spec.segments.map(() => "alloy"));
  assert.equal(f.state.agentVoice, "stock_felix_en");
  assert.equal(run.configured.voice_id, "stock_felix_en");
  assert.equal(run.captureIntegrity.valid, true);
});

test("ordinary runLive preserves shared voice fallback unless agentVoice is explicitly supplied", async () => {
  for (const agentVoice of [undefined, null, "stock_felix_en"]) {
    const f = fixture(undefined, { profile: false });
    const run = await f.run({ voice: "alloy", ...(agentVoice === undefined ? {} : { agentVoice }) });
    assert.deepEqual(f.state.callerVoices, ["alloy"]);
    assert.equal(f.state.agentVoice, agentVoice ?? "alloy");
    assert.equal(run.captureIntegrity.valid, true, "ordinary calls do not acquire interruption voice qualification");
  }
});

test("missing, mismatched or malformed agent voice acknowledgement invalidates interruption capture", async () => {
  for (const configuredVoice of [null, "alloy", "stock_other_en", { secret: "unbounded-voice-value" }]) {
    const f = fixture(undefined, { configuredVoice }), run = await f.run();
    assert.equal(f.state.agentVoice, "stock_felix_en");
    assert.equal(run.captureIntegrity.valid, false);
    assert.ok(run.captureIntegrity.issues.some(issue => issue.code === "configured_agent_voice_mismatch" && issue.severity === "error"));
    assert.equal(scoreInterruptionRun(f.spec, run).verdict, "INVALID_CAPTURE");
    assert.equal(JSON.stringify(run).includes("unbounded-voice-value"), false);
  }
});
test("cue inside a mid-sentence pause fails even with zero voiced overlap and a correct later reply", async () => {
  const f = fixture(undefined, { cueAt: 600 }), run = await f.run(), score = scoreInterruptionRun(f.spec, run);
  assert.equal(score.verdict, "FAIL");
  assert.equal(score.metrics.estimatedVoicedOverlapMs, 0);
  assert.equal(score.metrics.estimatedPauseOnlyOverlapMs, 100);
  assert.ok(score.metrics.firstAudiblePacketReceivedFromCallerEndMs < 0);
  assert.equal(score.metrics.postTurnBeginAudioFromCallerEndMs, 400);
  assert.equal(run.interruptionCapture.agentPackets.length, 2, "cue PCM must remain in packet evidence");
});
test("first packet after caller resumption is included and race exposure is observed, not labeled a cue", async () => {
  const f = fixture(interruptionScenarios()[2], { cueAt: 1200 }), run = await f.run(), score = scoreInterruptionRun(f.spec, run);
  assert.equal(score.verdict, "FAIL");
  assert.equal(score.metrics.resumedBeforeFirstOutput, true);
  assert.equal(score.metrics.delayedCueIdentityVerified, false);
  assert.equal(score.metrics.estimatedVoicedOverlapMs, 100);
});
test("a fragment's leading silence does not falsely claim caller speech already resumed", async () => {
  const f = fixture(interruptionScenarios()[2], { cueAt: 1200, leadingMsBySegment: [0, 100] });
  const run = await f.run(), score = scoreInterruptionRun(f.spec, run);
  assert.equal(score.metrics.resumedBeforeFirstOutput, false);
  assert.equal(score.metrics.segmentSpeechStartsMs[1] - score.metrics.segmentStartsMs[1], 100);
  assert.equal(score.verdict, "FAIL", "the caller still owns the intentional pause");
});
test("slow correction keeps all raw duplicate tokens and fails when the critical number is lost", async () => {
  const transcript = "The the the corrected number is three three five. Please.";
  const f = fixture(interruptionScenarios()[1], { transcript }), run = await f.run(), score = scoreInterruptionRun(f.spec, run);
  assert.equal(run.turns[0].engineCallerText, transcript);
  assert.equal(score.verdict, "FAIL");
  assert.equal(check(score, "caller_audio_contains_corrected_number").status, "PASS");
  assert.equal(check(score, "engine_retains_corrected_number").status, "FAIL");
});
test("a valid slow number correction is retained without requiring token deduplication", async () => {
  const f = fixture(interruptionScenarios()[1]), run = await f.run();
  assert.equal(scoreInterruptionRun(f.spec, run).verdict, "REVIEW");
});
test("post-end output delay cannot be masked by a quick earlier cue", async () => {
  const f = fixture(undefined, { cueAt: 600, responseDelay: 3100 }), run = await f.run(), score = scoreInterruptionRun(f.spec, run);
  assert.equal(check(score, "audio_after_final_caller_end_within_budget").status, "FAIL");
  assert.equal(score.metrics.postTurnBeginAudioFromCallerEndMs, 3100);
});
test("multiple turns and cancellation stay inspectable without certifying playback", async () => {
  const f = fixture(undefined, { cueAt: 600, earlyBegin: true, flush: true }), run = await f.run();
  assert.equal(run.captureIntegrity.valid, true);
  assert.ok(run.captureIntegrity.issues.every(i => i.severity === "warning"));
  assert.equal(run.turns[0].turnBegins.length, 2);
  const score = scoreInterruptionRun(f.spec, run);
  assert.equal(score.verdict, "FAIL");
  assert.equal(score.metrics.cancellationObserved, true);
});
test("real live instrumentation retains late caller pieces and reply after an already-settled early cue", async () => {
  const f = fixture(interruptionScenarios()[1], { cueAt: 600, earlyBegin: true,
    responseBeginDelay: 4400, responseDelay: 5200,
    lateCallerTranscripts: [{ delay: 4500, text: " one one" }] });
  const run = await f.run(), t = run.turns[0], observation = t.timing.postCallerObservation;
  assert.equal(run.captureIntegrity.valid, true);
  assert.equal(t.agentAudioMs, 300, "retain both early cue and late reply samples");
  assert.equal(t.engineCallerText, f.spec.scenario.turns[0].caller_says + " one one");
  assert.equal(t.engineCallerTranscriptEvents.at(-1).text, " one one");
  assert.equal(observation.elapsedMs, 7400);
  assert.equal(observation.minimumEndMs - observation.startedMs, 5000);
  assert.equal(observation.lastCallerTranscriptMs - observation.startedMs, 4500);
  const afterCaller = f.state.inputs.filter(frame => frame.at >= observation.startedMs && frame.at < observation.endedMs);
  assert.ok(afterCaller.length >= 370);
  assert.ok(afterCaller.every(frame => frame.pcm.every(sample => sample === 0)), "paced silence continues during the observation");
  assert.ok(afterCaller.slice(1).every((frame, i) => frame.at - afterCaller[i].at === 20));
  assert.equal(scoreInterruptionRun(f.spec, run).verdict, "FAIL", "observing later reply never erases the early interruption");
  assert.match(run.captureMethod.postCallerObservation.scoringLimitation, /coalesced turn/);
});

test("observation retains post-end audio on an earlier coalesced turn without claiming the stricter timing check passed", async () => {
  const f = fixture(undefined, { earlyBegin: true, responseBeginDelay: null, responseDelay: 4500 });
  const run = await f.run(), t = run.turns[0];
  assert.equal(run.captureIntegrity.valid, true);
  assert.equal(t.turnBegins.length, 1);
  assert.equal(t.agentAudioMs, 200);
  assert.equal(t.timing.postCallerObservation.elapsedMs, 6700);
  const score = scoreInterruptionRun(f.spec, run);
  assert.equal(check(score, "audio_after_final_caller_end_within_budget").status, "FAIL");
  assert.equal(score.metrics.postTurnBeginAudioFromCallerEndMs, null);
  assert.equal(score.metrics.firstAudiblePacketReceivedFromCallerEndMs, 4500);
});
test("ordinary runLive retains whole-utterance synthesis and its existing invalidation rules", async () => {
  const f = fixture(undefined, { cueAt: 100, earlyBegin: true, flush: true, profile: false }), run = await f.run();
  assert.equal(run.interruptionCapture, undefined);
  assert.equal(run.turns[0].timing.postCallerObservation, undefined);
  assert.equal(run.captureMethod.postCallerObservation, undefined);
  assert.equal(run.captureIntegrity.valid, false);
  assert.ok(run.captureIntegrity.issues.some(i => i.code === "multiple_response_turns" && i.severity === "error"));
  assert.ok(run.captureIntegrity.issues.some(i => i.code === "output_playback_interrupted" && i.severity === "error"));
  assert.deepEqual(f.state.synthesis, [f.spec.scenario.turns[0].caller_says]);
});
test("invalid/unverified capture never becomes an automated pass", async () => {
  const f = fixture(), original = await f.run();
  for (const mutate of [
    run => { run.captureIntegrity.valid = false; },
    run => { delete run.interruptionCapture; },
    run => { run.interruptionCapture.complete = false; },
    run => { run.interruptionCapture.agentPackets[0].atMs = NaN; },
    run => { run.interruptionCapture.agentPackets[0].samples += 1; },
    run => { run.interruptionCapture.callerFrames.splice(2, 1); },
    run => { run.turns[0].engineCallerText = "Expected words inserted here"; },
    run => { run.turns[0].engineCallerTranscriptEvents = []; },
    run => { run.turns[0].asrHypothesis = "Unverified synthesis"; },
    run => {
      const frame = run.interruptionCapture.callerFrames[2];
      frame.atMs -= 3; frame.endMs -= 3;
      for (const range of frame.energy) { range.startMs -= 3; range.endMs -= 3; }
    },
  ]) {
    const run = structuredClone(original); mutate(run);
    assert.equal(scoreInterruptionRun(f.spec, run).verdict, "INVALID_CAPTURE");
  }
});
test("bounded early timer delivery preserves its raw sign instead of clamping timestamps", async () => {
  const f = fixture(), run = await f.run();
  const frame = run.interruptionCapture.callerFrames[2];
  frame.atMs -= 1; frame.endMs -= 1;
  for (const range of frame.energy) { range.startMs -= 1; range.endMs -= 1; }
  const score = scoreInterruptionRun(f.spec, run);
  assert.equal(score.verdict, "REVIEW");
  assert.equal(score.metrics.callerFrameGapsMs[1], -1);
  assert.equal(score.metrics.callerFrameGapsMs[2], 1);
});
test("invalid specifications cannot accidentally certify a capture", async () => {
  const f = fixture(), run = await f.run();
  for (const spec of [null, { ...f.spec, maxResponseLatencyMs: NaN },
    { ...f.spec, criticalInput: [{ id: "broken", pattern: "[" }] }]) {
    assert.equal(scoreInterruptionRun(spec, run).verdict, "INVALID_CAPTURE");
  }
});
test("instrumentation bounds do not silently truncate to a valid capture", () => {
  const capture = newInterruptionCapture(24000);
  capture.agentPacket(tone(200), 120001, 120001, 24000, 0);
  assert.equal(capture.finish().complete, false);
  assert.deepEqual(capture.finish().issues, ["agent_packet_invalid"]);
});
test("CLI is explicit and rejects unsafe/duplicate options", () => {
  const defaults = parseInterruptionArgs(["--key-stdin", "--out", "new"]);
  assert.equal(defaults.label, "interruption");
  assert.equal(defaults.voice, "alloy");
  assert.equal(defaults.agentVoice, "stock_felix_en");
  const explicit = parseInterruptionArgs(["--key-stdin", "--out", "new", "--voice", "nova", "--agent-voice", "stock_felix_en"]);
  assert.equal(explicit.voice, "nova");
  assert.equal(explicit.agentVoice, "stock_felix_en");
  for (const args of [[], ["--key-stdin", "--out", "x", "--out", "y"],
    ["--key-stdin", "--out", "x", "--base-url", "https://user:secret@example.com"],
    ["--key-stdin", "--out", "x", "--agent-voice", "bad voice"],
    ["--key-stdin", "--out", "x", "--agent-voice", "stock_felix_en", "--agent-voice", "stock_other_en"],
    ["--key-stdin", "--out", "x", "--label", "bad label"]]) assert.throws(() => parseInterruptionArgs(args));
});
test("pack writes fresh hash-bound evidence, returns review=3 and refuses overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "interruption-test-"));
  const outDir = join(root, "pack");
  try {
    const result = await runInterruptionPack({ apiKey: "fake-key", outDir }, { log() {},
      runSession: async (scenario, opts, profile) => {
        assert.equal(profile.interruptionCapture, true);
        assert.equal(opts.voice, "alloy");
        assert.equal(opts.agentVoice, "stock_felix_en");
        const spec = interruptionScenarios().find(s => s.id === scenario.id);
        return fixture(spec).run(opts);
      } });
    assert.equal(result.exitCode, 3);
    assert.equal(result.rows.length, 3);
    assert.equal(result.manifest.voice, "alloy", "retain the legacy caller voice field");
    assert.equal(result.manifest.callerVoice, "alloy");
    assert.equal(result.manifest.agentVoice, "stock_felix_en");
    assert.ok(result.rows.every(r => r.verdict === "REVIEW" && r.attribution.candidateVerified === false));
    assert.equal(JSON.parse(readFileSync(join(outDir, "status.json"))).status, "COMPLETED");
    await assert.rejects(runInterruptionPack({ apiKey: "fake-key", outDir }, { log() {} }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const type of ["invalid", "failure", "error", "voice-mismatch", "voice-evidence-changed"]) test(`pack exit codes preserve ${type}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "interruption-exit-"));
  try {
    const result = await runInterruptionPack({ apiKey: "do-not-emit-me", outDir: join(root, "pack") }, { log() {},
      runSession: async (scenario, opts) => {
        if (type === "error") throw new Error("do-not-emit-me raw backend error");
        const spec = interruptionScenarios().find(s => s.id === scenario.id);
        const run = await fixture(spec, type === "failure" ? { cueAt: 600 }
          : type === "voice-mismatch" ? { configuredVoice: "alloy" } : {}).run(opts);
        if (type === "invalid") run.captureIntegrity.valid = false;
        if (type === "voice-evidence-changed") {
          assert.equal(run.captureIntegrity.valid, true);
          run.configured.voice_id = "alloy";
        }
        return run;
      } });
    assert.equal(result.exitCode, type === "failure" ? 1 : 2);
    const text = readFileSync(join(root, "pack", "interruption-mid-sentence.json"), "utf8");
    assert.equal(text.includes("do-not-emit-me"), false);
    assert.equal(text.includes("raw backend error"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
