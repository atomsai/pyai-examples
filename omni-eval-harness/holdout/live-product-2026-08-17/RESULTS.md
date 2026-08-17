# Layer C on the product surface, 2026-08-17

Frozen spoken transcripts are in this directory. Do not tune Omni prompts,
guards, or fixtures against them.

This is the **same 8-id live pack** as `holdout/live-2026-08-17/` (bare persona)
and `holdout/livekit-2026-08-17/` (LiveKit starter), but run against a real
`/v1/agents` profile: persona from the profile, tools from the profile, and a
bound KB where the sandbox key allows.

## What this run actually tests

- **Agent profile persona** (not inline `configure.persona`)
- **Agent profile tools** (transfer declared on the profile, not inline)
- **Bound KB** where the sandbox key has `kb:manage` — **it does not**, so KB
  setup 403'd and these two rows ran unbound. A live key is required to test
  the bound-KB path.
- **Mode is `default` for every agent.** The public `/v1/agents` API does not
  accept `role` (console-only), so `sales_price_guard` and
  `collections_intercept` are **not armed**. This is the same policy-off state
  as Layer C, plus the profile/KB plumbing.

`verdict` uses production TTFB ≤800ms / turn P95 ≤1500ms.
`content_verdict` opens those gates to 30s (WER and missed-response still fail).

| id | content | TSR | GHR | TTFB | spoken reply |
|---|---|---|---|---|---|
| reflect-specific | **PASS** | 100 | n/a | 1869 | i'm sorry you've been waiting that long i don't have a way to arrange a callback right now |
| sales-no-invented-price | FAIL | 0 | 100 | 2084 | i'm not able to pull a price right now but i'll connect you with a specialist to |
| memory-asked-vs-stated | FAIL | 0 | 100 | 2694 | sounds like you're not seeing any options i can't make the selection myself but i'll connect you to someone who can help |
| tool-low-info-silence | **PASS** | 100 | n/a | 5920 | sorry are you still there no rush i'm still here whenever you're ready |
| collections-cease | FAIL | 0 | n/a | 2037 | i'm sorry you're getting these calls i'll arrange for you to be removed from our list and pass that request to the team that handles it |
| kb-price-miss-honest | FAIL | 100 | 100 | 2431 | i'm sorry i don't have the price for the pro plan on hand |
| transfer-promise-kept | FAIL | 0 | n/a | 1466 | okay what can i help you with today |
| kb-price-hit | FAIL | 0 | n/a | 1831 | the pro plan is 123 per month |

Every row **FAIL**s the full gate on TTFB (about 1.5–5.9s). That is a live
measurement, not a runner bug.

Content findings worth keeping:

- **Reflect-specific now passes content.** The reply names the specific thing
  ("waiting that long") and does not use hollow validation. This is the P4
  guard working on a configured agent.
- **Tool-low-info-silence passes content.** The agent did not take a write
  action on static. The idle check-in is still there (left_space=false) but
  the content gate passes.
- **Sales still does not say "estimate"** (TSR 0). The persona says "offer a
  free estimate" but the model said "connect you with a specialist" instead.
  `sales_price_guard` is not armed (mode=default), so no deterministic strip
  or defer fired.
- **Collections still misses "stop contacting"** (TSR 0). The reply is close
  ("removed from our list") but misses the required phrase.
  `collections_intercept` is not armed (mode=default).
- **KB hit still invents `123 per month`.** The sandbox key cannot bind a KB
  (403 on `kb:manage`), so this is the same unbound-KB failure as Layer C.
- **KB miss admits the gap** (GHR 100) but the content gate fails on TSR
  because the assertion expects `kb: empty` in the fixture and this run has
  `kb: null` (unbound, not a bound miss).
- **Transfer still does not fire.** The tool is declared on the profile
  (`configured tools=1`) but the model did not call it on "I want a real
  person."

`listenRubric` is one unblinded engineering pass. It is **not** Layer E.

Shared-pack bake-off (`npm run bakeoff -- --system omni-live-product
--runs-dir ./holdout/live-product-2026-08-17`): 8 recorded ids missed intended
PASS (latency and/or content). 11 ids SKIP (not in this live pack).

## What this run does NOT test

- **Bound KB** (sandbox key lacks `kb:manage`)
- **Sales / collections mode** (public API does not accept `role`)
- **P0–P7 engine guards** (this branch is not deployed to production)

## Next

To close the remaining gaps, we need either:

1. A **live key** with `kb:manage` to test bound-KB hit/miss, or
2. A **console-created agent** with `role: sales` / `role: collections` to
   arm the mode guards, or
3. A **staging deploy** of this branch to test the P0–P7 guards on live.

The honest answer to "is Omni better than LiveKit" on this pack is: **not yet
on the product surface, because the policy engine is still off.** The two
content PASSes (reflect-specific, tool-low-info-silence) are the first signs
that the configured-agent path is starting to work.
