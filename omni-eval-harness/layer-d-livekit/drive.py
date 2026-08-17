"""Synthetic caller for the Layer D LiveKit starter. Writes Omni-shaped fixtures."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import struct
import time
import wave
from io import BytesIO
from pathlib import Path

import httpx
from dotenv import load_dotenv
from livekit import api, rtc

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

AGENT_NAME = "omni-eval-livekit"
OMNI_RATE = 24000
FRAME_MS = 20
SETTLE_S = 2.0
MIN_AGENT_S = 0.35
TURN_TIMEOUT_S = 30.0
GREETING_DRAIN_S = 6.0
AGENT_WAIT_S = 45.0
ENERGY_FLOOR = 180
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


def peak(pcm: bytes) -> int:
    if len(pcm) < 2:
        return 0
    return max(abs(struct.unpack_from("<h", pcm, i)[0]) for i in range(0, len(pcm) - 1, 2))


async def speak_pcm(client: httpx.AsyncClient, text: str, voice: str) -> bytes:
    if is_non_speech(text):
        return quiet_static(OMNI_RATE, 1200)
    res = await client.post(
        "https://api.pyai.com/v1/audio/speech",
        headers={"Authorization": f"Bearer {env('PYAI_API_KEY')}"},
        json={
            "model": "pyai-speak",
            "input": text,
            "voice": voice,
            "response_format": "pcm",
            "sample_rate": OMNI_RATE,
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


def caller_token(room: str) -> str:
    return (
        api.AccessToken(env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"))
        .with_identity("eval-caller")
        .with_name("eval-caller")
        .with_grants(
            api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True)
        )
        .to_jwt()
    )


def silence_frame() -> rtc.AudioFrame:
    n = max(1, int(OMNI_RATE * FRAME_MS / 1000))
    return rtc.AudioFrame(
        data=b"\x00" * (n * 2),
        sample_rate=OMNI_RATE,
        num_channels=1,
        samples_per_channel=n,
    )


async def publish_pcm(source: rtc.AudioSource, pcm: bytes) -> None:
    frame = max(1, int(OMNI_RATE * FRAME_MS / 1000))
    raw = memoryview(pcm)
    off = 0
    while off < len(raw):
        chunk = bytes(raw[off : off + frame * 2])
        if len(chunk) < frame * 2:
            chunk = chunk + b"\x00" * (frame * 2 - len(chunk))
        await source.capture_frame(
            rtc.AudioFrame(
                data=chunk,
                sample_rate=OMNI_RATE,
                num_channels=1,
                samples_per_channel=frame,
            )
        )
        await asyncio.sleep(FRAME_MS / 1000)
        off += frame * 2


async def pump_silence(source: rtc.AudioSource, stop: asyncio.Event) -> None:
    frame = silence_frame()
    while not stop.is_set():
        await source.capture_frame(frame)
        await asyncio.sleep(FRAME_MS / 1000)


class AgentCapture:
    def __init__(self) -> None:
        self.pcm = bytearray()
        self.first_at: float | None = None
        self.last_at: float | None = None

    def reset(self) -> None:
        self.pcm.clear()
        self.first_at = None
        self.last_at = None

    def on_frame(self, frame: rtc.AudioFrame) -> None:
        data = bytes(frame.data)
        loud = peak(data) >= ENERGY_FLOOR
        if self.first_at is None and not loud:
            return
        now = time.monotonic()
        if self.first_at is None:
            self.first_at = now
        if loud:
            self.last_at = now
        self.pcm.extend(data)


async def wait_settle(cap: AgentCapture, *, allow_empty: bool, timeout: float) -> None:
    start = time.monotonic()
    while True:
        elapsed = time.monotonic() - start
        audio_s = (cap.last_at - cap.first_at) if cap.first_at and cap.last_at else 0.0
        quiet = (time.monotonic() - cap.last_at) if cap.last_at else 0.0
        if audio_s >= MIN_AGENT_S and quiet >= SETTLE_S:
            return
        if allow_empty and cap.first_at is None and elapsed >= 0.8:
            return
        if elapsed >= timeout:
            return
        await asyncio.sleep(0.05)


def tools_for(room: str) -> list[dict]:
    log = Path(os.environ.get("LIVEKIT_TOOL_LOG", "/tmp/omni-eval-livekit-tools.jsonl"))
    if not log.exists():
        return []
    out = []
    for line in log.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("room") == room and row.get("name"):
            out.append({"name": row["name"], "args": row.get("args")})
    return out


def enable_transfer(scenario: dict) -> bool:
    for turn in scenario.get("turns") or []:
        for assertion in turn.get("expect") or []:
            if assertion.get("name") == "transfer_to_human":
                return True
    return False


def _is_agent(participant) -> bool:
    return not (participant.identity or "").startswith("eval-caller")


async def wait_agent(room: rtc.Room, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(_is_agent(p) for p in room.remote_participants.values()):
            return True
        await asyncio.sleep(0.1)
    return False


async def wait_ready(room: rtc.Room, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for p in room.remote_participants.values():
            if not _is_agent(p):
                continue
            attrs = dict(getattr(p, "attributes", None) or {})
            if attrs.get("eval_ready") == "1":
                return True
        await asyncio.sleep(0.1)
    return False


async def run_scenario(scenario: dict, voice: str, client: httpx.AsyncClient) -> dict:
    room_name = f"eval-{scenario['id']}-{int(time.time())}"
    meta = json.dumps(
        {
            "persona": scenario.get("persona") or "",
            "enable_transfer": enable_transfer(scenario),
            "scenario": scenario["id"],
        }
    )
    lkapi = api.LiveKitAPI(env("LIVEKIT_URL"), env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"))
    try:
        caller_pcms = []
        for spec in scenario.get("turns") or []:
            caller_pcms.append(await speak_pcm(client, spec.get("caller_says") or "", voice))

        await lkapi.room.create_room(
            api.CreateRoomRequest(
                name=room_name,
                metadata=meta,
                empty_timeout=180,
            )
        )

        room = rtc.Room()
        cap = AgentCapture()
        pumps: list[asyncio.Task] = []

        def _attach(track, participant) -> None:
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                return
            if (participant.identity or "").startswith("eval-caller"):
                return

            async def _pump():
                stream = rtc.AudioStream(track, sample_rate=OMNI_RATE, num_channels=1)
                async for ev in stream:
                    cap.on_frame(ev.frame)

            pumps.append(asyncio.create_task(_pump()))

        @room.on("track_subscribed")
        def _on_sub(track, publication, participant):
            _attach(track, participant)

        await room.connect(env("LIVEKIT_URL"), caller_token(room_name))
        source = rtc.AudioSource(OMNI_RATE, 1, queue_size_ms=4000)
        track = rtc.LocalAudioTrack.create_audio_track("caller", source)
        pub_opts = rtc.TrackPublishOptions()
        pub_opts.source = rtc.TrackSource.SOURCE_MICROPHONE
        await room.local_participant.publish_track(track, pub_opts)
        stop_silence = asyncio.Event()
        silence_task = asyncio.create_task(pump_silence(source, stop_silence))
        await lkapi.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=AGENT_NAME,
                room=room_name,
                metadata=meta,
            )
        )
        if not await wait_agent(room, AGENT_WAIT_S):
            raise TimeoutError(f"agent did not join {room_name}")
        if not await wait_ready(room, AGENT_WAIT_S):
            raise TimeoutError(f"agent session not ready in {room_name}")
        for participant in room.remote_participants.values():
            for pub in participant.track_publications.values():
                if pub.track is not None:
                    _attach(pub.track, participant)
        await asyncio.sleep(0.4)
        cap.reset()
        await wait_settle(cap, allow_empty=True, timeout=GREETING_DRAIN_S)

        turns = []
        for i, spec in enumerate(scenario.get("turns") or []):
            caller_text = spec.get("caller_says") or ""
            caller_pcm = caller_pcms[i]
            asr = await transcribe(client, caller_pcm, OMNI_RATE, "caller.wav")
            cap.reset()
            stop_silence.set()
            await silence_task
            t0 = time.monotonic()
            await publish_pcm(source, caller_pcm)
            t_done = time.monotonic()
            stop_silence = asyncio.Event()
            silence_task = asyncio.create_task(pump_silence(source, stop_silence))
            await wait_settle(cap, allow_empty=False, timeout=TURN_TIMEOUT_S)
            agent_pcm = bytes(cap.pcm)
            agent_text = await transcribe(client, agent_pcm, OMNI_RATE, "agent.wav") or ""
            ttfb = max(0, int((cap.first_at - t_done) * 1000)) if cap.first_at is not None else None
            turn_ms = max(0, int((cap.last_at - t_done) * 1000)) if cap.last_at is not None else None
            agent_ms = (
                int((cap.last_at - cap.first_at) * 1000)
                if cap.first_at and cap.last_at
                else None
            )
            turns.append(
                {
                    "index": i,
                    "callerText": caller_text,
                    "callerAudioMs": int(len(caller_pcm) / 2 / OMNI_RATE * 1000),
                    "asrHypothesis": asr,
                    "agentText": agent_text,
                    "agentAudioMs": agent_ms,
                    "ttfbMs": ttfb,
                    "turnMs": turn_ms,
                    "toolCalls": tools_for(room_name),
                    "bargeIn": None,
                    "kb": None,
                }
            )
            _ = t0

        stop_silence.set()
        await silence_task
        await room.disconnect()
    finally:
        try:
            await lkapi.room.delete_room(api.DeleteRoomRequest(room=room_name))
        except Exception:
            pass
        await lkapi.aclose()

    return {
        "scenarioId": scenario["id"],
        "sessionLabel": scenario.get("session_label") or f"livekit-{scenario['id']}",
        "mode": "live-voice",
        "source": "livekit-starter",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "turns": turns,
    }


def to_fixture(run: dict, scenario_id: str) -> dict:
    return {
        "fixture": f"{scenario_id}.livekit",
        "scenario": scenario_id,
        "session_label": run.get("sessionLabel"),
        "mode": run.get("mode") or "live-voice",
        "recorded_at": run.get("recordedAt"),
        "note": "Layer D LiveKit starter recording. Do not tune Omni prompts or guards on this.",
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
    out_dir = ROOT / "out" / "livekit"
    holdout = ROOT / "holdout" / "livekit-2026-08-17"
    out_dir.mkdir(parents=True, exist_ok=True)
    holdout.mkdir(parents=True, exist_ok=True)
    rows = []
    async with httpx.AsyncClient() as client:
        for sid in ids:
            path = ROOT / "scenarios" / f"{sid}.json"
            scenario = json.loads(path.read_text(encoding="utf-8"))
            print(f"[livekit-pack] starting {sid}", flush=True)
            try:
                run = await run_scenario(scenario, voice, client)
            except Exception as err:
                print(f"[livekit-pack] {sid} ERROR {err}", flush=True)
                rows.append({"id": sid, "verdict": "ERROR", "error": str(err)})
                continue
            fixture = to_fixture(run, sid)
            payload = json.dumps(fixture, indent=2) + "\n"
            (out_dir / f"{sid}.offline.json").write_text(payload, encoding="utf-8")
            (holdout / f"{sid}.offline.json").write_text(payload, encoding="utf-8")
            agent = " | ".join(t.get("agent_text") or "" for t in fixture["turns"])
            print(f"[livekit-pack] {sid} agent={agent!r}", flush=True)
            first = fixture["turns"][0] if fixture["turns"] else {}
            rows.append({"id": sid, "agent": agent, "ttfb": first.get("ttfb_ms")})
    summary = {"system": "livekit", "rows": rows}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (holdout / "DO_NOT_TUNE").write_text(
        "Frozen LiveKit holdout. Do not tune Omni prompts or guards against these recordings.\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
