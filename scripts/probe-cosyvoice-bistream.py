"""Probe the pinned CosyVoice runtime with full, segmented, and bi-stream text.

The probe is deliberately standalone and never downloads or upgrades anything.
When the pinned runtime/model/profile is unavailable it writes explicit blocked
evidence instead of silently testing another revision.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import re
import sys
import time
import wave
from pathlib import Path


PINNED_RUNTIME_REVISION = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
PINNED_MODEL_REVISION = "29e01c4e8d000f4bcd70751be16fa94bf3d85a18"
PINNED_MODEL_VERSION = "fun-cosyvoice3-0.5b-2512-29e01c4"
DEFAULT_TEXT = (
    "我检查了当前本地语音系统的完整链路。现在需要重点验证同一个合成会话能否持续接收稳定文本，"
    "并在不重新启动推理的情况下连续输出音频。这样可以保留整句话的语速、重音、停顿和音色上下文，"
    "同时减少片段边界造成的卡顿。接下来还会比较完整文本、旧式分段和真正双流式输入的首包延迟、实时率与输出长度。"
)


def parse_args() -> argparse.Namespace:
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "MagicBox" / "voice_clone"
    engine = local / "voice_engine" / "conversation"
    parser = argparse.ArgumentParser()
    parser.add_argument("--python-runtime", default=str(engine / "runtime" / "python" / "python.exe"))
    parser.add_argument("--repository-dir", default=str(engine / "runtime" / "CosyVoice"))
    parser.add_argument("--model-dir", default=str(engine / "tts" / "models" / PINNED_MODEL_VERSION))
    parser.add_argument("--voice-db", default=str(local / "voice_clone.json"))
    parser.add_argument("--profile-name", default="爱弥斯")
    parser.add_argument("--profile-id", default="")
    parser.add_argument("--reference-audio", default="")
    parser.add_argument("--reference-transcript", default="")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--increment-delay-ms", type=int, default=180)
    parser.add_argument("--output-dir", default="artifacts/voice-poc")
    parser.add_argument("--inspect-only", action="store_true")
    return parser.parse_args()


def read_json(file_path: Path):
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def git_revision(repository: Path) -> str:
    head = repository / ".git" / "HEAD"
    if not head.is_file():
        return ""
    value = head.read_text(encoding="utf-8").strip()
    if value.startswith("ref:"):
        target = repository / ".git" / value.split(":", 1)[1].strip()
        return target.read_text(encoding="utf-8").strip() if target.is_file() else ""
    return value


def source_capabilities(repository: Path) -> dict:
    cli_path = repository / "cosyvoice" / "cli" / "cosyvoice.py"
    frontend_path = repository / "cosyvoice" / "cli" / "frontend.py"
    model_path = repository / "cosyvoice" / "cli" / "model.py"
    sources = []
    for file_path in (cli_path, frontend_path, model_path):
        sources.append(file_path.read_text(encoding="utf-8") if file_path.is_file() else "")
    combined = "\n".join(sources)
    checks = {
        "inferenceInstruct2": "def inference_instruct2" in sources[0],
        "generatorFrontend": "isinstance(text, Generator)" in sources[1],
        "bistreamLlm": "inference_bistream" in sources[2],
        "singleTtsUuid": "this_uuid = str(uuid.uuid1())" in sources[2],
    }
    available = all(bool(source) for source in sources)
    return {
        "available": available,
        "files": [str(cli_path), str(frontend_path), str(model_path)],
        "checks": checks,
        "supportsIncrementalText": available and all(checks.values()),
        "sourceHash": hashlib.sha256(combined.encode("utf-8")).hexdigest() if available else "",
    }


def resolve_profile(args: argparse.Namespace) -> dict:
    database = read_json(Path(args.voice_db)) or {}
    profiles = database.get("profiles") if isinstance(database, dict) else []
    selected = next((item for item in profiles or [] if args.profile_id and item.get("id") == args.profile_id), None)
    if selected is None:
        selected = next((item for item in profiles or [] if item.get("name") == args.profile_name), None)
    model = (selected or {}).get("conversationModel") or {}
    return {
        "id": (selected or {}).get("id", ""),
        "name": (selected or {}).get("name", args.profile_name),
        "referenceAudio": args.reference_audio or model.get("referenceAudioPath", ""),
        "referenceTranscript": args.reference_transcript or model.get("referenceTranscript", ""),
        "speakerPromptId": model.get("speakerPromptId", ""),
        "modelVersion": model.get("modelVersion", ""),
        "state": model.get("state", ""),
    }


def write_json(file_path: Path, value: dict) -> None:
    file_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def split_segments(text: str) -> list[str]:
    parts = [item.strip() for item in re.split(r"(?<=[，。！？；：])", text) if item.strip()]
    output: list[str] = []
    current = ""
    for part in parts:
        if current and len(current) + len(part) > 42:
            output.append(current)
            current = ""
        current += part
    if current:
        output.append(current)
    return output


def write_wav(file_path: Path, pcm: bytes, sample_rate: int) -> None:
    with wave.open(str(file_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    repository = Path(args.repository_dir).resolve()
    model_dir = Path(args.model_dir).resolve()
    profile = resolve_profile(args)
    capabilities = source_capabilities(repository)
    actual_runtime_revision = git_revision(repository)
    model_state = read_json(model_dir / ".ready.json") or read_json(model_dir.parent.parent / "install_state.json") or {}
    environment = {
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "platform": sys.platform,
        "python": sys.version,
        "pythonRuntime": str(Path(args.python_runtime).resolve()),
        "repositoryDir": str(repository),
        "modelDir": str(model_dir),
        "expectedRuntimeRevision": PINNED_RUNTIME_REVISION,
        "actualRuntimeRevision": actual_runtime_revision,
        "expectedModelRevision": PINNED_MODEL_REVISION,
        "actualModelRevision": model_state.get("modelRevision", ""),
        "profile": {key: value for key, value in profile.items() if key not in ("referenceTranscript",)},
        "sourceCapabilities": capabilities,
    }
    missing = []
    if not repository.is_dir():
        missing.append("pinned CosyVoice repository")
    if not model_dir.is_dir():
        missing.append("pinned CosyVoice model")
    if not profile["referenceAudio"] or not Path(profile["referenceAudio"]).is_file():
        missing.append("prepared profile reference audio")
    if not profile["referenceTranscript"]:
        missing.append("prepared profile reference transcript")
    if actual_runtime_revision and actual_runtime_revision != PINNED_RUNTIME_REVISION:
        missing.append("matching pinned runtime revision")
    if environment["actualModelRevision"] and environment["actualModelRevision"] != PINNED_MODEL_REVISION:
        missing.append("matching pinned model revision")
    environment["blockedReasons"] = missing
    write_json(output_dir / "environment.json", environment)
    if args.inspect_only:
        write_json(output_dir / "timings.json", {"status": "inspect-only", "blockedReasons": missing})
        print(json.dumps(environment, ensure_ascii=False, indent=2))
        return 0
    if missing:
        write_json(output_dir / "timings.json", {"status": "blocked", "blockedReasons": missing})
        print("CosyVoice POC blocked: " + ", ".join(missing), file=sys.stderr)
        return 2

    sys.path.insert(0, str(repository))
    matcha = repository / "third_party" / "Matcha-TTS"
    sys.path.insert(0, str(matcha))
    import numpy as np  # type: ignore
    import torch  # type: ignore
    from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore

    model = AutoModel(model_dir=str(model_dir), fp16=True, load_trt=True)
    signature = str(inspect.signature(model.inference_instruct2))
    profile_id = profile["id"] or "magicbox-poc"
    prompt = profile["referenceTranscript"]
    prompt = prompt if "<|endofprompt|>" in prompt else f"You are a helpful assistant.<|endofprompt|>{prompt}"
    model.add_zero_shot_spk(prompt, profile["referenceAudio"], profile_id)
    instruction = "You are a helpful assistant. Speak naturally.<|endofprompt|>"
    style_id = f"{profile_id}::poc-natural"
    store = model.frontend.spk2info
    prompt_token, prompt_token_len = model.frontend._extract_text_token(instruction)
    store[style_id] = {**store[profile_id], "prompt_text": prompt_token, "prompt_text_len": prompt_token_len}
    sample_rate = int(model.sample_rate)

    def synthesize(label: str, inputs) -> tuple[bytes, dict]:
        torch.manual_seed(20260818)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(20260818)
        started = time.perf_counter()
        first_pcm = 0.0
        chunks: list[bytes] = []
        inference_count = 0
        iterable = inputs if isinstance(inputs, list) else [inputs]
        for text_input in iterable:
            inference_count += 1
            results = model.inference_instruct2(text_input, instruction, "", zero_shot_spk_id=style_id, stream=True, text_frontend=True)
            for result in results:
                speech = result.get("tts_speech") if isinstance(result, dict) else result
                array = speech.detach().float().cpu().squeeze().numpy()
                pcm = (np.clip(array, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                if pcm:
                    if not first_pcm:
                        first_pcm = time.perf_counter()
                    chunks.append(pcm)
        finished = time.perf_counter()
        pcm = b"".join(chunks)
        duration_ms = len(pcm) / 2 / sample_rate * 1000
        timing = {
            "label": label,
            "inferenceCount": inference_count,
            "audioChunkCount": len(chunks),
            "firstPcmMs": round((first_pcm - started) * 1000) if first_pcm else None,
            "elapsedMs": round((finished - started) * 1000),
            "audioDurationMs": round(duration_ms),
            "rtf": round((finished - started) * 1000 / max(1, duration_ms), 4),
            "pcmSamples": len(pcm) // 2,
        }
        return pcm, timing

    increments = split_segments(args.text)

    def incremental_text():
        for index, value in enumerate(increments):
            if index:
                time.sleep(max(0, args.increment_delay_ms) / 1000)
            yield value

    cases = [
        ("full-single-inference", args.text),
        ("current-segmented", increments),
        ("incremental-single-session", incremental_text()),
    ]
    timings = {"status": "completed", "apiSignature": signature, "sampleRate": sample_rate, "cases": []}
    for label, inputs in cases:
        pcm, timing = synthesize(label, inputs)
        write_wav(output_dir / f"{label}.wav", pcm, sample_rate)
        timings["cases"].append(timing)
    write_json(output_dir / "timings.json", timings)
    print(json.dumps(timings, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
