import importlib.util
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gpt_worker", root / "server/voice_engine_worker_gpt_sovits.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
profile = {"gptWeightsPath": "trained.ckpt", "sovitsWeightsPath": "trained.pth", "referenceAudioPath": "reference.wav"}
text = "你的名字叫做simple"
recovery = {"recoverMultilingualSemantics": True, "integrityAttempt": 3}
assert worker.mixed_language_recovery_parts(text, "zh", recovery) == [("你的名字叫做", "zh"), ("simple", "en")]
parts = worker.mixed_language_recovery_parts("欢迎Magic Box，版本V2！", "zh", recovery)
assert "".join(part for part, _ in parts) == "欢迎Magic Box，版本V2！"
assert [part for part, language in parts if language == "en"] == ["Magic Box", "V2！"]
assert worker.mixed_language_recovery_parts(text, "zh", {}) == [(text, "zh")]
with tempfile.TemporaryDirectory() as directory:
    worker.repo_dir = lambda _: Path(directory)
    checkpoint = Path(directory) / "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"test-checkpoint")
    for phrase, settings in [(text, {}), (text, {"recoverMultilingualSemantics": True, "integrityAttempt": 2}),
                             ("纯中文保持原模型", {"recoverMultilingualSemantics": True, "integrityAttempt": 3})]:
        model, strategy = worker.tts_inference_voice_model(directory, profile, phrase, settings)
        assert model is profile and strategy == "profile"
    model, strategy = worker.tts_inference_voice_model(directory, profile, text, {"recoverMultilingualSemantics": True, "integrityAttempt": 3})
    assert strategy == "multilingual-semantic-recovery"
    assert model["gptWeightsPath"] == str(checkpoint)
    assert model["sovitsWeightsPath"] == profile["sovitsWeightsPath"]
    assert model["referenceAudioPath"] == profile["referenceAudioPath"]
    assert profile["gptWeightsPath"] == "trained.ckpt"
    checkpoint.unlink()
    try:
        worker.tts_inference_voice_model(directory, profile, text, {"recoverMultilingualSemantics": True, "integrityAttempt": 3})
        raise AssertionError("Missing recovery model must not silently use the failed checkpoint")
    except RuntimeError as error:
        assert "pretrained GPT" in str(error)
print("GPT multilingual recovery routing passed.")
