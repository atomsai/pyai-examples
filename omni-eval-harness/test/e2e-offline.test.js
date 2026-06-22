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
  assert.match(md, /# Omni Eval Scorecard — appointment-booking/);
  assert.match(md, /\*\*Verdict:\*\* PASS/);
  assert.match(md, /LLM-judge:\*\* STUB/);
});
