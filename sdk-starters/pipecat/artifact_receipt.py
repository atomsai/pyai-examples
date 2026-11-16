"""Optional metadata-only receipt. Never uploads audio or retries synthesis."""
import re
import wave


def validate_saved_wav(path, expected_bytes):
    """Check the finalized header and payload before reporting a saved artifact."""
    with wave.open(str(path), "rb") as audio:
        if audio.getparams()[:3] != (1, 2, 24000) or audio.getcomptype() != "NONE":
            raise ValueError("Unexpected WAV format")
        size = audio.getnframes() * 2
        if size <= 0 or size != expected_bytes or len(audio.readframes(audio.getnframes())) != size:
            raise ValueError("Empty, incomplete or inconsistent WAV")


async def report_saved_artifact(session, request_ids, *, api_key, enabled=True):
    # A single-utterance starter must have one unambiguous successful request.
    if not enabled or not api_key or len(request_ids) != 1:
        return False
    request_id = request_ids[0]
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", request_id):
        return False
    try:
        # Bounded, best effort, no redirect or automatic retry. Do not print
        # exceptions/response bodies: they could contain sensitive information.
        import aiohttp
        async with session.post(
            "https://api.pyai.com/v1/me/artifacts",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"request_id": request_id, "source": "pipecat-starter"},
            timeout=aiohttp.ClientTimeout(total=3), allow_redirects=False,
        ) as response:
            return response.status in (200, 201)
    except Exception:
        return False
