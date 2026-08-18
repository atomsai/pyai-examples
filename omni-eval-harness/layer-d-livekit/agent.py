"""Layer D LiveKit starter: PyAI Hear/Speak + Groq LLM, no extra policy."""

from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobExecutorType,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.plugins import openai, silero

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

AGENT_NAME = "omni-eval-livekit"
TOOL_LOG = Path(os.environ.get("LIVEKIT_TOOL_LOG", "/tmp/omni-eval-livekit-tools.jsonl"))
GROQ_BASE = "https://api.groq.com/openai/v1"


def _parse_meta(*raws: str | None) -> dict:
    for raw in raws:
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return {}


def _log_tool(room: str, name: str, args: dict) -> None:
    TOOL_LOG.parent.mkdir(parents=True, exist_ok=True)
    with TOOL_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"room": room, "name": name, "args": args}) + "\n")


class EvalAgent(Agent):
    def __init__(self, persona: str) -> None:
        super().__init__(instructions=persona)


class TransferAgent(Agent):
    def __init__(self, persona: str, room_name: str) -> None:
        self._room_name = room_name
        super().__init__(instructions=persona)

    @function_tool
    async def transfer_to_human(self, reason: str = "") -> str:
        """Warm-transfer the caller to a human agent."""
        _log_tool(self._room_name, "transfer_to_human", {"reason": reason})
        return "Transfer signaled to the telephony transport."


def _llm():
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise ValueError("GROQ_API_KEY is required")
    model = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
    return openai.LLM(model=model, api_key=key, base_url=GROQ_BASE)


def _stt():
    from livekit.plugins import pyai

    # Exercise the released plugin's public realtime path. Version 0.1.0 waits
    # for every committed final before closing, fixing the lifecycle failure
    # that forced the original Layer D probe onto batch recognition.
    return pyai.STT(language="en")


def _tts():
    from livekit.plugins import pyai

    return pyai.TTS(voice=os.environ.get("PYAI_VOICE", "stock_sarah_style2"))


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    meta = _parse_meta(getattr(ctx.job, "metadata", None), getattr(ctx.room, "metadata", None))
    persona = (
        meta.get("persona")
        or "You are a phone support agent. Be brief. Do not invent prices or facts."
    )
    room_name = ctx.room.name if ctx.room else "unknown"
    agent = (
        TransferAgent(persona, room_name)
        if meta.get("enable_transfer")
        else EvalAgent(persona)
    )
    session = AgentSession(
        stt=_stt(),
        llm=_llm(),
        tts=_tts(),
        vad=silero.VAD.load(),
    )

    @session.on("user_input_transcribed")
    def _on_user(ev) -> None:
        text = getattr(ev, "transcript", None) or getattr(ev, "text", "")
        print(f"[agent] user transcript={text!r} room={room_name}", flush=True)

    await session.start(agent=agent, room=ctx.room)
    await ctx.room.local_participant.set_attributes({"eval_ready": "1"})
    print(f"[agent] session ready room={room_name}", flush=True)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=AGENT_NAME,
            job_executor_type=JobExecutorType.THREAD,
        )
    )
