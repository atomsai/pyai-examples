"""Shared call-audio renderer for the LiveKit and Pipecat bake-off arms."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
import wave


CALL_AUDIO_LEAD_MS = 250
CALL_AUDIO_BETWEEN_TURNS_MS = 500
CALL_AUDIO_DEFAULT_GAP_MS = 500
CALL_AUDIO_MAX_GAP_MS = 30_000


def _pcm_bytes(value: object) -> bytes:
    if value is None:
        return b""
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError("call audio segments must be PCM16 byte values")
    data = bytes(value)
    if len(data) % 2:
        raise ValueError("PCM16 segments must contain an even number of bytes")
    return data


def _silence(rate: int, duration_ms: int) -> bytes:
    samples = max(0, round(rate * duration_ms / 1000))
    return b"\x00\x00" * samples


def _bounded_gap(value: object) -> int:
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return CALL_AUDIO_DEFAULT_GAP_MS
    return max(0, min(CALL_AUDIO_MAX_GAP_MS, round(value)))


def write_call_wav(
    path: str | Path,
    turns: list[dict],
    rate: int,
) -> dict[str, int | str]:
    if not isinstance(rate, int) or rate <= 0:
        raise TypeError("call audio rate must be a positive integer")
    if not turns:
        raise ValueError("call audio needs at least one turn")

    pcm = bytearray(_silence(rate, CALL_AUDIO_LEAD_MS))
    for turn in turns:
        pcm.extend(_pcm_bytes(turn.get("caller_pcm")))
        pcm.extend(_silence(rate, _bounded_gap(turn.get("ttfb_ms"))))
        pcm.extend(_pcm_bytes(turn.get("agent_pcm")))
        pcm.extend(_silence(rate, CALL_AUDIO_BETWEEN_TURNS_MS))

    output = Path(path)
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    payload = output.read_bytes()
    return {
        "bytes": len(payload),
        "duration_ms": round((len(pcm) / 2 / rate) * 1000),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }
