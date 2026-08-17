import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadScenario, resolveScenarioPath } from "../src/scenario.js";
import { loadFixture, resolveFixturePath } from "../src/fixture.js";
import { evaluate } from "../src/scorers.js";
import { renderMarkdown } from "../src/scorecard.js";

// Harness root = the directory containing scenarios/ and fixtures/.
const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

test("offline end-to-end: sample scenario + fixture score a clean PASS", () => {
  const scenario = loadScenario(resolveScenarioPath("appointment-booking", BASE_DIR));
  const run = loadFixture(resolveFixturePath("appointment-booking", BASE_DIR));

  assert.equal(run.turns.length, 3);

  const sc = evaluate(scenario, run);

  // Headline verdict.
  assert.equal(sc.verdict, "PASS");

  // Every turn's hard (content) assertions passed.
  assert.ok(sc.turns.every((t) => t.hardOk), "all turns hard-pass");
  assert.equal(sc.counts.hardFailures, 0);
  assert.equal(sc.counts.softMisses, 0);

  // Deterministic metrics landed in the expected bands and passed their gates.
  assert.equal(sc.metrics.wer.band, "good");
  assert.ok(sc.metrics.wer.value < 5, `WER ${sc.metrics.wer.value} should be <5%`);
  assert.equal(sc.metrics.tsr.value, 100);
  assert.equal(sc.metrics.ttfbP95.band, "good");
  assert.equal(sc.metrics.turnP95.band, "good");
  assert.equal(sc.metrics.bargeRecovery.value, 100);
  assert.ok(sc.metrics.vaqi.value >= 70, `VAQI ${sc.metrics.vaqi.value} should be >=70`);
  assert.ok(Object.values(sc.metrics).every((m) => m.gatePass), "all gates pass");

  // The tool_called assertion actually matched a recorded tool call.
  const toolTurn = sc.turns[1];
  assert.ok(toolTurn.assertions.some((a) => a.type === "tool_called" && a.ok));

  // The LLM-judge dimension is present and honestly marked as a stub.
  assert.equal(sc.judge.stub, true);
  assert.ok(sc.turns.every((t) => t.judge.rationale.startsWith("[STUB]")));

  // Markdown renders and reflects the verdict.
  const md = renderMarkdown(sc);
  assert.match(md, /# Omni Eval Scorecard, appointment-booking/);
  assert.match(md, /\*\*Verdict:\*\* PASS/);
  assert.match(md, /LLM-judge:\*\* STUB/);

  // New humanness metrics stay n/a so they cannot fail a scenario that never
  // asserted a felt-move (P0: measure without breaking the existing gate).
  assert.equal(sc.metrics.crr.value, null);
  assert.equal(sc.metrics.pir.value, null);
  assert.equal(sc.metrics.ghr.value, null);
  assert.equal(sc.metrics.hps.value, null);
  assert.equal(sc.metrics.crr.gatePass, true);
});

function scoreNamed(id) {
  const scenario = loadScenario(resolveScenarioPath(id, BASE_DIR));
  const run = loadFixture(resolveFixturePath(id, BASE_DIR));
  return evaluate(scenario, run);
}

test("P0 kill: promise-thursday-callback current-bad fixture FAILs", () => {
  const sc = scoreNamed("promise-thursday-callback");
  assert.equal(sc.verdict, "FAIL");
  const last = sc.turns[sc.turns.length - 1];
  assert.equal(last.assertions.find((a) => a.type === "recalls")?.ok, false);
  assert.equal(last.assertions.find((a) => a.type === "promise_kept")?.ok, false);
  assert.equal(last.assertions.find((a) => a.type === "ledger_has")?.ok, false);
  assert.ok(sc.metrics.pir.value != null && sc.metrics.pir.value < 90);
});

test("P0 kill: kb-price-miss current-bad fixture FAILs", () => {
  const sc = scoreNamed("kb-price-miss");
  assert.equal(sc.verdict, "FAIL");
  assert.equal(sc.turns[0].assertions.find((a) => a.type === "kb_miss_honest")?.ok, false);
  assert.equal(sc.turns[0].assertions.find((a) => a.type === "no_unbacked_claim")?.ok, false);
  assert.equal(sc.metrics.ghr.value, 0);
});

test("P0 kill: memory-constraint current-bad fixture FAILs", () => {
  const sc = scoreNamed("memory-constraint");
  assert.equal(sc.verdict, "FAIL");
  const last = sc.turns[sc.turns.length - 1];
  assert.equal(last.assertions.find((a) => a.type === "recalls")?.ok, false);
  assert.equal(last.assertions.find((a) => a.type === "not_reask")?.ok, false);
  assert.equal(last.assertions.find((a) => a.type === "ledger_has")?.ok, false);
  assert.ok(sc.metrics.crr.value != null && sc.metrics.crr.value < 80);
  assert.ok(sc.metrics.rar.value != null && sc.metrics.rar.value > 10);
});

test("P2 intended: continuity-repeat-caller reuses the Thursday promise", () => {
  const sc = scoreNamed("continuity-repeat-caller");
  assert.equal(sc.verdict, "PASS");
  const turn = sc.turns[0];
  assert.equal(turn.assertions.find((a) => a.type === "recalls" && String(a.detail).includes("Thursday"))?.ok, true);
  assert.equal(turn.assertions.find((a) => a.type === "promise_kept")?.ok, true);
  assert.equal(turn.assertions.find((a) => a.type === "not_reask")?.ok, true);
  assert.ok(sc.metrics.crr.value != null && sc.metrics.crr.value >= 80);
  assert.ok(sc.metrics.pir.value != null && sc.metrics.pir.value >= 90);
});

test("P4 intended: reflect-specific echoes a content word without hollow validation", () => {
  const sc = scoreNamed("reflect-specific");
  assert.equal(sc.verdict, "PASS");
  const turn = sc.turns[0];
  assert.equal(turn.assertions.find((a) => a.type === "reflects_specific")?.ok, true);
  assert.equal(turn.assertions.find((a) => a.type === "not_generic_validation")?.ok, true);
});

test("P4 intended: affect-mismatch distressed reply stays specific and calm", () => {
  const sc = scoreNamed("affect-mismatch");
  assert.equal(sc.verdict, "PASS");
  const turn = sc.turns[0];
  assert.equal(turn.assertions.find((a) => a.type === "reflects_specific")?.ok, true);
  assert.equal(turn.assertions.find((a) => a.type === "not_generic_validation")?.ok, true);
});

test("P6 intended: idle-after-hard-question leaves space", () => {
  const sc = scoreNamed("idle-after-hard-question");
  assert.equal(sc.verdict, "PASS");
  const turn = sc.turns[0];
  assert.equal(turn.assertions.find((a) => a.type === "idle_patient")?.ok, true);
});

test("P6 intended: barge-partial-context drops the unplayed tail", () => {
  const sc = scoreNamed("barge-partial-context");
  assert.equal(sc.verdict, "PASS");
  const turn = sc.turns[0];
  assert.equal(turn.assertions.find((a) => a.type === "not_contains" && String(a.detail).includes("Thursday"))?.ok, true);
  assert.equal(sc.metrics.bargeRecovery.value, 100);
});

test("P7 intended: slow-tool-bridge covers dead air once and never says one moment", () => {
  const sc = scoreNamed("slow-tool-bridge");
  assert.equal(sc.verdict, "PASS");
  const first = sc.turns[0];
  const second = sc.turns[1];
  assert.equal(first.assertions.find((a) => a.type === "contains" && String(a.detail).includes("Let me check that"))?.ok, true);
  assert.equal(first.assertions.find((a) => a.type === "not_contains" && String(a.detail).includes("one moment"))?.ok, true);
  assert.equal(first.assertions.find((a) => a.type === "tool_called")?.ok, true);
  assert.equal(second.assertions.find((a) => a.type === "not_contains" && String(a.detail).includes("Let me check that"))?.ok, true);
  assert.equal(second.assertions.find((a) => a.type === "tool_called")?.ok, true);
});

test("P2 intended: continuity-wrong-card does not act on a stale order id", () => {
  const sc = scoreNamed("continuity-wrong-card");
  assert.equal(sc.verdict, "PASS");
  const turn = sc.turns[0];
  assert.equal(turn.assertions.find((a) => a.type === "tool_not_called")?.ok, true);
  assert.equal(turn.assertions.find((a) => a.type === "no_unbacked_claim")?.ok, true);
});
