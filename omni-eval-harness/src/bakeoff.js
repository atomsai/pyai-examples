// Layer D shared pack — same scripts LiveKit / Pipecat starters can run.
//
// Omni-only assertions (ledger_has, idle_patient) are stripped before a
// cross-system score. Ground truth for a bake-off is the spoken transcript +
// tool trace, not Omni conversation_state. Offline Omni fixtures here are the
// *contract* (intended PASS). A live Omni / LiveKit / Pipecat run replaces the
// fixture; this file does not call those stacks.

import { loadScenario, resolveScenarioPath } from "./scenario.js";
import { loadFixture, resolveFixturePath } from "./fixture.js";
import { evaluate } from "./scorers.js";

export const OMNI_ONLY_ASSERTIONS = new Set(["ledger_has", "idle_patient"]);

/** Scenarios whose scores are comparable without Omni ledger telemetry. */
export const SHARED_PACK = [
  { id: "appointment-booking", intended: "PASS" },
  { id: "memory-order-id-late", intended: "PASS" },
  { id: "memory-name-time-joint", intended: "PASS" },
  { id: "memory-asked-vs-stated", intended: "PASS" },
  { id: "memory-constraint-kept", intended: "PASS" },
  { id: "promise-thursday-kept", intended: "PASS" },
  { id: "kb-price-hit", intended: "PASS" },
  { id: "kb-price-miss-honest", intended: "PASS" },
  { id: "kb-prefer-over-persona", intended: "PASS" },
  { id: "tool-confirm-payment", intended: "PASS" },
  { id: "tool-confirm-book-it", intended: "PASS" },
  { id: "tool-low-info-silence", intended: "PASS" },
  { id: "transfer-promise-kept", intended: "PASS" },
  { id: "sales-no-invented-price", intended: "PASS" },
  { id: "collections-cease", intended: "PASS" },
  { id: "question-ceiling-support", intended: "PASS" },
  { id: "reflect-specific", intended: "PASS" },
  { id: "barge-partial-context", intended: "PASS" },
  { id: "slow-tool-bridge", intended: "PASS" },
  { id: "social-repeated-ask", intended: "PASS" },
  { id: "social-tool-failure", intended: "PASS" },
  { id: "social-interruption-resume", intended: "PASS" },
];

export function toSharedScenario(scenario) {
  return {
    ...scenario,
    turns: (scenario.turns || []).map((turn) => ({
      ...turn,
      expect: (turn.expect || []).filter((a) => !OMNI_ONLY_ASSERTIONS.has(a.type)),
    })),
  };
}

export function scoreSharedEntry(id, baseDir, run) {
  const scenario = toSharedScenario(loadScenario(resolveScenarioPath(id, baseDir)));
  const recorded = run ?? loadFixture(resolveFixturePath(id, baseDir));
  return evaluate(scenario, recorded);
}

export function scoreSharedPack(baseDir, runsById = {}, { requireRuns = false } = {}) {
  return SHARED_PACK.map((entry) => {
    const run = runsById[entry.id];
    if (requireRuns && !run) {
      return {
        id: entry.id,
        intended: entry.intended,
        verdict: "SKIP",
        ok: false,
        tsr: null,
        qRate: null,
        crr: null,
        rar: null,
        ghr: null,
        hps: null,
        ttfbP95: null,
        bargeRecovery: null,
      };
    }
    const sc = scoreSharedEntry(entry.id, baseDir, run);
    return {
      id: entry.id,
      intended: entry.intended,
      verdict: sc.verdict,
      ok: sc.verdict === entry.intended,
      tsr: sc.metrics.tsr.value,
      qRate: sc.metrics.qRate.value,
      crr: sc.metrics.crr.value,
      rar: sc.metrics.rar.value,
      ghr: sc.metrics.ghr.value,
      hps: sc.metrics.hps.value,
      ttfbP95: sc.metrics.ttfbP95.value,
      bargeRecovery: sc.metrics.bargeRecovery.value,
    };
  });
}
