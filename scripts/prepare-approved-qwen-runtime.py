"""Record the locally accepted 1.7B installation and its file integrity.

Run only after the user accepts the quality comparison. Does not download or
change voice training data. Runtime/pinned model must already be installed.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
base = ROOT / "MagicBoxData/voice_clone/voice_engine/qwen3-tts"
model = base / "models/1.7b-base"
assert (base / "runtime/python/Scripts/python.exe").is_file()
files = []
for file in sorted(model.rglob("*")):
    if not file.is_file() or ".cache" in file.parts or file.name in ("checksums.json", "magicbox-candidate.json"):
        continue
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    files.append({"path": file.relative_to(model).as_posix(), "bytes": file.stat().st_size, "sha256": digest.hexdigest()})
(model / "checksums.json").write_text(json.dumps({"files": files}, indent=2), encoding="utf-8")
(base / "approved-runtime.json").write_text(json.dumps({"schemaVersion": 1, "listeningAccepted": True, "modelRevision": "fd4b254389122332181a7c3db7f27e918eec64e3", "package": "faster-qwen3-tts==0.4.0", "qualityComparison": "artifacts/voice-clarity-comparison", "referencePolicy": "original prepared sentence at native sample rate", "codecMode": "complete-sentence"}, indent=2), encoding="utf-8")
print(f"Approved Qwen runtime: {len(files)} verified model files")
