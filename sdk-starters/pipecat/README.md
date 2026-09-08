# PyAI Pipecat starter

Plug PyAI speech services into the transport and LLM pipeline you already use.

## Requirements

Python 3.10–3.13. Only a PyAI key for the included text-to-WAV pipeline. A conversational bot additionally needs a Pipecat transport and an LLM; follow the linked integration guide.

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
