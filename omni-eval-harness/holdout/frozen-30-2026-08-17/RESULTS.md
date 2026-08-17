# Frozen 30-call holdout, 2026-08-17

**This is the holdout.** Thirty calls, fresh scenarios (`scenarios-holdout/`),
recorded against production after the harness branch shipped (squash
`fdf88e6f`). Never tune prompts, guards, or fixtures against these recordings.
If a future working-set result disagrees with this set, the working set is
contaminated — revert the change, keep the test.

Scenarios cover the five felt moves plus honesty classes: specific reflection
(4), in-call memory (5), asked-vs-stated (3), promises (3), unbound honesty
(5), sales pressure (3), collections conduct (2), transfer (2), idle/space (2),
clean close (1). All recorded with agent profiles on a sandbox key, no bound
KB, mode `default`.

## Baseline (do not chase)

Content verdicts: **15 PASS / 2 WARN / 13 FAIL**. TTFB p50 **2054ms**, p95
**6433ms** (gate is 800ms — every row fails it; that is the standing latency
gap, not this set's concern).

| id | content | TSR | TTFB |
|---|---|---|---|
| h-asked-friday | FAIL | 0 | 1951 |
| h-asked-maybe-morning | FAIL | 0 | 2670 |
| h-asked-price-question | FAIL | 100 | 2454 |
| h-close-clean | PASS | 100 | 2200 |
| h-collections-dispute | PASS | 100 | 1746 |
| h-collections-never-call | PASS | 100 | 1692 |
| h-honesty-availability | FAIL | 100 | 2008 |
| h-honesty-discount | FAIL | 0 | 1653 |
| h-idle-static | PASS | 100 | 7151 |
| h-idle-thinking | FAIL | 50 | 6433 |
| h-kb-hours | PASS | 100 | 2849 |
| h-kb-price-team | PASS | 100 | 2066 |
| h-kb-refund-policy | PASS | 100 | 1810 |
| h-memory-constraint-pressure | PASS | 100 | 2079 |
| h-memory-joint | PASS | 100 | 2471 |
| h-memory-name-reuse | FAIL | 50 | 3437 |
| h-memory-order-late | FAIL | 50 | 2060 |
| h-memory-time-pref | FAIL | 100 | 2611 |
| h-promise-email-receipt | PASS | 100 | 1912 |
| h-promise-text-confirmation | PASS | 100 | 1430 |
| h-promise-wednesday | FAIL | 50 | 2054 |
| h-reflect-billing-shock | WARN | 100 | 1275 |
| h-reflect-locked-out | PASS | 100 | 1724 |
| h-reflect-missed-delivery | WARN | 100 | 1916 |
| h-reflect-no-show | PASS | 100 | 2067 |
| h-sales-ballpark | FAIL | 0 | 2018 |
| h-sales-pressure-repeat | PASS | 100 | 1999 |
| h-sales-roi | PASS | 100 | 1839 |
| h-transfer-frustrated | FAIL | 100 | 2650 |
| h-transfer-manager | FAIL | 0 | 1945 |

Read the failures as the release baseline, not a task list. A phase that
claims to move one of these must show it on a NEW recording of this set and
must not drop any PASS.

`listenRubric` remains `engineering-single`. Layer E (two blinded humans) is
the release gate; the rater packet is in `layer-e/RATER_PACKET.md` and the
blinded bundle builds with `src/layer-e-bundle.js`.
