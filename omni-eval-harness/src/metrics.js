// Voice-native metric catalog with thresholds.
//
// These mirror the names + bands in docs/PYAI_EVALS_PLATFORM_PLAN_2026-06-16.md
// §4. The catalog is kept self-contained here on purpose: a sibling agent is
// building an engine-benchmark scorer set under evals/, and this harness must
// NOT depend on it — but the metric names and thresholds match so scorecards are
// comparable across both.
//
// Bands (good / warn / critical):
//   ASR   WER                <5%   / 5-10%      / >10%
//   Lat   TTFB (P95)         <400  / 400-800ms  / >800ms
//   Lat   turn latency P95   <800  / 800-1500ms / >1500ms
//   Turn  barge recovery     >90%  / 80-90%     / <80%
//   Out   Task Success Rate  >85%  / 75-85%     / <75%
//   Comp  VAQI (0-100)       >70 strong (we set warn at 60)

/** @typedef {"good"|"warn"|"critical"|"na"} Band */

export const METRICS = {
  wer: {
    key: "wer",
    label: "WER (ASR)",
    unit: "%",
    lowerIsBetter: true,
    good: 5,
    warn: 10,
    // Which scenario.thresholds key overrides the pass/fail gate for this metric.
    thresholdKey: "werPct",
  },
  ttfbP95: {
    key: "ttfbP95",
    label: "TTFB P95 (time-to-first-word)",
    unit: "ms",
    lowerIsBetter: true,
    good: 400,
    warn: 800,
    thresholdKey: "ttfbMs",
  },
  turnP95: {
    key: "turnP95",
    label: "Turn latency P95",
    unit: "ms",
    lowerIsBetter: true,
    good: 800,
    warn: 1500,
    thresholdKey: "turnP95Ms",
  },
  bargeRecovery: {
    key: "bargeRecovery",
    label: "Barge-in recovery rate",
    unit: "%",
    lowerIsBetter: false,
    good: 90,
    warn: 80,
    thresholdKey: "bargeRecoveryPct",
  },
  tsr: {
    key: "tsr",
    label: "Task Success Rate",
    unit: "%",
    lowerIsBetter: false,
    good: 85,
    warn: 75,
    thresholdKey: "tsrPct",
  },
  vaqi: {
    key: "vaqi",
    label: "VAQI (composite)",
    unit: "",
    lowerIsBetter: false,
    good: 70,
    warn: 60,
    thresholdKey: "vaqi",
  },
};

/** The scenario.thresholds keys recognized as gate overrides. */
export const THRESHOLD_KEYS = Object.values(METRICS).map((m) => m.thresholdKey);

/**
 * Classify a metric value into a good/warn/critical band per the catalog. Bands
 * use strict outer edges to match the plan ("<5% good", ">85% good"): the `good`
 * edge is exclusive, the `warn` edge inclusive.
 * @returns {Band}
 */
export function classify(spec, value) {
  if (value == null || Number.isNaN(value)) return "na";
  if (spec.lowerIsBetter) {
    if (value < spec.good) return "good";
    if (value <= spec.warn) return "warn";
    return "critical";
  }
  if (value > spec.good) return "good";
  if (value >= spec.warn) return "warn";
  return "critical";
}

/**
 * The pass/fail gate line for a metric. A scenario may override it via
 * scenario.thresholds[spec.thresholdKey]; otherwise we gate at the catalog's
 * warn edge (i.e. "critical" fails, "warn"/"good" pass).
 */
export function gateLine(spec, scenarioThresholds = {}) {
  const override = scenarioThresholds?.[spec.thresholdKey];
  return typeof override === "number" ? override : spec.warn;
}

/** Does `value` satisfy the gate `line` given the metric's direction? */
export function gatePass(spec, value, line) {
  if (value == null || Number.isNaN(value)) return true; // n/a never fails a gate
  return spec.lowerIsBetter ? value <= line : value >= line;
}

const BAND_TO_VERDICT = { good: "PASS", warn: "WARN", critical: "FAIL", na: "SKIP" };

/** Map a band to a PASS/WARN/FAIL/SKIP verdict label. */
export function bandVerdict(band) {
  return BAND_TO_VERDICT[band] ?? "SKIP";
}
