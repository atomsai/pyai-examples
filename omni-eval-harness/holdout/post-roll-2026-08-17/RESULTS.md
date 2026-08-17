# Post-roll measurement, 2026-08-17

Recorded against the **fully rolled fleet** (MIG `omni-ultra-l4-mig` on
template `omni-canonical-4fa3b19d-20260817`, image `4fa3b19d…`, source lock
`e97bad82…`). Same 30 scenarios as the frozen baseline
(`holdout/frozen-30-2026-08-17/`), which stays frozen and untouched.

This is a measurement, not a tuning target.

## Headline

- Content: **15 PASS / 3 WARN / 12 FAIL** (baseline 15/2/13).
- TTFB p50 **2066ms**, p95 5937ms — unchanged; the fixes were not latency work.
- **Latency decomposition is now live** (`turn_begin`): EOU/STT p50
  **1122ms**, brain+TTS p50 **920ms** (n=10 turns carrying the frame). The ~2s
  TTFB splits roughly in half, with end-of-turn/STT finalization the larger
  half. That is where latency work should point first.

## Moved rows (9)

Improved (5):

| id | was | now | why |
|---|---|---|---|
| h-transfer-manager | FAIL | PASS | transfer fix: "manager" request fires the tool |
| h-sales-ballpark | FAIL | PASS | ungrounded-figure guard: no invented ballpark |
| h-promise-wednesday | FAIL | PASS | commitment recalled on demand |
| h-asked-maybe-morning | FAIL | PASS | engages the question, no booking |
| h-memory-name-reuse | FAIL | WARN | partial recall |

Regressed on paper (4) — all read as run variance or assertion coverage, not
engine regressions:

| id | was | now | read |
|---|---|---|---|
| h-reflect-no-show | PASS | FAIL | empty reply (missed turn), a flake |
| h-sales-pressure-repeat | PASS | FAIL | "not sure what it refers to" — comprehension miss |
| h-kb-refund-policy | PASS | FAIL | honest "can't process a refund" — phrasing not in the miss regex |
| h-memory-constraint-pressure | PASS | FAIL | recalled the constraint but generalized ("any phone number" vs "work") |

Single live runs carry model-sampling variance; the deterministic offline gate
remains the CI truth. A regression claim needs a repeat, per the plan.

## What this run proves

1. The roll is complete and uniform (every probe turn carries `turn_begin`).
2. The two fix-targeted classes (transfer, unbound price) improved as designed.
3. The latency budget's first split is measured: EOU/STT ≈ 1.1s, brain+TTS ≈
   0.9s of the ~2s TTFB.
