"""Stream Speak to a WAV, then optionally transcribe a local recording."""
import argparse
from contextlib import closing
import os
from pathlib import Path
import time
import wave

from pyai import PyAI


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", default="Hello! Your PyAI voice integration is ready.")
    parser.add_argument("--transcribe", type=Path)
    args = parser.parse_args()
    started = time.perf_counter()
    received = 0
    with PyAI(api_key=os.environ["PYAI_API_KEY"]) as client:
        # Reuse this client in your application; do not recreate it per chunk.
        with wave.open("speech.wav", "wb") as audio:
            audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            with closing(client.audio.speech_stream(
                input=args.text,
                voice=os.getenv("PYAI_VOICE", "stock_emma_en_gb"),
                response_format="pcm", sample_rate=24000,
            )) as chunks:
                for chunk in chunks:
                    if not received:
                        print(f"First audio bytes: {(time.perf_counter() - started) * 1000:.0f} ms")
                    # A live player can consume each chunk here instead.
                    audio.writeframesraw(chunk)
                    received += len(chunk)
        if not received:
            raise RuntimeError("Speak returned no audio")
        print(f"Saved speech.wav ({received} PCM bytes)")
        if args.transcribe:
            with args.transcribe.open("rb") as recording:
                result = client.audio.transcriptions.create(
                    file=recording, filename=args.transcribe.name,
                )  # Omit the language hint for automatic detection.
            print(result["text"])


if __name__ == "__main__":
    main()
