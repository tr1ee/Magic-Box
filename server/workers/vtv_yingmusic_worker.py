"""MagicBox YingMusic-SVC JSONL worker.

The pinned upstream tree is invoked through the adjacent MagicBox runner. The
worker never passes an accompany path, so the result is always a dry vocal for
the shared MagicBox mixer.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import wave

loaded_target = None
_dll_handles = []


def prepare_runtime_dlls():
    candidates = [
        os.environ.get("MAGICBOX_YINGMUSIC_PYTHON_LIBRARY_BIN", ""),
        os.path.join(sys.prefix, "Lib", "site-packages", "torch", "lib"),
        os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages", "torch", "lib"),
    ]
    for candidate in candidates:
        directory = os.path.abspath(candidate)
        if not os.path.isdir(directory):
            continue
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            try:
                _dll_handles.append(os.add_dll_directory(directory))
            except OSError:
                pass


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(request_id, code, message, action="", details=None):
    emit({"requestId": request_id, "ok": False, "code": code, "message": message, "action": action, "details": details or {}})


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wav_info(path):
    with wave.open(path, "rb") as audio:
        frames = audio.getnframes()
        rate = audio.getframerate()
        return {"sampleRate": rate, "channels": audio.getnchannels(), "durationSec": frames / rate if rate else 0}


def normalize_wav_contract(path):
    """Normalize upstream float WAV output to the shared PCM16 WAV contract."""
    try:
        import soundfile as sf
        import numpy as np

        samples, rate = sf.read(path, always_2d=True, dtype="float32")
        if samples.ndim != 2 or samples.shape[1] == 0:
            raise RuntimeError("YingMusic output WAV contains no audio channels.")
        mono = samples[:, 0] if samples.shape[1] == 1 else np.mean(samples, axis=1)
        sf.write(path, mono, int(rate), format="WAV", subtype="PCM_16")
    except Exception as exc:
        raise RuntimeError(f"YingMusic output WAV normalization failed: {exc}") from exc


def runtime_value(name):
    value = os.environ.get(name, "")
    return os.path.abspath(value) if value else ""


def load_target(message):
    target = message.get("model") or {}
    audio_path = os.path.abspath(str(target.get("audioPath", "")))
    if not os.path.isfile(audio_path):
        raise FileNotFoundError("YingMusic target-timbre.wav is missing.")
    return {"audioPath": audio_path, "audioSha256": file_hash(audio_path), "manifestPath": target.get("manifestPath", "")}


def run_inference(message):
    target = loaded_target or {}
    input_path = os.path.abspath(str(message.get("inputPath", "")))
    output_path = os.path.abspath(str(message.get("outputPath", "")))
    if not os.path.isfile(input_path):
        raise FileNotFoundError("YingMusic source vocal is missing.")
    if not target.get("audioPath") or not os.path.isfile(target["audioPath"]):
        raise FileNotFoundError("YingMusic target reference is not loaded.")
    source_root = runtime_value("MAGICBOX_YINGMUSIC_SOURCE_ROOT")
    runner = runtime_value("MAGICBOX_YINGMUSIC_RUNNER")
    checkpoint = runtime_value("MAGICBOX_YINGMUSIC_CHECKPOINT")
    config = runtime_value("MAGICBOX_YINGMUSIC_CONFIG")
    cache_root = runtime_value("MAGICBOX_YINGMUSIC_CACHE_ROOT")
    if not source_root or not os.path.isfile(os.path.join(source_root, "my_inference.py")):
        raise RuntimeError("Pinned YingMusic my_inference.py is not installed.")
    if not runner or not os.path.isfile(runner):
        raise RuntimeError("MagicBox YingMusic patch runner is not installed.")
    if not checkpoint or not os.path.isfile(checkpoint):
        raise RuntimeError("YingMusic checkpoint is not installed.")
    if not config or not os.path.isfile(config):
        raise RuntimeError("YingMusic config is not installed.")
    settings = message.get("settings") or {}
    started = time.perf_counter()
    command = [
        sys.executable, runner,
        "--source", input_path,
        "--target", target["audioPath"],
        "--checkpoint", checkpoint,
        "--config", config,
        "--output-path", output_path,
        "--source-root", source_root,
        "--cache-root", cache_root,
        "--diffusion-steps", str(int(settings.get("diffusionSteps", 50))),
        "--cfg-rate", str(float(settings.get("cfgRate", 0.7))),
        "--auto-f0-adjust", "true" if settings.get("autoF0Adjust", True) else "false",
        "--max-shift-semitones", str(float(settings.get("maxShiftSemitones", 12))),
        "--seed", str(int(message.get("seed", 0))),
        "--fp16", "true" if settings.get("fp16", True) else "false",
    ]
    if settings.get("forcedPitchShift") is not None:
        command.extend(["--forced-pitch-shift", str(float(settings["forcedPitchShift"]))])
    completed = subprocess.run(
        command,
        cwd=source_root,
        env={**os.environ, "PYTHONNOUSERSITE": "1", "PYTHONHASHSEED": "0"},
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.stdout:
        print(completed.stdout, file=sys.stderr, end="", flush=True)
    if completed.stderr:
        print(completed.stderr, file=sys.stderr, end="", flush=True)
    if completed.returncode != 0:
        lowered = (completed.stdout + "\n" + completed.stderr).lower()
        if "out of memory" in lowered or ("cuda" in lowered and "memory" in lowered):
            raise RuntimeError("YingMusic inference failed with GPU out of memory.")
        raise RuntimeError(f"YingMusic inference failed with exit code {completed.returncode}.")
    if not os.path.isfile(output_path):
        raise FileNotFoundError("YingMusic inference completed without an output WAV.")
    normalize_wav_contract(output_path)
    info = wav_info(output_path)
    if info["sampleRate"] != 44100 or info["channels"] != 1:
        raise RuntimeError(f"YingMusic output contract failed: expected 44.1 kHz mono dry vocal, got {info['sampleRate']} Hz/{info['channels']} channels.")
    metrics = {}
    for line in completed.stdout.splitlines():
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                metrics.update(parsed)
        except Exception:
            continue
    return {
        "outputPath": output_path,
        "outputHash": file_hash(output_path),
        "sampleRate": info["sampleRate"],
        "channels": info["channels"],
        "durationSec": info["durationSec"],
        "runtimeFactor": (time.perf_counter() - started) / max(info["durationSec"], 1e-6),
        "reportedPitchShift": metrics.get("reportedPitchShift"),
        "dryVocal": True,
    }


def handle(message):
    global loaded_target
    request_id = str(message.get("requestId", ""))
    command = message.get("command")
    source_root = runtime_value("MAGICBOX_YINGMUSIC_SOURCE_ROOT")
    if command == "health":
        runner = runtime_value("MAGICBOX_YINGMUSIC_RUNNER")
        checkpoint = runtime_value("MAGICBOX_YINGMUSIC_CHECKPOINT")
        config = runtime_value("MAGICBOX_YINGMUSIC_CONFIG")
        prepare_runtime_dlls()
        try:
            import torch
            cuda_available = bool(torch.cuda.is_available())
            torch_version = torch.__version__
            torch_import_error = ""
        except Exception as exc:
            cuda_available = False
            torch_version = ""
            torch_import_error = f"{type(exc).__name__}: {exc}"
        source_present = os.path.isfile(os.path.join(source_root, "my_inference.py"))
        runner_present = os.path.isfile(runner)
        checkpoint_present = os.path.isfile(checkpoint)
        config_present = os.path.isfile(config)
        runtime_flag = bool(os.environ.get("MAGICBOX_YINGMUSIC_RUNTIME_READY"))
        ready = runtime_flag and cuda_available and source_present and runner_present and checkpoint_present and config_present
        emit({"requestId": request_id, "ok": True, "ready": ready, "engineId": "yingmusic-svc-zero-shot-v1", "pythonVersion": sys.version.split()[0], "sourceRoot": source_root, "runnerEntry": runner, "checkpointPath": checkpoint, "configPath": config, "runtimeFlag": runtime_flag, "sourcePresent": source_present, "runnerPresent": runner_present, "checkpointPresent": checkpoint_present, "configPresent": config_present, "cudaAvailable": cuda_available, "torchVersion": torch_version, "torchImportError": torch_import_error})
        return
    if command == "load_model":
        try:
            loaded_target = load_target(message)
            emit({"requestId": request_id, "ok": True, "loaded": True, "target": loaded_target})
        except FileNotFoundError as exc:
            fail(request_id, "TARGET_REFERENCE_INVALID", str(exc), "Build a valid 20–25 second reference artifact.")
        except Exception as exc:
            fail(request_id, "ENGINE_RUNTIME_UNHEALTHY", str(exc), "Inspect the isolated YingMusic worker log.")
        return
    if command == "infer":
        try:
            emit({"requestId": request_id, "event": "progress", "stage": "yingmusic.inference.started", "percent": 0})
            result = run_inference(message)
            emit({"requestId": request_id, "event": "progress", "stage": "yingmusic.inference.completed", "percent": 100})
            emit({"requestId": request_id, "ok": True, **result})
        except FileNotFoundError as exc:
            fail(request_id, "ENGINE_OUTPUT_MISSING", str(exc), "Check the pinned runtime and output path.")
        except Exception as exc:
            code = "ENGINE_GPU_OOM" if "out of memory" in str(exc).lower() else "ENGINE_RUNTIME_UNHEALTHY"
            fail(request_id, code, str(exc), "Inspect the isolated YingMusic worker log.")
        return
    if command in ("unload", "cancel"):
        if command == "unload":
            loaded_target = None
        emit({"requestId": request_id, "ok": True, "unloaded": command == "unload"})
        return
    if command == "shutdown":
        emit({"requestId": request_id, "ok": True, "shutdown": True})
        raise SystemExit(0)
    fail(request_id, "ENGINE_WORKER_PROTOCOL_ERROR", f"Unknown YingMusic worker command: {command}")


for raw in sys.stdin:
    try:
        handle(json.loads(raw))
    except SystemExit:
        raise
    except Exception as exc:
        print(f"YingMusic worker error: {exc}", file=sys.stderr, flush=True)
        fail("", "ENGINE_WORKER_PROTOCOL_ERROR", str(exc))
