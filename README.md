# PyAI examples

Runnable, copy-pasteable examples for building on [PyAI](https://pyai.com). Each
folder is self-contained with its own `package.json`, `.env.example`, and
`README.md`, and starts with `npm start`.

**Fastest start** — scaffold any example in one command (no clone):

```bash
npm create pyai-app@latest            # pick an example interactively
npm create pyai-app@latest openai-drop-in my-app --key pyai_test_…
```

| Example | What it shows | Stack |
|---|---|---|
| [`openai-drop-in`](./openai-drop-in) | Migrate from OpenAI by changing the **base URL**: the official `openai` SDK, pointed at PyAI, for **Speak** (TTS) + **Hear** (STT). Your method calls and preset voice names (`alloy`, `nova`, …) stay the same. | Node, Python |
| [`twilio-omni-voice-agent`](./twilio-omni-voice-agent) | A phone number that talks to an **Omni** voice agent — one-line bridge with [`@pyai/twilio`](../sdk/twilio). Barge-in, DTMF, and transfer-to-human included. | Node, Fastify |
| [`freeswitch-omni-voice-agent`](./freeswitch-omni-voice-agent) | SIP-trunk path: bridge a **FreeSWITCH** call (`mod_audio_stream`) to **Omni** at L16/16k — **no transcode, no resampling**. Barge-in, DTMF, transfer via ESL. | Node, `ws` |
| [`pyai-site-voice-concierge`](./pyai-site-voice-concierge) | A **"Talk to PyAI"** website voice agent: a browser widget brokered to **Omni** server-side (no key in the page), grounded per-turn on your own `kb_endpoint`. **One-click deploy** (Render) with grounding auto-configured — no ngrok. | Node, Fastify, browser |
| [`cascade-hear-llm-speak`](./cascade-hear-llm-speak) | The build-your-own pipeline: **Hear** (STT) → your LLM → **Speak** (TTS). Runs end to end with just a key. | Node, REST |
| [`speak-telephony-formats`](./speak-telephony-formats) | **Speak** server-side audio formats (`g711_ulaw`/`g711_alaw`/`pcm`/`mp3`/`opus`) — get Twilio-ready μ-law in one param instead of a hand-rolled resampler + μ-law encoder. | Node, Python, curl |
| [`browser-hear-live-captions`](./browser-hear-live-captions) | Stream mic audio from the browser to **Hear** and render live partial/final captions. | Static HTML/JS |
| [`voice-cloning`](./voice-cloning) | Clone a voice end to end: enroll a reference clip → poll until ready → speak in the cloned voice → use it in **Omni**. Includes the "why was my clip rejected" table. | Node, REST |
| [`recap-call-intelligence`](./recap-call-intelligence) | Mine your calls: batch-transcribe (diarized) with **Hear** jobs, then compute **talk-ratio + keywords + summary** — the Gong-style "conversation intelligence" recipe. | Node, REST |

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
- **A phone agent, fast** → `twilio-omni-voice-agent` (Omni does listen→think→speak
  for you).
- **A phone agent on your own SIP trunk** → `freeswitch-omni-voice-agent`.
- **A voice agent on your website** → `pyai-site-voice-concierge` (browser widget +
  server-side Omni broker + your own grounding endpoint).
- **Full control of the brain** → `cascade-hear-llm-speak` (bring your own LLM).
- **Telephony-ready TTS bytes (μ-law, etc.)** → `speak-telephony-formats`.
- **Captions / transcription UI** → `browser-hear-live-captions`.
- **Your own voice in the agent** → `voice-cloning`.
- **Analytics on recorded calls** → `recap-call-intelligence`.
