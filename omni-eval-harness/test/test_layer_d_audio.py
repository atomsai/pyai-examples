from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
import wave


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from layer_d_audio import write_call_wav  # noqa: E402


class LayerDAudioTest(unittest.TestCase):
    def test_writes_mono_pcm_with_measured_gap(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "call.wav"
            metadata = write_call_wav(
                path,
                [{
                    "caller_pcm": b"\x01\x00" * 100,
                    "agent_pcm": b"\x02\x00" * 200,
                    "ttfb_ms": 300,
                }],
                1000,
            )
            with wave.open(str(path), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 1000)
                self.assertEqual(wav.getnframes(), 1350)
            self.assertEqual(metadata["duration_ms"], 1350)
            self.assertRegex(str(metadata["sha256"]), r"^[0-9a-f]{64}$")

    def test_rejects_invalid_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "call.wav"
            with self.assertRaisesRegex(ValueError, "at least one turn"):
                write_call_wav(path, [], 24000)
            with self.assertRaisesRegex(ValueError, "even number of bytes"):
                write_call_wav(
                    path,
                    [{"caller_pcm": b"\x00", "agent_pcm": b""}],
                    24000,
                )


if __name__ == "__main__":
    unittest.main()
