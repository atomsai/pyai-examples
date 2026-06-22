#!/usr/bin/env python3
"""Speak telephony formats — the one-param μ-law win, in Python.

AFTER: ask Speak for response_format="g711_ulaw" and the server returns 8 kHz
mono μ-law — the exact bytes a Twilio Media Stream wants. No client-side
resampler, no μ-law encoder.

Run:  cp .env.example .env  (edit PYAI_API_KEY)  &&  python3 speak_g711.py
A pyai_test_ key is fine. Requires `pip install pyai-sdk` (zero third-party deps).
"""
import base64
import os
import sys

from pyai import PyAI

api_key = os.environ.get("PYAI_API_KEY")
if not api_key:
    sys.exit("Set PYAI_API_KEY (copy .env.example to .env). A pyai_test_ key is fine.")

pyai = PyAI(api_key=api_key, base_url=os.environ.get("PYAI_BASE_URL", "https://api.pyai.com"))
text = "Your appointment is confirmed for Tuesday at ten."
voice = os.environ.get("PYAI_VOICE", "stock_emma_en_gb")

# One param: the server hands back μ-law @ 8 kHz, ready for telephony.
ulaw = pyai.audio.speech(input=text, voice=voice, response_format="g711_ulaw")

with open("out.ulaw", "wb") as fh:
    fh.write(ulaw)

# For Twilio's <Connect><Stream>, this is the entire encode step:
twilio_media_payload = base64.b64encode(ulaw).decode()

print(f"AFTER  one param → {len(ulaw)} bytes μ-law (wrote out.ulaw)")
print(f"       twilio media payload (base64, first 32): {twilio_media_payload[:32]}…")
print("\nNo resampler, no μ-law encoder, no codec tests to maintain — the server did it.")
