# Browser live captions (PyAI Hear)

A single-page demo that streams your microphone to **PyAI Hear**'s streaming
socket and renders partial + final transcripts as you speak. Pure static
HTML/JS; the included server only serves the page.

## Run it

```bash
npm start                 # serves http://localhost:5173 (no dependencies)
```

Open <http://localhost:5173>, paste a **`pyai_test_`** sandbox key, and click
**Start listening**. Grant microphone access and talk — interim words appear in
italic and finalize as you pause.

## How it works

- Captures mic audio with `getUserMedia` + an `AudioContext`, converts each
  buffer to **PCM16**, and sends it as binary WebSocket frames.
- Connects to `wss://api.pyai.com/v1/audio/transcriptions/stream` with
  `?sample_rate=<ctx rate>&encoding=pcm16&interim_results=true`. Hear accepts any
  rate from 8000–48000, so the page just reports the `AudioContext`'s real rate —
  no in-browser resampling needed.
- Authenticates with the **subprotocol** `pyai-key.<key>` — the browser-safe way
  to pass the key on a WS upgrade (you can't set headers on a browser WebSocket).

## Security

Browsers can read anything in the page, so **only use a sandbox
(`pyai_test_`) key here**, scoped to `hear:stream`. For a production web app,
mint short-lived publishable tokens server-side instead of exposing a key.

> Uses a `ScriptProcessorNode` for maximum browser compatibility in a single
> file. For production, migrate to an `AudioWorklet` (off the main thread).
