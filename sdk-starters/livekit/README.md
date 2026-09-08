# PyAI LiveKit starter

Add Hear and Speak to an existing LiveKit Agents session.

## Requirements

Python 3.10–3.13. Only a PyAI key for the included speech.wav smoke test. A complete room agent also needs LiveKit credentials and your chosen LLM; the linked guide covers that setup.

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

This starter tests the TTS adapter without opening a room. LiveKit continues to own your agent loop; the adapter does not create an Omni session.

Select a voice from `GET https://api.pyai.com/v1/voices`. Use the current voice/language support table rather than assuming every voice supports every language. PCM, WAV and G.711 support streaming; MP3 and Opus are buffered.

Keep `.env` out of Git. These starters use server-side credentials.

[Full guide](https://docs.pyai.com/guides/livekit-agents) · [Agent setup](https://pyai.com/build-with-ai) · [API contract](https://api.pyai.com/openapi.json)
