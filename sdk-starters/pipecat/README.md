# PyAI Pipecat starter

Plug PyAI speech services into the transport and LLM pipeline you already use.

## Build a complete voice agent

PyAI is listed in Pipecat's [STT](https://docs.pipecat.ai/api-reference/server/services/stt/pyai)
and [TTS](https://docs.pipecat.ai/api-reference/server/services/tts/pyai) provider references.
Use the [complete WebRTC example](https://github.com/atomsai/pyai-speech-integrations/tree/main/pipecat-pyai#run-the-standalone-webrtc-example)
for a transport, VAD, LLM, Hear, Speak, and disconnect cleanup. Its README supplies
the separately pinned dependencies and server-side credential setup.

[Watch the existing interruption recording](https://docs.pipecat.ai/videos/pyai-speech-interruption.webm):
34 seconds using prerecorded synthetic input, live STT/TTS, scripted replies,
and VAD-driven interruption. This is not a human-microphone or latency benchmark.

Check the project's identity and billing limits with `GET /v1/me` before running.
PyAI, your LLM, and hosting have separate billing. The downloadable starter here
only writes a WAV file; it does not include a microphone or conversational loop.

## Try it in your browser

[Try Hear + Speak live](https://pyai-voice-demo-wfls74alya-uc.a.run.app/?source=pipecat)
before installing anything. Record or type a question about PyAI and hear the
reply. Answers are scripted; speech and transcription use real PyAI APIs.
Three free questions, no signup required; daily demo limits apply.

This standalone reference app demonstrates the speech APIs, not a hosted
Pipecat pipeline.
[Get a free API key](https://console.pyai.com/playground?signup=1&path=api&utm_source=pyai.com&utm_medium=starter&intent=pipecat-demo)
when you are ready to run the starter below.

## Requirements

Python 3.11–3.13. Only a PyAI key for the included text-to-WAV pipeline. A conversational bot additionally needs a Pipecat transport and an LLM; follow the linked integration guide.

## Run

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Fill in .env, then export its values in this shell:
set -a
. ./.env
set +a
python main.py
```

The downloadable starter is a complete text-to-audio pipeline. It does not open a microphone, room, or phone call.

Select a voice from `GET https://api.pyai.com/v1/voices`. Use the current voice/language support table rather than assuming every voice supports every language. PCM, WAV and G.711 support streaming; MP3 and Opus are buffered.

Keep `.env` out of Git. These starters use server-side credentials.

[Full guide](https://docs.pyai.com/guides/pipecat) · [Agent setup](https://pyai.com/build-with-ai) · [API contract](https://api.pyai.com/openapi.json)

## Saved-file measurement

After closing and validating a nonempty `speech.wav`, this starter sends the
original speech request ID and the fixed source `pipecat-starter` to PyAI's
existing product analytics using the same key. No audio, transcript, filename,
local path or content hash is sent. Set `PYAI_REPORT_ARTIFACTS=0` to disable it.
The optional receipt has a three-second timeout; telemetry failure never retries
synthesis or prevents using the saved file. Missing response IDs and pipeline
errors are not reported as successful artifacts.

Analytics matches receipts to successful Speak usage from the same key, counts
the first saved artifact and later UTC days of activity, and keeps internal/test
organizations separate. This measures a validated local save, not audible
playback or sound quality. Existing downloads and uninstrumented applications do
not emit these receipts. Receipts are retained for 180 days; the growth report
uses 7/30/90-day signup cohorts. It does not reassign existing customers to a new
acquisition channel.
