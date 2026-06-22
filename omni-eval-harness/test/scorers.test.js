import assert from "node:assert/strict";
import { test } from "node:test";

import { wer, aggregateWer, normalize, normalizedIncludes, editDistance } from "../src/text.js";
import { METRICS, classify, gateLine, gatePass, bandVerdict } from "../src/metrics.js";
import { scoreAssertion, percentile, computeVaqi, evaluate } from "../src/scorers.js";
import { heuristicJudge, expectedKeywordsFor } from "../src/judge.js";

// --- text / WER -------------------------------------------------------------

test("normalize strips punctuation, casing, and collapses whitespace", () => {
  assert.equal(normalize("Hi,  I'd  LIKE — that!"), "hi i d like that");
  assert.equal(normalize(""), "");
  assert.equal(normalize(null), "");
});

test("editDistance counts substitutions/insertions/deletions", () => {
  assert.equal(editDistance(["a", "b", "c"], ["a", "b", "c"]), 0);
  assert.equal(editDistance(["a", "b", "c"], ["a", "x", "c"]), 1); // substitution
  assert.equal(editDistance(["a", "b"], ["a", "b", "c"]), 1); // insertion
  assert.equal(editDistance(["a", "b", "c"], ["a", "c"]), 1); // deletion
});

test("wer is edits over reference words, normalization-aware", () => {
  assert.equal(wer("the cat sat", "the cat sat"), 0);
  assert.equal(Math.round(wer("the cat sat", "the dog sat")), 33); // 1/3
  assert.equal(wer("Wednesday at 10 works", "wednesday at ten works"), 25); // 1/4
  assert.equal(wer("", ""), 0);
  assert.equal(wer("", "hello"), 100);
});

test("aggregateWer is corpus-level (total edits / total ref words)", () => {
  const w = aggregateWer([
    { reference: "the cat sat", hypothesis: "the dog sat" }, // 1 edit / 3
    { reference: "a b", hypothesis: "a b" }, // 0 / 2
  ]);
  assert.equal(Math.round(w * 100) / 100, 20); // 1 / 5
  assert.equal(aggregateWer([]), null);
  assert.equal(aggregateWer([{ reference: "", hypothesis: "x" }]), null);
});

test("normalizedIncludes matches case/punctuation-insensitively", () => {
  assert.equal(normalizedIncludes("...on Wednesday at 10 AM.", "wednesday"), true);
  assert.equal(normalizedIncludes("all set", "sorry"), false);
});

// --- metric catalog ---------------------------------------------------------

test("classify honors the plan bands", () => {
  assert.equal(classify(METRICS.wer, 4), "good");
  assert.equal(classify(METRICS.wer, 5), "warn");
  assert.equal(classify(METRICS.wer, 11), "critical");

  assert.equal(classify(METRICS.ttfbP95, 399), "good");
  assert.equal(classify(METRICS.ttfbP95, 400), "warn");
  assert.equal(classify(METRICS.ttfbP95, 801), "critical");

  assert.equal(classify(METRICS.tsr, 90), "good");
  assert.equal(classify(METRICS.tsr, 85), "warn");
  assert.equal(classify(METRICS.tsr, 74), "critical");

  assert.equal(classify(METRICS.bargeRecovery, 95), "good");
  assert.equal(classify(METRICS.bargeRecovery, 85), "warn");
  assert.equal(classify(METRICS.bargeRecovery, 79), "critical");

  assert.equal(classify(METRICS.wer, null), "na");
});

test("gateLine defaults to the warn edge and is overridable by the scenario", () => {
  assert.equal(gateLine(METRICS.wer, {}), 10);
  assert.equal(gateLine(METRICS.wer, { werPct: 6 }), 6);
  assert.equal(gateLine(METRICS.tsr, {}), 75);
  assert.equal(gateLine(METRICS.tsr, { tsrPct: 90 }), 90);
});

test("gatePass respects metric direction and treats n/a as non-failing", () => {
  assert.equal(gatePass(METRICS.wer, 9, 10), true); // lower-is-better
  assert.equal(gatePass(METRICS.wer, 11, 10), false);
  assert.equal(gatePass(METRICS.tsr, 80, 75), true); // higher-is-better
  assert.equal(gatePass(METRICS.tsr, 70, 75), false);
  assert.equal(gatePass(METRICS.wer, null, 10), true);
});

test("bandVerdict maps bands to PASS/WARN/FAIL/SKIP", () => {
  assert.equal(bandVerdict("good"), "PASS");
  assert.equal(bandVerdict("warn"), "WARN");
  assert.equal(bandVerdict("critical"), "FAIL");
  assert.equal(bandVerdict("na"), "SKIP");
});

// --- per-turn assertion scorers --------------------------------------------

const turn = (over = {}) => ({
  agentText: "Booked you on Wednesday at 10 AM.",
  ttfbMs: 300,
  turnMs: 700,
  toolCalls: [{ name: "book_appointment", args: { day: "Wednesday", time: "10:00" } }],
  ...over,
});

test("contains / not_contains", () => {
  assert.equal(scoreAssertion({ type: "contains", value: "wednesday" }, turn()).ok, true);
  assert.equal(scoreAssertion({ type: "contains", value: "tuesday" }, turn()).ok, false);
  assert.equal(scoreAssertion({ type: "not_contains", value: "sorry" }, turn()).ok, true);
  assert.equal(scoreAssertion({ type: "not_contains", value: "booked" }, turn()).ok, false);
});

test("regex (incl. flags and invalid pattern)", () => {
  assert.equal(scoreAssertion({ type: "regex", value: "wed\\w+", flags: "i" }, turn()).ok, true);
  assert.equal(scoreAssertion({ type: "regex", value: "^never" }, turn()).ok, false);
  const bad = scoreAssertion({ type: "regex", value: "(" }, turn());
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /invalid regex/);
});

test("tool_called with subset arg match", () => {
  assert.equal(scoreAssertion({ type: "tool_called", name: "book_appointment" }, turn()).ok, true);
  assert.equal(
    scoreAssertion({ type: "tool_called", name: "book_appointment", args: { day: "Wednesday" } }, turn()).ok,
    true,
  );
  assert.equal(
    scoreAssertion({ type: "tool_called", name: "book_appointment", args: { day: "Friday" } }, turn()).ok,
    false,
  );
  assert.equal(scoreAssertion({ type: "tool_called", name: "cancel" }, turn()).ok, false);
});

test("latency_budget is soft and gates ttfb and/or turn", () => {
  const ok = scoreAssertion({ type: "latency_budget", ttfbMs: 800, turnMs: 1500 }, turn());
  assert.equal(ok.ok, true);
  assert.equal(ok.soft, true);
  const overTtfb = scoreAssertion({ type: "latency_budget", ttfbMs: 200 }, turn());
  assert.equal(overTtfb.ok, false);
  const overTurn = scoreAssertion({ type: "latency_budget", turnMs: 500 }, turn());
  assert.equal(overTurn.ok, false);
});

// --- aggregate helpers ------------------------------------------------------

test("percentile (nearest-rank)", () => {
  assert.equal(percentile([640, 690, 720], 0.95), 720);
  assert.equal(percentile([640, 690, 720], 0.5), 690);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([5], 0.5), 5);
});

test("VAQI composite weighting (interruptions 40 / missed 40 / latency 20)", () => {
  assert.equal(computeVaqi({ bargeRecoveryRate: 1, missedResponseRate: 0, turnP95: 720 }), 100);
  assert.equal(computeVaqi({ bargeRecoveryRate: null, missedResponseRate: 0, turnP95: 1500 }), 80);
  assert.equal(computeVaqi({ bargeRecoveryRate: 0.5, missedResponseRate: 0.5, turnP95: 800 }), 60);
});

// --- LLM-judge stub ---------------------------------------------------------

test("heuristic judge is a labeled stub keyed on keyword coverage", () => {
  const r = heuristicJudge({ agentText: "Booked Wednesday at 10", expectedKeywords: ["Wednesday"] });
  assert.equal(r.pass, true);
  assert.match(r.rationale, /^\[STUB\]/);
  const empty = heuristicJudge({ agentText: "", expectedKeywords: ["Wednesday"] });
  assert.equal(empty.pass, false);
  assert.deepEqual(expectedKeywordsFor([{ type: "contains", value: "x" }, { type: "regex", value: "y" }]), ["x"]);
});

// --- evaluate() end to end on small in-memory runs -------------------------

function mkScenario(expect, thresholds = {}) {
  return { id: "t", persona: "p", turns: [{ caller_says: "hello", expect }], thresholds };
}
function mkRun(turnOver = {}) {
  return {
    scenarioId: "t",
    agentId: "a",
    mode: "offline",
    turns: [
      {
        index: 0,
        callerText: "hello",
        agentText: "hi there",
        ttfbMs: 300,
        turnMs: 700,
        asrHypothesis: null,
        toolCalls: [],
        bargeIn: null,
        ...turnOver,
      },
    ],
  };
}

test("evaluate: clean pass", () => {
  const sc = evaluate(mkScenario([{ type: "contains", value: "hi" }]), mkRun());
  assert.equal(sc.verdict, "PASS");
  assert.equal(sc.metrics.tsr.value, 100);
  assert.equal(sc.counts.hardFailures, 0);
});

test("evaluate: failed content assertion -> FAIL", () => {
  const sc = evaluate(mkScenario([{ type: "contains", value: "goodbye" }]), mkRun());
  assert.equal(sc.verdict, "FAIL");
  assert.equal(sc.counts.hardFailures, 1);
  assert.equal(sc.metrics.tsr.value, 0);
});

test("evaluate: soft latency miss -> WARN (not FAIL)", () => {
  const sc = evaluate(
    mkScenario([{ type: "contains", value: "hi" }, { type: "latency_budget", ttfbMs: 200 }]),
    mkRun({ ttfbMs: 300 }),
  );
  assert.equal(sc.verdict, "WARN");
  assert.equal(sc.counts.hardFailures, 0);
  assert.equal(sc.counts.softMisses, 1);
});

test("evaluate: warn-band metric -> WARN", () => {
  const sc = evaluate(mkScenario([{ type: "contains", value: "hi" }]), mkRun({ ttfbMs: 500 }));
  assert.equal(sc.metrics.ttfbP95.band, "warn");
  assert.equal(sc.verdict, "WARN");
});

test("evaluate: aggregate-gate breach -> FAIL", () => {
  // ttfb 900 fails the default <=800 gate even though the only assertion passes.
  const sc = evaluate(mkScenario([{ type: "contains", value: "hi" }]), mkRun({ ttfbMs: 900 }));
  assert.equal(sc.metrics.ttfbP95.gatePass, false);
  assert.equal(sc.verdict, "FAIL");
});
