"""Re-score independent local ASR transcripts with old/new ordered coverage."""
import argparse
import importlib.util
import json
from pathlib import Path


def load_worker(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


parser = argparse.ArgumentParser()
parser.add_argument("--audio-dir", required=True)
parser.add_argument("--old-worker", required=True)
parser.add_argument("--report", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
worker = load_worker("new_preparation", root / "server/voice_engine_worker_preparation.py")
old = load_worker("old_preparation", Path(args.old_worker))
request = {"modelDir": str(root / "MagicBoxData/voice_clone/voice_engine/preparation/models/voice-preparation-v1")}
clauses = ["你好小鸟，我叫小爱！", "是树神的私人助理！", "你的名字叫做simple"]
report = []
for model_name, model in [("primary", worker.load_asr_model(request)), ("secondary", worker.load_secondary_asr_model(request))]:
    for index, expected in enumerate(clauses, 1):
        for audio_path in sorted(Path(args.audio_dir).glob(f"clause-{index}-attempt-*.wav")):
            observed = "".join(segment.text for segment in worker.transcribe(request, audio_path, "zh", model=model))
            item = {"model": model_name, "audioPath": str(audio_path.resolve()), "expected": expected, "observed": observed,
                    "before": old.transcript_coverage(expected, observed, "zh"),
                    "after": worker.transcript_coverage(expected, observed, "zh")}
            report.append(item)
            Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(item, ensure_ascii=True), flush=True)
