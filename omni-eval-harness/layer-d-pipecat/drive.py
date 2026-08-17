"""Synthetic caller for the Layer D Pipecat starter. Writes Omni-shaped fixtures.

Spawns `bot.py <scenario>` per scenario, connects over the websocket transport,
streams Speak-synthesized caller PCM in real time, captures agent audio, and
transcribes both sides with Hear REST — the same ground truth as Layers C/D.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import struct
import subprocess
import sys
import time
import wave
from io import BytesIO
from pathlib import Path

import httpx
import websockets
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

RATE = 24000
FRAME_MS = 20
SETTLE_S = 2.0
MIN_AGENT_S = 0.35
TURN_TIMEOUT_S = 30.0
GREETING_DRAIN_S = 4.0
BOT_READY_TIMEOUT_S = 60.0
PACK = [
    "reflect-specific",
    "sales-no-invented-price",
    "memory-asked-vs-stated",
    "tool-low-info-silence",
    "collections-cease",
    "kb-price-miss-honest",
    "transfer-promise-kept",
    "kb-price-hit",
]


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"missing {name} in .env")
    return value


def is_non_speech(text: str) -> bool:
    return not re.search(r"[\w]", text or "", re.UNICODE)


def quiet_static(rate: int, duration_ms: int) -> bytes:
    n = max(1, int(rate * duration_ms / 1000))
    return b"".join(struct.pack("<h", ((i * 17) % 121) - 60) for i in range(n))


def pcm16_wav(pcm: bytes, rate: int) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm)
    return buf.getvalue()


async def speak_pcm(client: httpx.AsyncClient, text: str, voice: str) -> bytes:
    if is_non_speech(text):
        return quiet_static(RATE, 1200)
    res = await client.post(
        "https://api.pyai.com/v1/audio/speech",
        headers={"Authorization": f"Bearer {env('PYAI_API_KEY')}"},
        json={
            "model": "pyai-speak",
            "input": text,
            "voice": voice,
            "response_format": "pcm",
            "sample_rate": RATE,
        },
        timeout=60.0,
    )
    res.raise_for_status()
    return res.content


async def transcribe(client: httpx.AsyncClient, pcm: bytes, rate: int, name: str) -> str | None:
    if len(pcm) < int(rate * 0.08) * 2:
        return None
    files = {"file": (name, pcm16_wav(pcm, rate), "audio/wav")}
    res = await client.post(
        "https://api.pyai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {env('PYAI_API_KEY')}"},
        data={"model": "pyai-hear", "language": "en"},
        files=files,
        timeout=60.0,
    )
    res.raise_for_status()
    text = (res.json() or {}).get("text")
    return text.strip() if isinstance(text, str) and text.strip() else None


def tools_for(scenario_id: str) -> list[dict]:
    log = Path(os.environ.get("PIPECAT_TOOL_LOG", "/tmp/omni-eval-pipecat-tools.jsonl"))
    if not log.exists():
        return []
    out = []
    for line in log.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("scenario") == scenario_id and row.get("name"):
            out.append({"name": row["name"], "args": row.get("args")})
    return out


async def run_scenario(scenario: dict, voice: str, client: httpx.AsyncClient) -> dict:
    from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame
    from pipecat.serializers.protobuf import ProtobufFrameSerializer, frame_protos

    sid = scenario["id"]
    # Same brain as the LiveKit arm (gpt-oss-20b): llama-3.3-70b on Groq
    # returns tool_use_failed for the transfer tool, so it is not a viable
    # default-customer brain for this pack.
    bot_env = dict(os.environ)
    bot_env["GROQ_MODEL"] = os.environ.get("PIPECAT_GROQ_MODEL", "openai/gpt-oss-20b")
    bot = subprocess.Popen(
        [str(HERE / ".venv" / "bin" / "python"), str(HERE / "bot.py"), sid],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=str(HERE),
        env=bot_env,
    )
    try:
        bot_log = open(HERE / "out" / f"bot-{sid}.log", "a", encoding="utf-8")
        deadline = time.monotonic() + BOT_READY_TIMEOUT_S
        ready = False
        while time.monotonic() < deadline:
            line = bot.stdout.readline() if bot.stdout else ""
            if line:
                bot_log.write(line)
                bot_log.flush()
            if "BOT_READY" in line:
                ready = True
                break
            if bot.poll() is not None:
                raise RuntimeError(f"bot exited early: {line.strip()}")
            await asyncio.sleep(0.05)
        if not ready:
            raise TimeoutError("bot did not signal BOT_READY")

        def _drain():
            for line in bot.stdout or []:
                bot_log.write(line)
                bot_log.flush()

        import threading

        threading.Thread(target=_drain, daemon=True).start()

        serializer = ProtobufFrameSerializer()
        agent_pcm = bytearray()
        first_at: float | None = None
        last_at: float | None = None

        async with websockets.connect(f"ws://127.0.0.1:8765", max_size=None) as ws:

            async def pump_in():
                nonlocal first_at, last_at
                async for message in ws:
                    frame = await serializer.deserialize(message)
                    # The protobuf serializer maps the "audio" oneof to
                    # InputAudioRawFrame on BOTH directions' deserialize path,
                    # so server agent audio arrives as InputAudioRawFrame here.
                    if isinstance(frame, (InputAudioRawFrame, OutputAudioRawFrame)):
                        now = time.monotonic()
                        if first_at is None:
                            first_at = now
                        last_at = now
                        agent_pcm.extend(frame.audio)

            receiver = asyncio.create_task(pump_in())

            def encode_audio(chunk: bytes) -> bytes:
                # Client->server audio is not serializer-encodable; build the
                # same protobuf Frame the server deserializes as
                # InputAudioRawFrame.
                proto = frame_protos.Frame()
                proto.audio.audio = chunk
                proto.audio.sample_rate = RATE
                proto.audio.num_channels = 1
                return proto.SerializeToString()

            async def send_pcm(pcm: bytes):
                frame_len = int(RATE * FRAME_MS / 1000)
                raw = memoryview(pcm)
                off = 0
                while off < len(raw):
                    chunk = bytes(raw[off : off + frame_len * 2])
                    if len(chunk) < frame_len * 2:
                        chunk = chunk + b"\x00" * (frame_len * 2 - len(chunk))
                    await ws.send(encode_audio(chunk))
                    await asyncio.sleep(FRAME_MS / 1000)
                    off += frame_len * 2

            async def wait_settle(allow_empty: bool, timeout: float) -> None:
                start = time.monotonic()
                while True:
                    elapsed = time.monotonic() - start
                    audio_s = (last_at - first_at) if first_at and last_at else 0.0
                    quiet = (time.monotonic() - last_at) if last_at else 0.0
                    if audio_s >= MIN_AGENT_S and quiet >= SETTLE_S:
                        return
                    if allow_empty and first_at is None and elapsed >= 0.8:
                        return
                    if elapsed >= timeout:
                        return
                    await asyncio.sleep(0.05)

            # Drain any greeting (the starter has none, but stay consistent).
            await wait_settle(allow_empty=True, timeout=GREETING_DRAIN_S)

            turns = []
            silence = b"\x00" * int(RATE * FRAME_MS / 1000) * 2
            for i, spec in enumerate(scenario.get("turns") or []):
                caller_text = spec.get("caller_says") or ""
                caller_pcm = await speak_pcm(client, caller_text, voice)
                asr = await transcribe(client, caller_pcm, RATE, "caller.wav")
                agent_pcm.clear()
                first_at = None
                last_at = None
                await send_pcm(caller_pcm)
                t_done = time.monotonic()
                # Keep realtime silence flowing so VAD sees the turn end.
                silence_until = time.monotonic() + TURN_TIMEOUT_S
                while time.monotonic() < silence_until:
                    audio_s = (last_at - first_at) if first_at and last_at else 0.0
                    quiet = (time.monotonic() - last_at) if last_at else 0.0
                    if audio_s >= MIN_AGENT_S and quiet >= SETTLE_S:
                        break
                    await ws.send(encode_audio(silence))
                    await asyncio.sleep(FRAME_MS / 1000)
                agent_text = await transcribe(client, bytes(agent_pcm), RATE, "agent.wav") or ""
                ttfb = max(0, int((first_at - t_done) * 1000)) if first_at is not None else None
                turn_ms = max(0, int((last_at - t_done) * 1000)) if last_at is not None else None
                agent_ms = (
                    int((last_at - first_at) * 1000) if first_at and last_at else None
                )
                turns.append(
                    {
                        "index": i,
                        "callerText": caller_text,
                        "callerAudioMs": int(len(caller_pcm) / 2 / RATE * 1000),
                        "asrHypothesis": asr,
                        "agentText": agent_text,
                        "agentAudioMs": agent_ms,
                        "ttfbMs": ttfb,
                        "turnMs": turn_ms,
                        "toolCalls": tools_for(sid),
                        "bargeIn": None,
                        "kb": None,
                    }
                )
            receiver.cancel()

        return {
            "scenarioId": sid,
            "sessionLabel": scenario.get("session_label") or f"pipecat-{sid}",
            "mode": "live-voice",
            "source": "pipecat-starter",
            "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "turns": turns,
        }
    finally:
        bot.terminate()
        try:
            bot.wait(timeout=10)
        except subprocess.TimeoutExpired:
            bot.kill()


def to_fixture(run: dict, scenario_id: str) -> dict:
    return {
        "fixture": f"{scenario_id}.pipecat",
        "scenario": scenario_id,
        "session_label": run.get("sessionLabel"),
        "mode": run.get("mode") or "live-voice",
        "recorded_at": run.get("recordedAt"),
        "note": "Layer D Pipecat starter recording. Do not tune Omni prompts or guards on this.",
        "turns": [
            {
                "caller_says": t.get("callerText") or "",
                "caller_audio_ms": t.get("callerAudioMs"),
                "asr_hypothesis": t.get("asrHypothesis"),
                "agent_text": t.get("agentText") or "",
                "agent_audio_ms": t.get("agentAudioMs"),
                "ttfb_ms": t.get("ttfbMs"),
                "turn_ms": t.get("turnMs"),
                "tool_calls": t.get("toolCalls") or [],
                "barge_in": t.get("bargeIn"),
                "kb": t.get("kb"),
            }
            for t in run.get("turns") or []
        ],
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ids", nargs="*")
    args = parser.parse_args()
    ids = args.ids or PACK
    voice = os.environ.get("PYAI_VOICE") or "stock_sarah_style2"
    out_dir = ROOT / "out" / "pipecat"
    holdout = ROOT / "holdout" / "pipecat-2026-08-17"
    out_dir.mkdir(parents=True, exist_ok=True)
    holdout.mkdir(parents=True, exist_ok=True)
    rows = []
    async with httpx.AsyncClient() as client:
        for sid in ids:
            path = ROOT / "scenarios" / f"{sid}.json"
            scenario = json.loads(path.read_text(encoding="utf-8"))
            print(f"[pipecat-pack] starting {sid}", flush=True)
            try:
                run = await run_scenario(scenario, voice, client)
            except Exception as err:
                print(f"[pipecat-pack] {sid} ERROR {err}", flush=True)
                rows.append({"id": sid, "verdict": "ERROR", "error": str(err)})
                continue
            fixture = to_fixture(run, sid)
            payload = json.dumps(fixture, indent=2) + "\n"
            (out_dir / f"{sid}.offline.json").write_text(payload, encoding="utf-8")
            (holdout / f"{sid}.offline.json").write_text(payload, encoding="utf-8")
            agent = " | ".join(t.get("agent_text") or "" for t in fixture["turns"])
            print(f"[pipecat-pack] {sid} agent={agent!r}", flush=True)
            first = fixture["turns"][0] if fixture["turns"] else {}
            rows.append({"id": sid, "agent": agent, "ttfb": first.get("ttfb_ms")})
    summary = {"system": "pipecat", "rows": rows}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (holdout / "DO_NOT_TUNE").write_text(
        "Frozen Pipecat holdout. Do not tune Omni prompts or guards against these recordings.\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
