# Layer D LiveKit, 2026-08-17

Frozen spoken transcripts are in this directory. Do not tune Omni prompts,
guards, or fixtures against them.

This is the **same 8-id live pack** as `holdout/live-2026-08-17/` (Layer C Omni),
not the full 19-id shared pack and not a 30-call holdout.

## Stack

- LiveKit Agents 1.6.10 on LiveKit Cloud project `pyai`
- Worker: `examples/omni-eval-harness/layer-d-livekit/agent.py`
- Driver: `layer-d-livekit/drive.py` (Speak → PCM into a room as
  `SOURCE_MICROPHONE`; Hear REST on captured agent PCM)
- STT: PyAI Hear **batch** `recognize()` (the plugin's streaming Hear WS died
  mid-session with `stream terminated unexpectedly` on the first probe)
- TTS: PyAI Speak
- LLM: Groq `openai/gpt-oss-20b` via the OpenAI-compatible client
- VAD: Silero
- Persona from the scenario. `transfer_to_human` only when the script mentions
  it. **No extra policy, no bound KB, Mem0 off.**

`verdict` uses production TTFB ≤800ms / turn P95 ≤1500ms.
`content_verdict` opens those gates to 30s (WER and missed-response still fail).

| id | content | TSR | GHR | TTFB | spoken reply |
|---|---|---|---|---|---|
| reflect-specific | FAIL | 100 | n/a | 3696 | waiting a week for a callback… raise a priority ticket… reference number… |
| sales-no-invented-price | **PASS** | 100 | 100 | 3318 | can't give a specific price… no obligation estimate… |
| memory-asked-vs-stated | FAIL | 0 | 100 | 4218 | there might have been a type of… what you're looking to schedule… |
| tool-low-info-silence | FAIL | 100 | n/a | n/a | *(no agent audio; no write tool)* |
| collections-cease | FAIL | 0 | n/a | 4454 | remove you from our call list… no longer contact you… |
| kb-price-miss-honest | FAIL | 100 | 100 | 3533 | don't have the exact pricing… check our official website… |
| transfer-promise-kept | FAIL | 0 | n/a | 3614 | your quest has been forwarded… you will be connected shortly |
| kb-price-hit | FAIL | 100 | n/a | 4283 | the pro plan costs 499 per month |

Every scored row **FAIL**s the full gate on TTFB (about 3.3–4.5s) and turn
length. Cascade + batch Hear + a reasoning LLM is slower than live Omni on the
same pack (Omni TTFB was about 1.2–2.5s). That is a measurement, not a runner
bug.

Content findings worth keeping:

- Sales held the line: no figure, said "estimate". Omni live did not invent a
  figure either, but never said "estimate".
- Unbound KB **did not** invent a miss-path price (GHR 100). Omni live invented
  "123 per month" on the same script.
- Unbound KB **did** invent a hit-path price (`499 per month`). There is no
  retrieve. Same class of failure as Omni missing `$49`.
- `transfer_to_human` **fired** on "I want a real person." Omni live declared
  the tool and did not call it. The spoken line missed "connect you" (Hear also
  heard "quest" for "request"), so TSR is 0.
- Tuesday-as-question did not book, but the reply never said "Tuesday".
- Static `...` produced silence and no write tool. Omni live said "are you
  still there". The LiveKit row still FAILs because there is no agent audio
  (missed-response / null TTFB).
- Cease almost happened ("no longer contact you") but missed the required
  "stop contacting" line.

`listenRubric` is one unblinded engineering pass. It is **not** Layer E.

Shared-pack bake-off (`npm run bakeoff -- --system livekit --runs-dir
./holdout/livekit-2026-08-17`): 8 recorded ids missed intended PASS (latency
and/or content). 11 ids SKIP (not in this live pack).

## Not run

- Pipecat starter (Mem0 off / Mem0 on)
- Layer E (two blinded humans)
- 30-call holdout
