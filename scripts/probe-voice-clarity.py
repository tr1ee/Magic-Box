"""Controlled local reference/model comparison; never promotes a candidate."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/voice-clarity-comparison"
OUT.mkdir(parents=True, exist_ok=True)
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", NUMBA_CACHE_DIR=str(OUT / "cache"))
import numpy as np
import soundfile as sf
import torch
from faster_qwen3_tts import FasterQwen3TTS

db = json.loads((ROOT / "MagicBoxData/voice_clone/voice_clone.json").read_text(encoding="utf-8"))
profile = next(p for p in db["profiles"] if p["id"] == "voice-profile-1784636071044-034d62")
sample = next(s for s in db["samples"] if s["id"] == "voice-sample-1784636153005-9addb9")
segment = next(s for s in sample["segments"] if s["id"] == profile["conversationModel"]["sourceSegmentIds"][0])
def local(path):
    return ROOT / "MagicBoxData/voice_clone" / str(path).replace("\\", "/").split("/voice_clone/", 1)[1]

refs = {"processed-16k": local(profile["conversationModel"]["referenceAudioPath"]), "separated-32k": local(segment["audioPath"])}
raw = OUT / "original-reference.wav"
subprocess.run([str(ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-ss", str(sample["preparation"]["runtime"]["sourceTrimStartSeconds"] + segment["startSeconds"]), "-i", str(local(sample["storedPath"])), "-t", str(segment["durationSeconds"]), "-ac", "1", "-c:a", "pcm_s16le", str(raw)], check=True)
refs["original"] = raw
text = "清晨的窗外传来几声鸟鸣，桌上的茶还冒着热气。我想用清晰、自然的声音，把这段文字完整地读给你听。"
report = {"scope": "isolated local quality comparison; listening approval required", "text": text, "referenceText": segment["transcript"], "references": {}, "cases": []}
for name, path in refs.items():
    values, rate = sf.read(path)
    report["references"][name] = {"path": str(path), "sampleRate": rate, "seconds": len(values)/rate, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

size = os.environ.get("VOICE_PROBE_MODEL", "1.7b-base")
directory = ROOT / "MagicBoxData/voice_clone/voice_engine/qwen3-tts/models" / size
model = FasterQwen3TTS.from_pretrained(str(directory), local_files_only=True, max_seq_len=2048)
report["model"] = json.loads((directory / "magicbox-candidate.json").read_text())
for name, path in refs.items():
    torch.manual_seed(20260904)
    torch.cuda.manual_seed_all(20260904)
    start = time.perf_counter()
    arrays, rate = model.generate_voice_clone(text=text, language="Chinese", ref_audio=str(path), ref_text=segment["transcript"], max_new_tokens=512, non_streaming_mode=True)
    values = np.asarray(arrays[0], dtype=np.float32).reshape(-1)
    elapsed = time.perf_counter() - start
    output = OUT / f"{size}-{name}.wav"
    sf.write(output, values, rate, subtype="PCM_16")
    result = {"reference": name, "file": str(output), "generationSeconds": round(elapsed, 3), "audioSeconds": round(len(values)/rate, 3), "rtf": round(elapsed/(len(values)/rate), 3), "clippingRatio": float(np.mean(np.abs(values) >= 1))}
    report["cases"].append(result)
    (OUT / f"{size}-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)
