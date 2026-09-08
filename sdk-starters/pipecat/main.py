"""A complete text-to-audio Pipecat pipeline; no transport or LLM account needed."""
import asyncio
import os
import time
import wave
from pipecat.frames.frames import EndFrame, Frame, TTSAudioRawFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat_pyai import PyAITTSService


class SaveAudio(FrameProcessor):
    def __init__(self, output):
        super().__init__()
        self.output = output
        self.received = 0
        self.started = time.perf_counter()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            if not self.received:
                print(f"First audio frame: {(time.perf_counter() - self.started) * 1000:.0f} ms")
            self.output.writeframesraw(frame.audio)
            self.received += len(frame.audio)
        await self.push_frame(frame, direction)


async def main():
    with wave.open("speech.wav", "wb") as output:
        output.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        sink = SaveAudio(output)
        tts = PyAITTSService(voice=os.getenv("PYAI_VOICE", "stock_emma_en_gb"))
        task = PipelineTask(Pipeline([tts, sink]), params=PipelineParams(audio_out_sample_rate=24000))
        await task.queue_frames([TTSSpeakFrame("Hello from PyAI and Pipecat."), EndFrame()])
        await PipelineRunner().run(task)
        if not sink.received:
            raise RuntimeError("No audio frames received")
        print("Saved speech.wav")


if __name__ == "__main__":
    asyncio.run(main())
