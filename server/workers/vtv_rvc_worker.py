"""MagicBox RVC v2 JSONL worker.

The worker is deliberately thin: the pinned RVC tree owns model loading and
conversion, while this process owns the JSONL boundary, isolation, hashes and
the common result metadata. stdout is JSONL only; subprocess diagnostics go to
stderr.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import wave

loaded_model = None
_dll_handles = []


def terminate_process_tree(process):
    if not process or process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except Exception:
            pass
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def prepare_runtime_dlls():
    candidates = [
        os.environ.get("MAGICBOX_RVC_PYTHON_LIBRARY_BIN", ""),
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


def error(request_id, code, message, action="", details=None):
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


def source_root():
    value = os.environ.get("MAGICBOX_RVC_SOURCE_ROOT", "")
    return os.path.abspath(value) if value else ""


def rvc_entry():
    root = source_root()
    runner = os.environ.get("MAGICBOX_RVC_RUNNER", os.path.join(os.path.dirname(__file__), "magicbox_rvc_runner.py"))
    return root, os.path.join(root, "infer", "vc", "modules.py"), os.path.abspath(runner)


def inspect_model(model_path):
    """Use the pinned runtime's torch loader for a conservative checkpoint check."""
    try:
        import torch
        checkpoint = torch.load(model_path, map_location="cpu", weights_only=False)
        if not isinstance(checkpoint, dict):
            return {"modelVersion": "unknown", "usesF0": None, "speakerCount": None}
        config = checkpoint.get("config") or checkpoint.get("model", {}).get("config") or []
        return {
            "modelVersion": "v2" if len(config) >= 18 else "unknown",
            "usesF0": bool(config[-1] != 0) if config else None,
            "speakerCount": checkpoint.get("spk_id") if isinstance(checkpoint.get("spk_id"), int) else None,
        }
    except Exception as exc:
        raise RuntimeError(f"RVC checkpoint inspection failed: {exc}") from exc


class RvcNoProgressError(RuntimeError):
    pass


def run_runner_process(command, root, progress_path, input_duration, request_id, attempt, stall_timeout_seconds):
    attempt_started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=root,
        env={**os.environ, "PYTHONNOUSERSITE": "1", "PYTHONHASHSEED": "0"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    completed_signature = None
    last_completion_at = attempt_started
    while True:
        try:
            stdout, stderr = process.communicate(timeout=5)
            return subprocess.CompletedProcess(command, process.returncode, stdout or "", stderr or "")
        except subprocess.TimeoutExpired:
            chunk_progress = {}
            try:
                with open(progress_path, "r", encoding="utf-8") as handle:
                    chunk_progress = json.load(handle)
            except Exception:
                chunk_progress = {}
            next_signature = int(chunk_progress.get("completedChunks", 0))
            if next_signature != completed_signature:
                completed_signature = next_signature
                last_completion_at = time.perf_counter()
            stalled_seconds = time.perf_counter() - last_completion_at
            if stalled_seconds >= stall_timeout_seconds:
                terminate_process_tree(process)
                raise RvcNoProgressError(
                    f"RVC chunk {int(chunk_progress.get('chunk', 1))} did not complete in "
                    f"{round(stalled_seconds)} seconds."
                )
            chunk_count = int(chunk_progress.get("chunkCount", 0))
            current_chunk = int(chunk_progress.get("chunk", 0))
            emit({
                "requestId": request_id,
                "event": "progress",
                "stage": (
                    f"rvc.inference.chunk {current_chunk}/{chunk_count} processing"
                    if chunk_count else "rvc.inference.loading"
                ),
                "percent": chunk_progress.get("percent"),
                "elapsedSec": round(time.perf_counter() - attempt_started, 1),
                "sourceDurationSec": round(input_duration, 3),
                "stalledSec": round(stalled_seconds, 1),
                "attempt": attempt,
            })


def run_inference(message, request_id):
    model = loaded_model or {}
    input_path = os.path.abspath(str(message.get("inputPath", "")))
    output_path = os.path.abspath(str(message.get("outputPath", "")))
    if not os.path.isfile(input_path):
        raise FileNotFoundError("RVC input audio is missing.")
    if not model.get("modelPath") or not os.path.isfile(model["modelPath"]):
        raise FileNotFoundError("RVC target model is not loaded.")
    if not model.get("indexPath") or not os.path.isfile(model["indexPath"]):
        raise FileNotFoundError("RVC target index is not loaded.")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    root, entry, runner = rvc_entry()
    if not root or not os.path.isfile(entry):
        raise RuntimeError("Pinned RVC infer.vc.modules.VC runtime is not installed.")
    settings = message.get("settings") or {}
    progress_path = f"{output_path}.progress.json"
    try:
        os.remove(progress_path)
    except OSError:
        pass
    requested_chunk_seconds = max(12.0, min(60.0, float(settings.get("chunkSeconds", 30.0))))
    chunk_attempts = [requested_chunk_seconds]
    if requested_chunk_seconds > 15.0:
        chunk_attempts.append(15.0)

    def runner_command(chunk_seconds):
        return [
            sys.executable, runner,
            "--source-root", root,
            "--model", model["modelPath"],
            "--input", input_path,
            "--output", output_path,
            "--pitch", str(int(settings.get("pitchShiftSemitones", 0))),
            "--seed", str(int(message.get("seed") if message.get("seed") is not None else 31002)),
            "--f0-method", str(settings.get("f0Method", "rmvpe")),
            "--index", model["indexPath"],
            "--index-rate", str(float(settings.get("indexRate", 0.65))),
            "--resample-sr", str(int(settings.get("resampleSr", 0))),
            "--rms-mix-rate", str(float(settings.get("rmsMixRate", 0.25))),
            "--protect", str(float(settings.get("protect", 0.33))),
            "--chunk-seconds", str(chunk_seconds),
            "--chunk-context-seconds", str(float(settings.get("chunkContextSeconds", 3.0))),
            "--chunk-crossfade-seconds", str(float(settings.get("chunkCrossfadeSeconds", 0.1))),
            "--progress-file", progress_path,
            "--parent-pid", str(os.getpid()),
        ]

    started = time.perf_counter()
    input_duration = wav_info(input_path)["durationSec"]
    completed = None
    command = None
    retry_count = 0
    for attempt_index, chunk_seconds in enumerate(chunk_attempts):
        try:
            os.remove(progress_path)
        except OSError:
            pass
        if attempt_index:
            retry_count += 1
            emit({
                "requestId": request_id,
                "event": "progress",
                "stage": f"rvc.inference.retry {chunk_seconds:g}s chunks",
                "percent": 0,
                "elapsedSec": round(time.perf_counter() - started, 1),
                "sourceDurationSec": round(input_duration, 3),
                "attempt": attempt_index + 1,
            })
        command = runner_command(chunk_seconds)
        stall_timeout_seconds = 180.0 if attempt_index == 0 else 240.0
        try:
            completed = run_runner_process(
                command,
                root,
                progress_path,
                input_duration,
                request_id,
                attempt_index + 1,
                stall_timeout_seconds,
            )
            break
        except RvcNoProgressError as exc:
            if attempt_index + 1 >= len(chunk_attempts):
                raise RuntimeError(
                    f"{exc} Automatic retry with smaller 15-second chunks also made no progress."
                ) from exc
    if completed.stdout:
        print(completed.stdout, file=sys.stderr, end="", flush=True)
    if completed.stderr:
        print(completed.stderr, file=sys.stderr, end="", flush=True)
    if completed.returncode != 0:
        try:
            os.remove(progress_path)
        except OSError:
            pass
        lowered = (completed.stdout + "\n" + completed.stderr).lower()
        if "out of memory" in lowered or ("cuda" in lowered and "memory" in lowered):
            raise RuntimeError("RVC inference failed with GPU out of memory.")
        diagnostic_lines = [line.strip() for line in completed.stderr.splitlines() if line.strip()]
        diagnostic = next(
            (line for line in reversed(diagnostic_lines) if not line.startswith(("warnings.warn(", "FutureWarning:"))),
            "",
        )
        detail = f": {diagnostic}" if diagnostic else ""
        raise RuntimeError(f"RVC inference failed with exit code {completed.returncode}{detail}")
    if not os.path.isfile(output_path):
        raise FileNotFoundError("RVC inference completed without an output WAV.")
    try:
        os.remove(progress_path)
    except OSError:
        pass
    info = wav_info(output_path)
    metrics = {}
    for line in completed.stdout.splitlines():
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict): metrics.update(parsed)
        except Exception:
            continue
    return {
        "outputPath": output_path,
        "outputHash": file_hash(output_path),
        "sampleRate": info["sampleRate"],
        "channels": info["channels"],
        "durationSec": info["durationSec"],
        "runtimeFactor": metrics.get("runtimeFactor", (time.perf_counter() - started) / max(info["durationSec"], 1e-6)),
        "modelSampleRate": model.get("sampleRate"),
        "modelVersion": model.get("inspection", {}).get("modelVersion"),
        "f0Enabled": model.get("usesF0"),
        "indexLoaded": True,
        "indexRate": settings.get("indexRate", 0.65),
        "pitchMethod": settings.get("f0Method", "rmvpe"),
        "reportedPitchShift": int(settings.get("pitchShiftSemitones", 0)),
        "seed": metrics.get("seed"),
        "peakVramMiB": metrics.get("peakVramMiB"),
        "chunked": bool(metrics.get("chunked", False)),
        "chunkCount": int(metrics.get("chunkCount", 1)),
        "chunkSeconds": metrics.get("chunkSeconds"),
        "requestedChunkSeconds": requested_chunk_seconds,
        "chunkRetryCount": retry_count,
    }


def handle(message):
    global loaded_model
    request_id = str(message.get("requestId", ""))
    command = message.get("command")
    root, entry, runner = rvc_entry()
    if command == "health":
        prepare_runtime_dlls()
        try:
            import torch
            cuda_available = bool(torch.cuda.is_available())
            torch_version = torch.__version__
        except Exception:
            cuda_available = False
            torch_version = ""
        ready = bool(os.environ.get("MAGICBOX_RVC_RUNTIME_READY")) and cuda_available and os.path.isfile(entry)
        emit({"requestId": request_id, "ok": True, "ready": ready and os.path.isfile(runner), "engineId": "rvc-v2-finetuned", "pythonVersion": sys.version.split()[0], "sourceRoot": root, "workerEntry": entry, "runnerEntry": runner, "cudaAvailable": cuda_available, "torchVersion": torch_version})
        return
    if command == "inspect_model":
        model = message.get("model") or {}
        model_path = os.path.abspath(str(model.get("modelPath", "")))
        if not os.path.isfile(model_path):
            error(request_id, "ENGINE_MODEL_MISSING", "RVC model is missing.", "Import a .pth + .index bundle.")
            return
        try:
            emit({"requestId": request_id, "ok": True, "inspection": inspect_model(model_path)})
        except Exception as exc:
            error(request_id, "RVC_MODEL_INSPECTION_FAILED", str(exc), "Import a readable RVC v2 checkpoint.")
        return
    if command == "load_model":
        model = message.get("model") or {}
        model_path = os.path.abspath(str(model.get("modelPath", "")))
        index_path = os.path.abspath(str(model.get("indexPath", "")))
        if not os.path.isfile(model_path):
            error(request_id, "ENGINE_MODEL_MISSING", "RVC model is missing.", "Import a complete .pth + .index bundle.")
            return
        if not os.path.isfile(index_path):
            error(request_id, "RVC_INDEX_MISSING", "RVC index is missing.", "Import a complete .pth + .index bundle.")
            return
        try:
            inspection = inspect_model(model_path)
        except Exception as exc:
            error(request_id, "RVC_MODEL_INSPECTION_FAILED", str(exc), "Import a readable RVC v2 checkpoint.")
            return
        loaded_model = {"modelPath": model_path, "indexPath": index_path, "modelSha256": file_hash(model_path), "indexSha256": file_hash(index_path), "inspection": inspection, "sampleRate": model.get("sampleRate"), "usesF0": model.get("usesF0")}
        emit({"requestId": request_id, "ok": True, "loaded": True, "model": loaded_model})
        return
    if command == "infer":
        try:
            emit({"requestId": request_id, "event": "progress", "stage": "rvc.inference.started", "percent": 0})
            result = run_inference(message, request_id)
            emit({"requestId": request_id, "event": "progress", "stage": "rvc.inference.completed", "percent": 100})
            emit({"requestId": request_id, "ok": True, **result})
        except FileNotFoundError as exc:
            error(request_id, "ENGINE_OUTPUT_MISSING", str(exc), "Check the pinned runtime and output path.")
        except Exception as exc:
            code = "ENGINE_GPU_OOM" if "out of memory" in str(exc).lower() else "ENGINE_RUNTIME_UNHEALTHY"
            error(request_id, code, str(exc), "Inspect the isolated RVC worker log.")
        return
    if command in ("unload", "cancel"):
        if command == "unload":
            loaded_model = None
        emit({"requestId": request_id, "ok": True, "unloaded": command == "unload"})
        return
    if command == "shutdown":
        emit({"requestId": request_id, "ok": True, "shutdown": True})
        raise SystemExit(0)
    error(request_id, "ENGINE_WORKER_PROTOCOL_ERROR", f"Unknown RVC worker command: {command}")


for raw in sys.stdin:
    try:
        handle(json.loads(raw))
    except SystemExit:
        raise
    except Exception as exc:
        print(f"RVC worker error: {exc}", file=sys.stderr, flush=True)
        error("", "ENGINE_WORKER_PROTOCOL_ERROR", str(exc))
