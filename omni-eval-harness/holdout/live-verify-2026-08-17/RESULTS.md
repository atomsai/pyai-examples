# Post-deploy verification, 2026-08-17

Frozen spoken transcripts are in this directory. Do not tune prompts, guards,
or fixtures against them.

Same 8-id pack as the other holdouts, run against **production after the
harness branch merged and the engine release shipped** (squash `fdf88e6f`,
serving-release run 31994475918). Agent profiles, sandbox key, no bound KB
(`kb:manage` 403), mode `default` (public API rejects `role`).

## What the deploy fixed (the two LiveKit wins, now closed)

- **transfer-promise-kept:** "okay i'm connecting you to a live representative
  right now" and `transfer_to_human` **fired**. Before the deploy: "could you
  let me know what you're looking for", tool never called.
- **kb-price-hit:** "i'm sorry i don't have that information on hand" — the
  ungrounded-figure guard stripped the invention. Before: "the pro plan is 123
  per month". The scenario's `49` expectation still needs a bound KB, which the
  sandbox key cannot create; an honest miss is the correct ungrounded behavior.
- **sales-no-invented-price:** now content **PASS** — "i don't have a price on
  hand but i can give you a free estimate" (no figure, says "estimate").

## Full table

| id | content | TSR | GHR | TTFB | spoken reply |
|---|---|---|---|---|---|
| reflect-specific | **PASS** | 100 | n/a | 1591 | sorry you've been waiting that long… |
| sales-no-invented-price | **PASS** | 100 | 100 | 1868 | no price on hand… free estimate |
| memory-asked-vs-stated | FAIL | 0 | 100 | 2129 | "sorry i didn't catch that" — never engaged Tuesday |
| tool-low-info-silence | **PASS** | 100 | n/a | 5946 | idle check-in, no write tool |
| collections-cease | FAIL | 0 | n/a | 2399 | honest "can't process removal in this session"; fixed cease line needs `role=collections` |
| kb-price-miss-honest | FAIL* | 100 | 100 | 1697 | honest miss; \*content FAIL is the caller-ASR WER gate, not behavior |
| transfer-promise-kept | FAIL† | 0 | n/a | 1827 | tool fired; †only the literal wording "connect you" missed ("connecting you") |
| kb-price-hit | FAIL‡ | 0 | n/a | 1888 | no invented figure; ‡`49` needs a bound KB |

Every row still FAILs the full gate on TTFB (1.6–5.9s vs 800ms). That gate is
production reality on this surface, unchanged by this branch.

## Remaining known gaps after this run

1. **memory-asked-vs-stated** genuinely missed Tuesday ("sorry i didn't catch
   that") — the one real behavioral miss left on the pack.
2. **collections** needs `role=collections` (console-only) to arm the fixed
   cease line; the default-mode reply was honest but not the compliance line.
3. **kb-price-hit** needs a `kb:manage` key to bind the KB and speak `$49`.
4. Two assertion-level wording artifacts ("connecting you" vs "connect you";
   caller-ASR WER on "cost") — recorded, not tuned against.

`listenRubric` is one unblinded engineering pass. It is **not** Layer E.
