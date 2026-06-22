#!/usr/bin/env python3
"""OpenAI drop-in — your OpenAI audio code, served by PyAI.

The ONLY structural change from an OpenAI integration is the client below: set
`base_url` to PyAI and use your PyAI key. The two `client.audio.*` calls are the
same ones you already wrote against OpenAI; only the model names differ
(pyai-voice / pyai-hear instead of tts-1 / whisper-1).

Self-contained: with just a key it synthesizes a line, writes hello.mp3, then
transcribes that file back.

Run:  cp .env.example .env  (edit PYAI_API_KEY)
      pip install -r requirements.txt  &&  python3 main.py
"""
import os
import sys

from openai import OpenAI

api_key = os.environ.get("PYAI_API_KEY")
if not api_key:
    sys.exit("Set PYAI_API_KEY (copy .env.example to .env). A pyai_test_ key is fine.")

base = os.environ.get("PYAI_BASE_URL", "https://api.pyai.com").rstrip("/")

# ── The whole migration: point the official OpenAI SDK at PyAI. ──────────────
client = OpenAI(api_key=api_key, base_url=f"{base}/v1")
# ─────────────────────────────────────────────────────────────────────────────

voice = os.environ.get("PYAI_VOICE", "alloy")  # an OpenAI preset name — works unchanged
text = "The fastest migration is the one where you change a single line."

# Speak (TTS): identical to OpenAI's client.audio.speech.create, model renamed.
speech = client.audio.speech.create(
    model="pyai-voice",  # was: "tts-1" / "gpt-4o-mini-tts"
    voice=voice,
    input=text,
    response_format="mp3",
)
with open("hello.mp3", "wb") as fh:
    fh.write(speech.content)
print(f'[Speak] wrote hello.mp3 via OpenAI SDK → PyAI (voice "{voice}")')

# Hear (STT): identical to OpenAI's client.audio.transcriptions.create.
with open("hello.mp3", "rb") as fh:
    transcription = client.audio.transcriptions.create(
        model="pyai-hear",  # was: "whisper-1"
        file=fh,
    )
print(f"[Hear]  transcript: {transcription.text}")
print("\u2713 Round-trip through the OpenAI SDK, served by PyAI.")
