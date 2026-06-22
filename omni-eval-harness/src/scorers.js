// Deterministic scoring engine.
//
// Two layers, both pure and fully unit-tested (no network, no key):
//   1. Per-turn assertion scorers  — contains / not_contains / regex /
//      tool_called / latency_budget.
//   2. Aggregate metric scorers    — WER, TTFB P95, turn-latency P95, barge-in
//      recovery, Task Success Rate, and the VAQI composite, classified against
//      the catalog in metrics.js.
//
// `evaluate()` ties them together into a structured scorecard object that
// scorecard.js renders to markdown/JSON. It works identically on a RunResult
// produced by the OFFLINE fixture loader or the LIVE runner.

import {
  METRICS,
  classify,
  bandVerdict,
  gateLine,
  gatePass,
} from "./metrics.js";
import { aggregateWer, normalizedIncludes, wer } from "./text.js";
import { expectedKeywordsFor, resolveJudge } from "./judge.js";

// --- per-turn assertion scorers --------------------------------------------

/** Soft assertions affect WARN/latency metrics but do not by themselves FAIL. */
const SOFT_TYPES = new Set(["latency_budget"]);

function argsMatch(callArgs, expectedArgs) {
  if (!expectedArgs) return true;
  if (!callArgs || typeof callArgs !== "object") return false;
  for (const [k, v] of Object.entries(expectedArgs)) {
    const got = callArgs[k];
    const eq = typeof v === "object" ? JSON.stringify(got) === JSON.stringify(v) : got === v;
    if (!eq) return false;
  }
  return true; // subset match: the call may carry extra args
}

/** Score one assertion against one normalized turn. */
export function scoreAssertion(assertion, turn) {
  const type = assertion.type;
  const soft = SOFT_TYPES.has(type);
  const agentText = turn.agentText ?? "";

  switch (type) {
    case "contains": {
      const ok = normalizedIncludes(agentText, assertion.value);
      return { type, ok, soft, detail: ok ? `found "${assertion.value}"` : `missing "${assertion.value}"` };
    }
    case "not_contains": {
      const ok = !normalizedIncludes(agentText, assertion.value);
      return { type, ok, soft, detail: ok ? `absent "${assertion.value}"` : `unexpected "${assertion.value}"` };
    }
    case "regex": {
      let re;
      try {
        re = new RegExp(assertion.value, assertion.flags ?? "");
      } catch (err) {
        return { type, ok: false, soft, detail: `invalid regex: ${err.message}` };
      }
      const ok = re.test(agentText);
      return { type, ok, soft, detail: ok ? `matched /${assertion.value}/` : `no match /${assertion.value}/` };
    }
    case "tool_called": {
      const calls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
      const ok = calls.some((c) => c.name === assertion.name && argsMatch(c.args, assertion.args));
      const seen = calls.map((c) => c.name).join(", ") || "none";
      return { type, ok, soft, detail: ok ? `tool "${assertion.name}" called` : `tool "${assertion.name}" not called (saw: ${seen})` };
    }
    case "latency_budget": {
      const parts = [];
      let ok = true;
      if (typeof assertion.ttfbMs === "number") {
        const within = typeof turn.ttfbMs === "number" && turn.ttfbMs <= assertion.ttfbMs;
        if (!within) ok = false;
        parts.push(`ttfb ${fmtMs(turn.ttfbMs)}<=${assertion.ttfbMs}ms ${within ? "ok" : "OVER"}`);
      }
      if (typeof assertion.turnMs === "number") {
        const within = typeof turn.turnMs === "number" && turn.turnMs <= assertion.turnMs;
        if (!within) ok = false;
        parts.push(`turn ${fmtMs(turn.turnMs)}<=${assertion.turnMs}ms ${within ? "ok" : "OVER"}`);
      }
      return { type, ok, soft, detail: parts.join("; ") || "no budget set" };
    }
    default:
      return { type: type ?? "unknown", ok: false, soft: false, detail: `unknown assertion type "${type}"` };
  }
}

function fmtMs(v) {
  return typeof v === "number" ? String(Math.round(v)) : "n/a";
}

// --- aggregate helpers ------------------------------------------------------

/** Percentile (nearest-rank) of a numeric array. Returns null when empty. */
export function percentile(values, q) {
  const xs = values.filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1));
  return xs[idx];
}

/**
 * VAQI composite (0-100): interruptions 40% + missed-response 40% + latency
 * 20%, exactly the weighting in the evals plan §4. Each sub-score is 0..1:
 *   interruptions  = barge-in recovery rate (1.0 when no barge was attempted)
 *   missed         = 1 - (turns with an empty agent reply / total turns)
 *   latency        = turnP95 mapped linearly from the good edge (1.0) to the
 *                    warn edge (0.0) of the turn-latency band.
 */
export function computeVaqi({ bargeRecoveryRate, missedResponseRate, turnP95 }) {
  const interruptions = bargeRecoveryRate == null ? 1 : bargeRecoveryRate;
  const missed = 1 - (missedResponseRate ?? 0);
  const good = METRICS.turnP95.good;
  const warn = METRICS.turnP95.warn;
  let latency;
  if (turnP95 == null) latency = 1;
  else if (turnP95 <= good) latency = 1;
  else if (turnP95 >= warn) latency = 0;
  else latency = 1 - (turnP95 - good) / (warn - good);
  const vaqi = 100 * (0.4 * interruptions + 0.4 * missed + 0.2 * latency);
  return Math.round(vaqi * 10) / 10;
}

// --- the full evaluation ----------------------------------------------------

/**
 * Evaluate a RunResult against a scenario, producing a structured scorecard.
 * @param {object} scenario  loaded + validated scenario
 * @param {object} run       normalized RunResult (offline fixture or live run)
 * @param {object} [opts]    { judgeFn, judgeName }
 */
export function evaluate(scenario, run, opts = {}) {
  const judge = resolveJudge(opts);
  const thresholds = scenario.thresholds ?? {};
  const scenarioTurns = scenario.turns ?? [];

  const turns = run.turns.map((turn, i) => {
    const spec = scenarioTurns[i] ?? {};
    const assertions = (spec.expect ?? []).map((a) => scoreAssertion(a, turn));
    const hardOk = assertions.filter((r) => !r.soft).every((r) => r.ok);
    const softOk = assertions.filter((r) => r.soft).every((r) => r.ok);

    const perTurnWer =
      turn.asrHypothesis != null ? Number(wer(turn.callerText, turn.asrHypothesis).toFixed(2)) : null;

    const judgeResult = judge({
      callerText: turn.callerText,
      agentText: turn.agentText,
      expectedKeywords: expectedKeywordsFor(spec.expect ?? []),
      persona: scenario.persona,
    });

    return {
      index: i,
      callerText: turn.callerText,
      agentText: turn.agentText ?? "",
      ttfbMs: turn.ttfbMs ?? null,
      turnMs: turn.turnMs ?? null,
      asrHypothesis: turn.asrHypothesis ?? null,
      werPct: perTurnWer,
      toolCalls: turn.toolCalls ?? [],
      bargeIn: turn.bargeIn ?? null,
      assertions,
      hardOk,
      softOk,
      judge: { ...judgeResult, stub: judge.stub },
    };
  });

  // ---- aggregate metrics ----
  const werPct = aggregateWer(
    run.turns
      .filter((t) => t.asrHypothesis != null)
      .map((t) => ({ reference: t.callerText, hypothesis: t.asrHypothesis })),
  );
  const ttfbP95 = percentile(run.turns.map((t) => t.ttfbMs), 0.95);
  const ttfbP50 = percentile(run.turns.map((t) => t.ttfbMs), 0.5);
  const turnP95 = percentile(run.turns.map((t) => t.turnMs), 0.95);
  const turnP50 = percentile(run.turns.map((t) => t.turnMs), 0.5);

  const bargeAttempts = run.turns.filter((t) => t.bargeIn?.attempted).length;
  const bargeRecovered = run.turns.filter((t) => t.bargeIn?.attempted && t.bargeIn?.recovered).length;
  const bargeRecoveryRate = bargeAttempts > 0 ? bargeRecovered / bargeAttempts : null;
  const bargeRecoveryPct = bargeRecoveryRate == null ? null : Number((bargeRecoveryRate * 100).toFixed(1));

  const totalTurns = turns.length;
  const passedTurns = turns.filter((t) => t.hardOk).length;
  const tsr = totalTurns > 0 ? Number(((passedTurns / totalTurns) * 100).toFixed(1)) : null;

  const missedTurns = run.turns.filter((t) => (t.agentText ?? "").trim() === "").length;
  const missedResponseRate = totalTurns > 0 ? missedTurns / totalTurns : 0;

  const vaqi = computeVaqi({ bargeRecoveryRate, missedResponseRate, turnP95 });

  const rawValues = {
    wer: werPct,
    ttfbP95,
    turnP95,
    bargeRecovery: bargeRecoveryPct,
    tsr,
    vaqi,
  };

  const metrics = {};
  for (const spec of Object.values(METRICS)) {
    const value = rawValues[spec.key];
    const band = classify(spec, value);
    const line = gateLine(spec, thresholds);
    const passes = gatePass(spec, value, line);
    metrics[spec.key] = {
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      value,
      band,
      verdict: bandVerdict(band),
      gateLine: line,
      gatePass: passes,
      lowerIsBetter: spec.lowerIsBetter,
    };
  }

  // ---- overall verdict ----
  const hardFailures = turns.filter((t) => !t.hardOk).length;
  const softMisses = turns.filter((t) => !t.softOk).length;
  const gateFailed = Object.values(metrics).some((m) => !m.gatePass);
  const anyWarn = Object.values(metrics).some((m) => m.band === "warn");

  let verdict;
  if (hardFailures > 0 || gateFailed) verdict = "FAIL";
  else if (anyWarn || softMisses > 0) verdict = "WARN";
  else verdict = "PASS";

  return {
    scenarioId: scenario.id,
    agentId: run.agentId ?? scenario.agent_id ?? null,
    persona: scenario.persona ?? null,
    mode: run.mode ?? "offline",
    source: run.source ?? null,
    generatedAt: new Date().toISOString(),
    verdict,
    metrics,
    extra: {
      ttfbP50,
      turnP50,
      bargeAttempts,
      bargeRecovered,
      missedTurns,
      missedResponseRate: Number((missedResponseRate * 100).toFixed(1)),
      turnsTotal: totalTurns,
      turnsPassed: passedTurns,
    },
    judge: { stub: judge.stub, name: judge.name_ },
    counts: { turns: totalTurns, hardFailures, softMisses },
    turns,
  };
}
