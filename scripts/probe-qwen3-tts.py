"""Offline candidate evaluation; never changes the selected production engine."""
import json
import os
from pathlib import Path
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/qwen3-tts-candidate"
OUT.mkdir(parents=True, exist_ok=True)
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["NUMBA_CACHE_DIR"] = str(OUT / "numba-cache")
import numpy as np
import torch
from faster_qwen3_tts import FasterQwen3TTS

baseline = json.loads((ROOT / "artifacts/voice-architecture-study/results.json").read_text(encoding="utf-8"))
database = json.loads((ROOT / "MagicBoxData/voice_clone/voice_clone.json").read_text(encoding="utf-8"))
profile = next(p for p in database["profiles"] if p["id"] == "voice-profile-1784636071044-034d62")
model_dir = ROOT / "MagicBoxData/voice_clone/voice_engine/qwen3-tts/models/0.6b-base"
started = time.perf_counter()
model = FasterQwen3TTS.from_pretrained(str(model_dir), local_files_only=True, max_seq_len=2048)
report = {"model": json.loads((model_dir / "magicbox-candidate.json").read_text()), "device": torch.cuda.get_device_name(0), "torch": torch.__version__, "scope": "isolated TTS; primary reference matches CosyVoice architecture study; no LLM or ASR running", "referenceSha256": baseline["referenceSha256"], "loadSeconds": round(time.perf_counter()-started, 3), "cases": []}

def run(label, passages, full_text=False):
    torch.manual_seed(20260904)
    torch.cuda.manual_seed_all(20260904)
    torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    frames, audio = [], []
    playback_end = 0
    for text in passages:
        for chunk, sr, timing in model.generate_voice_clone_streaming(text=text, language="Chinese", ref_audio=baseline["referencePath"], ref_text=profile["conversationModel"]["referenceTranscript"], chunk_size=8, xvec_only=False, non_streaming_mode=full_text, max_new_tokens=512):
            values = np.asarray(chunk, dtype=np.float32).reshape(-1)
            if not values.size:
                continue
            at = time.perf_counter() - start
            duration = len(values) / sr
            gap = max(0, at-playback_end) if frames else 0
            playback_end = max(at, playback_end) + duration
            frames.append({"arrivalSeconds": round(at, 4), "durationSeconds": round(duration, 4), "simulatedGapSeconds": round(gap, 4)})
            audio.append(values)
    torch.cuda.synchronize()
    elapsed = time.perf_counter()-start
    values = np.concatenate(audio)
    with wave.open(str(OUT / f"{label}.wav"), "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(sr)
        wav.writeframes((np.clip(values, -1, 1)*32767).astype("<i2").tobytes())
    result = {"label": label, "text": "".join(passages), "generationSeconds": round(elapsed, 3), "audioSeconds": round(len(values)/sr, 3), "rtf": round(elapsed/(len(values)/sr), 4), "firstAudioSeconds": frames[0]["arrivalSeconds"], "starvationSeconds": round(sum(f["simulatedGapSeconds"] for f in frames), 3), "clippingRatio": float(np.mean(np.abs(values)>=1)), "peakTorchMiB": round(torch.cuda.max_memory_allocated()/1024**2), "frames": frames}
    report["cases"].append(result)
    (OUT / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k not in ("frames", "text")}), flush=True)

run("cold", baseline["passages"][:1])
run("streaming-text-1", baseline["passages"])
run("whole-text-1", baseline["passages"], True)
run("whole-text-2", baseline["passages"], True)
run("streaming-text-2", baseline["passages"])
report["status"] = "completed"
(OUT / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
