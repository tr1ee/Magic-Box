import importlib.util
import math
import os
import random
import struct
import sys
import tempfile
import time
import types
import wave
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "server" / "voice_engine_worker_preparation.py"
SPEC = importlib.util.spec_from_file_location("voice_preparation_worker", WORKER_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)
SEED_WORKER_PATH = ROOT / "server" / "voice_engine_worker_seed_vc.py"
SEED_SPEC = importlib.util.spec_from_file_location("seed_vc_worker", SEED_WORKER_PATH)
SEED_WORKER = importlib.util.module_from_spec(SEED_SPEC)
SEED_SPEC.loader.exec_module(SEED_WORKER)

EXPECTED_TEXT = "Every requested sentence is present."
EXPECTED_HTDEMUCS_CHECKPOINT = "955717e8-8726e21a.th"


def assert_ordered_coverage_recovers_after_errors():
    expected = list("你好小鸟我叫小爱是树神的私人助理")
    observed = expected.copy()
    observed[3] = "猫"
    assert WORKER.ordered_token_coverage(expected, observed) == (len(expected) - 1) / len(expected)
    assert WORKER.ordered_token_coverage(expected, observed) >= 0.92
    observed[8] = "在"
    assert WORKER.ordered_token_coverage(expected, observed) < 0.92
    assert WORKER.ordered_token_coverage(expected, expected[:8]) < 0.92
    assert WORKER.ordered_token_coverage(expected, list(reversed(expected))) < 0.92
    assert WORKER.ordered_token_coverage(["magicbox", "works"], ["magic", "box", "works"]) == 1
    assert WORKER.ordered_token_coverage(["magicbox", "box"], ["magic", "box"]) == 0.5
    assert WORKER.ordered_token_coverage([], []) == 1
    assert WORKER.ordered_token_coverage(["missing"], []) == 0

    def reference_lcs(left, right, matches):
        previous = [0] * (len(right) + 1)
        for item in left:
            row = [0]
            for index, other in enumerate(right):
                row.append(max(previous[index + 1], row[-1], previous[index] + int(matches(item, other))))
            previous = row
        return previous[-1] / len(left) if left else 1

    rng = random.Random(71093)
    for _ in range(250):
        left = [rng.choice("甲乙丙丁") for _ in range(rng.randrange(25))]
        right = [rng.choice("甲乙丙丁") for _ in range(rng.randrange(25))]
        assert WORKER.ordered_token_coverage(left, right) == reference_lcs(left, right, lambda a, b: a == b)
        left_options = [frozenset((item, rng.choice("甲乙丙丁"))) for item in left]
        right_options = [frozenset((item, rng.choice("甲乙丙丁"))) for item in right]
        assert WORKER.ordered_option_coverage(left_options, right_options) == reference_lcs(
            left_options, right_options, lambda a, b: not a.isdisjoint(b))
    assert WORKER.ordered_option_coverage([frozenset("ab"), frozenset("b")], [frozenset("b")]) == 0.5


def write_pcm_wav(path, envelope, carrier_hz=200, extra_signal=None, sample_rate=16000):
    duration_seconds = 18
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        frames = bytearray()
        for index in range(sample_rate * duration_seconds):
            time_seconds = index / sample_rate
            carrier = math.sin(math.tau * carrier_hz * time_seconds)
            value = envelope(time_seconds) * carrier
            if extra_signal:
                value += extra_signal(time_seconds)
            value = max(-0.98, min(0.98, value))
            frames.extend(struct.pack("<h", round(value * 32767)))
        writer.writeframes(frames)


def validate(path, settings=None):
    original_transcribe = WORKER.transcribe
    WORKER.transcribe = lambda *_args, **_kwargs: [SimpleNamespace(text=EXPECTED_TEXT)]
    try:
        return WORKER.validate_synthesis({
            "audioPath": str(path),
            "expectedText": EXPECTED_TEXT,
            "language": "en",
            "settings": settings or {},
        }, model=object(), emit=False, runtime_checked=True)
    finally:
        WORKER.transcribe = original_transcribe


def assert_extra_text_is_bounded():
    assert WORKER.observed_token_count_is_bounded(10, 13)
    assert not WORKER.observed_token_count_is_bounded(10, 20)
    assert WORKER.ordered_coverage("你好", "你好你好") == 1.0
    assert not WORKER.observed_token_count_is_bounded(2, 4)
    collapsed, normalized = WORKER.collapse_expressive_repetitions(list("我复活啦啦啦啦啦啦我测你的吗"))
    assert normalized
    assert "".join(collapsed) == "我复活啦我测你的吗"


def assert_clean_fixture(directory):
    path = directory / "clean.wav"
    write_pcm_wav(path, lambda _time_seconds: 0.5)
    result = validate(path)
    assert result["accepted"], result
    assert not result["waveformHealth"]["persistentModulationDetected"], result
    # 100/120 Hz are plausible low vocal fundamentals, not proof that a 50/60
    # Hz electrical fundamental exists.
    for frequency in (100, 120):
        voice_path = directory / f"clean-{frequency}hz.wav"
        write_pcm_wav(voice_path, lambda _time_seconds: 0.5, carrier_hz=frequency)
        voice_result = validate(voice_path)
        assert voice_result["accepted"], voice_result
        assert voice_result["waveformHealth"]["lineHumFrequencyHz"] == 0, voice_result
    syllabic_path = directory / "clean-syllabic-envelope.wav"
    write_pcm_wav(syllabic_path, lambda time_seconds: 0.55 * (1 + 0.20 * math.sin(math.tau * 2 * time_seconds)))
    syllabic_result = validate(syllabic_path)
    assert syllabic_result["accepted"], syllabic_result


def assert_hum_fixture(directory):
    path = directory / "hum.wav"
    write_pcm_wav(
        path,
        lambda _time_seconds: 0.50,
        extra_signal=lambda time_seconds: 0.35 * math.sin(math.tau * 60 * time_seconds),
    )
    result = validate(path)
    assert not result["accepted"], result
    assert "line_hum_detected" in result["reasons"], result
    assert result["waveformHealth"]["lineHumFrequencyHz"] == 60, result
    repaired_path = directory / "hum-repaired.wav"
    repair = WORKER.repair_synthesis_audio({
        "audioPath": str(path),
        "outputPath": str(repaired_path),
    }, runtime_checked=True)
    repaired = validate(repaired_path)
    assert "notch_60hz" in repair["appliedFilters"], repair
    assert repaired["accepted"], repaired


def assert_electronic_roughness_fixture(directory):
    path = directory / "electronic-roughness.wav"
    write_pcm_wav(
        path,
        lambda _time_seconds: 0.18,
        carrier_hz=220,
        extra_signal=lambda time_seconds: 0.22 * math.sin(math.tau * 10000 * time_seconds),
        sample_rate=32000,
    )
    advisory = validate(path)
    assert advisory["accepted"], advisory
    assert advisory["waveformHealth"]["electronicRoughnessDetected"], advisory
    rejected = validate(path, {"enforceSpectralQuality": True})
    assert not rejected["accepted"], rejected
    assert "electronic_roughness_detected" in rejected["reasons"], rejected
    assert rejected["waveformHealth"]["highFrequencyRatio"] > 0.08, rejected
    assert rejected["waveformHealth"]["highToPresenceRatio"] > 0.55, rejected


def assert_seed_vc_config_is_portable(directory):
    import yaml

    repo_dir = directory / "relocated-seed-vc"
    local_models = repo_dir / "checkpoints" / "magicbox_models"
    whisper_dir = local_models / "whisper-small"
    bigvgan_dir = local_models / "bigvgan_v2_44khz_128band_512x"
    whisper_dir.mkdir(parents=True)
    bigvgan_dir.mkdir(parents=True)
    (whisper_dir / "config.json").write_text("{}", encoding="utf-8")
    (bigvgan_dir / "config.json").write_text("{}", encoding="utf-8")
    source_config = repo_dir / "checkpoints" / "magicbox_seed_vc_svc.yml"
    source_config.write_text(
        "model_params:\n"
        "  vocoder:\n"
        "    name: C:\\\\stale-install\\\\bigvgan\n"
        "  speech_tokenizer:\n"
        "    name: C:\\\\stale-install\\\\whisper\n",
        encoding="utf-8",
    )
    output_dir = directory / "runtime-config"
    output_dir.mkdir()
    runtime_config = SEED_WORKER.portable_seed_vc_config(repo_dir, source_config, output_dir)
    patched = yaml.safe_load(runtime_config.read_text(encoding="utf-8"))
    assert Path(patched["model_params"]["vocoder"]["name"]) == bigvgan_dir.resolve(), patched
    assert Path(patched["model_params"]["speech_tokenizer"]["name"]) == whisper_dir.resolve(), patched
    assert "stale-install" in source_config.read_text(encoding="utf-8")


def assert_localized_tremble_fixture(directory):
    path = directory / "localized-tremble.wav"

    def envelope(time_seconds):
        # The stable 2 Hz speech-like envelope dominates the whole file. A
        # local 1.4 s, 6 Hz wobble must still fail even when the global score
        # is diluted below the threshold.
        base = 0.55 * (1 + 0.20 * math.sin(math.tau * 2 * time_seconds))
        if 8.0 <= time_seconds < 9.4:
            return base * (1 + 0.35 * math.sin(math.tau * 6 * time_seconds))
        return base

    write_pcm_wav(path, envelope)
    result = validate(path)
    health = result["waveformHealth"]
    assert health["modulationScore"] < 0.45, health
    assert health["maxLocalModulationScore"] > 0.45, health
    assert health["persistentModulationDetected"], health
    assert health["persistentModulationSeconds"] >= 1.2, health
    assert not result["accepted"], result
    assert "unstable_amplitude_detected" in result["reasons"], result


def assert_validation_handles_chinese_orthography(directory):
    path = directory / "chinese-orthography.wav"
    silent_path = directory / "chinese-orthography-silent.wav"
    write_pcm_wav(path, lambda _time_seconds: 0.5)
    write_pcm_wav(silent_path, lambda _time_seconds: 0.0)
    expected_chinese = "\u4f60\u597d\uff0c\u4eca\u5929\u6211\u4eec\u6765\u6d4b\u8bd5\u4f18\u5316\u540e\u7684\u514b\u9686\u58f0\u97f3\u3002"
    traditional_chinese = "\u4f60\u597d,\u4eca\u5929\u6211\u5011\u4f86\u6e2c\u8a66\u512a\u5316\u5f8c\u7684\u514b\u9686\u8072\u97f3"

    class FakeModel:
        def __init__(self, unprompted):
            self.unprompted = unprompted
            self.calls = []

        def transcribe(self, _path, **kwargs):
            self.calls.append(kwargs)
            return [SimpleNamespace(text=self.unprompted)], None

    orthography_model = FakeModel(traditional_chinese)
    result = WORKER.validate_synthesis({
        "audioPath": str(path),
        "expectedText": expected_chinese,
        "language": "zh",
    }, model=orthography_model, emit=False, runtime_checked=True)
    assert result["accepted"], result
    assert result["coverage"] == 1.0, result
    # Ten of seventeen codepoints match; later words still count after a
    # traditional character differs. Phonetic coverage remains exact.
    assert result["unpromptedCoverage"] == 0.588, result
    assert result["phoneticCoverage"] == 1.0, result
    assert result["chineseOrthographyNormalized"], result
    assert result["expectedTokenCount"] == 17, result
    assert len(orthography_model.calls) == 1, orthography_model.calls

    low_codepoint_simplified = "\u4e07\u4e0e\u4e11\u4e13\u4e1a\u4e1b\u4e1c\u4e1d\u4e22\u4e24\u4e25\u4e27\u4e2a\u4e34\u4e3a\u4e3d\u4e3e"
    low_codepoint_traditional = "\u842c\u8207\u919c\u5c08\u696d\u53e2\u6771\u7d72\u4e1f\u5169\u56b4\u55aa\u500b\u81e8\u70ba\u9e97\u8209"
    diverse = WORKER.validate_synthesis({
        "audioPath": str(path),
        "expectedText": low_codepoint_simplified,
        "language": "zh",
    }, model=FakeModel(low_codepoint_traditional), emit=False, runtime_checked=True)
    assert diverse["accepted"] and diverse["phoneticCoverage"] == 1.0, diverse

    orthography_pairs = [
        ("\u770b\u7740\u97f3\u4e50", "\u770b\u8457\u97f3\u6a02"),
        ("\u91cd\u5e86\u94f6\u884c", "\u91cd\u6176\u9280\u884c"),
        ("\u5934\u53d1\u53d1\u5c55", "\u982d\u9aee\u767c\u5c55"),
        ("\u91cc\u9762\u5e72\u51c0", "\u88e1\u9762\u4e7e\u6de8"),
        ("\u53d1\u578b", "\u9aee\u578b"),
        ("\u7248\u672cV2\u53d1\u5e03", "\u7248\u672cV\u4e8c\u767c\u4f48"),
        ("2026\u5e74\u53d1\u5e03", "\u4e8c\u96f6\u4e8c\u516d\u5e74\u767c\u4f48"),
        ("2.5%\u53d1\u5e03", "\u767e\u5206\u4e4b\u4e8c\u70b9\u4e94\u767c\u4f48"),
    ]
    for simplified, traditional in orthography_pairs:
        normalized = WORKER.validate_synthesis({
            "audioPath": str(path),
            "expectedText": simplified,
            "language": "zh",
        }, model=FakeModel(traditional), emit=False, runtime_checked=True)
        assert normalized["accepted"] and normalized["phoneticCoverage"] == 1.0, (simplified, traditional, normalized)

    adversarial_cases = [
        (silent_path, ""),
        (path, "".join(WORKER.tokenise(expected_chinese)[:10])),
        (path, "".join(reversed(WORKER.tokenise(expected_chinese)))),
        (path, "\u9519" * 17),
        (path, "".join(WORKER.tokenise(expected_chinese)[:9]) + "\u9519" * 8),
    ]
    for audio_path, unprompted in adversarial_cases:
        rejected = WORKER.validate_synthesis({
            "audioPath": str(audio_path),
            "expectedText": expected_chinese,
            "language": "zh",
        }, model=FakeModel(unprompted), emit=False, runtime_checked=True)
        assert not rejected["accepted"], (unprompted, rejected)
        assert "ordered_text_coverage_low" in rejected["reasons"], (unprompted, rejected)

    expressive_text = "我复活啦！啦啦啦啦啦，我测你的吗！"
    collapsed_chant = WORKER.validate_synthesis({
        "audioPath": str(path),
        "expectedText": expressive_text,
        "language": "zh",
    }, model=FakeModel("我复活啦，我测你的吗！"), emit=False, runtime_checked=True)
    assert collapsed_chant["accepted"], collapsed_chant
    assert collapsed_chant["expressiveRepetitionNormalized"], collapsed_chant
    assert collapsed_chant["expressiveCoverage"] == 1.0, collapsed_chant

    missing_tail = WORKER.validate_synthesis({
        "audioPath": str(path),
        "expectedText": expressive_text,
        "language": "zh",
    }, model=FakeModel("我复活啦"), emit=False, runtime_checked=True)
    assert not missing_tail["accepted"], missing_tail
    assert "ordered_text_coverage_low" in missing_tail["reasons"], missing_tail

    english_model = FakeModel("Entirely different English words.")
    english = WORKER.validate_synthesis({
        "audioPath": str(path),
        "expectedText": EXPECTED_TEXT,
        "language": "en",
    }, model=english_model, emit=False, runtime_checked=True)
    assert not english["accepted"], english
    assert len(english_model.calls) == 1, english_model.calls


def assert_secondary_asr_can_resolve_primary_under_transcription(directory):
    path = directory / "secondary-asr-authoritative.wav"
    write_pcm_wav(path, lambda _time_seconds: 0.5)
    expected = "你好，今天也要保持快乐，认真完成每一件想做的事情。"

    class FakeModel:
        def __init__(self, text):
            self.text = text

        def transcribe(self, _path, **_kwargs):
            return [SimpleNamespace(text=self.text)], None

    original_loader = WORKER.load_secondary_asr_model
    WORKER.load_secondary_asr_model = lambda _request: FakeModel(expected)
    try:
        result = WORKER.validate_synthesis({
            "audioPath": str(path),
            "expectedText": expected,
            "language": "zh",
            "settings": {"secondaryAsrEnabled": True},
        }, model=FakeModel("你好今天"), emit=False, runtime_checked=True)
    finally:
        WORKER.load_secondary_asr_model = original_loader

    assert result["accepted"], result
    assert result["coverage"] == 1.0, result
    assert result["secondaryAsrAuthoritative"], result
    assert result["reason"] == "" and result["reasons"] == [], result
    assert result["primaryAsrRawCoverage"] < 0.92, result
    assert "ordered_text_coverage_low" not in result["reasons"], result


def assert_reference_relative_tremble_fixture(directory):
    reference_path = directory / "human-reference-rhythm.wav"
    candidate_path = directory / "matching-reference-rhythm.wav"
    unstable_path = directory / "excess-reference-rhythm.wav"

    def reference_envelope(time_seconds):
        base = 0.55 * (1 + 0.20 * math.sin(math.tau * 2 * time_seconds))
        if 8.0 <= time_seconds < 9.4:
            return base * (1 + 0.35 * math.sin(math.tau * 6 * time_seconds))
        return base

    write_pcm_wav(reference_path, reference_envelope)
    write_pcm_wav(candidate_path, reference_envelope)
    write_pcm_wav(
        unstable_path,
        lambda time_seconds: 0.50 * (1 + 0.55 * math.sin(math.tau * 6 * time_seconds)),
    )
    original_transcribe = WORKER.transcribe
    WORKER.transcribe = lambda *_args, **_kwargs: [SimpleNamespace(text=EXPECTED_TEXT)]
    try:
        matching = WORKER.validate_synthesis({
            "audioPath": str(candidate_path),
            "referenceAudioPath": str(reference_path),
            "expectedText": EXPECTED_TEXT,
            "language": "en",
        }, model=object(), emit=False, runtime_checked=True)
        assert matching["accepted"], matching
        assert matching["waveformHealth"]["persistentModulationDetected"], matching
        assert not matching["waveformHealth"]["exceedsReferenceModulation"], matching

        excess = WORKER.validate_synthesis({
            "audioPath": str(unstable_path),
            "referenceAudioPath": str(reference_path),
            "expectedText": EXPECTED_TEXT,
            "language": "en",
        }, model=object(), emit=False, runtime_checked=True)
        assert not excess["accepted"], excess
        assert "unstable_amplitude_detected" in excess["reasons"], excess
        assert excess["waveformHealth"]["exceedsReferenceModulation"], excess

        for high_reference_score in (0.77, 0.80, 1.0):
            localized_candidate, high_limit = WORKER.waveform_instability_exceeds_reference(
                {"persistentModulationDetected": True, "modulationScore": 0.30},
                {"modulationScore": high_reference_score},
            )
            unstable_candidate, _ = WORKER.waveform_instability_exceeds_reference(
                {"persistentModulationDetected": True, "modulationScore": 0.70},
                {"modulationScore": high_reference_score},
            )
            assert high_limit is None and localized_candidate, (high_reference_score, high_limit)
            assert unstable_candidate, high_reference_score
    finally:
        WORKER.transcribe = original_transcribe


def assert_training_distribution_tremble_fixture(directory):
    del directory
    reference_health = {"activity": 0.7, "modulationScore": 0.32}
    baseline_healths = [
        {"activity": 0.7, "modulationScore": score}
        for score in (0.22, 0.28, 0.31, 0.36, 0.42, 0.48)
    ]
    candidate_health = {"persistentModulationDetected": True, "modulationScore": 0.50}
    unstable_health = {"persistentModulationDetected": True, "modulationScore": 0.78}
    candidate_exceeds, limit = WORKER.waveform_instability_exceeds_reference(
        candidate_health,
        reference_health,
        baseline_healths,
    )
    unstable_exceeds, unstable_limit = WORKER.waveform_instability_exceeds_reference(
        unstable_health,
        reference_health,
        baseline_healths,
    )
    baseline = WORKER.waveform_modulation_baseline(reference_health, baseline_healths)
    assert baseline["kind"] == "training-distribution", baseline
    assert baseline["count"] == 6, baseline
    assert limit == unstable_limit
    assert not candidate_exceeds, (limit, candidate_health)
    assert unstable_exceeds, (unstable_limit, unstable_health)

    # A collection of already-unstable clips must never train the gate to
    # accept maximum modulation. It falls back to the usable reference.
    unsafe_baselines = [
        {"activity": 0.8, "modulationScore": score}
        for score in (0.80, 0.84, 0.90, 0.96, 1.0)
    ]
    unsafe_baseline = WORKER.waveform_modulation_baseline(reference_health, unsafe_baselines)
    unsafe_candidate, unsafe_limit = WORKER.waveform_instability_exceeds_reference(
        {"persistentModulationDetected": True, "modulationScore": 1.0},
        reference_health,
        unsafe_baselines,
    )
    assert unsafe_baseline["kind"] == "reference", unsafe_baseline
    assert unsafe_limit < 0.72, unsafe_limit
    assert unsafe_candidate, (unsafe_limit, unsafe_baseline)

    # Even a high-but-usable distribution remains capped at the strict
    # boundary, so a maximum-wobble candidate cannot pass.
    high_usable_baselines = [
        {"activity": 0.8, "modulationScore": score}
        for score in (0.66, 0.67, 0.68, 0.69, 0.71)
    ]
    capped = WORKER.waveform_modulation_baseline(reference_health, high_usable_baselines)
    capped_candidate, capped_limit = WORKER.waveform_instability_exceeds_reference(
        {"persistentModulationDetected": True, "modulationScore": 1.0},
        reference_health,
        high_usable_baselines,
    )
    assert capped["kind"] == "training-distribution", capped
    assert capped_limit == 0.72, capped
    assert capped_candidate, (capped_limit, capped)


def assert_sentence_assembly(directory):
    source_path = directory / "source.wav"
    source_path.write_bytes(b"source")
    vocal_path = directory / "vocal.wav"
    accompaniment_path = directory / "accompaniment.wav"
    original_require_runtime = WORKER.require_runtime
    original_isolate_vocals = WORKER.isolate_vocals
    original_transcribe = WORKER.transcribe
    original_run_ffmpeg = WORKER.run_ffmpeg
    original_emit_progress = WORKER.emit_progress
    isolated_sources = []
    try:
        WORKER.require_runtime = lambda _request: {
            **WORKER.torch_runtime_state(),
            "asrDevice": "cpu",
        }
        def fake_isolate(_request, source, _output):
            isolated_sources.append(Path(source))
            return vocal_path, accompaniment_path

        WORKER.isolate_vocals = fake_isolate
        WORKER.run_ffmpeg = lambda _request, args: Path(args[-1]).write_bytes(b"clip")
        WORKER.emit_progress = lambda *_args, **_kwargs: None
        split_sentence = [
            SimpleNamespace(start=0, end=1.5, text="This sentence begins", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
            SimpleNamespace(start=1.5, end=4.0, text="and ends here.", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
        ]
        WORKER.transcribe = lambda *_args, **_kwargs: split_sentence
        assembled = WORKER.prepare_source({
            "sourceAudioPath": str(source_path),
            "outputDir": str(directory / "assembled"),
            "language": "en",
            "minClipSeconds": 2.5,
            "maxClipSeconds": 10,
        })["segments"]
        assert len(assembled) == 1, assembled
        assert assembled[0]["qualityVerdict"] == "eligible", assembled
        assert assembled[0]["transcript"] == "This sentence begins and ends here.", assembled

        trim_output = directory / "trimmed"
        trimmed = WORKER.prepare_source({
            "sourceAudioPath": str(source_path),
            "outputDir": str(trim_output),
            "language": "en",
            "trimApplied": True,
            "trimStartSeconds": 54,
            "trimEndSeconds": 286.1,
            "minClipSeconds": 2.5,
            "maxClipSeconds": 10,
        })
        assert isolated_sources[-1] == trim_output / "selected-source.wav", isolated_sources
        assert trimmed["runtime"]["sourceTrimApplied"], trimmed
        assert trimmed["runtime"]["sourceTrimStartSeconds"] == 54, trimmed
        assert trimmed["runtime"]["sourceTrimEndSeconds"] == 286.1, trimmed

        suffix_only = [
            SimpleNamespace(start=1.0, end=4.0, text="sentence.", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
        ]
        WORKER.transcribe = lambda *_args, **_kwargs: suffix_only
        uncertain = WORKER.prepare_source({
            "sourceAudioPath": str(source_path),
            "outputDir": str(directory / "suffix"),
            "language": "en",
            "minClipSeconds": 2.5,
            "maxClipSeconds": 10,
        })["segments"]
        assert uncertain[0]["qualityVerdict"] == "needs-review", uncertain
        assert "uncertain_sentence_start" in uncertain[0]["exclusionReasons"], uncertain

        unpunctuated_run = [
            SimpleNamespace(start=0.0, end=4.2, text="This long thought keeps going", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
            SimpleNamespace(start=4.2, end=8.4, text="without any decoder punctuation", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
            SimpleNamespace(start=8.4, end=12.6, text="so it must be capped", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
            SimpleNamespace(start=12.6, end=16.8, text="at a reviewable duration", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
            SimpleNamespace(start=16.8, end=21.0, text="instead of becoming one long clip", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
            SimpleNamespace(start=21.0, end=24.0, text="for training", avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
        ]
        WORKER.transcribe = lambda *_args, **_kwargs: unpunctuated_run
        capped = WORKER.prepare_source({
            "sourceAudioPath": str(source_path),
            "outputDir": str(directory / "capped"),
            "language": "en",
            "minClipSeconds": 2.5,
            "maxClipSeconds": 10,
        })["segments"]
        assert len(capped) == 3, capped
        assert all(2.5 <= segment["durationSeconds"] <= 10 for segment in capped), capped
        assert all("sentence_too_long" not in segment["exclusionReasons"] for segment in capped), capped
        assert all(segment["qualityVerdict"] == "needs-review" for segment in capped), capped
        assert all("uncertain_sentence_boundary" in segment["exclusionReasons"] for segment in capped), capped

        monolithic_text = " ".join("word%d" % index for index in range(50))
        monolithic_segment = [
            SimpleNamespace(start=1.0, end=49.62, text=monolithic_text, avg_logprob=-0.1, no_speech_prob=0.01, compression_ratio=1.0),
        ]
        WORKER.transcribe = lambda *_args, **_kwargs: monolithic_segment
        monolithic = WORKER.prepare_source({
            "sourceAudioPath": str(source_path),
            "outputDir": str(directory / "monolithic"),
            "language": "en",
            "minClipSeconds": 2.5,
            "maxClipSeconds": 10,
        })["segments"]
        assert len(monolithic) == 5, monolithic
        assert all(2.5 <= segment["durationSeconds"] <= 10 for segment in monolithic), monolithic
        assert all("sentence_too_long" not in segment["exclusionReasons"] for segment in monolithic), monolithic
        assert all(segment["resliced"] for segment in monolithic), monolithic
        assert all(segment["qualityVerdict"] == "needs-review" for segment in monolithic), monolithic

        vocal_path.write_bytes(b"vocal")
        accompaniment_path.write_bytes(b"accompaniment")
        WORKER.isolate_vocals = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("re-slicing must reuse the existing vocal instead of running Demucs"))
        WORKER.transcribe = lambda *_args, **_kwargs: split_sentence
        reused = WORKER.prepare_source({
            "sourceAudioPath": str(source_path),
            "outputDir": str(directory / "reused"),
            "preparedVocalPath": str(vocal_path),
            "preparedAccompanimentPath": str(accompaniment_path),
            "language": "en",
            "minClipSeconds": 2.5,
            "maxClipSeconds": 10,
        })
        assert Path(reused["vocalPath"]).is_file(), reused
        assert Path(reused["accompanimentPath"]).is_file(), reused
        assert len(reused["segments"]) == 1, reused
    finally:
        WORKER.require_runtime = original_require_runtime
        WORKER.isolate_vocals = original_isolate_vocals
        WORKER.transcribe = original_transcribe
        WORKER.run_ffmpeg = original_run_ffmpeg
        WORKER.emit_progress = original_emit_progress


def assert_asr_cache_resolution(directory):
    original_module = sys.modules.get("faster_whisper")
    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_name, **kwargs):
            captured["model_name"] = model_name
            captured.update(kwargs)

    sys.modules["faster_whisper"] = types.SimpleNamespace(WhisperModel=FakeWhisperModel)
    try:
        model_dir = directory / "asr-model"
        cache_dir = model_dir / "cache" / "faster-whisper"
        repository_cache = cache_dir / "models--Systran--faster-whisper-small"
        selected_snapshot = repository_cache / "snapshots" / "complete-revision"
        selected_snapshot.mkdir(parents=True)
        for filename in ("model.bin", "config.json", "tokenizer.json"):
            (selected_snapshot / filename).write_bytes(b"ready")
        (repository_cache / "refs").mkdir()
        (repository_cache / "refs" / "main").write_text("complete-revision\n", encoding="utf-8")

        # A newer but incomplete download must not replace the known-complete
        # revision selected by refs/main.
        incomplete_snapshot = repository_cache / "snapshots" / "newer-incomplete"
        incomplete_snapshot.mkdir()
        (incomplete_snapshot / "model.bin").write_bytes(b"partial")

        resolved = WORKER.local_faster_whisper_model_path(cache_dir, "small")
        assert resolved == selected_snapshot.resolve(), resolved
        assert WORKER.local_faster_whisper_model_path(cache_dir, "unsupported") is None

        WORKER.load_asr_model({"modelDir": str(model_dir), "asrModel": "small"})
        assert Path(captured["model_name"]) == selected_snapshot.resolve(), captured
        assert captured["device"] == "cpu", captured
        assert captured["compute_type"] == "int8", captured
        assert captured["local_files_only"] is True, captured
        assert "download_root" not in captured, captured

        try:
            WORKER.load_asr_model({"modelDir": str(directory / "missing-asr-model"), "asrModel": "small"})
            raise AssertionError("an absent managed model must fail locally")
        except RuntimeError as error:
            assert "missing or incomplete" in str(error), error
    finally:
        if original_module is None:
            del sys.modules["faster_whisper"]
        else:
            sys.modules["faster_whisper"] = original_module


def assert_cuda_runtime_detection_and_progress():
    original_torch = sys.modules.get("torch")
    original_cuda_visibility = os.environ.get("CUDA_VISIBLE_DEVICES")
    fake_torch = types.SimpleNamespace(
        __version__="2.4.0+cu121",
        version=types.SimpleNamespace(cuda="12.1"),
        cuda=types.SimpleNamespace(
            is_available=lambda: True,
            get_device_name=lambda _index: "Test NVIDIA GPU",
        ),
    )
    sys.modules["torch"] = fake_torch
    os.environ.pop("CUDA_VISIBLE_DEVICES", None)
    try:
        state = WORKER.torch_runtime_state()
        assert state["device"] == "cuda", state
        assert state["gpuAvailable"], state
        assert state["gpuName"] == "Test NVIDIA GPU", state
        assert state["torchVersion"] == "2.4.0+cu121", state
        assert state["torchCudaVersion"] == "12.1", state
        assert WORKER.separation_progress_percent(0, 300, "cuda") == 18
        assert 18 < WORKER.separation_progress_percent(30, 300, "cuda") < 54
        assert WORKER.separation_progress_percent(9999, 300, "cpu") == 53
    finally:
        if original_cuda_visibility is None:
            os.environ.pop("CUDA_VISIBLE_DEVICES", None)
        else:
            os.environ["CUDA_VISIBLE_DEVICES"] = original_cuda_visibility
        if original_torch is None:
            del sys.modules["torch"]
        else:
            sys.modules["torch"] = original_torch


def assert_faster_whisper_runtime_configuration():
    keys = (
        "KMP_DUPLICATE_LIB_OK",
        "HF_HUB_OFFLINE",
        "TRANSFORMERS_OFFLINE",
        "HF_HUB_DISABLE_TELEMETRY",
        "HF_HOME",
        "HF_HUB_CACHE",
        "TRANSFORMERS_CACHE",
    )
    original_settings = {key: os.environ.get(key) for key in keys}
    os.environ["KMP_DUPLICATE_LIB_OK"] = "FALSE"
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["TRANSFORMERS_OFFLINE"] = "0"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "0"
    try:
        with tempfile.TemporaryDirectory(prefix="magic-box-hf-cache-") as temporary_cache:
            managed_cache = Path(temporary_cache) / "faster-whisper"
            WORKER.configure_faster_whisper_runtime(managed_cache)
        assert os.environ["KMP_DUPLICATE_LIB_OK"] == "TRUE"
        assert os.environ["HF_HUB_OFFLINE"] == "1"
        assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
        assert os.environ["HF_HUB_DISABLE_TELEMETRY"] == "1"
        assert Path(os.environ["HF_HUB_CACHE"]) == managed_cache.resolve()
        assert Path(os.environ["HF_HOME"]) == managed_cache.resolve().parent
        assert Path(os.environ["TRANSFORMERS_CACHE"]) == managed_cache.resolve().parent / "transformers"
    finally:
        for key, value in original_settings.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def assert_progress_heartbeat_emits_during_slow_native_work():
    original_emit_progress = WORKER.emit_progress
    progress_events = []
    try:
        WORKER.emit_progress = lambda *event: progress_events.append(event)
        with WORKER.ProgressHeartbeat("transcribing", "Reviewing speech locally", 62, interval_seconds=0.01):
            time.sleep(0.24)
        assert len(progress_events) >= 2, progress_events
        assert all(event[0] == "transcribing" for event in progress_events), progress_events
    finally:
        WORKER.emit_progress = original_emit_progress


def assert_vocal_separation_uses_detected_device_and_heartbeats(directory):
    source_path = directory / "heartbeat-source.wav"
    source_path.write_bytes(b"source")
    output_dir = directory / "heartbeat-output"
    stem_dir = output_dir / "stems" / "htdemucs" / source_path.stem
    stem_dir.mkdir(parents=True)
    (stem_dir / "vocals.wav").write_bytes(b"vocals")
    (stem_dir / "no_vocals.wav").write_bytes(b"accompaniment")
    original_runtime_state = WORKER.torch_runtime_state
    original_popen = WORKER.subprocess.Popen
    original_run_ffmpeg = WORKER.run_ffmpeg
    original_emit_progress = WORKER.emit_progress
    original_sleep = WORKER.time.sleep
    commands = []
    progress_events = []

    class FakeProcess:
        def __init__(self):
            self.poll_count = 0
            self.returncode = None

        def poll(self):
            self.poll_count += 1
            if self.poll_count == 1:
                return None
            self.returncode = 0
            return self.returncode

    try:
        WORKER.torch_runtime_state = lambda: {
            "device": "cuda",
            "gpuAvailable": True,
            "gpuName": "Test NVIDIA GPU",
            "torchVersion": "2.4.0+cu121",
            "torchCudaVersion": "12.1",
        }
        WORKER.subprocess.Popen = lambda command, **_kwargs: commands.append(command) or FakeProcess()
        WORKER.run_ffmpeg = lambda _request, args: Path(args[-1]).write_bytes(b"converted")
        WORKER.emit_progress = lambda *event: progress_events.append(event)
        WORKER.time.sleep = lambda _seconds: None
        vocal_path, accompaniment_path = WORKER.isolate_vocals(
            {"sourceDurationSeconds": 300},
            source_path,
            output_dir,
        )
        assert commands and "-d" in commands[0], commands
        assert commands[0][commands[0].index("-d") + 1] == "cuda", commands
        assert progress_events and progress_events[0][0] == "separating", progress_events
        assert "NVIDIA GPU" in progress_events[0][1], progress_events
        assert vocal_path.is_file() and accompaniment_path.is_file()
        assert not (output_dir / "demucs.stderr.log").exists()
    finally:
        WORKER.torch_runtime_state = original_runtime_state
        WORKER.subprocess.Popen = original_popen
        WORKER.run_ffmpeg = original_run_ffmpeg
        WORKER.emit_progress = original_emit_progress
        WORKER.time.sleep = original_sleep


def assert_hashed_demucs_checkpoint_is_ready(directory):
    model_dir = directory / "prepared-model"
    checkpoint_dir = model_dir / "cache" / "torch" / "hub" / "checkpoints"
    checkpoint_dir.mkdir(parents=True)
    # This is the filename produced by Demucs for htdemucs on the packaged
    # Windows installation path. It is intentionally not htdemucs-prefixed.
    assert WORKER.HTDEMUCS_CHECKPOINT_FILENAME == EXPECTED_HTDEMUCS_CHECKPOINT
    expected_checkpoint = checkpoint_dir / EXPECTED_HTDEMUCS_CHECKPOINT
    expected_checkpoint.write_bytes(b"checkpoint")
    whisper_repository = model_dir / "cache" / "faster-whisper" / "models--Systran--faster-whisper-small"
    whisper_dir = whisper_repository / "snapshots" / "fixture-revision"
    whisper_dir.mkdir(parents=True)
    (whisper_dir / "model.bin").write_bytes(b"model")
    (whisper_dir / "config.json").write_text("{}", encoding="utf-8")
    (whisper_dir / "tokenizer.json").write_text("{}", encoding="utf-8")
    (whisper_repository / "refs").mkdir()
    (whisper_repository / "refs" / "main").write_text("fixture-revision\n", encoding="utf-8")
    (model_dir / ".models-ready.json").write_text(
        '{"engine":"voice-preparation-local","modelVersion":"voice-preparation-v1","modelsReady":true}',
        encoding="utf-8",
    )
    original_demucs = sys.modules.get("demucs")
    original_faster_whisper = sys.modules.get("faster_whisper")
    sys.modules["demucs"] = types.SimpleNamespace()
    sys.modules["faster_whisper"] = types.SimpleNamespace()
    try:
        state = WORKER.dependency_state({"modelDir": str(model_dir)})
        assert state["separationReady"], state
        assert state["asrReady"], state
        assert state["modelsReady"], state

        # A different Demucs model must not satisfy the htdemucs gate just
        # because it is also a .th file inside the cache.
        expected_checkpoint.unlink()
        (checkpoint_dir / "unrelated-and-corrupt.th").write_bytes(b"checkpoint")
        assert not WORKER.dependency_state({"modelDir": str(model_dir)})["modelsReady"]

        # A partial/empty expected filename and a stale marker without the
        # checkpoint are both unavailable, rather than false-ready.
        (checkpoint_dir / "unrelated-and-corrupt.th").unlink()
        expected_checkpoint.write_bytes(b"")
        assert not WORKER.dependency_state({"modelDir": str(model_dir)})["modelsReady"]
        expected_checkpoint.unlink()
        assert not WORKER.dependency_state({"modelDir": str(model_dir)})["modelsReady"]
    finally:
        if original_demucs is None:
            del sys.modules["demucs"]
        else:
            sys.modules["demucs"] = original_demucs
        if original_faster_whisper is None:
            del sys.modules["faster_whisper"]
        else:
            sys.modules["faster_whisper"] = original_faster_whisper


with tempfile.TemporaryDirectory(prefix="magic-box-voice-waveform-test-") as temporary_directory:
    assert_ordered_coverage_recovers_after_errors()
    fixture_directory = Path(temporary_directory)
    assert_clean_fixture(fixture_directory)
    assert_extra_text_is_bounded()
    assert_hum_fixture(fixture_directory)
    assert_electronic_roughness_fixture(fixture_directory)
    assert_seed_vc_config_is_portable(fixture_directory)
    assert_localized_tremble_fixture(fixture_directory)
    assert_validation_handles_chinese_orthography(fixture_directory)
    assert_secondary_asr_can_resolve_primary_under_transcription(fixture_directory)
    assert_reference_relative_tremble_fixture(fixture_directory)
    assert_training_distribution_tremble_fixture(fixture_directory)
    assert_sentence_assembly(fixture_directory)
    assert_asr_cache_resolution(fixture_directory)
    assert_cuda_runtime_detection_and_progress()
    assert_faster_whisper_runtime_configuration()
    assert_progress_heartbeat_emits_during_slow_native_work()
    assert_vocal_separation_uses_detected_device_and_heartbeats(fixture_directory)
    assert_hashed_demucs_checkpoint_is_ready(fixture_directory)

print("Voice Preparation PCM waveform fixtures passed.")
