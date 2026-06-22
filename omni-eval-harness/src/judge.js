// LLM-as-judge — STUB (clearly marked, pluggable).
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ THIS DOES NOT CALL ANY MODEL.                                          │
// │ It is a deterministic heuristic stand-in so the harness runs offline,  │
// │ in CI, with no judge credentials. Every rationale is prefixed [STUB].  │
// └───────────────────────────────────────────────────────────────────────┘
//
// To plug in a REAL judge, pass `{ judgeFn }` to evaluate()/buildScorecard().
// The contract a real judge must implement:
//
//   async function judgeFn(input) -> { score: number(0..1), pass: boolean, rationale: string }
//     input = {
//       callerText,        // what the synthetic caller said this turn
//       agentText,         // the agent's reply transcript
//       expectedKeywords,  // string[] pulled from the turn's contains/regex assertions
//       persona,           // the scenario persona (system prompt)
//     }
//
// Follow the §2 judge discipline from the evals plan when you implement it:
// judge model stronger than production, decompose the rubric into 3-5 binary
// checks (not a 1-10 score), pin the judge version, and keep a human-calibrated
// holdout. The stub below is intentionally simple and conservative.

import { normalizedIncludes, tokenize } from "./text.js";

/**
 * Heuristic task-success judge. Scores how well the agent reply covers the
 * turn's expected keywords, with a small bonus for actually responding. Purely
 * lexical — no semantics, no model. Treat its output as a placeholder dimension.
 */
export function heuristicJudge(input) {
  const { agentText = "", expectedKeywords = [] } = input ?? {};
  const responded = tokenize(agentText).length > 0;

  if (expectedKeywords.length === 0) {
    // Nothing to check against — credit a non-empty response, flag an empty one.
    return {
      score: responded ? 0.75 : 0,
      pass: responded,
      rationale: responded
        ? "[STUB] No expected keywords; agent produced a non-empty reply."
        : "[STUB] No expected keywords; agent reply was empty.",
    };
  }

  const hits = expectedKeywords.filter((k) => normalizedIncludes(agentText, k));
  const coverage = hits.length / expectedKeywords.length;
  // Coverage is 80% of the score; a non-empty reply earns the last 20%.
  const score = Number((coverage * 0.8 + (responded ? 0.2 : 0)).toFixed(3));
  const pass = score >= 0.6;
  return {
    score,
    pass,
    rationale: `[STUB] keyword coverage ${hits.length}/${expectedKeywords.length}` +
      (hits.length ? ` (matched: ${hits.join(", ")})` : "") +
      (responded ? "" : "; empty reply"),
  };
}

/**
 * Resolve which judge to use. Defaults to the heuristic STUB; pass a real
 * implementation via `opts.judgeFn`. Always returns a function with the judge
 * contract above plus a `stub` flag the scorecard surfaces honestly.
 */
export function resolveJudge(opts = {}) {
  if (typeof opts.judgeFn === "function") {
    const fn = (input) => opts.judgeFn(input);
    fn.stub = false;
    fn.name_ = opts.judgeName ?? "custom";
    return fn;
  }
  const fn = (input) => heuristicJudge(input);
  fn.stub = true;
  fn.name_ = "heuristic-stub";
  return fn;
}

/** Pull the keyword list a judge should look for out of a turn's assertions. */
export function expectedKeywordsFor(assertions = []) {
  const out = [];
  for (const a of assertions) {
    if (a.type === "contains" && typeof a.value === "string") out.push(a.value);
  }
  return out;
}
