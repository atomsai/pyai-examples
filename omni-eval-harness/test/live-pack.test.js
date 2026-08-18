import assert from "node:assert/strict";
import { test } from "node:test";

import { isNonSpeechCaller, kbFromQueryEvent, pcm16ToWav, toolsForScenario } from "../src/live.js";
import { listenRubric, runResultToFixture } from "../src/live-pack.js";

test("pcm16ToWav writes a mono PCM header", () => {
  const pcm = new Int16Array([0, 1, -1, 32767]);
  const wav = pcm16ToWav(pcm, 24000);
  const dv = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.equal(dv.getUint16(20, true), 1);
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 24000);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 8);
  assert.equal(wav.length, 52);
});

test("toolsForScenario enables transfer only when asserted", () => {
  const transfer = toolsForScenario({
    turns: [{ expect: [{ type: "tool_called", name: "transfer_to_human" }] }],
  });
  assert.deepEqual(transfer.map((t) => t.name), ["transfer_to_human"]);
  const silence = toolsForScenario({
    turns: [{ expect: [{ type: "tool_not_called", name: "transfer_to_human" }] }],
  });
  assert.deepEqual(silence.map((t) => t.name), ["transfer_to_human"]);
  const book = toolsForScenario({
    turns: [{ expect: [{ type: "tool_called", name: "book_appointment" }] }],
  });
  assert.deepEqual(book, []);
});

test("kbFromQueryEvent maps none/hit", () => {
  assert.equal(kbFromQueryEvent({ event: "kb_query", none: true, reason: "timeout" }), "timeout");
  assert.equal(kbFromQueryEvent({ event: "kb_query", none: true, reason: "no_kb" }), "empty");
  assert.equal(kbFromQueryEvent({ event: "kb_query", top_ids: ["doc-1"] }), "hit");
  assert.equal(kbFromQueryEvent({ event: "kb_query", top_ids: [] }), "empty");
});

test("ellipsis-only caller text is non-speech", () => {
  assert.equal(isNonSpeechCaller("..."), true);
  assert.equal(isNonSpeechCaller("I want a real person."), false);
});

test("runResultToFixture keeps spoken text and listenRubric stays single-rater", () => {
  const run = {
    sessionLabel: "eval-x",
    mode: "live-voice",
    recordedAt: "2026-08-17T00:00:00.000Z",
    turns: [{ callerText: "callback for a week", agentText: "Nobody called you back for a week.", toolCalls: [] }],
  };
  const fixture = runResultToFixture(run, "reflect-specific");
  assert.equal(fixture.turns[0].agent_text, "Nobody called you back for a week.");
  const listen = listenRubric({ id: "reflect-specific" }, run);
  assert.equal(listen.rater, "engineering-single");
  assert.equal(listen.heard, true);
});

test("scoreLiveRow reads agentText from a normalized run", async () => {
  const { scoreLiveRow } = await import("../src/live-pack.js");
  const scenario = {
    id: "reflect-specific",
    persona: "Be brief.",
    turns: [{ caller_says: "callback for a week", expect: [] }],
    thresholds: { werPct: 100, ttfbMs: 800, turnP95Ms: 1500 },
  };
  const run = {
    turns: [{ callerText: "callback for a week", agentText: "Nobody called you back for a week.", toolCalls: [] }],
  };
  const row = scoreLiveRow(scenario, run, run);
  assert.equal(row.agent, "Nobody called you back for a week.");
});

test("content verdict excludes ASR and latency failures", async () => {
  const { scoreLiveRow } = await import("../src/live-pack.js");
  const scenario = {
    id: "transport-noise",
    persona: "Be brief.",
    turns: [
      {
        caller_says: "callback for a week",
        expect: [{ type: "contains", value: "week" }],
      },
    ],
    thresholds: { werPct: 10, ttfbMs: 800, turnP95Ms: 1500 },
  };
  const run = {
    turns: [
      {
        callerText: "callback for a week",
        asrHypothesis: "completely unrelated words",
        agentText: "Nobody called you back for a week.",
        ttfbMs: 5000,
        turnMs: 8000,
        toolCalls: [],
      },
    ],
  };

  const row = scoreLiveRow(scenario, run, run);
  assert.equal(row.verdict, "FAIL");
  assert.equal(row.content_verdict, "PASS");
  assert.equal(row.tsr, 100);
});
