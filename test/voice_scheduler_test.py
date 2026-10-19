import importlib.util
from pathlib import Path
import sys
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("voice_worker_test", Path(__file__).resolve().parents[1] / "server/live_voice_worker.py")
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)


class VoiceSchedulerTests(unittest.TestCase):
    def test_long_article_is_conserved_and_bounded(self):
        text = "今天我们慢慢来。请清晰地朗读这段文字，然后继续下一段。" * 800
        parts = list(worker.bounded_speech_passages([text]))
        self.assertEqual("".join(parts), text)
        self.assertGreater(len(parts), 100)
        self.assertLessEqual(max(map(len, parts)), 88)
        self.assertLessEqual(len(parts[0]), 36)

    def test_idle_flush_decimals_and_incremental_english(self):
        inputs = ["圆周率是 3.14，", "今天温度是 26.5 度。", "", "Please read the next sentence clearly. " * 40]
        self.assertEqual("".join(worker.bounded_speech_passages(inputs)), "".join(inputs))
        self.assertTrue(any("3.14" in p for p in worker.bounded_speech_passages(inputs)))
        self.assertLessEqual(max(map(len, worker.bounded_speech_passages(["a" * 2000]))), 320)

    def test_acknowledgement_waits_for_consumer_and_cancel_unblocks(self):
        events = []
        original = worker.emit
        worker.emit = events.append
        try:
            stream = worker.TextChunkStream(maxsize=1)
            self.assertTrue(stream.append("第一句。", {"sequence": 1}))
            self.assertFalse(stream.append("第二句。", {"sequence": 2}))
            self.assertEqual(events, [])
            self.assertEqual(next(iter(stream)), "第一句。")
            self.assertEqual(events, [{"sequence": 1}])
            stream.cancel()
            self.assertEqual(list(stream), [])
        finally:
            worker.emit = original

    def test_prefetch_waits_for_playhead_and_cancels_promptly(self):
        turn = worker.Turn("session", "turn", "tts", playback_paced=True, generated_seconds=30)
        results = []
        thread = threading.Thread(target=lambda: results.append(worker.wait_for_playback_budget(turn)))
        thread.start()
        time.sleep(0.07)
        self.assertEqual(results, [])
        turn.played_seconds = 20
        thread.join(0.3)
        self.assertEqual(results, [True])
        turn.played_seconds = 0
        thread = threading.Thread(target=lambda: results.append(worker.wait_for_playback_budget(turn)))
        thread.start()
        turn.cancelled.set()
        thread.join(0.3)
        self.assertEqual(results, [True, False])

    def test_missing_playback_progress_fails_instead_of_growing_queue(self):
        turn = worker.Turn("session", "turn", "tts", playback_paced=True, generated_seconds=30)
        turn.playback_updated_at = time.monotonic() - 16
        with self.assertRaisesRegex(RuntimeError, "Playback"):
            worker.wait_for_playback_budget(turn)


if __name__ == "__main__":
    unittest.main()
