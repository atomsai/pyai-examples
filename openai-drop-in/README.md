# OpenAI drop-in: keep your code, change the base URL

Already calling OpenAI for text-to-speech or transcription? You don't rewrite
anything. Point the **official `openai` SDK** at PyAI and your existing calls —
same methods, same preset voice names (`alloy`, `nova`, …), same response
shapes — run against PyAI's [Speak](https://pyai.com/models/speak) and
[Hear](https://pyai.com/models/hear).

```diff
- const client = new OpenAI();                       // hits api.openai.com
+ const client = new OpenAI({
+   apiKey: process.env.PYAI_API_KEY,                 // pyai_live_… / pyai_test_…
+   baseURL: "https://api.pyai.com/v1",               // ← the one edit that matters
+ });
```

That's it. The rest of this example is the *same* `audio.speech.create` and
`audio.transcriptions.create` calls you already have — just renamed to PyAI's
models (`pyai-voice`, `pyai-hear`). Everything else is byte-for-byte your OpenAI
code.

```
  text ──▶ client.audio.speech.create()        ──▶ hello.mp3   (Speak / TTS)
  hello.mp3 ──▶ client.audio.transcriptions.create() ──▶ text  (Hear / STT)
            ▲ official OpenAI SDK, PyAI base URL ▲
```

## What changes vs. OpenAI

| | OpenAI | PyAI (this example) |
|---|---|---|
| SDK | `openai` | `openai` (unchanged) |
| Base URL | `https://api.openai.com/v1` | `https://api.pyai.com/v1` |
| API key | `OPENAI_API_KEY` | `PYAI_API_KEY` (`pyai_test_…` is fine) |
| TTS model | `tts-1` / `gpt-4o-mini-tts` | `pyai-voice` |
| STT model | `whisper-1` | `pyai-hear` |
| Voices | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` | **same names accepted** (mapped to PyAI stock voices), plus `GET /v1/voices` |
| Method calls | `audio.speech.create`, `audio.transcriptions.create` | identical |
| Response shapes | binary audio · `{ text }` | identical |

So: two value edits (base URL + model name). No new SDK, no reshaping payloads,
no relearning auth.

## Run it

This example is self-contained: with only a PyAI key it synthesizes a line,
writes `hello.mp3`, then transcribes that file back — proving both Speak and Hear
through the OpenAI SDK in one round trip.

```bash
cp .env.example .env        # then edit PYAI_API_KEY (a pyai_test_ key is fine)

# Node
npm install
npm start

# Python
pip install -r requirements.txt
python3 main.py
```

Output:

```
[Speak] wrote hello.mp3 via OpenAI SDK → PyAI (voice "alloy")
[Hear]  transcript: The fastest migration is the one where you change a single line.
✓ Round-trip through the OpenAI SDK, served by PyAI.
```

## Realtime, too

Voice agents on OpenAI Realtime migrate the same way — keep the realtime client,
point it at PyAI's OpenAI-compatible alias:

```
wss://api.pyai.com/v1/realtime?model=pyai-omni-realtime
```

See the [`pyai-site-voice-concierge`](../pyai-site-voice-concierge) example for a
full browser voice agent, and `docs/quickstart.md` §4 for the native Omni socket.

## Notes

- Uses the **official OpenAI SDK** on purpose — the whole point is that your
  current code keeps working. For PyAI-native ergonomics (telephony formats,
  cloning, Omni) use [`@pyai/sdk`](../../sdk/typescript) / `pip install pyai-sdk`.
- Keys are opaque — pass them through verbatim; never parse, split, or decode.
- A first-call `402 credit_exhausted` on a brand-new `pyai_live_` key is the
  billing gate, not a broken key — use a `pyai_test_` sandbox key to try it.
