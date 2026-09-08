import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResultToFixture } from "../src/live-pack.js";
import { loadFixture, normalizeFixture } from "../src/fixture.js";

function recordedRun() {
  const callerEvents = [
    { atMs: 150, clientTurnIndex: 0, text: "Order five", final: false, mode: "delta", sequence: 1 },
    { atMs: 250, clientTurnIndex: 0, text: " one three.", final: false, mode: "delta", sequence: 2 },
    { atMs: 290, clientTurnIndex: 0, text: "Order 513.", final: true, mode: "replace", sequence: 3 },
  ];
  return {
    mode: "live-voice", captureIntegrity: { valid: true, issues: [] },
    captureMethod: { inputRate: 24000, outputRate: 24000, agentTranscription: "post-session-hear",
      callerTranscription: "pre-session-hear", engineCallerTranscription: "server-0x02-observed-deltas-with-client-turn-timestamps",
      timing: "client-monotonic-queued-playback-energy-bounds", settleQuietMs: 2000,
      turnBoundary: "audio-after-latest-turn-begin-plus-playout-and-advisory-quiet",
      postTurnBeginTiming: "Received after turn_begin; not a substantive-answer claim.",
      completionLimitation: "No server reply-end marker.", maxInputGapMs: 0 },
    engineCallerTranscriptEvents: callerEvents,
    turns: [{ callerText: "What about order 513?", asrHypothesis: "What about order five thirteen?",
      agentText: "The recorded spoken answer.", engineCallerText: "Order 513.",
      engineAssistantText: "Intended synthesis text.", ttfbMs: -42,
      anyAudioTtfbMs: -42, postTurnBeginTtfbMs: 2927, replyStartedAtMs: 5672,
      sttFinalMs: 700, brainTtsMs: -824,
      timing: { ttfbMs: -42, anyAudioTtfbMs: -42, postTurnBeginTtfbMs: 2927,
        agentFirstPacketMs: 5672, latestTurnBeginMs: 6496, postTurnBeginFirstPacketMs: 8641,
        postTurnBeginSpeechOnsetMs: 8641, lastAssistantTranscriptMs: 9400,
        callerMaxFrameGapMs: 0, callerOffsetBasis: "energy-bound", settleReason: "settled",
        method: "client-monotonic-queued-playback-energy-bounds" },
      engineCallerTranscriptEvents: callerEvents,
      engineAssistantTranscriptEvents: [{ atMs: 9400, text: "Intended synthesis text.", final: true, mode: "replace" }],
      turnBegins: [{ atMs: 6496, turn: 1 }],
      events: [{ atMs: 5000, event: "idle_prompt" }],
    }],
  };
}

test("disk fixture replay preserves cue timing, advisories and raw engine caller deltas without replacing scoring text", () => {
  const original = recordedRun();
  const fixture = runResultToFixture(original, "cue-witness");
  const directory = mkdtempSync(join(tmpdir(), "capture-evidence-"));
  const path = join(directory, "recording.json");
  writeFileSync(path, JSON.stringify(fixture));
  const replay = loadFixture(path);
  assert.deepEqual(replay.captureMethod, original.captureMethod);
  assert.deepEqual(replay.engineCallerTranscriptEvents, original.engineCallerTranscriptEvents);
  assert.deepEqual(replay.captureIntegrity, original.captureIntegrity);
  for (const key of ["engineCallerText", "engineAssistantText", "engineCallerTranscriptEvents",
    "engineAssistantTranscriptEvents", "anyAudioTtfbMs", "postTurnBeginTtfbMs", "replyStartedAtMs",
    "sttFinalMs", "brainTtsMs", "timing", "turnBegins", "events"]) {
    assert.deepEqual(replay.turns[0][key], original.turns[0][key], key);
  }
  assert.equal(replay.turns[0].ttfbMs, -42);
  assert.equal(replay.turns[0].agentText, "The recorded spoken answer.");
  assert.equal(replay.turns[0].asrHypothesis, "What about order five thirteen?");
  assert.deepEqual(runResultToFixture(replay, "cue-witness"), fixture);
});

test("legacy fixtures do not acquire engine evidence or capture certification", () => {
  const replay = normalizeFixture({ scenario: "old", turns: [{ caller_says: "Hello", agent_text: "Hello" }] });
  assert.equal(Object.hasOwn(replay, "captureMethod"), false);
  assert.equal(Object.hasOwn(replay, "captureIntegrity"), false);
  assert.equal(Object.hasOwn(replay.turns[0], "engineCallerText"), false);
  assert.equal(Object.hasOwn(replay.turns[0], "timing"), false);
});

test("capture metadata copies only known fields and cannot carry arbitrary environment or tool payloads", () => {
  const run = recordedRun();
  run.captureMethod.secret = "private-data";
  run.turns[0].timing.secret = "private-data";
  run.engineCallerTranscriptEvents[0].secret = "private-data";
  const fixture = runResultToFixture(run, "allowlist");
  assert.doesNotMatch(JSON.stringify(fixture), /private-data|secret/);
});

test("malformed and oversized event evidence fails visibly rather than truncating or coercing", () => {
  for (const event of [
    { atMs: Infinity, text: "caller", final: false, mode: "delta" },
    { atMs: 1, text: "caller", final: "false", mode: "delta" },
    { atMs: 1, text: "caller", final: false, mode: "unknown" },
    { atMs: 1, text: "x".repeat(4001), final: false, mode: "delta" },
    { atMs: 1, final: false, mode: "delta" },
  ]) {
    const run = recordedRun();
    run.engineCallerTranscriptEvents = [event];
    assert.throws(() => runResultToFixture(run, "bad-evidence"), /Invalid or oversized capture evidence/);
  }
  const fixture = runResultToFixture(recordedRun(), "too-many-events");
  fixture.engine_caller_transcript_events = Array(4097).fill(fixture.engine_caller_transcript_events[0]);
  assert.throws(() => normalizeFixture(fixture), /Invalid or oversized capture evidence/);
  const badTiming = runResultToFixture(recordedRun(), "invalid-time");
  badTiming.turns[0].timing.postTurnBeginTtfbMs = "2927";
  assert.throws(() => normalizeFixture(badTiming), /Invalid or oversized capture evidence/);
});
