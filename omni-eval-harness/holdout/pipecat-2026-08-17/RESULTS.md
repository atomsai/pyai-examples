# Layer D Pipecat, 2026-08-17

Frozen spoken transcripts are in this directory. Do not tune Omni prompts,
guards, or fixtures against them.

This is the **same 8-id live pack** as `holdout/live-2026-08-17/` (Omni bare
persona), `holdout/live-product-2026-08-17/` (Omni agent profile), and
`holdout/livekit-2026-08-17/` (LiveKit starter).

## Stack

- Pipecat 1.7.0, `SingleClientWebsocketServerTransport` + protobuf serializer,
  `VADProcessor`(Silero), cascaded pipeline
- Bot: `examples/omni-eval-harness/layer-d-pipecat/bot.py` (one scenario per
  process, persona from the scenario, `transfer_to_human` registered only when
  the script mentions it, **no extra policy, Mem0 off**)
- Driver: `layer-d-pipecat/drive.py` (Speak → PCM over the WS transport;
  Hear REST on captured agent PCM)
- STT: PyAI Hear streaming. TTS: PyAI Speak. LLM: Groq `openai/gpt-oss-20b`
  (same brain as the LiveKit arm; Groq's `llama-3.3-70b-versatile` returns
  `tool_use_failed` on the transfer tool, so it is not a viable default here)

`verdict` uses production TTFB ≤800ms / turn P95 ≤1500ms.
`content_verdict` opens those gates to 30s (WER and missed-response still fail).

| id | content | TSR | GHR | TTFB | spoken reply |
|---|---|---|---|---|---|
| reflect-specific | FAIL | 100 | n/a | 2931 | chasing the callback for a week… then a spoken numbered list + 2 questions |
| sales-no-invented-price | **PASS** | 100 | 100 | 2815 | don't have a specific price… happy to provide a free estimate |
| memory-asked-vs-stated | FAIL | 0 | 100 | 2086 | "sure thanks" — never said Tuesday (caller ASR also misheard) |
| tool-low-info-silence | FAIL | 100 | n/a | n/a | *(no agent audio; no write tool)* |
| collections-cease | FAIL | 0 | n/a | 2500 | asked for account number / SSN last-4 + email; no cease line |
| kb-price-miss-honest | FAIL* | 100 | 100 | 2977 | don't have the current price… website or sales team |
| transfer-promise-kept | FAIL | 0 | n/a | 5089 | "i'm transferring you to a real person right now" + tool **fired** |
| kb-price-hit | FAIL | 0 | n/a | 2629 | the pro plan costs for 10 per month or 99 per year |

\* content FAIL is the caller-ASR WER gate (Hear heard "how much does the pro
plan", dropping "cost"), not agent behavior. The agent's reply was an honest
miss with no invented figure.

Every scored row **FAIL**s the full gate on TTFB (about 2.1–5.1s). Cascade +
streaming Hear + a reasoning LLM is slower than live Omni (1.2–2.5s) on the
same pack.

Content findings worth keeping:

- **Transfer fired** with clean spoken handoff ("i'm transferring you to a
  real person right now"). The only failing assertion is the literal wording
  "connect you". (First gpt-oss run fired the tool but the bot's handler
  returned instead of `result_callback`, so no reply was spoken — driver bug,
  fixed before this recording.)
- Sales held the line again: no figure, said "estimate". Same as LiveKit.
- Unbound KB **invented** "10 per month or 99 per year" on the hit path. No
  framework has a guard for this. Omni's verify-before-trust guard landed on
  this branch today (`8d148b23`).
- Collections asked for SSN last-4 to process a cease request — the exact
  conduct a compliance layer exists to prevent. Omni's collections mode has
  the fixed cease line; it needs `role` (console) to arm.
- Static `...` produced silence and no write tool, same as LiveKit. Omni is
  the only arm that spoke an idle check-in (content PASS there).

`listenRubric` is one unblinded engineering pass. It is **not** Layer E.

Shared-pack bake-off (`npm run bakeoff -- --system pipecat --runs-dir
./holdout/pipecat-2026-08-17`): 8 recorded ids missed intended PASS (latency
and/or content). 11 ids SKIP (not in this live pack).

## Not run

- Pipecat + Mem0 arm (plan's best-case-plugin arm)
- Layer E (two blinded humans)
- 30-call holdout
