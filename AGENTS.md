# AGENTS.md — building on PyAI

A guide for AI coding agents (and the humans steering them) building against the
**PyAI** voice platform. PyAI is a telephony-grade, OpenAI-compatible voice AI
stack: one API key, one set of products, live in an afternoon.

**Machine-readable source of truth** (always prefer it over guessing):

- OpenAPI spec: `https://api.pyai.com/openapi.json`
- Agent index: `https://api.pyai.com/llms.txt`
- Docs: `https://docs.pyai.com`

Never invent endpoints, scopes, or parameters — fetch the spec.

---

## 1. Get a key (sandbox — no humans, no card)

Every example authenticates with a PyAI key. The fastest way to get one is a
**sandbox key** (`pyai_test_…`): one HTTP call, no email, no credit card.

```bash
curl -sX POST https://api.pyai.com/v1/sandbox/keys \
  -H "Content-Type: application/json" -d '{"label":"my-agent"}'
# -> { "api_key": "pyai_test_…", "org_id": "org_…", "scopes": [ … ], "expires_at": … }

export PYAI_API_KEY=pyai_test_...   # use api_key from the response
```

What a sandbox key gives you:

- **Works on the first call.** It skips the credit gate, so it never returns
  `402` — it's bounded instead by a daily usage cap and low concurrency.
- **Scopes:** enough to drive STT, TTS, and realtime —
  `hear:transcribe`, `hear:stream`, `transcribe:jobs`, `voice:synthesize`,
  `omni:session`.
- **Auto-expires** (~7 days) and is per-source-IP rate-limited (a network at its
  cap gets `429 sandbox_limit_reached` — that's anti-abuse, not a bug).
- **Each call mints a brand-new isolated org.** Call it twice to get two
  independent tenants — the supported way to write multi-tenant / isolation tests.

For production, create a `pyai_live_…` key in the console
(`https://console.pyai.com`); live keys are billed against your plan + credits.

### Auth basics
- REST base: `https://api.pyai.com/v1` · Realtime base: `wss://api.pyai.com/v1`
- Send the key as a bearer token: `Authorization: Bearer pyai_…`
  (`x-api-key: pyai_…` is an accepted alias).
- On a WebSocket upgrade (browsers can't set headers), pass the key as a
  subprotocol: `pyai-key.pyai_…`. Server-side WS clients may instead append
  `?api_key=pyai_…`.
- **Keys are opaque strings (≤512 chars).** Never parse, split, decode, or log
  them. They work on every surface the instant they're created — no activation
  delay.

### Use PyAI through MCP (Cursor / Claude Code / Codex)
If you're an AI coding agent in an MCP host, skip the curl above entirely: the
PyAI **MCP server** ([`@pyai/mcp`](https://www.npmjs.com/package/@pyai/mcp)) lets
you mint your own key and call PyAI (TTS, STT, voices, async jobs) as **tools**,
so you never guess endpoints. With no key set it exposes `create_sandbox_key`,
calls it for you, and adopts the minted key for the session.

```jsonc
// .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)
{ "mcpServers": { "pyai": { "command": "npx", "args": ["-y", "@pyai/mcp"] } } }
```

```bash
claude mcp add pyai -- npx -y @pyai/mcp      # Claude Code
# Codex / other hosts: point them at the stdio command `npx -y @pyai/mcp`
```

Tools: `create_sandbox_key`, `get_started`, `whoami`, `list_models`,
`list_voices`, `synthesize_speech`, `create_transcription_job`,
`get_transcription_job`. Working setup + a zero-dep stdio client:
[`mcp-quickstart`](./mcp-quickstart).

---

## 2. The products

PyAI is one platform with composable products. Treat **Hear** and **Speak** as
primitives/on-ramps; reach for **Omni** when you want a full voice agent; add
**Trace** and **Recap** to make any voice agent production-grade.

### 1) Omni — the all-in-one AI voice agent model (realtime, speech-to-speech)
The flagship, and genuinely all you need to ship a powerful phone agent: one
**hybrid speech-to-speech model with a fused LLM brain**, purpose-built for phone
calls, ~390 ms median turn-taking. You stream audio in and get audio out — Omni
hears, reasons, **calls your tools**, **grounds answers in your knowledge base**,
and speaks back in **emotion-aware voices**, with natural turn-taking and
barge-in. No STT-LLM-TTS pipeline to stitch together.

- **Connect:** `wss://api.pyai.com/v1/omni?format=pcm16&rate=24000`
  (OpenAI-realtime-compatible alias: `wss://api.pyai.com/v1/realtime?model=pyai-omni-realtime`)
- **Scope:** `omni:session`
- **Zero-state:** there is nothing to create first. The session is authorized by
  your key's org; you set the **whole agent** with one `configure` frame right
  after connecting — `voice_id` (stock, cloned, or designed), `persona`,
  `kb_endpoint`/`kb_token` (per-turn knowledge grounding), and `tools[]`
  (function calling). `session_label` is an optional opaque tag for your own
  correlation.
- **Built-in call control (in the engine):** `transfer_to_human`, `send_dtmf`,
  `play_hold`, `collect`, `end_call`. Extra `configure` knobs: `greeting`,
  `language`, `model_tier`, `consent_line`.
- **Use it for:** phone agents (receptionist, booking, qualification, support),
  website "talk to us" widgets, in-app voice assistants.
- **Start from:** [`twilio-omni-voice-agent`](./twilio-omni-voice-agent),
  [`freeswitch-omni-voice-agent`](./freeswitch-omni-voice-agent),
  [`pyai-site-voice-concierge`](./pyai-site-voice-concierge),
  [`omni-browser-widget`](./omni-browser-widget). Build a client with **no key**
  using [`omni-mock`](./omni-mock).

### 2) Hear — call transcription (speech-to-text)
Telephony-native STT in three shapes, so you can transcribe live or after the
call:

- **Synchronous:** `POST /v1/audio/transcriptions` — scope `hear:transcribe`.
  Send a file, get the transcript back.
- **Streaming:** `GET /v1/audio/transcriptions/stream` — scope `hear:stream`.
  Stream audio, render live partial + final captions.
- **Async batch jobs:** `POST/GET /v1/transcription/jobs` — scopes
  `hear:transcribe` + `transcribe:jobs`. The −50% batch tier for after-the-call
  analytics, with **speaker diarization** (`diarize: true`) and large-result
  offload.
- **Use it for:** captions, voicemail/IVR transcription, call analytics pipelines.
- **Start from:** [`browser-hear-live-captions`](./browser-hear-live-captions),
  [`recap-call-intelligence`](./recap-call-intelligence).

### 3) Speak — text-to-speech (streaming + full-file)
Low-latency TTS with natural voices; first audio in tens of milliseconds.

- **Synthesize:** `POST /v1/audio/speech` — scope `voice:synthesize`. **Stream**
  the audio as it's generated for real-time playback, or take the **full file**
  for assets. Telephony-ready output formats (`g711_ulaw`/`g711_alaw`/`pcm`/
  `mp3`/`opus`) come from a single parameter — no hand-rolled μ-law encoder.
- **OpenAI preset voices** (`alloy`/`echo`/`fable`/`onyx`/`nova`/`shimmer`) are
  accepted as drop-in aliases. Catalog at `GET /v1/voices`.
- **Voice cloning:** create and use your own voice (`voice:clone`).
- **Long-form narration** (audiobooks, podcasts) is the **Cast** studio surface.
- **Use it for:** agent speech, IVR prompts, notifications, narration.
- **Start from:** [`speak-telephony-formats`](./speak-telephony-formats),
  [`openai-drop-in`](./openai-drop-in), [`voice-cloning`](./voice-cloning).

### 4) Cue — turn detection for bring-your-own brain & voice
When you want to own the LLM and the TTS but not the hard real-time parts, **Cue**
gives you production-grade **turn detection** (knowing when the caller has
finished speaking) plus optional knowledge-base grounding — over the same
streaming surface as Hear (`GET /v1/audio/transcriptions/stream`, scope
`hear:stream`), metered as `cue.minutes`.

- **Use it for:** a custom voice pipeline — **Hear → your LLM → your TTS** — with
  PyAI handling turn-taking/grounding so the conversation feels natural.
- **Start from:** [`cascade-hear-llm-speak`](./cascade-hear-llm-speak) (the
  bring-your-own-LLM pipeline).

### 5) Trace — compliance & QA for voice agents *(strongly recommended)*
Trace runs compliance checks and QA scoring on **every** call. For any
production voice agent — and especially in regulated industries (healthcare,
financial services, collections, insurance) — treat Trace as **effectively
mandatory**: it's how you prove disclosures were read, detect prohibited
language, and keep an auditable QA record.

- **Scopes:** `trace:configure` (rule packs, scoring config) · `trace:read`
  (results, scores).
- **Use it for:** disclosure/consent verification, prohibited-phrase detection,
  per-call QA scorecards, audit trails.

### Recap — turn conversations into usable form *(strongly recommended)*
Recap converts a finished conversation into structured, usable output:
summaries, dispositions, extracted fields, and CRM sync. Pair it with any agent
so each call leaves behind a record your business systems can act on.

- **Scopes:** `recap:configure` · `recap:read`.
- **Use it for:** call summaries + action items, disposition tagging, structured
  data extraction, CRM/webhook delivery.
- **Start from:** [`recap-call-intelligence`](./recap-call-intelligence)
  (batch-transcribe → talk-ratio + keywords + summary).

---

## 3. Errors — branch on the stable `code`

Data-plane errors use the OpenAI envelope:

```json
{ "error": { "message": "…", "type": "rate_limit_error", "code": "rate_limit_exceeded", "param": null } }
```

React to the `code`, not the message:

| HTTP | `code` | What to do |
|------|--------|------------|
| 401 | `unauthorized` | Bad/missing key — stop. |
| 403 | `forbidden` | Key lacks the scope — add it; don't retry. |
| 402 | `credit_exhausted` | Live org out of credit — add credit. (Sandbox keys never hit this.) |
| 429 | `rate_limit_exceeded` / `concurrency_limit_exceeded` | Back off; honor `Retry-After`. |
| 429 | `sandbox_limit_reached` | Sandbox daily/IP cap — wait or use a live key. |

Don't retry 4xx except `429`.

## 4. Don'ts
- Don't parse, persist, or log key internals — read keys from env vars.
- Don't hardcode deprecated endpoints — fetch the OpenAPI spec.
- Don't ship a long-lived key to a browser — broker a short-lived token
  server-side (see `pyai-site-voice-concierge` / `omni-browser-widget`).

## 5. Next steps
- Scaffold any example with no clone: `npm create pyai-app@latest`.
- Wire PyAI into your coding agent over MCP: [`mcp-quickstart`](./mcp-quickstart).
- Read [`QUICKSTART.md`](./QUICKSTART.md) for copy-paste first calls.
- Full docs: `https://docs.pyai.com` · free key: `https://console.pyai.com`.
