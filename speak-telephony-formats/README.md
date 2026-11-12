# Streaming TTS for phone audio

Use **Speak** for streaming text-to-speech in a phone application. This existing
example sends one fixed 49-character greeting and consumes raw **8 kHz mono
G.711 μ-law** chunks as they arrive. It writes `out.ulaw` without buffering the
whole response. It does not connect to a carrier, place a call, or play audio.

## Run the Node example

Node.js 22+, no dependencies:

```sh
cp .env.example .env
# Set a test key and its confirmed PYAI_PROJECT_ID; review its usage limits.
npm start
```

The example reads `GET /v1/me`, prints project identity and billing/limit fields,
and stops before synthesis if the project differs, is live, lacks the scope or
has an invalid or zero daily cap. An absent or null daily cap means no provider
daily ceiling; the example still enforces its independent one-request bound.
Review the project's remaining usage separately:
`/v1/me` reports configured caps, not a remaining-usage counter. Starting it
requests **one** greeting under that project's limits. There are no retries,
and a 30-second deadline aborts the request and stream. Cancellation cannot
undo usage already processed. See [current billing](https://pyai.com/pricing).
An existing `out.ulaw` is preserved; move it before running again.

The request sets `stream: true`, `response_format: "g711_ulaw"`, and
`sample_rate: 8000`. Node's stream pipeline preserves backpressure and cancels
upstream on sink failure. For a connected phone transport, frame and pace these
bytes to its requirements; HTTP chunk boundaries are not telephony frames.
Base64-encode each paced μ-law payload for Twilio Media Streams. Do not base64
an entire long response into one frame. Carrier setup and charges are separate.

Use PCM for sinks that require signed 16-bit little-endian samples. MP3 and
Opus responses are buffered; choosing them does not demonstrate low-latency
chunk synthesis. See the [Speak format and streaming guide](https://docs.pyai.com/guides/speak-overview).

## Python streaming counterpart

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install pyai-sdk==0.5.0
set -a
. ./.env
set +a
python speak_g711.py
```

This uses `speech_stream` and writes each received chunk. It checks the same test
project first, sends one greeting and does not retry. Its HTTP timeout is an
inactivity timeout, not a total wall-clock deadline; use the Node example when
a strict total deadline is required. Do not run both unless both requests fit
your approved usage budget.

## Test without generating audio

```sh
npm test
```

Tests inject a mock HTTP transport and synthetic bytes: early chunk delivery,
one POST, identity mismatch, failed responses, cancellation and sink failure.
They establish stream behavior, not synthesis quality or audible playback.
