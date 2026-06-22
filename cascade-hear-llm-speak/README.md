# Cascade: Hear → your LLM → Speak

The build-it-yourself voice pipeline: transcribe with **Hear**, think with **your
own LLM**, speak with **Speak**. Use this when you want full control over the
brain in the middle (vs. [Omni](https://pyai.com/models/omni), which is the whole
agent in one socket).

```
audio ──▶ Hear (STT) ──▶ your LLM ──▶ Speak (TTS) ──▶ audio
```

This example is fully self-contained: with just an API key it synthesizes a
sample question, transcribes it, runs a stubbed LLM, and writes the spoken reply
to `reply.wav`. No audio file or extra credentials required.

## Run it

```bash
cp .env.example .env     # then edit PYAI_API_KEY (a pyai_test_ key is fine)
npm install              # no third-party deps; just sets up the script
npm start
```

Output:

```
[Hear]  transcript: Hi, what are your opening hours this weekend?
[LLM]   reply:      Thanks for asking! ... We're open 9am to 6pm, Saturday and Sunday.
[Speak] wrote reply.wav (NNNNN bytes)
```

## Make it yours

- **Plug in a real LLM.** Replace the `llm()` stub in `index.js` with a call to
  your model (OpenAI, Anthropic, a local model, …) and return its text.
- **Use your own audio.** Set `INPUT_AUDIO=./call.wav` to transcribe a real file
  instead of the synthesized sample.
- **Stream for low latency.** This demo uses the simple synchronous endpoints.
  For live calls, use Hear's streaming socket
  (`wss://api.pyai.com/v1/audio/transcriptions/stream`, see the
  [browser captions example](../browser-hear-live-captions)) and Speak's
  streamed response so you start talking back within tens of milliseconds.

Uses only the built-in `fetch` (Node ≥ 22) — see `index.js`.
