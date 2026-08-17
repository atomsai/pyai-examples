"""Layer D Pipecat starter: PyAI Hear/Speak + Groq LLM, no extra policy.

One scenario per process: `python bot.py <scenario_id>`. The driver connects
over the websocket transport, streams caller PCM, and captures the reply.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.serializers.protobuf import ProtobufFrameSerializer
from pipecat.services.groq.llm import GroqLLMService
from pipecat.transports.websocket.server import (
    SingleClientWebsocketServerParams,
    SingleClientWebsocketServerTransport,
)

from pipecat_pyai import PyAISTTService, PyAITTSService

RATE = 24000
PORT = 8765
TOOL_LOG = Path(os.environ.get("PIPECAT_TOOL_LOG", "/tmp/omni-eval-pipecat-tools.jsonl"))


def _log_tool(scenario: str, name: str, args: dict) -> None:
    TOOL_LOG.parent.mkdir(parents=True, exist_ok=True)
    with TOOL_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"scenario": scenario, "name": name, "args": args}) + "\n")


def _enable_transfer(scenario: dict) -> bool:
    for turn in scenario.get("turns") or []:
        for assertion in turn.get("expect") or []:
            if assertion.get("name") == "transfer_to_human":
                return True
    return False


async def main() -> None:
    scenario_id = sys.argv[1]
    scenario = json.loads((ROOT / "scenarios" / f"{scenario_id}.json").read_text())
    persona = scenario.get("persona") or "You are a phone support agent. Be brief."

    transport = SingleClientWebsocketServerTransport(
        SingleClientWebsocketServerParams(
            serializer=ProtobufFrameSerializer(),
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=RATE,
            audio_out_sample_rate=RATE,
            add_wav_header=False,
        ),
        host="127.0.0.1",
        port=PORT,
    )

    stt = PyAISTTService(language="en", sample_rate=RATE)
    tts = PyAITTSService(
        voice=os.environ.get("PYAI_VOICE", "stock_sarah_style2"),
        sample_rate=RATE,
    )
    llm = GroqLLMService(
        api_key=os.environ["GROQ_API_KEY"],
        model=os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b"),
    )

    tools = None
    if _enable_transfer(scenario):
        from pipecat.adapters.schemas.function_schema import FunctionSchema
        from pipecat.adapters.schemas.tools_schema import ToolsSchema

        async def transfer_to_human(params):
            args = dict(getattr(params, "arguments", {}) or {})
            _log_tool(scenario_id, "transfer_to_human", args)
            await params.result_callback(
                "Transfer signaled to the telephony transport."
            )

        llm.register_function("transfer_to_human", transfer_to_human)
        tools = ToolsSchema(
            standard_tools=[
                FunctionSchema(
                    name="transfer_to_human",
                    description="Warm-transfer the caller to a human agent.",
                    properties={"reason": {"type": "string"}},
                    required=[],
                )
            ]
        )

    context_kwargs = {"messages": [{"role": "system", "content": persona}]}
    if tools:
        context_kwargs["tools"] = tools
    context = LLMContext(**context_kwargs)
    aggregators = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            VADProcessor(vad_analyzer=SileroVADAnalyzer()),
            stt,
            aggregators.user(),
            llm,
            tts,
            transport.output(),
            aggregators.assistant(),
        ]
    )
    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True),
    )

    @transport.event_handler("on_websocket_ready")
    async def _ready(_transport):
        print("BOT_READY", flush=True)

    @transport.event_handler("on_client_disconnected")
    async def _bye(_transport, _ws):
        asyncio.get_running_loop().create_task(task.cancel())

    await PipelineRunner().run(task)


if __name__ == "__main__":
    asyncio.run(main())
