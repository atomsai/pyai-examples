# PyAI examples

Runnable, copy-pasteable examples for building on [PyAI](https://pyai.com). Each
folder is self-contained with its own `package.json`, `.env.example`, and
`README.md`, and starts with `npm start`.

> **Meet Omni — the all-in-one AI voice agent model.** Omni is a hybrid
> speech-to-speech model with a fused LLM brain: over a single WebSocket it
> hears, reasons, **calls your tools**, **grounds answers in your knowledge
> base**, and speaks back in **emotion-aware voices** — with ~390 ms turn-taking
> and barge-in. No STT-LLM-TTS pipeline to assemble, nothing to provision first.
> One `configure` frame sets the whole agent (voice, persona, knowledge, tools);
> built-in call control (`transfer_to_human`, `send_dtmf`, `play_hold`,
> `collect`, `end_call`) ships in the engine. The Omni examples below take you
> from a phone number to a grounded, tool-using agent in minutes.

**Fastest start** — scaffold any example in one command (no clone):

```bash
npm create pyai-app@latest            # pick an example interactively
npm create pyai-app@latest openai-drop-in my-app --key pyai_test_…
```

| Example | What it shows | Stack |
|---|---|---|
| [`openai-drop-in`](./openai-drop-in) | Migrate from OpenAI by changing the **base URL**: the official `openai` SDK, pointed at PyAI, for **Speak** (TTS) + **Hear** (STT). Your method calls and preset voice names (`alloy`, `nova`, …) stay the same. | Node, Python |
| [`twilio-omni-voice-agent`](./twilio-omni-voice-agent) | A phone number that talks to the all-in-one **Omni** agent model — one-line bridge with [`@pyai/twilio`](../sdk/twilio). The fused brain reasons, calls tools, and grounds on your KB; barge-in, DTMF, and transfer-to-human included. | Node, Fastify |
| [`freeswitch-omni-voice-agent`](./freeswitch-omni-voice-agent) | SIP-trunk path: bridge a **FreeSWITCH** call (`mod_audio_stream`) to **Omni** at L16/16k — **no transcode, no resampling**. Barge-in, DTMF, transfer via ESL. | Node, `ws` |
| [`pyai-site-voice-concierge`](./pyai-site-voice-concierge) | A **"Talk to PyAI"** website voice agent: a browser widget brokered to **Omni** server-side (no key in the page), grounded per-turn on your own `kb_endpoint`. **One-click deploy** (Render) with grounding auto-configured — no ngrok. | Node, Fastify, browser |
| [`omni-browser-widget`](./omni-browser-widget) | The **minimal embeddable**: add a talking **Omni** voice agent to any site with **one `<script>` tag**. Self-contained widget + a ~80-line, **zero-dependency** token-broker so your key never ships to the browser. No phone/Twilio. | Node (no deps), browser |
| [`cascade-hear-llm-speak`](./cascade-hear-llm-speak) | The build-your-own pipeline: **Hear** (STT) → your LLM → **Speak** (TTS). Runs end to end with just a key. | Node, REST |
| [`speak-telephony-formats`](./speak-telephony-formats) | **Speak** server-side audio formats (`g711_ulaw`/`g711_alaw`/`pcm`/`mp3`/`opus`) — get Twilio-ready μ-law in one param instead of a hand-rolled resampler + μ-law encoder. | Node, Python, curl |
| [`browser-hear-live-captions`](./browser-hear-live-captions) | Stream mic audio from the browser to **Hear** and render live partial/final captions. | Static HTML/JS |
| [`voice-cloning`](./voice-cloning) | Clone a voice end to end: enroll a reference clip → poll until ready → speak in the cloned voice → use it in **Omni**. Includes the "why was my clip rejected" table. | Node, REST |
| [`recap-call-intelligence`](./recap-call-intelligence) | Mine your calls: batch-transcribe (diarized) with **Hear** jobs, then compute **talk-ratio + keywords + summary** — the Gong-style "conversation intelligence" recipe. | Node, REST |
| [`omni-mock`](./omni-mock) | An **offline Omni server** (wire protocol v2) to build + test your realtime client with **no key** — handshake, PCM16 both ways, barge-in, DTMF, and a built-in check for the event-vs-`type` footgun. | Node, `ws` |
| [`mcp-quickstart`](./mcp-quickstart) | Use PyAI from **Cursor / Claude Code / Codex** via the **MCP** server ([`@pyai/mcp`](https://www.npmjs.com/package/@pyai/mcp)): your agent mints a free key and calls PyAI directly. Includes a zero-dep stdio client that mints a sandbox key → synthesizes speech end to end. | Node (no deps) |

## Getting a key

All examples authenticate with a PyAI key. A **sandbox** key (`pyai_test_…`) is
perfect for trying things out. Keys are opaque — pass them through verbatim;
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
  hear→think→tool-call→ground→speak for you — the whole agent in one model).
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
- **Build an Omni client before you have a key** → `omni-mock` (offline protocol server).
- **Build with PyAI from Cursor / Claude Code / Codex** → `mcp-quickstart` (the MCP server; your agent mints a key and calls PyAI for you).
