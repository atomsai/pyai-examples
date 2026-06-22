# omni-eval-harness

Run scripted **voice** scenarios against a PyAI **Omni** agent (and the **Hear**
stream) **without a real phone call**, then score them against the voice-native
metric catalog. This is the functional-now version of the "simulation endpoint
v1" primitive from the
[evals plan](../../docs/PYAI_EVALS_PLATFORM_PLAN_2026-06-16.md): a synthetic
caller, deterministic scorers, timing capture, and a PASS/WARN/FAIL scorecard.

There is no offline `omni-mock`. The harness has two modes:

- **OFFLINE (default)** — replays a recorded session **fixture** and scores it.
  No network, no key, CI-safe. This is what `npm test` and `npm run offline` use.
- **LIVE (`--live`)** — connects to the real surfaces as a synthetic caller:
  **Speak → PCM → Omni**, plus the **Hear stream** for caller-audio WER, captures
  the session, and scores it. **Gated** on `PYAI_API_KEY` — with no key it skips
  cleanly and exits 0 (the repo's dormant-gate pattern), so the same command is
  safe to wire into CI.

The scorers, scenario/fixture formats, timing, and scorecard are identical across
both modes — the only difference is whether the `RunResult` came from a live WS
session or a recorded fixture.

## Quick start

```bash
# OFFLINE — score the sample recorded session (no key, no network):
npm run offline

# Unit + offline e2e tests:
npm test

# LIVE — needs a key; without one it skips and exits 0 (dormant gate):
cp .env.example .env   # add a pyai_test_ sandbox key
npm run live
```

Offline mode and the tests need **no `npm install`** (zero third-party imports on
that path). Live mode needs the workspace SDKs built once — see
[Live mode](#live-mode).

## File tree

```
omni-eval-harness/
├── package.json            # ESM, node>=22; file: deps on @pyai/twilio + @pyai/sdk
├── .env.example            # PYAI_API_KEY etc. (live mode only)
├── README.md
├── scenarios/
│   └── appointment-booking.json      # sample scenario (3 turns, all assertion types)
├── fixtures/
│   └── appointment-booking.offline.json   # sample recorded session (scored in CI)
├── src/
│   ├── run.js              # entry: offline default + live gate, emits scorecard
│   ├── scenario.js         # scenario format + loader/validator
│   ├── fixture.js          # offline fixture loader -> RunResult
│   ├── live.js             # LIVE runner (reuses @pyai/twilio + @pyai/sdk); dormant
│   ├── scorers.js          # assertion scorers + aggregate metrics + evaluate()
│   ├── metrics.js          # metric catalog + thresholds (mirrors the evals plan)
│   ├── text.js             # normalization, tokenization, WER
│   ├── judge.js            # LLM-judge STUB (clearly marked, pluggable)
│   └── scorecard.js        # markdown + JSON scorecard renderer
└── test/
    ├── scorers.test.js     # scorer / metric / judge unit tests
    ├── scenario.test.js    # scenario validation
    └── e2e-offline.test.js # offline end-to-end on the sample fixture
```

## Scenario format

A scenario is a JSON file under `scenarios/`:

```json
{
  "id": "appointment-booking",
  "persona": "You are the front-desk scheduler for Brightsmile Dental ...",
  "agent_id": "clinic-front-desk",
  "opening": "Thanks for calling Brightsmile Dental, how can I help?",
  "turns": [
    { "caller_says": "Hi, I'd like to book a cleaning for next week.",
      "expect": [
        { "type": "contains", "value": "cleaning" },
        { "type": "regex", "value": "(monday|tuesday|wednesday|\\d)", "flags": "i" },
        { "type": "latency_budget", "ttfbMs": 800, "turnMs": 1500 }
      ] }
  ],
  "thresholds": { "werPct": 10, "ttfbMs": 800, "turnP95Ms": 1500,
                  "bargeRecoveryPct": 90, "tsrPct": 85, "vaqi": 70 }
}
```

Caller turns are plain text. In **voice** mode the runner synthesizes each
`caller_says` to audio with Speak; in **text** mode it sends the text directly.

### Assertions (`expect[]`)

| Assertion | Shape | Kind | Checks |
|---|---|---|---|
| `contains` | `{ type, value }` | hard | agent reply contains the substring (case/punctuation-insensitive) |
| `not_contains` | `{ type, value }` | hard | agent reply does **not** contain it |
| `regex` | `{ type, value, flags? }` | hard | agent reply matches the pattern |
| `tool_called` | `{ type, name, args? }` | hard | a tool with `name` was called (and `args` subset-match if given) |
| `latency_budget` | `{ type, ttfbMs?, turnMs? }` | **soft** | this turn's TTFB / turn latency are within budget |

**Hard** assertions failing → the turn fails → drags down Task Success Rate and
makes the run **FAIL**. **Soft** (latency) misses → **WARN**, and feed the
aggregate latency metrics rather than failing on their own.

`thresholds` are the scenario's per-metric **gate lines** (the pass/fail line).
Anything you omit defaults to the catalog's warn edge.

## Scorers & metric catalog

Two deterministic layers, both pure and fully unit-tested:

1. **Per-turn assertion scorers** — the table above.
2. **Aggregate metric scorers**, classified into good / warn / critical bands and
   gated against `thresholds`. The names and bands mirror
   [the evals plan §4](../../docs/PYAI_EVALS_PLATFORM_PLAN_2026-06-16.md) (this
   harness keeps its scorers self-contained — it does **not** depend on `evals/`):

   | Metric | Good / Warn / Critical |
   |---|---|
   | WER (ASR) | <5% / 5–10% / >10% |
   | TTFB P95 (time-to-first-word) | <400ms / 400–800ms / >800ms |
   | Turn latency P95 | <800ms / 800–1500ms / >1500ms |
   | Barge-in recovery rate | >90% / 80–90% / <80% |
   | Task Success Rate | >85% / 75–85% / <75% |
   | VAQI (composite) | >70 strong (warn <60) |

   **WER** is corpus-level (total edits / total reference words) between each
   caller turn and the Hear-stream transcript of its audio. **VAQI** =
   `interruptions·40% + missed-response·40% + latency·20%` (0–100), exactly the
   plan's weighting.

**Overall verdict:** `FAIL` if any hard assertion fails or any metric breaches its
gate; else `WARN` if any band is warn or any soft latency budget was missed; else
`PASS`. `run.js` exits non-zero on `FAIL` so it can gate CI (`--no-exit-code` to
disable).

## Scorecard

Each run writes `out/<scenario>.scorecard.md` and `out/<scenario>.scorecard.json`
and prints the markdown. Sample (the offline default run):

```
# Omni Eval Scorecard — appointment-booking

- **Verdict:** PASS
- **Mode:** live-voice (`fixtures/appointment-booking.offline.json`)
- **LLM-judge:** STUB (heuristic-stub) — deterministic placeholder, NOT a real model

## Aggregate metrics
| Dimension | Value | Band | Gate |
|---|---|---|---|
| WER (ASR) | 4.2% | GOOD | PASS (<=10%) |
| TTFB P95 (time-to-first-word) | 320ms | GOOD | PASS (<=800ms) |
| Turn latency P95 | 720ms | GOOD | PASS (<=1500ms) |
| Barge-in recovery rate | 100% | GOOD | PASS (>=90%) |
| Task Success Rate | 100% | GOOD | PASS (>=85%) |
| VAQI (composite) | 100 | GOOD | PASS (>=70) |
```

(Per-turn breakdowns, assertion results, and judge rationales follow in the full
report.)

## Offline fixtures

A **fixture** is a recorded session — exactly the per-turn signals the live runner
captures, serialized so the scorers can replay them with no network:

```json
{
  "scenario": "appointment-booking",
  "agent_id": "clinic-front-desk",
  "mode": "live-voice",
  "turns": [
    { "caller_says": "...",          // reference text
      "asr_hypothesis": "...",       // Hear-stream transcript of the caller audio (-> WER)
      "agent_text": "...",           // Omni agent reply transcript
      "ttfb_ms": 320, "turn_ms": 690,
      "tool_calls": [ { "name": "book_appointment", "args": { "day": "Wednesday" } } ],
      "barge_in": { "attempted": true, "recovered": true } }
  ]
}
```

The shipped fixture is hand-authored to PASS and to exercise **every** scorer
(content assertions, a tool call, a barge-in, real timing, and a deliberate ASR
substitution so WER is non-zero). To capture a real one, run `--live` and save the
emitted `out/<scenario>.scorecard.json` `turns[]` into this shape ("save a real
call as a test").

## Live mode

Live mode reuses the repo's packages instead of re-implementing audio/transport:

- **`@pyai/twilio`** → `OmniClient` (Omni WS client + event demux), the
  anti-aliased polyphase resampler, and PCM16⇄bytes helpers.
- **`@pyai/sdk`** → Speak (synthetic-caller TTS) and the Hear stream (caller-audio
  WER).

Per caller turn it: synthesizes the turn (Speak → PCM16 @ 24 kHz), transcribes
that audio through the Hear stream for a real WER, streams the PCM to Omni in
real-time ~20 ms frames, then captures the agent's transcript, **TTFB**, and
**turn latency** (first agent audio after the caller stops; turn end after the
agent goes quiet for a settle window).

### The gate

`run.js --live` checks `PYAI_API_KEY`:

- **absent** → prints a skip notice and **exits 0** (dormant gate — CI-safe).
- **present** → dynamically imports `src/live.js` and runs against
  `https://api.pyai.com` (override with `PYAI_BASE_URL`). `agent_id` resolves from
  `--agent-id` → `PYAI_AGENT_ID` → the scenario → `harness-agent`.

Those two SDKs are TypeScript, consumed from their build output. The offline path
and tests never import them; live mode does, so build them once first:

```bash
(cd ../../sdk/twilio && npm install && npm run build)
(cd ../../sdk/typescript && npm install && npm run build)
npm install        # link the file: deps into this example
npm run live
```

If they aren't built, live mode fails with an actionable message (offline mode and
tests are unaffected).

## Fully functional vs stubbed

**Fully functional (deterministic, tested, offline):**

- Scenario format + validation; assertion scorers (`contains` / `not_contains` /
  `regex` / `tool_called` / `latency_budget`).
- Aggregate metrics: WER (real edit-distance), TTFB/turn P50+P95, barge-in
  recovery, Task Success Rate, VAQI — banded and gated.
- Transcript capture, timing capture, tool-call capture, scorecard (md + JSON),
  PASS/WARN/FAIL gating + CI exit code.
- Live transport reuse (Omni WS + resampler via `@pyai/twilio`; Speak + Hear via
  `@pyai/sdk`) wired and ready when a key + built SDKs are present.

**Stubbed / pluggable (clearly marked):**

- **LLM-judge** (`src/judge.js`) — a deterministic keyword-coverage heuristic that
  **calls no model**; every rationale is prefixed `[STUB]`. Plug a real judge by
  passing `{ judgeFn }` to `evaluate()`; the contract and the §2 judge discipline
  (decompose into binary checks, pin the version, keep a human-calibrated holdout)
  are documented in `src/judge.js`.

**Engine-roadmap-dependent (sent forward-compatibly):** text-mode input and
mid-call tool calls — the Omni protocol marks both as not-yet-honored, so live
mode sends them and captures whatever the engine returns; the offline fixtures
exercise the scoring of both today.
```
