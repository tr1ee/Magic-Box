import faulthandler
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root / "artifacts/ttv-strict-2026-09-06" / ("gpt-original-acoustic" if "--original-acoustic" in sys.argv else "gpt-diagnostic")
output.mkdir(parents=True, exist_ok=True)
trace = (output / "stacks.log").open("w")
faulthandler.dump_traceback_later(45, repeat=True, file=trace)
model_dir = root / "MagicBoxData/voice_clone/voice_engine/gpt-sovits/models/gpt-sovits-managed-v1"
os.environ["MAGIC_BOX_GPT_SOVITS_REPO"] = str(root / "MagicBoxData/voice_clone/voice_engine/gpt-sovits/runtime/GPT-SoVITS")
os.environ["TEMP"] = str(output)
os.environ["TMP"] = str(output)
spec = importlib.util.spec_from_file_location("gpt", root / "server/voice_engine_worker_gpt_sovits.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
db = json.loads((root / "MagicBoxData/voice_clone/voice_clone.json").read_text(encoding="utf-8"))
profile = next(item for item in db["profiles"] if item["id"] == "voice-profile-1787531284835-22d3cc")
voice = profile["voiceModel"]
if "--original-acoustic" in sys.argv:
    voice = {**voice, "sovitsWeightsPath": str(root / "MagicBoxData/voice_clone/voice_engine/gpt-sovits/runtime/GPT-SoVITS/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth")}
request = {"action": "tts", "modelDir": str(model_dir), "voiceModel": voice,
           "text": "你的名字叫做simple", "language": "zh", "textLang": "zh", "promptLang": "zh",
           "promptText": voice["promptText"], "refAudioPath": voice["referenceAudioPath"],
           "outputPath": str(output / "mixed-recovery.wav"),
           "settings": {"recoverMultilingualSemantics": True, "integrityAttempt": 3, "seed": 9362, "temperature": .85}}
started = time.perf_counter()
result = worker.handle(request)
(output / "result.json").write_text(json.dumps({"elapsedSec": time.perf_counter() - started, "result": result}, indent=2), encoding="utf-8")
faulthandler.cancel_dump_traceback_later()
print("Diagnostic synthesis completed", flush=True)
