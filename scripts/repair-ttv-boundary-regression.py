"""Reproduce boundary repair on the saved regression, without regenerating speech."""
import importlib.util
import json
import wave
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("prep", root / "server/voice_engine_worker_preparation.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
request = {"modelDir": str(root / "MagicBoxData/voice_clone/voice_engine/preparation/models/voice-preparation-v1"), "language": "zh"}
directory = root / "artifacts/ttv-strict-2026-09-06/after-seed-assembly/seed-evidence/voice-seed-vc-pipeline-v2-1788665522931-73780d"
output_dir = root / "artifacts/ttv-boundary-regression"
output_dir.mkdir(exist_ok=True)
middle = output_dir / "middle-aligned.wav"
result = worker.trim_synthesis_clause_batch({**request, "candidates": [{"id": "middle", "audioPath": str(directory / "seed-full-identity-validation-clause-2.wav"),
                                                                       "outputPath": str(middle), "expectedText": "是树神的私人助理！"}]})
if not result["results"][0]["accepted"]:
    raise RuntimeError(result)
paths = [directory / "seed-full-clarity-recovery-clauses/clause-1.wav", middle, directory / "seed-full-clarity-recovery-clauses/clause-3.wav"]
frames = []
for source in paths:
    with wave.open(str(source), "rb") as reader:
        assert reader.getnchannels() == 1 and reader.getsampwidth() == 2 and reader.getframerate() == 32000
        frames.append(reader.readframes(reader.getnframes()))
output = output_dir / "boundary-corrected.wav"
with wave.open(str(output), "wb") as writer:
    writer.setnchannels(1)
    writer.setsampwidth(2)
    writer.setframerate(32000)
    writer.writeframes(b"".join(frames))
result["outputPath"] = str(output)
result["asr"] = []
for name, model in [("primary", worker.load_asr_model(request)), ("secondary", worker.load_secondary_asr_model(request))]:
    for source, expected in [(middle, "是树神的私人助理！"), (output, "你好小鸟，我叫小爱！是树神的私人助理！你的名字叫做simple")]:
        text = "".join(segment.text for segment in worker.transcribe(request, source, "zh", model=model, vad_filter=False))
        result["asr"].append({"model": name, "file": source.name, "text": text, **worker.transcript_coverage(expected, text, "zh")})
result["waveform"] = worker.waveform_health(output)
(output_dir / "repair-report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=True), flush=True)
