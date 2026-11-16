"""A complete text-to-audio Pipecat pipeline; no transport or LLM account needed."""
import asyncio
import os
import time
import wave
import aiohttp
from artifact_receipt import report_saved_artifact, validate_saved_wav
from pipecat.frames.frames import EndFrame, ErrorFrame, Frame, TTSAudioRawFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat_pyai import PyAITTSService


class ObservedTTS(PyAITTSService):
    speech_complete = False

    async def run_tts(self, text, context_id):
        self.speech_complete = False
        received, failed = False, False
        async for frame in super().run_tts(text, context_id):
            received = received or isinstance(frame, TTSAudioRawFrame) and bool(frame.audio)
            failed = failed or isinstance(frame, ErrorFrame)
            yield frame
        self.speech_complete = received and not failed


class SaveAudio(FrameProcessor):
    def __init__(self, output):
        super().__init__()
        self.output = output
        self.received = 0
        self.failed = False
        self.started = time.perf_counter()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, ErrorFrame):
            self.failed = True
        if isinstance(frame, TTSAudioRawFrame):
            if not self.received:
                print(f"First audio frame: {(time.perf_counter() - self.started) * 1000:.0f} ms")
            self.output.writeframesraw(frame.audio)
            self.received += len(frame.audio)
        await self.push_frame(frame, direction)


async def main():
    request_ids = []
    trace = aiohttp.TraceConfig()

    async def response_received(session, context, params):
        if params.url.path == "/v1/audio/speech" and params.response.status == 200:
            request_ids.append(params.response.headers.get("x-request-id", ""))

    trace.on_request_end.append(response_received)
    async with aiohttp.ClientSession(trace_configs=[trace]) as session:
        with wave.open("speech.wav", "wb") as output:
            output.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            sink = SaveAudio(output)
            tts = ObservedTTS(voice=os.getenv("PYAI_VOICE", "stock_emma_en_gb"), aiohttp_session=session)
            task = PipelineTask(Pipeline([tts, sink]), params=PipelineParams(audio_out_sample_rate=24000))
            await task.queue_frames([TTSSpeakFrame("Hello from PyAI and Pipecat."), EndFrame()])
            await PipelineRunner().run(task)
            if sink.failed or not sink.received or not tts.speech_complete:
                raise RuntimeError("Speech did not complete successfully; do not automatically retry")
        # wave.close() fixes the WAV header before validation and the receipt.
        validate_saved_wav("speech.wav", sink.received)
        print("Saved and validated speech.wav (playback has not been verified)")
        enabled = os.getenv("PYAI_REPORT_ARTIFACTS", "1") != "0"
        reported = await report_saved_artifact(session, request_ids,
            api_key=os.getenv("PYAI_API_KEY", ""), enabled=enabled)
        print("Saved-file receipt recorded" if reported else "Saved-file receipt skipped or unavailable; the file is still saved")


if __name__ == "__main__":
    asyncio.run(main())
