import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("prep", Path(__file__).resolve().parents[1] / "server/voice_engine_worker_preparation.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ClauseBoundaryTests(unittest.TestCase):
    def test_extra_next_clause_is_outside_expected_span(self):
        words = [{"text": "是树神的私人助理", "start": .44, "end": 1.82}, {"text": "你的", "start": 1.82, "end": 2.42}]
        self.assertEqual(worker.unique_clause_word_span(words, "是树神的私人助理！"), (.44, 1.82))

    def test_ambiguous_repetition_and_partial_word_are_rejected(self):
        with self.assertRaises(RuntimeError):
            worker.unique_clause_word_span([{"text": "你好你好", "start": 0, "end": 2}], "你好")
        with self.assertRaises(RuntimeError):
            worker.unique_clause_word_span([{"text": "助理你的", "start": 0, "end": 2}], "助理")

    def test_cut_uses_silence_and_does_not_chop_sustained_speech(self):
        rate = 16000
        audio = np.ones(rate * 3) * .15
        audio[round(rate * 1.8):round(rate * 2.02)] = 0
        boundary = worker.quiet_clause_boundary(audio, rate, 1.82, "end")
        self.assertGreater(boundary / rate, 1.8)
        self.assertLess(boundary / rate, 2.02)
        with self.assertRaises(RuntimeError):
            worker.quiet_clause_boundary(np.ones(rate * 3) * .15, rate, 1.82, "end")


if __name__ == "__main__":
    unittest.main()
