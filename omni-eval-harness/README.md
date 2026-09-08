# omni-eval-harness

Run scripted **voice** scenarios against a PyAI **Omni** agent (and the **Hear**
stream) **without a real phone call**, then score them against the voice-native
metric catalog. This is the functional-now version of the "simulation endpoint
v1" primitive from the
[evals plan](../../docs/PYAI_EVALS_PLATFORM_PLAN_2026-06-16.md): a synthetic
caller, deterministic scorers, timing capture, and a PASS/WARN/FAIL scorecard.

There is no offline `omni-mock`. The harness has two modes:

- **OFFLINE (default)**, replays a recorded session **fixture** and scores it.
  No network, no key, CI-safe. This is what `npm test` and `npm run offline` use.
- **LIVE (`--live`)**, connects to the real surfaces as a synthetic caller:
  **Speak → PCM → Omni**, plus the **Hear stream** for caller-audio WER, captures
  the session, and scores it. **Gated** on `PYAI_API_KEY`, with no key it skips
  cleanly and exits 0 (the repo's dormant-gate pattern), so the same command is
  safe to wire into CI.

The scorers, scenario/fixture formats, timing, and scorecard are identical across
both modes, the only difference is whether the `RunResult` came from a live WS
session or a recorded fixture.

## Quick start

```bash
# OFFLINE, score the sample recorded session (no key, no network):
npm run offline

# Unit + offline e2e tests:
npm test

# LIVE, needs a key; without one it skips and exits 0 (dormant gate):
cp .env.example .env   # add a pyai_test_ sandbox key
npm run live
```

Offline mode and the tests need **no `npm install`** (zero third-party imports on
that path). Live mode needs the workspace SDKs built once, see
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
  "session_label": "clinic-front-desk",
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
| `tool_not_called` | `{ type, name }` | hard | named tool did **not** fire |
| `latency_budget` | `{ type, ttfbMs?, turnMs? }` | **soft** | this turn's TTFB / turn latency are within budget |
| `recalls` | `{ type, value }` | hard | reply or ledger still contains `value` |
| `not_reask` | `{ type, pattern }` | hard | reply does not match the re-ask regex |
| `ledger_has` | `{ type, key }` | hard | conversation_state has that slot |
| `promise_kept` | `{ type, value }` | hard | a prior commitment is still in the reply, ledger, or tool args |
| `no_unbacked_claim` | `{ type }` | hard | no invented price / completed action / phone |
| `kb_miss_honest` | `{ type }` | hard | when `kb` is empty/timeout/error, admit the miss and invent nothing |
| `not_generic_validation` | `{ type }` | hard | no "I understand" / "I hear you" stock phrase |
| `reflects_specific` | `{ type }` | soft if caller turn is thin | echoes a content word from the caller |
| `max_questions` | `{ type, n? }` | hard | `?` count ≤ `n` (default 1) |
| `safety_line` | `{ type, class }` | hard | fixed safety class (`emergency`, `self_harm`, …) |
| `idle_patient` | `{ type, min_s? }` | hard | no idle check-in before `min_s` (default 12) |

**Hard** assertions failing → the turn fails → drags down Task Success Rate and
makes the run **FAIL**. **Soft** (latency) misses → **WARN**, and feed the
aggregate latency metrics rather than failing on their own.

`thresholds` are the scenario's per-metric **gate lines** (the pass/fail line).
Anything you omit defaults to the catalog's warn edge.

## Scorers & metric catalog

Two deterministic layers, both pure and fully unit-tested:

1. **Per-turn assertion scorers**, the table above.
2. **Aggregate metric scorers**, classified into good / warn / critical bands and
   gated against `thresholds`. The names and bands mirror
   [the evals plan §4](../../docs/PYAI_EVALS_PLATFORM_PLAN_2026-06-16.md) (this
   harness keeps its scorers self-contained, it does **not** depend on `evals/`):

   | Metric | Good / Warn / Critical |
   |---|---|
   | WER (ASR) | <5% / 5-10% / >10% |
   | TTFB P95 (time-to-first-word) | <400ms / 400-800ms / >800ms |
   | Turn latency P95 | <800ms / 800-1500ms / >1500ms |
   | Barge-in recovery rate | >90% / 80-90% / <80% |
   | Task Success Rate | >85% / 75-85% / <75% |
   | VAQI (composite) | >70 strong (warn <60) |
   | CRR / PIR / GHR | >90 / 80–90 / <80 (n/a unless asserted) |
   | RAR (re-ask) | <5% / 5–10% / >10% (n/a unless asserted) |
   | Q-rate | <35% good / ≤45% warn (only if `max_questions` is asserted) |
   | HPS | >80 / 65–80 / <65 (n/a unless a felt-move was asserted) |

   **WER** is corpus-level (total edits / total reference words) between each
   caller turn and the Hear-stream transcript of its audio. **VAQI** =
   `interruptions·40% + missed-response·40% + latency·20%` (0-100), exactly the
   plan's weighting.

**Overall verdict:** `FAIL` if any hard assertion fails or any metric breaches its
gate; else `WARN` if any band is warn or any soft latency budget was missed; else
`PASS`. `run.js` exits non-zero on `FAIL` so it can gate CI (`--no-exit-code` to
disable).

## Scorecard

Each run writes `out/<scenario>.scorecard.md` and `out/<scenario>.scorecard.json`
and prints the markdown. Sample (the offline default run):

```
# Omni Eval Scorecard, appointment-booking

- **Verdict:** PASS
- **Mode:** live-voice (`fixtures/appointment-booking.offline.json`)
- **LLM-judge:** STUB (heuristic-stub), deterministic placeholder, NOT a real model

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

A **fixture** is a recorded session, exactly the per-turn signals the live runner
captures, serialized so the scorers can replay them with no network:

```json
{
  "scenario": "appointment-booking",
  "session_label": "clinic-front-desk",
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

### Agent creator development probes

With Node 22.18+ and the workspace SDKs built (instructions below), run the
creator's actual versioned prompt compiler across its seven roles plus Custom:

```bash
# Use an existing test key through PYAI_API_KEY, or explicitly mint a sandbox key.
npm run live-creator -- --sandbox --out /tmp/creator-eval-first-run
```

Use `--roles receptionist,sales,scratch` to limit a run. The optional
`--variant grounded-candidate` adds an evaluation-only missing-facts rule;
it does not change the shipped console templates. The manifest identifies the
variant and records its different prompt hash. `--key-stdin` reads an opaque
key from the first stdin line instead of the environment; disable terminal
echo before entering any key interactively.

The output directory must not exist. Each of the eight scenarios has two caller
turns, synthesized with Speak and sent as audio to Omni using the creator's
default voice. This pack uses inline prompts with **no KB or connected tools**
to probe missing-knowledge honesty and unsupported action confirmations.
It does not yet test custom greetings, voice delivery instructions, managed
Agent persistence, successful integrations, barge-in, or human-rated voice
quality. These are development probes, not a held-out benchmark.

`manifest.json` freezes the prompt text, template version, SHA-256 and hashes
of the harness source files before the run. Per-scenario JSON and WAV files preserve transcripts, audio and
deterministic checks. `summary.json` retains errors in the run count;
`status.json` distinguishes a blocked or incomplete run from a completed one.
Missing credentials and rate limits fail visibly. Do not repeatedly mint keys
to work around a sandbox cap; supply an existing authorized test key instead.

The creator scorer checks unsupported facts and action promises against explicit
scenario evidence and configured tools. It also flags multiple requested details,
idle responses and missing conversational relevance. Exact successful tool results
must match the call and precede speech before they can support a completion claim.
These are conservative lexical checks; ambiguous quotations or paraphrases require
review rather than a confident semantic verdict.

`checksVerdict: CHECKS_PASS` means individual deterministic assertions passed,
not that the conversation was good. The overall result remains `REVIEW` until
human assessment. Shared hard assertions also remain blocking. The broader aggregate verdict is recorded separately:
its question-rate gate can reject valid clarification questions in a short
two-turn probe. Negative first-audio gaps are retained as overlap; missing timing
must not be counted as zero latency. `INVALID_CAPTURE` distinguishes framing,
timeout, dropped-stream or incomplete-recording failures from content quality.
Empty replies fail, but heuristic passes
still require transcript and audio review. The
existing judge is a stub and provides no independent quality certification.
Keep original evidence, use a new directory on every run, and use a separate
holdout before claiming improvements from prompt tuning.

Creator command exit codes: `1` for a content failure, `2` for an incomplete or
invalid capture, and `3` when automated checks finished but human review remains.
No creator run silently becomes an automated quality certification.

Shared scoring also rejects invalid captures, including replayed recordings with
explicit failure metadata. Legacy fixtures without that metadata remain usable
as unverified replays; their absence of metadata does not establish capture
validity. The general `run.js` command exits `2` for an invalid capture.

Live mode reuses the repo's packages instead of re-implementing audio/transport:

- **`@pyai/twilio`** → `OmniClient` (Omni WS client + event demux), the
  anti-aliased polyphase resampler, and PCM16⇄bytes helpers.
- **`@pyai/sdk`** → Speak (synthetic-caller TTS) and the Hear stream (caller-audio
  WER).

Before connecting it synthesizes and transcribes caller audio through Speak and
Hear REST. It streams PCM in real-time frames, including silence throughout the
greeting and responses. Reply transcription happens after closing the socket, so
REST processing cannot cause idle messages during the call. Engine synthesis text
is recorded separately from the transcription of audio actually captured.

The WAV uses separate caller/agent channels on an estimated playout timeline,
preserving gaps and overlaps. It is not an acoustic speaker recording. Timing
uses monotonic timestamps and approximate energy bounds; response completion still
uses two seconds of quiet because the public transport has no explicit reply-end
event. Do not treat overlap as fast turn-taking or these client measurements as
a production latency benchmark.

### The gate

`run.js --live` checks `PYAI_API_KEY`:

- **absent** → prints a skip notice and **exits 0** (dormant gate, CI-safe).
- **present** → dynamically imports `src/live.js` and runs against
  `https://api.pyai.com` (override with `PYAI_BASE_URL`). `session_label`
  resolves from `--session-label` → `PYAI_SESSION_LABEL` → the scenario →
  `harness-session`.

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

### Frozen production packs and call audio

`live-product` runs managed Agent profiles and writes each fixture beside a
listenable WAV built from the exact captured caller/agent PCM plus the measured
time-to-first-audio gap:

```bash
PYAI_EVAL_SCENARIOS_DIR=scenarios-holdout \
PYAI_EVAL_HOLDOUT_DIR=holdout/social-canary-30-2026-08-18 \
npm run live-product
```

Completed `live-product` directories contain `DO_NOT_TUNE`, and that runner
refuses to overwrite one. Always choose a new `PYAI_EVAL_HOLDOUT_DIR`. The LiveKit and
Pipecat drivers honor that variable plus `PYAI_EVAL_OUTPUT_DIR` and produce the
same `<scenario>.offline.json` + `<scenario>.wav` pair.

The `live-pack`, `live-product` and `live-continuity` commands exit `2` for an
incomplete or invalid capture, `1` for failed checks and `3` when automated checks
finish but human review remains. Their `listen` fields are unrated until human
assessment. The accompanying observations are literal transcript measurements,
with zero human raters; they cannot prove that a promise was kept or that a
listener would call again. Blinded ratings use the separate Layer E workflow.

### Repeated in-region bake-off

On an ephemeral runner in `us-central1`, create the two isolated virtualenvs,
install their pinned requirements, build the workspace TypeScript SDKs, and
run:

```bash
PYAI_EVAL_RUN_ID=20260818T090000Z \
PYAI_EVAL_REPEATS=3 \
npm run bakeoff:in-region
```

The script refuses to run outside the requested GCP region and records the same
eight scenarios for Omni, LiveKit, and Pipecat on every repetition. The
LiveKit arm uses the public plugin's streaming Hear path; do not replace it
with batch recognition, which changes the framework pipeline being measured.
`content_verdict` excludes WER, latency, barge-in, and VAQI transport gates so
speech-recognition variance cannot be mislabeled as a conversation-content
failure. Summarize only a complete run matrix:

```bash
npm run bakeoff:repeated -- \
  --system omni=holdout/in-region-20260818T090000Z/omni \
  --system livekit=holdout/in-region-20260818T090000Z/livekit \
  --system pipecat=holdout/in-region-20260818T090000Z/pipecat \
  --out holdout/in-region-20260818T090000Z/summary.json
```

The summarizer fails if any repetition has an error, a missing scenario, or a
missing WAV; failed calls cannot disappear from the comparison.

### Layer E blinded panel

Build a balanced bundle only after every system has real audio for the same
scenarios:

```bash
npm run layer-e-bundle -- \
  --out out/layer-e-2026-08-18 \
  --system omni=holdout/social-canary-30-2026-08-18 \
  --system livekit=holdout/livekit-in-region-2026-08-18 \
  --system pipecat=holdout/pipecat-in-region-2026-08-18
```

Share only `out/layer-e-2026-08-18/rater/`. The system mapping stays under
`coordinator/`. After two independent sheets are returned:

```bash
npm run layer-e-score -- \
  --mapping out/layer-e-2026-08-18/coordinator/mapping.json \
  --rater /path/to/rater-one.csv \
  --rater /path/to/rater-two.csv \
  --out out/layer-e-2026-08-18/coordinator/results.json
```

Calls with disagreement on two or more dimensions are emitted as
`needs_adjudication`; pass a third blinded sheet with another `--rater` to
complete the result. `n/a` is excluded rather than silently counted as a yes.

## Fully functional vs stubbed

**Fully functional (deterministic, tested, offline):**

- Scenario format + validation; assertion scorers (`contains` / `not_contains` /
  `regex` / `tool_called` / `latency_budget`).
- Aggregate metrics: WER (real edit-distance), TTFB/turn P50+P95, barge-in
  recovery, Task Success Rate, VAQI, banded and gated.
- Transcript capture, timing capture, tool-call capture, scorecard (md + JSON),
  PASS/WARN/FAIL gating + CI exit code.
- Live transport reuse (Omni WS + resampler via `@pyai/twilio`; Speak + Hear via
  `@pyai/sdk`) wired and ready when a key + built SDKs are present.

**Stubbed / pluggable (clearly marked):**

- **LLM-judge** (`src/judge.js`), a deterministic keyword-coverage heuristic that
  **calls no model**; every rationale is prefixed `[STUB]`. Plug a real judge by
  passing `{ judgeFn }` to `evaluate()`; the contract and the §2 judge discipline
  (decompose into binary checks, pin the version, keep a human-calibrated holdout)
  are documented in `src/judge.js`.

**Engine-roadmap-dependent (sent forward-compatibly):** text-mode input and
mid-call tool calls, the Omni protocol marks both as not-yet-honored, so live
mode sends them and captures whatever the engine returns; the offline fixtures
exercise the scoring of both today.
