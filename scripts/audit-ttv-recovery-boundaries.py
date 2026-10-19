"""Inspect independent word timings for the reported TTV assembly regression."""
import importlib.util
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("prep", root / "server/voice_engine_worker_preparation.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
request = {"modelDir": str(root / "MagicBoxData/voice_clone/voice_engine/preparation/models/voice-preparation-v1")}
directory = root / "artifacts/ttv-strict-2026-09-06/after-seed-assembly/seed-evidence/voice-seed-vc-pipeline-v2-1788665522931-73780d"
output_dir = root / "artifacts/ttv-boundary-regression"
output_dir.mkdir(exist_ok=True)
results = []
for name, model in [("primary", worker.load_asr_model(request)), ("secondary", worker.load_secondary_asr_model(request))]:
    for filename in ["validated-clause-assembly.wav", "seed-full-identity-validation-clause-2.wav", "seed-full-identity.wav"]:
        segments, _ = model.transcribe(str(directory / filename), language="zh", vad_filter=False, word_timestamps=True, condition_on_previous_text=False, beam_size=5)
        segments = list(segments)
        item = {"model": name, "file": filename, "text": "".join(s.text for s in segments),
                "words": [{"text": w.word, "start": w.start, "end": w.end, "probability": w.probability} for s in segments for w in (s.words or [])]}
        results.append(item)
        (output_dir / "word-timings.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(item, ensure_ascii=True), flush=True)
