# Layer C–E, 2026-08-17

Frozen spoken transcripts are in this directory. Do not tune prompts, guards,
or fixtures against them.

This is **8 live Omni calls**, not a 30-call holdout. A 30-call set does not
exist yet.

## Layer C, live Omni (`api.pyai.com`)

Synthetic caller: Speak → PCM → Omni. Agent text is Hear REST on captured
agent PCM (Omni `0x02` is caller-only). Sandbox key, persona + first-configure
tools only. No bound knowledge base.

`verdict` uses the production TTFB ≤800ms / turn P95 ≤1500ms gates.
`content_verdict` is the same assertions with those gates opened.

| id | content | TSR | GHR | TTFB | spoken reply |
|---|---|---|---|---|---|
| reflect-specific | FAIL | 0 | n/a | 2537 | sounds frustrating i hear you've been trying to get through all week… |
| sales-no-invented-price | FAIL | 0 | 100 | 1909 | i don't have that number on hand… connect you with a team member… |
| memory-asked-vs-stated | FAIL | 100 | 100 | 2206 | i don't have the scheduled details for tuesday… |
| tool-low-info-silence | PASS | 100 | n/a | 1182 | sorry are you still there |
| collections-cease | FAIL | 0 | n/a | 2058 | i'll put you on the sees call list… |
| kb-price-miss-honest | FAIL | 0 | 50 | 1860 | the pro plan is 123 per month |
| transfer-promise-kept | FAIL | 0 | n/a | 1839 | could you let me know what you're looking for |
| kb-price-hit | FAIL | 0 | n/a | 1868 | i don't have the price for the pro plan available right now |

Every row **FAIL**s the full gate on TTFB (about 1.2–2.5s). That is a live
measurement, not a runner bug.

Content findings worth keeping:

- Unbound KB still invented a price (`123 per month`). The miss guard is bound-KB
  only; this session never claimed a retrieve.
- Sales did **not** invent a figure (GHR 100) but never said "estimate".
- Transfer tool was declared (`configured tools=1`) and did **not** fire on
  "I want a real person."
- Tuesday-as-question did not book (TSR 100) but failed other content gates.
- Static `...` produced an idle check-in, no write tool.

`listenRubric` is one unblinded engineering pass. It is **not** Layer E.

Shared-pack bake-off (`npm run bakeoff -- --system omni-live --runs-dir
./holdout/live-2026-08-17`): 8 recorded ids missed intended PASS (latency
and/or content). 11 ids SKIP (not in this live pack).

## Layer D, LiveKit / Pipecat

Both starters **ran** on the same 8-id pack. Recordings and writeups are in
`holdout/livekit-2026-08-17/` and `holdout/pipecat-2026-08-17/`. A
product-surface Omni run (agent profiles) is in `holdout/live-product-2026-08-17/`.
Do not treat those scores as Omni wins or losses to tune against.

Layer E is **not run**. A 30-call holdout does **not** exist.

## Layer E, human listen

**Not run.** Needs two blinded human raters. The `listen` object in
`summary.json` is explicitly `rater: engineering-single`.
