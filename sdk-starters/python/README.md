# PyAI Python starter

Stream Speak and transcribe recordings with Hear through one reusable client.

## Requirements

Python 3.10+. A PyAI key. The starter writes speech.wav; add --transcribe call.wav to transcribe your own recording.

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

The starter measures first received bytes, not speaker playback latency. Feed PCM chunks to your audio sink for live playback.

Select a voice from `GET https://api.pyai.com/v1/voices`. Use the current voice/language support table rather than assuming every voice supports every language. PCM, WAV and G.711 support streaming; MP3 and Opus are buffered.

Keep `.env` out of Git. These starters use server-side credentials.

[Full guide](https://docs.pyai.com/guides/sdks) · [Agent setup](https://pyai.com/build-with-ai) · [API contract](https://api.pyai.com/openapi.json)
