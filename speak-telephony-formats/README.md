# Speak telephony formats: 120 lines of DSP → one param

**Speak (`POST /v1/audio/speech`) now encodes the audio server-side.** Ask for
`response_format: "g711_ulaw"` and you get back exactly the bytes a Twilio Media
Stream or SIP leg wants — 8 kHz mono μ-law — with no client-side resampler and no
μ-law encoder. The same `response_format` + `sample_rate` give you `wav`, `pcm`,
`mp3`, `opus`, and `g711_alaw` too.

```
                       BEFORE                                    AFTER
  Speak ─▶ wav@24k ─▶ [your resampler 24k→8k] ─▶      Speak ─▶ g711_ulaw@8k ─▶ Twilio
                      [your μ-law encoder]    ─▶ Twilio        (one request param)
                      ~120 lines of DSP you own & test
```

## The accepted formats

| `response_format` | sample rates (Hz) | Content-Type | notes |
|---|---|---|---|
| `mp3` | 8000 / 16000 / 24000 / 48000 | `audio/mpeg` | default; buffered (not chunk-streamed) |
| `wav` | 8000 / 16000 / 24000 / 48000 | `audio/wav` | |
| `opus` | 8000 / 16000 / 24000 / 48000 | `audio/ogg` | buffered |
| `aac` | 8000 / 16000 / 24000 / 48000 | `audio/aac` | buffered |
| `flac` | 8000 / 16000 / 24000 / 48000 | `audio/flac` | lossless |
| `pcm` | 8000 / 16000 / 24000 / 48000 | `audio/pcm` | raw int16 LE mono, no header |
| `g711_ulaw` | 8000 (forced) | `audio/basic` | Twilio / PSTN μ-law |
| `g711_alaw` | 8000 (forced) | `audio/basic` | A-law (EU telephony) |

Any value outside this set is rejected with `400 unsupported_format`. `sample_rate`
is optional — omit it for the engine's native 24 kHz (`g711_*` is always 8 kHz);
omit `response_format` for the default `mp3`. Responses carry `x-pyai-format` and
`x-pyai-sample-rate` headers so you can confirm what you got.

## Run it

```bash
cp .env.example .env       # then edit PYAI_API_KEY (a pyai_test_ key is fine)

# Node (also demonstrates the @pyai/twilio μ-law helpers as the "before")
npm install
npm start

# Python (zero third-party deps)
python3 speak_g711.py
```

Both write `out.ulaw` (raw 8 kHz μ-law) and print its size and the response
headers.

## The one-liner, three ways

### Node — `@pyai/sdk` + `@pyai/twilio`

```js
import PyAI from "@pyai/sdk";
const pyai = new PyAI({ apiKey: process.env.PYAI_API_KEY });

// AFTER: server returns μ-law@8k directly — base64 straight into a Twilio frame.
const ulaw = new Uint8Array(
  await pyai.audio.speech({
    input: "Your appointment is confirmed.",
    voice: "stock_emma_en_gb",
    response_format: "g711_ulaw",
  }),
);
const twilioMediaPayload = Buffer.from(ulaw).toString("base64");
```

### Python — `pyai-sdk`

```python
import base64, os
from pyai import PyAI

pyai = PyAI(api_key=os.environ["PYAI_API_KEY"])
ulaw = pyai.audio.speech(
    input="Your appointment is confirmed.",
    voice="stock_emma_en_gb",
    response_format="g711_ulaw",   # -> audio/basic, forced 8 kHz
)
twilio_media_payload = base64.b64encode(ulaw).decode()
```

### Raw curl — no SDK

```bash
curl -sS https://api.pyai.com/v1/audio/speech \
  -H "Authorization: Bearer $PYAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Your appointment is confirmed.","voice":"stock_emma_en_gb","response_format":"g711_ulaw"}' \
  -D - -o out.ulaw
# Response headers include:
#   content-type: audio/basic
#   x-pyai-format: g711_ulaw
#   x-pyai-sample-rate: 8000
# `out.ulaw` is raw 8 kHz mono μ-law — base64 it into a Twilio <Stream> media frame.
```

> Want a different rate? `pcm` at `sample_rate: 16000` for a 16 kHz agent
> pipeline, `mp3` for progressive download, `opus` for WebRTC. Same call, one
> param.
