import importlib.util
import json
from pathlib import Path
import soundfile as sf

root = Path(__file__).resolve().parents[1]
directory = root / "artifacts/ttv-strict-2026-09-06/gpt-diagnostic"
result = json.loads((directory / "result.json").read_text())["result"]
data, rate = sf.read(directory / "mixed-recovery.wav")
offset = sum(item["durationSeconds"] for item in result["segmentDiagnostics"][:-1])
audio_path = directory / "english-part.wav"
sf.write(audio_path, data[round(offset * rate):], rate)
spec = importlib.util.spec_from_file_location("prep", root / "server/voice_engine_worker_preparation.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
request = {"modelDir": str(root / "MagicBoxData/voice_clone/voice_engine/preparation/models/voice-preparation-v1")}
results = []
for name, model in [("primary", worker.load_asr_model(request)), ("secondary", worker.load_secondary_asr_model(request))]:
    observed = " ".join(segment.text for segment in worker.transcribe(request, audio_path, "en", model=model, vad_filter=False))
    results.append({"model": name, "observed": observed, "coverage": worker.transcript_coverage("simple", observed, "en")})
(directory / "english-asr.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=True))
