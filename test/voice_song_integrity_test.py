import importlib.util
from pathlib import Path
import unittest

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "voice_engine_worker_seed_vc",
    ROOT / "server" / "voice_engine_worker_seed_vc.py",
)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class SongIntegrityDecisionTests(unittest.TestCase):
    def test_localized_dropout_rejects_even_when_long_song_average_is_low(self):
        frames = 27700
        issue_mask = np.zeros(frames, dtype=bool)
        issue_mask[13200:13250] = True
        source_rms = np.ones(frames, dtype=np.float32) * 0.1
        source_rms[13180] = 0.001
        source_rms[13270] = 0.001
        intervals = WORKER._song_problem_intervals(issue_mask, source_rms, 277.0)
        self.assertTrue(intervals)
        reasons = WORKER._song_integrity_reasons(
            duration_delta_percent=0,
            onset_lag_ms=0,
            voiced_dropout_percent=0.5,
            pitch_over_100_percent=0,
            abrupt_jumps_per_minute=0,
            target_similarity=0.8,
            identity_floor=0.55,
            problem_intervals=intervals,
        )
        self.assertIn("localized_pitch_failure", reasons)

    def test_already_similar_source_has_achievable_non_regression_floor(self):
        floor = WORKER._song_identity_floor(0.90)
        self.assertAlmostEqual(floor, 0.87)
        self.assertLessEqual(WORKER._song_identity_floor(1.0), 0.90)
        reasons = WORKER._song_integrity_reasons(
            duration_delta_percent=0,
            onset_lag_ms=0,
            voiced_dropout_percent=0,
            pitch_over_100_percent=0,
            abrupt_jumps_per_minute=0,
            target_similarity=0.88,
            identity_floor=floor,
            problem_intervals=[],
        )
        self.assertNotIn("target_identity_weak", reasons)

    def test_exact_octave_error_is_not_erased_by_pitch_class_wrapping(self):
        source_f0 = np.full(100, 220.0, dtype=np.float32)
        converted_f0 = np.full(100, 440.0, dtype=np.float32)
        voiced = np.ones(100, dtype=bool)
        absolute_error, pitch_class_error = WORKER._song_pitch_errors(source_f0, converted_f0, voiced)
        self.assertTrue(np.allclose(absolute_error, 1200.0, atol=0.01))
        self.assertTrue(np.allclose(pitch_class_error, 0.0, atol=0.01))
        reasons = WORKER._song_integrity_reasons(
            duration_delta_percent=0,
            onset_lag_ms=0,
            voiced_dropout_percent=0,
            pitch_over_100_percent=100,
            abrupt_jumps_per_minute=0,
            target_similarity=0.8,
            identity_floor=0.55,
            problem_intervals=[],
        )
        self.assertIn("pitch_deviation", reasons)

    def test_short_pitch_transition_mismatches_do_not_become_repair_phrases(self):
        issue_mask = np.zeros(500, dtype=bool)
        issue_mask[100:106] = True
        issue_mask[112:118] = True
        persistent = WORKER._song_persistent_mask(issue_mask, 18)
        self.assertFalse(persistent.any())

    def test_sustained_pitch_damage_remains_repairable(self):
        issue_mask = np.zeros(500, dtype=bool)
        issue_mask[100:125] = True
        persistent = WORKER._song_persistent_mask(issue_mask, 18)
        self.assertTrue(np.all(persistent[100:125]))
        source_rms = np.ones(500, dtype=np.float32) * 0.1
        intervals = WORKER._song_problem_intervals(persistent, source_rms, 5.0)
        self.assertTrue(intervals)

    def test_abrupt_jump_can_be_expanded_into_a_phrase_repair_interval(self):
        abrupt = np.zeros(500, dtype=bool)
        abrupt[250] = True
        expanded = WORKER._song_dilate_mask(abrupt, 15)
        source_rms = np.ones(500, dtype=np.float32) * 0.1
        source_rms[200] = 0.001
        source_rms[300] = 0.001
        intervals = WORKER._song_problem_intervals(expanded, source_rms, 5.0)
        self.assertTrue(intervals)


if __name__ == "__main__":
    unittest.main()
