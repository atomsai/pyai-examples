"""Exercise the LiveKit TTS adapter without a room or LLM account."""
import asyncio
import aiohttp
import os
import time
import wave
from livekit.plugins import pyai


async def main():
    session = aiohttp.ClientSession()
    tts = pyai.TTS(voice=os.getenv("PYAI_VOICE", "stock_emma_en_gb"), http_session=session)
    received = 0
    started = time.perf_counter()
    try:
        with wave.open("speech.wav", "wb") as output:
            output.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            async with tts.synthesize("Hello from PyAI and LiveKit.") as stream:
                async for event in stream:
                    if not received:
                        print(f"First audio frame: {(time.perf_counter() - started) * 1000:.0f} ms")
                    output.writeframesraw(bytes(event.frame.data))
                    received += len(event.frame.data)
        if not received:
            raise RuntimeError("No audio frames received")
        print("Saved speech.wav")
    finally:
        await tts.aclose()
        await session.close()


if __name__ == "__main__":
    asyncio.run(main())
