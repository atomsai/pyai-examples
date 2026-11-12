# PyAI examples

Runnable, copy-pasteable examples for building on [PyAI](https://pyai.com). Follow each folder’s README for its runtime, dependencies and run command;
Node and Python starters are both available.

> **Meet Omni, the all-in-one AI voice agent model.** Omni is a hybrid
> speech-to-speech model with a fused LLM brain: over a single WebSocket it
> hears, reasons, **calls your tools**, **grounds answers in your knowledge
> base**, and speaks back in **emotion-aware voices**, with ~390 ms turn-taking
> and barge-in. No STT-LLM-TTS pipeline to assemble, nothing to provision first.
> One `configure` frame sets the whole agent (voice, persona, knowledge, tools);
> built-in call control (`transfer_to_human`, `send_dtmf`, `play_hold`,
> `collect`, `end_call`) ships in the engine. The Omni examples below take you
> from a phone number to a grounded, tool-using agent in minutes.

**Fastest start**, scaffold any example in one command (no clone):

```bash
npm create pyai-app@latest            # pick an example interactively
npm create pyai-app@latest openai-drop-in my-app --key pyai_test_…
```

| Example | What it shows | Stack |
|---|---|---|
| [`openai-drop-in`](./openai-drop-in) | Migrate from OpenAI by changing the **base URL**: the official `openai` SDK, pointed at PyAI, for **Speak** (TTS) + **Hear** (STT). Your method calls and preset voice names (`alloy`, `nova`, …) stay the same. | Node, Python |
| [`twilio-omni-voice-agent`](./twilio-omni-voice-agent) | A phone number that talks to the all-in-one **Omni** agent model, one-line bridge with [`@pyai/twilio`](../sdk/twilio). The fused brain reasons, calls tools, and grounds on your KB; barge-in, DTMF, and transfer-to-human included. | Node, Fastify |
| [`twilio-live-translation`](./twilio-live-translation) | Private two-human translation test host: isolated browser call legs, transcript persistence, echo gating and agent replacement. Requires the candidate SDK build; live carrier acceptance remains pending. | Node, Twilio browser SDK |
| [`plivo-live-translation`](./plivo-live-translation) | Private two-human translation test host with 16 kHz PCM, explicit carrier clear receipts, saved transcripts and agent replacement. Requires the candidate SDK build; live carrier acceptance remains pending. | Node, Plivo browser SDK |
| [`freeswitch-omni-voice-agent`](./freeswitch-omni-voice-agent) | SIP-trunk path: bridge a **FreeSWITCH** call (`mod_audio_stream`) to **Omni** at L16/16k, **no transcode, no resampling**. Barge-in, DTMF, transfer via ESL. | Node, `ws` |
| [`pyai-site-voice-concierge`](./pyai-site-voice-concierge) | A **"Talk to PyAI"** website voice agent: a browser widget brokered to **Omni** server-side (no key in the page), grounded per-turn on your own `kb_endpoint`. **One-click deploy** (Render) with grounding auto-configured, no ngrok. | Node, Fastify, browser |
| [`omni-browser-widget`](./omni-browser-widget) | The **minimal embeddable**: add a talking **Omni** voice agent to any site with **one `<script>` tag**. Self-contained widget + a ~80-line, **zero-dependency** token-broker so your key never ships to the browser. No phone/Twilio. | Node (no deps), browser |
| [`cascade-hear-llm-speak`](./cascade-hear-llm-speak) | The build-your-own pipeline: **Hear** (STT) → your LLM → **Speak** (TTS). Runs end to end with just a key. | Node, REST |
| [`speak-telephony-formats`](./speak-telephony-formats) | Stream one bounded **Speak** request as G.711 μ-law chunks, with project checks, backpressure and cancellation. No carrier call. | Node, Python |
| [`browser-hear-live-captions`](./browser-hear-live-captions) | Stream mic audio from the browser to **Hear** and render live partial/final captions. | Node backend, browser |
| [`voice-cloning`](./voice-cloning) | Clone a voice end to end: enroll a reference clip → poll until ready → speak in the cloned voice → use it in **Omni**. Includes the "why was my clip rejected" table. | Node, REST |
| [`recap-call-intelligence`](./recap-call-intelligence) | Turn a conversation into a typed **`recap.call`**: enable Recap, POST utterances or a Hear job with `call_id`, read `recap.record.v1`. | Node, REST |
| [`trace-dashboard`](./trace-dashboard) | Customize and embed a Trace summary dashboard, add an authenticated server adapter, and receive signed completed-call events. Fictional sample mode works without credentials. | Node (no deps), browser |
| [`amd-twilio-detection`](./amd-twilio-detection) | Rip out Twilio AMD with **one line of TwiML**: fork the call's media to **PyAI AMD** and get who/what answered (human, voicemail, IVR, **screening**, dead number, fax) with the reason, on a webhook. `answered_by_twilio` keeps your routing unchanged. | Node (no deps) |
| [`omni-mock`](./omni-mock) | An **offline Omni server** (wire protocol v2) to build + test your realtime client with **no key**, handshake, PCM16 both ways, barge-in, DTMF, and a built-in check for the event-vs-`type` footgun. | Node, `ws` |
| [`mcp-quickstart`](./mcp-quickstart) | Use PyAI from **Cursor / Claude Code / Codex** via the **MCP** server ([`@pyai/mcp`](https://www.npmjs.com/package/@pyai/mcp)): hosted HTTP uses OAuth; local stdio uses your CLI profile. Inspect identity and billing before opting into a bounded synthesis request. | Node (no deps) |

## Choose the requested job

| Job | Existing implementation path |
|---|---|
| Telephony transcription | [Hear streaming guide](https://docs.pyai.com/guides/streaming-stt): decode G.711 to PCM16 at 8 kHz; use final events. [Recorded transcription](https://docs.pyai.com/guides/hear-overview) and [async speaker labels](https://docs.pyai.com/guides/async-transcription-jobs) are separate paths. |
| Streaming TTS for a phone app | [speak-telephony-formats](./speak-telephony-formats): streamed audio bytes, no Calling or carrier setup. |
| LiveKit | [Existing starter](./sdk-starters/livekit) and [agent integration guide](https://docs.pyai.com/guides/livekit-agents). The starter is a TTS adapter test; bring rooms, worker and LLM for a complete agent. |
| Pipecat | [Existing starter](./sdk-starters/pipecat) and [pipeline guide](https://docs.pyai.com/guides/pipecat). The starter is text-to-WAV; bring transport and LLM for conversation. |
| Voice agent | [omni-browser-widget](./omni-browser-widget) for browser conversations; framework guides above when you own the conversation pipeline. Saved Agent profiles are optional for Omni. |
| Dubbing | [Existing runnable Dub API workflow](https://docs.pyai.com/guides/dub-overview). Check [live capabilities](https://api.pyai.com/healthz/dub), submit, poll, then download. Source and output languages are independent. |

## Getting a key

All examples authenticate with a PyAI key. A **sandbox** key (`pyai_test_…`) is
bounded by project usage limits. Before running any audio example, inspect
`GET /v1/me` and verify `org_id`, `project_id`, `env`, scopes, limits and billing
context. Live projects incur usage charges; [current billing](https://pyai.com/pricing).
Keys are opaque, pass them through verbatim;
never parse, split, or decode them.

- REST base: `https://api.pyai.com/v1`
- Realtime base: `wss://api.pyai.com/v1`
- Live contract: `https://api.pyai.com/openapi.json` · agent index: `https://api.pyai.com/llms.txt`

## Conventions

- **Node ≥ 22.** Examples use built-in `fetch`, `WebSocket`/`ws`, and
  `--env-file`, so most need no third-party dependencies.
- **`.env`.** Copy `.env.example` to `.env` and fill it in before `npm start`.
- **Never commit secrets.** `.env` is git-ignored; only the `.env.example`
  templates are checked in.

## Which one do I want?

- **Already on OpenAI for audio** → `openai-drop-in` (keep your code; change the base URL).
- **A phone agent, fast** → `twilio-omni-voice-agent` (Omni does
  hear→think→tool-call→ground→speak for you, the whole agent in one model).
- **A phone agent on your own SIP trunk** → `freeswitch-omni-voice-agent`.
- **A voice agent on your website** → `pyai-site-voice-concierge` (full standalone
  app: browser widget + server-side Omni broker + your own grounding endpoint).
- **Drop a voice widget into an existing site** → `omni-browser-widget` (one
  `<script>` tag + a tiny token endpoint; no framework, no deps).
- **Full control of the brain** → `cascade-hear-llm-speak` (bring your own LLM).
- **Telephony-ready TTS bytes (μ-law, etc.)** → `speak-telephony-formats`.
- **Captions / transcription UI** → `browser-hear-live-captions`.
- **Your own voice in the agent** → `voice-cloning`.
- **Analytics on recorded calls** → `recap-call-intelligence`.
- **Answering machine detection / rip out Twilio AMD** → `amd-twilio-detection` (one line of TwiML).
- **Build an Omni client before you have a key** → `omni-mock` (offline protocol server).
- **Build with PyAI from Cursor / Claude Code / Codex** → `mcp-quickstart` (choose hosted HTTP or local stdio; verify identity before usage).
