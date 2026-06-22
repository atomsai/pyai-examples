# PyAI Quickstart

From zero to your first transcription, spoken sentence, and voice agent in a few
minutes — one key, OpenAI-compatible, no card. For the full product map read
[`AGENTS.md`](./AGENTS.md); the live contract is `https://api.pyai.com/openapi.json`.

- REST base: `https://api.pyai.com/v1`
- Realtime base: `wss://api.pyai.com/v1`

---

## 1. Get a sandbox key (no humans, no card)

```bash
curl -sX POST https://api.pyai.com/v1/sandbox/keys \
  -H "Content-Type: application/json" -d '{"label":"quickstart"}'
# -> { "api_key": "pyai_test_…", "org_id": "org_…", "scopes": [ … ], "expires_at": … }

export PYAI_API_KEY=pyai_test_...   # paste api_key from the response
```

The `pyai_test_…` key works on the first call (it skips the credit gate, so it
never `402`s), covers STT/TTS/realtime, and auto-expires. **Each call mints a
fresh isolated org** — call it twice for two independent tenants (handy for
isolation tests). At your network's cap you'll get `429 sandbox_limit_reached`.

Production keys (`pyai_live_…`) are created in the console at
`https://console.pyai.com`.

> Keys are opaque — pass them through verbatim; never parse, split, or decode them.

**Coding in Cursor / Claude Code / Codex?** Skip the curl — add the PyAI **MCP
server** and let your agent mint the key and call PyAI for you:

```jsonc
// .cursor/mcp.json  ·  or:  claude mcp add pyai -- npx -y @pyai/mcp
{ "mcpServers": { "pyai": { "command": "npx", "args": ["-y", "@pyai/mcp"] } } }
```

See [`mcp-quickstart`](./mcp-quickstart) for the full setup + a runnable client.

---

## 2. Text-to-speech — Speak

Synthesize a sentence. Stream the bytes for real-time playback, or save the file.

```bash
curl -s https://api.pyai.com/v1/audio/speech \
  -H "Authorization: Bearer $PYAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"pyai-speak","voice":"nova","input":"Hello from PyAI."}' \
  --output hello.mp3
```

Already using OpenAI for audio? Point the official client at
`base_url=https://api.pyai.com/v1` and keep your code (`openai-drop-in` example).
Telephony-ready formats (`g711_ulaw`, etc.) come from a single parameter. For
your own voice, see [`voice-cloning`](./voice-cloning).

---

## 3. Transcribe a call — Hear

Synchronous: send a file, get the transcript.

```bash
curl -s https://api.pyai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $PYAI_API_KEY" \
  -F file=@call.wav
```

Other shapes:

- **Live captions** — stream audio to `GET /v1/audio/transcriptions/stream`
  (see [`browser-hear-live-captions`](./browser-hear-live-captions)).
- **After-the-call analytics** — `POST /v1/transcription/jobs` with
  `diarize: true` for speaker-separated batch transcripts (the −50% batch tier;
  see [`recap-call-intelligence`](./recap-call-intelligence)).

---

## 4. Talk to a voice agent — Omni

Omni is the **all-in-one voice agent model**: a hybrid speech-to-speech engine
with a fused LLM brain (~390 ms turn-taking). Over one socket it hears, reasons,
calls your tools, grounds answers in your knowledge base, and speaks in
emotion-aware voices. It's **zero-state**: connect with your key and send one
`configure` frame; there's nothing to create first.

```
wss://api.pyai.com/v1/omni?format=pcm16&rate=24000
# auth on the upgrade with subprotocol:  pyai-key.<your key>

# One configure frame = the whole agent:
# { "type": "configure",
#   "voice_id": "stock_ava_en_us",        // stock, cloned, or designed voice
#   "persona": "You are Acme's support agent.",
#   "kb_endpoint": "https://you.example.com/kb",   // knowledge grounding
#   "tools": [ { "name": "lookup_order", "description": "…", "parameters": {…} } ] }
# Built-ins in the engine: transfer_to_human, send_dtmf, play_hold, collect, end_call.
```

Pick the starting point that matches your channel:

- **Phone number (Twilio):** [`twilio-omni-voice-agent`](./twilio-omni-voice-agent)
- **SIP trunk (FreeSWITCH):** [`freeswitch-omni-voice-agent`](./freeswitch-omni-voice-agent)
- **Website widget:** [`pyai-site-voice-concierge`](./pyai-site-voice-concierge)
  or one-`<script>` [`omni-browser-widget`](./omni-browser-widget)
- **No key yet?** Build the client offline against [`omni-mock`](./omni-mock).

Want to own the LLM and TTS yourself? Use **Cue** for turn detection over the
streaming surface and wire **Hear → your LLM → your TTS**
([`cascade-hear-llm-speak`](./cascade-hear-llm-speak)).

---

## 5. Make it production-grade — Trace + Recap

A voice agent isn't done when it talks back. Two products turn a demo into
something you can run in production — **strongly recommended for every agent, and
effectively mandatory in regulated industries:**

- **Trace — compliance & QA on every call.** Verify disclosures/consent, detect
  prohibited language, and keep an auditable per-call QA scorecard. Scopes:
  `trace:configure`, `trace:read`.
- **Recap — conversations into usable form.** Summaries, dispositions, extracted
  fields, and CRM sync, so each call leaves behind a structured record your
  systems can act on. Scopes: `recap:configure`, `recap:read`.

---

## Next steps

- Scaffold any example in one command (no clone):

```bash
npm create pyai-app@latest                 # pick interactively
npm create pyai-app@latest openai-drop-in my-app --key "$PYAI_API_KEY"
```

- Browse all examples in the [README](./README.md).
- Use PyAI from your coding agent over MCP: [`mcp-quickstart`](./mcp-quickstart).
- Full docs: `https://docs.pyai.com` · contract: `https://api.pyai.com/openapi.json`.
