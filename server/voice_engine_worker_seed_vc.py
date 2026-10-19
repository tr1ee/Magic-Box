import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback
import wave


ENGINE_ID = "seed-vc-svc-local"
MODEL_VERSION = "seed-vc-svc-v1"
_SONG_MODEL_CACHE = {}
_SONG_TARGET_CENTROID_CACHE = {}
_SPEAKER_MODEL_CACHE = {}
_ERES2NET_MODEL_CACHE = {}
_DNSMOS_MODEL_CACHE = {}
_NISQA_MODEL_CACHE = {}
_UTMOS_MODEL_CACHE = {}
_FCPE_MODEL_CACHE = {}
_ROFORMER_MODEL_CACHE = {}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(request_id, percent, message):
    emit({"id": request_id, "event": "progress", "progress": percent, "message": message})


def runtime_paths(request):
    model_dir = Path(request.get("modelDir") or os.environ.get("MAGIC_BOX_VOICE_ENGINE_MODEL_DIR") or ".").resolve()
    runtime_dir = Path(__file__).resolve().parent
    repo_dir = Path(
        request.get("repoDir")
        or os.environ.get("MAGIC_BOX_SEED_VC_REPO")
        or runtime_dir / "seed-vc"
    ).resolve()
    return model_dir, runtime_dir, repo_dir


def torch_state():
    if importlib.util.find_spec("torch") is None:
        return {"torchInstalled": False, "gpuAvailable": False, "device": "missing"}
    import torch

    gpu_available = bool(torch.cuda.is_available())
    return {
        "torchInstalled": True,
        "gpuAvailable": gpu_available,
        "device": "cuda" if gpu_available else "cpu",
        "torchVersion": str(torch.__version__),
        "gpuName": torch.cuda.get_device_name(0) if gpu_available else "",
    }


def health(request):
    model_dir, runtime_dir, repo_dir = runtime_paths(request)
    torch_info = torch_state()
    seed_ready = (repo_dir / "inference.py").is_file()
    demucs_ready = importlib.util.find_spec("demucs") is not None
    fcpe_ready = importlib.util.find_spec("torchfcpe") is not None
    checkpoint_root = repo_dir / "checkpoints"
    models_ready = checkpoint_root.is_dir() and any(checkpoint_root.rglob("*.pth"))
    roformer_model, roformer_config, roformer_code = roformer_paths(request, repo_dir)
    roformer_ready = bool(roformer_model.is_file() and roformer_config.is_file() and roformer_code.is_file())
    return {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "installed": bool(torch_info["torchInstalled"] and seed_ready and demucs_ready),
        "runtimeReady": bool(torch_info["torchInstalled"] and seed_ready and demucs_ready),
        "conversionReady": bool(torch_info["torchInstalled"] and seed_ready),
        "separationReady": bool(torch_info["torchInstalled"] and demucs_ready),
        "fcpeReady": bool(torch_info["torchInstalled"] and fcpe_ready),
        "roformerReady": roformer_ready,
        "roformerModelPath": str(roformer_model) if roformer_ready else "",
        "roformerConfigPath": str(roformer_config) if roformer_ready else "",
        "modelsReady": models_ready,
        "modelDir": str(model_dir),
        "runtimeDir": str(runtime_dir),
        "repoDir": str(repo_dir),
        "license": "GPL-3.0",
        "separationLicense": "MIT",
        **torch_info,
    }


def command_error(label, completed):
    details = (completed.stderr or completed.stdout or "").strip()
    if len(details) > 5000:
        details = details[-5000:]
    return RuntimeError(f"{label} failed with exit code {completed.returncode}: {details}")


def run_command(command, cwd, env=None):
    completed = subprocess.run(
        [str(item) for item in command],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return completed


def run_command_with_heartbeat(command, cwd, env, request_id, device):
    process = subprocess.Popen(
        [str(item) for item in command],
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    started_at = time.monotonic()
    while True:
        try:
            stdout, stderr = process.communicate(timeout=10)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            elapsed_seconds = max(1, int(time.monotonic() - started_at))
            heartbeat_progress = min(92, 12 + (elapsed_seconds // 10) * 2)
            minutes, seconds = divmod(elapsed_seconds, 60)
            elapsed_label = f"{minutes}m {seconds:02d}s" if minutes else f"{seconds}s"
            progress(
                request_id,
                heartbeat_progress,
                f"Seed-VC inference running on {device.upper()} - {elapsed_label} elapsed",
            )


def portable_seed_vc_config(repo_dir, source_config, output_dir):
    """Patch install-time absolute model paths for the current portable root."""
    import yaml

    local_models = repo_dir / "checkpoints" / "magicbox_models"
    whisper_dir = local_models / "whisper-small"
    bigvgan_dir = local_models / "bigvgan_v2_44khz_128band_512x"
    missing = [
        str(candidate)
        for candidate in (whisper_dir / "config.json", bigvgan_dir / "config.json")
        if not candidate.is_file()
    ]
    if missing:
        raise RuntimeError(f"Seed-VC portable model cache is incomplete: {', '.join(missing)}")
    config = yaml.safe_load(source_config.read_text(encoding="utf-8"))
    config["model_params"]["speech_tokenizer"]["name"] = str(whisper_dir.resolve())
    config["model_params"]["vocoder"]["name"] = str(bigvgan_dir.resolve())
    runtime_config = output_dir / "magicbox_seed_vc_svc.runtime.yml"
    runtime_config.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return runtime_config


def separate_stems(request):
    request_id = request.get("id")
    model_dir, runtime_dir, _ = runtime_paths(request)
    source_path = Path(request["sourceAudioPath"]).resolve()
    vocal_path = Path(request["vocalPath"]).resolve()
    accompaniment_path = Path(request["accompanimentPath"]).resolve()
    work_dir = Path(request.get("workingDir") or vocal_path.parent).resolve()
    demucs_output = work_dir / "demucs-output"
    model_name = str(request.get("separationModel") or "htdemucs")
    segment_seconds = max(4, min(7, int(float(request.get("segmentSeconds") or 7))))
    separation_overlap = max(0.1, min(0.75, float(request.get("separationOverlap") or 0.5)))
    separation_shifts = max(1, min(2, int(request.get("separationShifts") or 1)))
    torch_info = torch_state()
    requested_device = str(request.get("device") or "auto").lower()
    device = "cuda" if requested_device == "auto" and torch_info["gpuAvailable"] else requested_device
    if device not in {"cuda", "cpu"}:
        device = "cpu"

    vocal_path.parent.mkdir(parents=True, exist_ok=True)
    accompaniment_path.parent.mkdir(parents=True, exist_ok=True)
    demucs_output.mkdir(parents=True, exist_ok=True)
    progress(request_id, 10, f"Loading Demucs {model_name} on {device}")

    command = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--two-stems",
        "vocals",
        "-n",
        model_name,
        "--segment",
        str(segment_seconds),
        "--overlap",
        str(separation_overlap),
        "--shifts",
        str(separation_shifts),
        "-j",
        "1",
        "-d",
        device,
        "-o",
        str(demucs_output),
        str(source_path),
    ]
    command_env = os.environ.copy()
    command_env["TORCH_HOME"] = command_env.get("TORCH_HOME") or str(model_dir / "cache" / "torch")
    command_env["PYTHONIOENCODING"] = "utf-8"
    command_env["PYTHONUTF8"] = "1"
    media_tool_dirs = []
    for tool_path in (request.get("ffmpegPath"), request.get("ffprobePath"), os.environ.get("MAGIC_BOX_FFMPEG_PATH"), os.environ.get("MAGIC_BOX_FFPROBE_PATH")):
        if tool_path:
            tool_file = Path(str(tool_path)).resolve()
            if tool_file.is_file():
                media_tool_dirs.append(str(tool_file.parent))
    if media_tool_dirs:
        command_env["PATH"] = os.pathsep.join(dict.fromkeys(media_tool_dirs + [command_env.get("PATH", "")]))
    completed = run_command(command, runtime_dir, env=command_env)
    warnings = []
    if completed.returncode != 0 and device == "cuda":
        warnings.append("Demucs GPU separation failed; retried on CPU.")
        progress(request_id, 28, "Demucs GPU pass failed; retrying on CPU")
        command[command.index("cuda")] = "cpu"
        device = "cpu"
        completed = run_command(command, runtime_dir, env=command_env)
    if completed.returncode != 0:
        raise command_error("Demucs vocal separation", completed)

    stem_dir = demucs_output / model_name / source_path.stem
    generated_vocal = stem_dir / "vocals.wav"
    generated_accompaniment = stem_dir / "no_vocals.wav"
    if not generated_vocal.is_file() or not generated_accompaniment.is_file():
        matches = list(demucs_output.rglob("vocals.wav"))
        generated_vocal = matches[0] if matches else generated_vocal
        no_vocal_matches = list(demucs_output.rglob("no_vocals.wav"))
        generated_accompaniment = no_vocal_matches[0] if no_vocal_matches else generated_accompaniment
    if not generated_vocal.is_file() or not generated_accompaniment.is_file():
        raise RuntimeError("Demucs completed but did not create vocals.wav and no_vocals.wav.")

    shutil.copy2(generated_vocal, vocal_path)
    shutil.copy2(generated_accompaniment, accompaniment_path)
    progress(request_id, 100, "Demucs vocal separation completed")
    return {
        "vocalPath": str(vocal_path),
        "accompanimentPath": str(accompaniment_path),
        "separationStrategy": f"demucs-{model_name}",
        "model": model_name,
        "device": device,
        "overlap": separation_overlap,
        "shifts": separation_shifts,
        "warnings": warnings,
    }


def sha256_file(path):
    import hashlib

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def roformer_paths(request, repo_dir):
    """Resolve the explicitly pinned alternate separator without guessing weights."""
    model_dir = Path(
        request.get("modelDir")
        or os.environ.get("MAGIC_BOX_VOICE_ENGINE_MODEL_DIR")
        or repo_dir.parent / "models"
    ).resolve()
    separator_root = Path(
        request.get("roformerRoot")
        or os.environ.get("MAGIC_BOX_VTV_ROFORMER_ROOT")
        or model_dir.parent / "vtv-separators" / "bs-roformer"
    ).resolve()
    model_path = Path(
        request.get("roformerModelPath")
        or separator_root / "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
    ).resolve()
    config_path = Path(
        request.get("roformerConfigPath")
        or separator_root / "model_bs_roformer_ep_317_sdr_12.9755.yaml"
    ).resolve()
    code_root = Path(
        request.get("roformerCodeRoot")
        or os.environ.get("MAGIC_BOX_VTV_ROFORMER_CODE_ROOT")
        or repo_dir.parent.parent.parent / "gpt-sovits" / "runtime" / "GPT-SoVITS" / "tools" / "uvr5"
    ).resolve()
    return model_path, config_path, code_root / "bsroformer.py"


def separate_stems_roformer(request):
    """Run the pinned 44.1 kHz BS-RoFormer separator as an explicit A/B lane."""
    import librosa
    import soundfile as sf
    import torch

    request_id = request.get("id")
    _, _, repo_dir = runtime_paths(request)
    source_path = Path(request["sourceAudioPath"]).resolve()
    vocal_path = Path(request["vocalPath"]).resolve()
    accompaniment_path = Path(request["accompanimentPath"]).resolve()
    work_dir = Path(request.get("workingDir") or vocal_path.parent).resolve()
    model_path, config_path, code_file = roformer_paths(request, repo_dir)
    if not source_path.is_file():
        raise RuntimeError("BS-RoFormer source audio is missing.")
    if not model_path.is_file() or not config_path.is_file() or not code_file.is_file():
        raise RuntimeError("Pinned BS-RoFormer model, config, or runtime code is missing.")
    torch_info = torch_state()
    requested_device = str(request.get("device") or "auto").lower()
    device = "cuda" if requested_device == "auto" and torch_info["gpuAvailable"] else requested_device
    if device not in {"cuda", "cpu"}:
        device = "cpu"
    code_root = code_file.parent
    if str(code_root) not in sys.path:
        sys.path.insert(0, str(code_root))
    cache_key = (str(model_path), model_path.stat().st_size, model_path.stat().st_mtime_ns, device)
    loader = _ROFORMER_MODEL_CACHE.get(cache_key)
    if loader is None:
        progress(request_id, 10, f"Loading pinned BS-RoFormer on {device.upper()}")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from bsroformer import Roformer_Loader

            loader = Roformer_Loader(str(model_path), str(config_path), device, device == "cuda")
        _ROFORMER_MODEL_CACHE.clear()
        _ROFORMER_MODEL_CACHE[cache_key] = loader

    # The pinned checkpoint is stereo. Keep the source untouched, but provide
    # a deterministic stereo 44.1 kHz analysis lane when the upload is mono.
    roformer_source_path = source_path
    source_mix, _ = librosa.load(str(source_path), sr=44100, mono=False)
    if source_mix.ndim == 1:
        roformer_source_path = work_dir / "bs-roformer-stereo-input.wav"
        stereo_mix = torch.from_numpy(source_mix).float().repeat(2, 1).numpy().T
        sf.write(str(roformer_source_path), stereo_mix, 44100, subtype="PCM_16")
    elif source_mix.ndim == 2 and source_mix.shape[0] > 2:
        roformer_source_path = work_dir / "bs-roformer-stereo-input.wav"
        sf.write(str(roformer_source_path), source_mix[:2].T, 44100, subtype="PCM_16")

    vocal_root = work_dir / "bs-roformer-vocals"
    other_root = work_dir / "bs-roformer-other"
    vocal_root.mkdir(parents=True, exist_ok=True)
    other_root.mkdir(parents=True, exist_ok=True)
    progress(request_id, 24, "Separating vocals with pinned BS-RoFormer")
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        loader.run_folder(str(roformer_source_path), str(other_root), str(vocal_root), "wav")
    vocal_candidates = sorted(vocal_root.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    other_candidates = sorted(other_root.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not vocal_candidates or not other_candidates:
        raise RuntimeError("BS-RoFormer completed but did not create vocal and accompaniment WAVs.")
    vocal_path.parent.mkdir(parents=True, exist_ok=True)
    accompaniment_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(vocal_candidates[0], vocal_path)
    shutil.copy2(other_candidates[0], accompaniment_path)
    progress(request_id, 100, "BS-RoFormer vocal separation completed")
    return {
        "vocalPath": str(vocal_path),
        "accompanimentPath": str(accompaniment_path),
        "separationStrategy": "bs-roformer-viperx-ep317-sdr12.9755",
        "model": model_path.name,
        "modelSha256": sha256_file(model_path),
        "configPath": str(config_path),
        "device": device,
        "sampleRate": 44100,
        "overlap": 0.5,
        "shifts": 1,
        "warnings": [],
    }


def wav_duration(path):
    try:
        import soundfile

        return float(soundfile.info(str(path)).duration)
    except Exception:
        pass
    try:
        with wave.open(str(path), "rb") as reader:
            return reader.getnframes() / float(reader.getframerate())
    except Exception:
        return 0.0


def _song_audio(path, sample_rate=16000):
    import librosa

    audio, _ = librosa.load(str(path), sr=sample_rate, mono=True)
    if audio.size == 0:
        raise RuntimeError(f"Song integrity audio was empty: {path}")
    return audio


def _song_rms_frames(audio, frame_length=640, hop_length=160):
    import librosa
    import numpy as np

    values = librosa.feature.rms(
        y=audio,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )[0]
    return np.asarray(values, dtype=np.float32)


def _song_alignment_lag(source_rms, converted_rms, max_lag_frames=25):
    import numpy as np

    best_lag = 0
    best_score = float("-inf")
    for lag in range(-max_lag_frames, max_lag_frames + 1):
        source_start = max(0, -lag)
        converted_start = max(0, lag)
        length = min(len(source_rms) - source_start, len(converted_rms) - converted_start)
        if length < 100:
            continue
        source_values = source_rms[source_start:source_start + length]
        converted_values = converted_rms[converted_start:converted_start + length]
        source_values = source_values - source_values.mean()
        converted_values = converted_values - converted_values.mean()
        denominator = float(np.linalg.norm(source_values) * np.linalg.norm(converted_values))
        score = float(np.dot(source_values, converted_values) / denominator) if denominator > 1e-9 else -1.0
        if score > best_score:
            best_score = score
            best_lag = lag
    return best_lag


def _song_speaker_embedding(model, audio, device):
    import numpy as np
    import torch
    import torchaudio

    values = torch.tensor(audio, dtype=torch.float32, device=device).unsqueeze(0)
    features = torchaudio.compliance.kaldi.fbank(
        values,
        num_mel_bins=80,
        dither=0,
        sample_frequency=16000,
    )
    features = features - features.mean(dim=0, keepdim=True)
    with torch.no_grad():
        embedding = model(features.unsqueeze(0)).squeeze().float().cpu().numpy()
    norm = float(np.linalg.norm(embedding))
    return embedding / max(norm, 1e-9)


def _song_active_embeddings(model, audio, device, window_seconds=4, hop_seconds=2, limit=64):
    import numpy as np

    sample_rate = 16000
    window = window_seconds * sample_rate
    hop = hop_seconds * sample_rate
    if len(audio) <= window:
        return [_song_speaker_embedding(model, audio, device)]
    chunks = []
    energies = []
    for start in range(0, len(audio) - window + 1, hop):
        chunk = audio[start:start + window]
        chunks.append(chunk)
        energies.append(float(np.sqrt(np.mean(np.square(chunk)))))
    threshold = max(float(np.percentile(energies, 45)), 0.003)
    selected = [chunk for chunk, energy in zip(chunks, energies) if energy >= threshold]
    if not selected:
        selected = [chunks[int(np.argmax(energies))]]
    if len(selected) > limit:
        indexes = np.linspace(0, len(selected) - 1, num=limit, dtype=int)
        selected = [selected[index] for index in indexes]
    return [_song_speaker_embedding(model, chunk, device) for chunk in selected]


def _song_identity_floor(source_similarity):
    source_similarity = float(source_similarity)
    if source_similarity >= 0.78:
        return max(0.75, min(0.90, source_similarity - 0.03))
    return max(0.55, min(0.78, source_similarity + 0.15))


def _song_pitch_errors(source_f0, converted_f0, paired_voiced, expected_shift_cents=0.0):
    import numpy as np

    raw_error = np.zeros(len(source_f0), dtype=np.float32)
    raw_error[paired_voiced] = (
        1200.0 * np.log2(converted_f0[paired_voiced] / source_f0[paired_voiced])
        - float(expected_shift_cents)
    )
    pitch_class_error = np.zeros(len(source_f0), dtype=np.float32)
    pitch_class_error[paired_voiced] = ((raw_error[paired_voiced] + 600.0) % 1200.0) - 600.0
    return raw_error, pitch_class_error


def _fcpe_model(device):
    import torchfcpe

    key = str(device)
    cached = _FCPE_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    model = torchfcpe.spawn_bundled_infer_model(device=key)
    _FCPE_MODEL_CACHE[key] = model
    return model


def _fcpe_f0(audio, device):
    import numpy as np
    import torch

    model = _fcpe_model(device)
    tensor = torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0).unsqueeze(-1).to(device)
    with torch.no_grad():
        values = model.infer(
            tensor,
            sr=16000,
            decoder_mode="local_argmax",
            threshold=0.006,
            f0_min=50,
            f0_max=1200,
            interp_uv=False,
            output_interp_target_length=(len(audio) // 160) + 1,
        )
    if hasattr(values, "detach"):
        values = values.detach().float().cpu().numpy()
    values = np.asarray(values, dtype=np.float32).reshape(-1)
    if values.size < 2:
        raise RuntimeError("FCPE returned too few pitch frames.")
    return values


def _median_f0_disagreement(first, second):
    import numpy as np

    length = min(len(first), len(second))
    if length <= 0:
        return 0.0, 0
    first = np.asarray(first[:length], dtype=np.float32)
    second = np.asarray(second[:length], dtype=np.float32)
    mask = (first > 1) & (second > 1)
    if int(mask.sum()) < 1:
        return 0.0, 0
    cents = 1200.0 * np.abs(np.log2(first[mask] / second[mask]))
    return float(np.median(cents)), int(mask.sum())


def _song_integrity_reasons(
    duration_delta_percent,
    onset_lag_ms,
    voiced_dropout_percent,
    pitch_over_100_percent,
    abrupt_jumps_per_minute,
    target_similarity,
    identity_floor,
    problem_intervals,
):
    reasons = []
    if duration_delta_percent > 1.0:
        reasons.append("duration_mismatch")
    if abs(onset_lag_ms) > 80.0:
        reasons.append("onset_mismatch")
    if voiced_dropout_percent > 3.0:
        reasons.append("voiced_pitch_dropout")
    if pitch_over_100_percent > 4.0:
        reasons.append("pitch_deviation")
    if abrupt_jumps_per_minute > 6.0:
        reasons.append("pitch_discontinuity")
    if problem_intervals:
        reasons.append("localized_pitch_failure")
    if target_similarity < identity_floor:
        reasons.append("target_identity_weak")
    return reasons


def _song_models(repo_dir, device):
    import torch

    key = (str(repo_dir), str(device))
    cached = _SONG_MODEL_CACHE.get(key)
    if cached:
        return cached
    from modules.rmvpe import RMVPE

    checkpoint_root = repo_dir / "checkpoints"
    rmvpe_matches = sorted(checkpoint_root.glob("models--lj1995--VoiceConversionWebUI/snapshots/*/rmvpe.pt"))
    campplus_matches = sorted(checkpoint_root.glob("models--funasr--campplus/snapshots/*/campplus_cn_common.bin"))
    if not rmvpe_matches or not campplus_matches:
        raise RuntimeError("Seed-VC song integrity models are missing. Reinstall the managed Seed-VC runtime.")
    pitch_model = RMVPE(str(rmvpe_matches[-1]), is_half=False, device=device)
    speaker_model = _speaker_identity_model(repo_dir, device)
    cached = (pitch_model, speaker_model)
    _SONG_MODEL_CACHE[key] = cached
    return cached


def _speaker_identity_model(repo_dir, device):
    import torch

    key = (str(repo_dir), str(device))
    cached = _SPEAKER_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    repo_text = str(repo_dir)
    if repo_text not in sys.path:
        sys.path.insert(0, repo_text)
    from modules.campplus.DTDNN import CAMPPlus

    checkpoint_root = repo_dir / "checkpoints"
    matches = sorted(checkpoint_root.glob("models--funasr--campplus/snapshots/*/campplus_cn_common.bin"))
    if not matches:
        raise RuntimeError("Seed-VC speaker identity model is missing. Reinstall the managed Seed-VC runtime.")
    model = CAMPPlus(feat_dim=80, embedding_size=192)
    try:
        state = torch.load(str(matches[-1]), map_location="cpu", weights_only=True)
    except TypeError:
        state = torch.load(str(matches[-1]), map_location="cpu")
    model.load_state_dict(state)
    model.eval().to(device)
    _SPEAKER_MODEL_CACHE[key] = model
    return model


def _quality_evaluator_root(request, repo_dir):
    configured = request.get("qualityEvaluatorDir") or os.environ.get("MAGIC_BOX_VOICE_QUALITY_EVALUATOR_DIR")
    if configured:
        return Path(configured).resolve()
    return repo_dir.parents[2] / "quality-evaluators"


def _eres2net_identity_model(request, repo_dir, device):
    import torch

    quality_root = _quality_evaluator_root(request, repo_dir)
    checkpoint = quality_root / "eres2netv2" / "pretrained_eres2netv2.ckpt"
    if not checkpoint.is_file():
        raise RuntimeError("ERes2NetV2 speaker identity model is missing. Install the managed quality evaluator weights.")
    gpt_eres_root = repo_dir.parents[2] / "gpt-sovits" / "runtime" / "GPT-SoVITS" / "GPT_SoVITS" / "eres2net"
    if not (gpt_eres_root / "ERes2NetV2.py").is_file():
        raise RuntimeError("ERes2NetV2 runtime implementation is missing from the managed GPT-SoVITS runtime.")
    key = (str(checkpoint), str(device))
    cached = _ERES2NET_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    module_root = str(gpt_eres_root)
    if module_root not in sys.path:
        sys.path.insert(0, module_root)
    from ERes2NetV2 import ERes2NetV2

    model = ERes2NetV2(baseWidth=26, scale=2, expansion=2)
    try:
        state = torch.load(str(checkpoint), map_location="cpu", weights_only=True)
    except TypeError:
        state = torch.load(str(checkpoint), map_location="cpu")
    model.load_state_dict(state, strict=True)
    model.eval().to(device)
    _ERES2NET_MODEL_CACHE[key] = model
    return model


def _dns_mos_evaluator(request, repo_dir, device):
    quality_root = _quality_evaluator_root(request, repo_dir)
    evaluator_root = repo_dir / "baselines" / "dnsmos"
    primary = evaluator_root / "sig_bak_ovr.onnx"
    p808 = evaluator_root / "model_v8.onnx"
    if not primary.is_file() or not p808.is_file():
        raise RuntimeError("DNSMOS evaluator models are missing. Install the managed quality evaluator weights.")
    key = (str(primary), str(p808), str(device))
    cached = _DNSMOS_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    repo_text = str(repo_dir)
    if repo_text not in sys.path:
        sys.path.insert(0, repo_text)
    from baselines.dnsmos.dnsmos_computor import DNSMOSComputer

    evaluator = DNSMOSComputer(str(primary), str(p808), device="cuda", device_id=0)
    _DNSMOS_MODEL_CACHE[key] = evaluator
    return evaluator


def _nisqa_evaluator(request, repo_dir, device):
    quality_root = _quality_evaluator_root(request, repo_dir)
    root = quality_root / "nisqa"
    checkpoint = root / "weights" / "nisqa.tar"
    if not checkpoint.is_file() or not (root / "nisqa" / "NISQA_model.py").is_file():
        raise RuntimeError("NISQA evaluator model is missing. Install the managed quality evaluator weights.")
    key = (str(checkpoint), str(device))
    cached = _NISQA_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    root_text = str(root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)
    from nisqa.NISQA_model import nisqaModel

    args = {
        "mode": "predict_file",
        "pretrained_model": str(checkpoint),
        "deg": "",
        "output_dir": None,
        "tr_bs_val": 1,
        "tr_num_workers": 0,
        "tr_parallel": False,
        "tr_device": "cpu",
        "ms_channel": None,
    }
    # NISQA prints its model/config diagnostics to stdout. Keep the worker's
    # stdout reserved for JSON Lines responses.
    with contextlib.redirect_stdout(io.StringIO()):
        evaluator = nisqaModel(args)
    evaluator.dev = device
    _NISQA_MODEL_CACHE[key] = evaluator
    return evaluator


def _utmos_evaluator(request, repo_dir, device):
    quality_root = _quality_evaluator_root(request, repo_dir)
    root = quality_root / "utmosv2"
    checkpoint = quality_root / "utmosv2-cache" / "models" / "fusion_stage3" / "fold0_s42_best_model.pth"
    wav2vec_root = quality_root / "hf-cache" / "hub" / "models--facebook--wav2vec2-base"
    if not checkpoint.is_file() or not (root / "utmosv2" / "_core" / "create.py").is_file():
        raise RuntimeError("UTMOSv2 evaluator model is missing. Install the managed quality evaluator weights.")
    if not wav2vec_root.is_dir():
        raise RuntimeError("UTMOSv2 wav2vec2-base feature model is missing.")
    key = (str(checkpoint), str(wav2vec_root), str(device))
    cached = _UTMOS_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    os.environ["UTMOSV2_CHACHE"] = str(quality_root / "utmosv2-cache")
    os.environ["HF_HOME"] = str(quality_root / "hf-cache")
    os.environ["HF_HUB_CACHE"] = str(quality_root / "hf-cache" / "hub")
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    root_text = str(root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)
    import importlib
    config = importlib.import_module("utmosv2.config.fusion_stage3")
    config.model.ssl.name = "facebook/wav2vec2-base"
    config.model.multi_spec.pretrained = False
    from utmosv2 import create_model

    with contextlib.redirect_stdout(io.StringIO()):
        evaluator = create_model(
            pretrained=True,
            config="fusion_stage3",
            fold=0,
            checkpoint_path=checkpoint,
            device=str(device),
        )
    evaluator.eval()
    _UTMOS_MODEL_CACHE[key] = evaluator
    return evaluator


def _nisqa_predict(evaluator, audio_path):
    import numpy as np

    evaluator.args["deg"] = str(audio_path)
    evaluator.args["mode"] = "predict_file"
    evaluator._loadDatasetsFile()
    with contextlib.redirect_stdout(io.StringIO()):
        frame = evaluator.predict()
    if hasattr(frame, "iloc"):
        row = frame.iloc[0]
        values = np.asarray([
            row["mos_pred"],
            row["noi_pred"],
            row["dis_pred"],
            row["col_pred"],
            row["loud_pred"],
        ], dtype=float)
    else:
        values = np.asarray(frame[0] if isinstance(frame, tuple) else frame).reshape(-1)
    return {
        "mos": round(float(values[0]), 6),
        "noisiness": round(float(values[1]), 6),
        "discontinuity": round(float(values[2]), 6),
        "coloration": round(float(values[3]), 6),
        "loudness": round(float(values[4]), 6),
    }


def _utmos_predict(evaluator, audio_path):
    with contextlib.redirect_stdout(io.StringIO()):
        value = evaluator.predict(input_path=str(audio_path))
    if hasattr(value, "detach"):
        value = value.detach().cpu().reshape(-1)[0].item()
    elif isinstance(value, (list, tuple)):
        value = value[0]
    return float(value)


def evaluate_quality_batch(request):
    import librosa
    import numpy as np
    import torch

    _, _, repo_dir = runtime_paths(request)
    candidates = request.get("candidates") or []
    if not isinstance(candidates, list) or not candidates or len(candidates) > 16:
        raise RuntimeError("Quality evaluation requires 1-16 readable candidates.")
    torch_info = torch_state()
    device = torch.device("cuda" if torch_info["gpuAvailable"] else "cpu")
    speaker_model = _eres2net_identity_model(request, repo_dir, device)
    dns_mos = _dns_mos_evaluator(request, repo_dir, device)
    nisqa = None
    nisqa_error = ""
    try:
        nisqa = _nisqa_evaluator(request, repo_dir, torch.device("cpu"))
    except Exception as error:
        nisqa_error = str(error)
    utmos = None
    utmos_error = ""
    try:
        utmos = _utmos_evaluator(request, repo_dir, torch.device("cpu"))
    except Exception as error:
        utmos_error = str(error)
    reference_paths = [
        Path(item).resolve()
        for item in request.get("targetReferenceAudioPaths") or []
        if item and Path(item).is_file()
    ][:16]
    if not reference_paths:
        fallback = Path(request.get("targetReferenceAudioPath") or "").resolve()
        if fallback.is_file():
            reference_paths = [fallback]
    if not reference_paths:
        raise RuntimeError("Quality evaluation requires at least one readable target reference.")
    target_centroid = _song_target_centroid(reference_paths, speaker_model, device)
    results = []
    for index, candidate in enumerate(candidates):
        candidate_id = str(candidate.get("id") or index + 1)
        audio_path = Path(candidate.get("audioPath") or "").resolve()
        if not audio_path.is_file():
            raise RuntimeError("Quality evaluation received unreadable candidate audio.")
        audio, sampling_rate = librosa.load(str(audio_path), sr=16000, mono=True)
        if audio.size < 160:
            raise RuntimeError("Quality evaluation received an audio candidate that is too short.")
        identity_embeddings = _song_active_embeddings(speaker_model, audio, device, limit=16)
        target_similarity = float(np.median([np.dot(item, target_centroid) for item in identity_embeddings]))
        dns = dns_mos.compute(str(audio_path), sampling_rate)
        nisqa_result = None
        if nisqa is not None:
            try:
                nisqa_result = _nisqa_predict(nisqa, audio_path)
            except Exception as error:
                nisqa_error = str(error)
        utmos_score = None
        if utmos is not None:
            try:
                utmos_score = _utmos_predict(utmos, audio_path)
            except Exception as error:
                utmos_error = str(error)
        perceptual_score = utmos_score if utmos_score is not None else float(dns.get("OVRL"))
        results.append({
            "id": candidate_id,
            "encoderB": {
                "score": round(target_similarity, 6),
                "embeddingCount": len(identity_embeddings),
                "targetReferenceCount": len(reference_paths),
                "evaluatorVersion": "eres2netv2-sv-zh-cn-16k-common-v1.0.2"
            },
            "perceptual": {
                "available": True,
                "status": "shadow",
                "score": round(perceptual_score, 6),
                "utmos": round(utmos_score, 6) if utmos_score is not None else None,
                "dnsMos": {
                    "ovrl": round(float(dns.get("OVRL")), 6),
                    "sig": round(float(dns.get("SIG")), 6),
                    "bak": round(float(dns.get("BAK")), 6),
                    "p808": round(float(dns.get("P808_MOS")), 6)
                },
                "nisqa": nisqa_result,
                "evaluatorVersion": "+".join(filter(None, [
                    "dnsmos-v1-model-v8",
                    "nisqa-v2.0" if nisqa_result else "",
                    "utmosv2-fusion-stage3-fold0" if utmos_score is not None else ""
                ]))
            }
        })
    return {
        "available": True,
        "device": torch_info["device"],
        "perceptualProvider": getattr(dns_mos, "provider", "CPUExecutionProvider"),
        "nisqaAvailable": nisqa is not None,
        "nisqaError": nisqa_error,
        "utmosAvailable": utmos is not None,
        "utmosError": utmos_error,
        "results": results,
        "evaluatorVersions": {
            "speaker": "eres2netv2-sv-zh-cn-16k-common-v1.0.2",
            "perceptual": "+".join(filter(None, [
                "dnsmos-v1-model-v8",
                "nisqa-v2.0" if nisqa is not None else "",
                "utmosv2-fusion-stage3-fold0" if utmos is not None else ""
            ]))
        }
    }


def analyze_waveform_artifacts(request):
    """Run deterministic, model-free artifact checks on final candidate audio.

    These checks intentionally complement (rather than replace) DNSMOS/NISQA/
    UTMOS.  They are cheap enough to run for every candidate and fail closed
    when the PCM cannot be decoded.
    """
    import librosa
    import numpy as np

    candidates = request.get("candidates") or []
    if not isinstance(candidates, list) or not candidates or len(candidates) > 16:
        raise RuntimeError("Waveform artifact analysis requires 1-16 readable candidates.")
    results = []
    for index, candidate in enumerate(candidates):
        candidate_id = str(candidate.get("id") or index + 1)
        audio_path = Path(candidate.get("audioPath") or "").resolve()
        if not audio_path.is_file():
            raise RuntimeError("Waveform artifact analysis received unreadable candidate audio.")
        audio, sample_rate = librosa.load(str(audio_path), sr=None, mono=True)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size < max(160, int(sample_rate * 0.05)):
            raise RuntimeError("Waveform artifact analysis received an audio candidate that is too short.")
        finite_audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
        duration_seconds = float(len(finite_audio) / max(1, sample_rate))
        clipping_ratio = float(np.mean(np.abs(finite_audio) >= 0.999))
        dc_offset = float(abs(np.mean(finite_audio)))
        delta = np.abs(np.diff(finite_audio))
        # Ordinary voiced consonants can have a large one-sample slope.  Keep
        # the hard transient floor high enough to describe a discontinuity,
        # while retaining a percentile component for unusually hot material.
        click_threshold = max(0.8, float(np.percentile(delta, 99.9)) * 1.75)
        click_count = int(np.sum(delta >= click_threshold))
        click_rate_per_minute = float(click_count / max(duration_seconds, 0.05) * 60.0)
        spectrum = np.abs(np.fft.rfft(finite_audio * np.hanning(len(finite_audio))))
        frequencies = np.fft.rfftfreq(len(finite_audio), 1.0 / max(1, sample_rate))
        total_energy = float(np.sum(spectrum[1:] ** 2))
        hum_energy = 0.0
        for base in (50.0, 60.0):
            for harmonic in range(1, 6):
                center = base * harmonic
                mask = np.abs(frequencies - center) <= 1.5
                hum_energy = max(hum_energy, float(np.sum(spectrum[mask] ** 2)))
        line_hum_ratio = hum_energy / max(total_energy, 1e-12)
        reasons = []
        if not np.isfinite(audio).all():
            reasons.append("non_finite_pcm")
        if clipping_ratio > 0.001:
            reasons.append("clipping_detected")
        if dc_offset > 0.02:
            reasons.append("dc_offset_high")
        if click_rate_per_minute > 6.0:
            reasons.append("click_pop_detected")
        if line_hum_ratio > 0.08:
            reasons.append("line_hum_detected")
        results.append({
            "id": candidate_id,
            "passed": not reasons,
            "reasons": reasons,
            "sampleRate": int(sample_rate),
            "durationSeconds": round(duration_seconds, 6),
            "clippingRatio": round(clipping_ratio, 8),
            "dcOffset": round(dc_offset, 8),
            "clickCount": click_count,
            "clickRatePerMinute": round(click_rate_per_minute, 4),
            "lineHumRatio": round(line_hum_ratio, 8),
            "evaluatorVersion": "waveform-artifact-gates-v1"
        })
    return {"available": True, "results": results, "evaluatorVersion": "waveform-artifact-gates-v1"}


def _speaker_reference_calibration(reference_paths, model, device):
    import numpy as np

    if model is None:
        return None
    reference_embeddings = [
        _song_active_embeddings(model, _song_audio(reference_path), device, limit=2)
        for reference_path in reference_paths
    ]
    scores = []
    leave_one_out = len(reference_embeddings) > 1
    for index, own_embeddings in enumerate(reference_embeddings):
        if not own_embeddings:
            continue
        if leave_one_out:
            comparison = [
                embedding
                for other_index, embeddings in enumerate(reference_embeddings)
                if other_index != index
                for embedding in embeddings
            ]
            centroid = np.mean(comparison, axis=0)
            centroid = centroid / max(float(np.linalg.norm(centroid)), 1e-9)
            scores.append(float(np.median([np.dot(item, centroid) for item in own_embeddings])))
        else:
            scores.append(1.0)
    return {
        "scores": [round(score, 6) for score in scores],
        "referenceCount": len(reference_paths),
        "leaveOneOut": leave_one_out,
    }


def calibrate_speaker_identity(request):
    import torch

    _, _, repo_dir = runtime_paths(request)
    reference_paths = [
        Path(item).resolve()
        for item in request.get("targetReferenceAudioPaths") or []
        if item and Path(item).is_file()
    ][:16]
    if not reference_paths:
        fallback = Path(request.get("targetReferenceAudioPath") or "").resolve()
        if fallback.is_file():
            reference_paths = [fallback]
    if not reference_paths:
        raise RuntimeError("Speaker identity calibration requires at least one readable target reference.")
    torch_info = torch_state()
    device = torch.device("cuda" if torch_info["gpuAvailable"] else "cpu")
    encoder_a = _speaker_identity_model(repo_dir, device)
    result = {
        "device": torch_info["device"],
        "targetReferenceCount": len(reference_paths),
        "encoderA": _speaker_reference_calibration(reference_paths, encoder_a, device),
        "evaluatorVersions": {"encoderA": "campplus-campplus_cn_common"},
    }
    try:
        encoder_b = _eres2net_identity_model(request, repo_dir, device)
        result["encoderB"] = _speaker_reference_calibration(reference_paths, encoder_b, device)
        result["evaluatorVersions"]["encoderB"] = "eres2netv2-sv-zh-cn-16k-common-v1.0.2"
    except Exception as error:
        result["encoderB"] = None
        result["encoderBError"] = str(error)
    return result


def _song_target_centroid(reference_paths, speaker_model, device):
    import numpy as np

    key = tuple(
        (str(path), path.stat().st_size, path.stat().st_mtime_ns)
        for path in reference_paths
    ) + (("device", str(device)), ("model", type(speaker_model).__name__))
    cached = _SONG_TARGET_CENTROID_CACHE.get(key)
    if cached is not None:
        return cached
    target_embeddings = []
    for reference_path in reference_paths:
        target_embeddings.extend(_song_active_embeddings(speaker_model, _song_audio(reference_path), device, limit=2))
    centroid = np.mean(target_embeddings, axis=0)
    centroid = centroid / max(float(np.linalg.norm(centroid)), 1e-9)
    _SONG_TARGET_CENTROID_CACHE.clear()
    _SONG_TARGET_CENTROID_CACHE[key] = centroid
    return centroid


def _song_problem_intervals(issue_mask, source_rms, duration_seconds, max_intervals=8):
    import numpy as np

    padded = np.pad(issue_mask.astype(np.int8), (1, 1))
    starts = np.where(np.diff(padded) == 1)[0]
    ends = np.where(np.diff(padded) == -1)[0]
    raw = [(int(start), int(end)) for start, end in zip(starts, ends) if end - start >= 8]
    if not raw:
        return []
    merged = []
    for start, end in raw:
        if merged and start - merged[-1][1] <= 200:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    candidates = []
    for start, end in merged:
        center = (start + end) / 200.0
        repair_start = max(0.0, min(start / 100.0 - 1.2, center - 2.0))
        repair_end = min(duration_seconds, max(end / 100.0 + 1.2, center + 2.0))
        if repair_end - repair_start > 16.0:
            repair_start = max(0.0, center - 8.0)
            repair_end = min(duration_seconds, repair_start + 16.0)
        start_frame = max(0, int(round(repair_start * 100)))
        end_frame = min(len(source_rms) - 1, int(round(repair_end * 100)))
        start_search = source_rms[max(0, start_frame - 100):min(len(source_rms), start_frame + 101)]
        end_search = source_rms[max(0, end_frame - 100):min(len(source_rms), end_frame + 101)]
        if start_search.size:
            repair_start = max(0.0, (max(0, start_frame - 100) + int(np.argmin(start_search))) / 100.0)
        if end_search.size:
            repair_end = min(duration_seconds, (max(0, end_frame - 100) + int(np.argmin(end_search))) / 100.0)
        if repair_end - repair_start < 1.0:
            repair_start = max(0.0, center - 2.0)
            repair_end = min(duration_seconds, center + 2.0)
        candidates.append({
            "startSeconds": round(float(repair_start), 3),
            "endSeconds": round(float(repair_end), 3),
            "issueSeconds": round(float((end - start) / 100.0), 3),
        })
    candidates.sort(key=lambda item: item["issueSeconds"], reverse=True)
    selected = sorted(candidates[:max_intervals], key=lambda item: item["startSeconds"])
    compacted = []
    for item in selected:
        if compacted and item["startSeconds"] <= compacted[-1]["endSeconds"] + 0.2:
            compacted[-1]["endSeconds"] = max(compacted[-1]["endSeconds"], item["endSeconds"])
            compacted[-1]["issueSeconds"] = round(compacted[-1]["issueSeconds"] + item["issueSeconds"], 3)
        else:
            compacted.append(dict(item))
    return compacted


def _song_persistent_mask(issue_mask, minimum_frames):
    """Keep only continuous issues long enough to be audible and repairable."""
    import numpy as np

    result = np.zeros(len(issue_mask), dtype=bool)
    padded = np.pad(np.asarray(issue_mask, dtype=bool).astype(np.int8), (1, 1))
    starts = np.where(np.diff(padded) == 1)[0]
    ends = np.where(np.diff(padded) == -1)[0]
    for start, end in zip(starts, ends):
        if end - start >= int(minimum_frames):
            result[int(start):int(end)] = True
    return result


def _song_dilate_mask(issue_mask, radius_frames):
    import numpy as np

    mask = np.asarray(issue_mask, dtype=bool)
    radius = max(0, int(radius_frames))
    if radius == 0 or not mask.any():
        return mask.copy()
    return np.convolve(mask.astype(np.int8), np.ones(radius * 2 + 1, dtype=np.int8), mode="same") > 0


def analyze_song_conversion(request):
    import numpy as np
    import torch

    request_id = request.get("id")
    _, _, repo_dir = runtime_paths(request)
    source_path = Path(request["sourceAudioPath"]).resolve()
    converted_path = Path(request["convertedAudioPath"]).resolve()
    reference_paths = [
        Path(item).resolve()
        for item in request.get("targetReferenceAudioPaths") or []
        if item and Path(item).is_file()
    ][:16]
    if not source_path.is_file() or not converted_path.is_file():
        raise RuntimeError("Song integrity analysis requires readable source and converted vocals.")
    if not reference_paths:
        fallback = Path(request.get("targetReferenceAudioPath") or "").resolve()
        if fallback.is_file():
            reference_paths = [fallback]
    if not reference_paths:
        raise RuntimeError("Song integrity analysis requires at least one readable target reference.")

    torch_info = torch_state()
    device = torch.device("cuda" if torch_info["gpuAvailable"] else "cpu")
    progress(request_id, 8, f"Checking song pitch and target identity on {str(device).upper()}")
    repo_text = str(repo_dir)
    if repo_text not in sys.path:
        sys.path.insert(0, repo_text)
    source_audio = _song_audio(source_path)
    converted_audio = _song_audio(converted_path)
    source_duration = len(source_audio) / 16000.0
    converted_duration = len(converted_audio) / 16000.0
    source_rms = _song_rms_frames(source_audio)
    converted_rms = _song_rms_frames(converted_audio)
    lag_frames = _song_alignment_lag(source_rms, converted_rms)

    pitch_model, speaker_model = _song_models(repo_dir, device)
    source_f0 = pitch_model.infer_from_audio(source_audio, thred=0.03)
    converted_f0 = pitch_model.infer_from_audio(converted_audio, thred=0.03)
    fcpe_source_f0 = _fcpe_f0(source_audio, device)
    fcpe_converted_f0 = _fcpe_f0(converted_audio, device)
    source_start = max(0, -lag_frames)
    converted_start = max(0, lag_frames)
    aligned_length = min(
        len(source_f0) - source_start,
        len(converted_f0) - converted_start,
        len(source_rms) - source_start,
        len(converted_rms) - converted_start,
    )
    if aligned_length < 100:
        raise RuntimeError("Song integrity analysis could not align the source and converted vocals.")
    source_f0 = source_f0[source_start:source_start + aligned_length]
    converted_f0 = converted_f0[converted_start:converted_start + aligned_length]
    fcpe_source_f0 = fcpe_source_f0[source_start:min(len(fcpe_source_f0), source_start + aligned_length)]
    fcpe_converted_f0 = fcpe_converted_f0[converted_start:min(len(fcpe_converted_f0), converted_start + aligned_length)]
    fcpe_aligned_length = min(len(fcpe_source_f0), len(fcpe_converted_f0), aligned_length)
    if fcpe_aligned_length < 50:
        raise RuntimeError("FCPE integrity analysis could not align the source and converted vocals.")
    fcpe_source_f0 = fcpe_source_f0[:fcpe_aligned_length]
    fcpe_converted_f0 = fcpe_converted_f0[:fcpe_aligned_length]
    aligned_source_rms = source_rms[source_start:source_start + aligned_length]
    source_voiced = source_f0 > 1
    converted_voiced = converted_f0 > 1
    paired_voiced = source_voiced & converted_voiced
    if int(source_voiced.sum()) < 100 or int(paired_voiced.sum()) < 50:
        raise RuntimeError("Song integrity analysis found too little voiced singing to validate safely.")

    expected_pitch_shift_cents = float((request.get("settings") or {}).get("pitchShift") or 0) * 100.0
    pitch_error, pitch_class_error = _song_pitch_errors(
        source_f0,
        converted_f0,
        paired_voiced,
        expected_shift_cents=expected_pitch_shift_cents,
    )
    pitch_error_values = np.abs(pitch_error[paired_voiced])
    pitch_class_error_values = np.abs(pitch_class_error[paired_voiced])
    voiced_dropout = source_voiced & ~converted_voiced
    source_cents = np.zeros(aligned_length, dtype=np.float32)
    converted_cents = np.zeros(aligned_length, dtype=np.float32)
    source_cents[source_voiced] = 1200.0 * np.log2(source_f0[source_voiced])
    converted_cents[converted_voiced] = 1200.0 * np.log2(converted_f0[converted_voiced])
    consecutive = source_voiced[:-1] & source_voiced[1:] & converted_voiced[:-1] & converted_voiced[1:]
    abrupt = consecutive & (np.abs(np.diff(source_cents)) < 80.0) & (np.abs(np.diff(converted_cents)) > 250.0)
    abrupt_mask = np.zeros(aligned_length, dtype=bool)
    abrupt_indexes = np.where(abrupt)[0]
    abrupt_mask[abrupt_indexes] = True
    abrupt_mask[np.minimum(abrupt_indexes + 1, aligned_length - 1)] = True

    target_centroid = _song_target_centroid(reference_paths, speaker_model, device)
    source_embeddings = _song_active_embeddings(speaker_model, source_audio, device)
    converted_embeddings = _song_active_embeddings(speaker_model, converted_audio, device)
    source_similarity = float(np.median([np.dot(item, target_centroid) for item in source_embeddings]))
    target_similarity = float(np.median([np.dot(item, target_centroid) for item in converted_embeddings]))
    fcpe_disagreement_source, fcpe_source_voiced_frames = _median_f0_disagreement(source_f0[:fcpe_aligned_length], fcpe_source_f0)
    fcpe_disagreement_converted, fcpe_converted_voiced_frames = _median_f0_disagreement(converted_f0[:fcpe_aligned_length], fcpe_converted_f0)
    fcpe_disagreement = float(np.median([value for value in (fcpe_disagreement_source, fcpe_disagreement_converted) if value >= 0]))

    voiced_dropout_percent = float(voiced_dropout.sum() / max(1, source_voiced.sum()) * 100.0)
    pitch_over_100_percent = float(np.mean(pitch_error_values > 100.0) * 100.0)
    duration_minutes = max(source_duration / 60.0, 1.0 / 60.0)
    abrupt_jumps_per_minute = float(abrupt.sum() / duration_minutes)
    duration_delta_percent = abs(converted_duration - source_duration) / max(source_duration, 0.001) * 100.0
    identity_floor = _song_identity_floor(source_similarity)
    # RMVPE boundaries do not land on exactly the same 10 ms frame after a
    # timbre conversion. Treating every short boundary mismatch as a broken
    # note made valid real songs fail forever: the repair pass reproduced the
    # same harmless transition and the strict local gate rejected it again.
    # Keep the aggregate guards above, but only schedule a local phrase repair
    # for sustained interior damage or for an aggregate failure that needs a
    # concrete repair interval.
    voicing_edges = np.zeros(aligned_length, dtype=bool)
    voicing_edges[1:] = source_voiced[1:] != source_voiced[:-1]
    source_pitch_steps = np.zeros(aligned_length, dtype=bool)
    source_pitch_steps[1:] = (
        source_voiced[:-1]
        & source_voiced[1:]
        & (np.abs(np.diff(source_cents)) > 80.0)
    )
    transition_guard = _song_dilate_mask(voicing_edges | source_pitch_steps, 10)
    pitch_deviation = paired_voiced & (np.abs(pitch_error) > 100.0)
    if voiced_dropout_percent > 3.0:
        localized_dropout = _song_persistent_mask(voiced_dropout, 8)
    else:
        localized_dropout = _song_persistent_mask(voiced_dropout & ~transition_guard, 12)
    if pitch_over_100_percent > 4.0:
        localized_pitch_deviation = _song_persistent_mask(pitch_deviation, 10)
    else:
        localized_pitch_deviation = _song_persistent_mask(pitch_deviation & ~transition_guard, 18)
    localized_abrupt = (
        _song_dilate_mask(abrupt_mask, 15)
        if abrupt_jumps_per_minute > 6.0
        else np.zeros(aligned_length, dtype=bool)
    )
    issue_mask = localized_dropout | localized_pitch_deviation | localized_abrupt
    problem_intervals = _song_problem_intervals(issue_mask, aligned_source_rms, source_duration)
    reasons = _song_integrity_reasons(
        duration_delta_percent=duration_delta_percent,
        onset_lag_ms=lag_frames * 10.0,
        voiced_dropout_percent=voiced_dropout_percent,
        pitch_over_100_percent=pitch_over_100_percent,
        abrupt_jumps_per_minute=abrupt_jumps_per_minute,
        target_similarity=target_similarity,
        identity_floor=identity_floor,
        problem_intervals=problem_intervals,
    )
    score = (
        target_similarity * 2.0
        - voiced_dropout_percent / 10.0
        - pitch_over_100_percent / 20.0
        - abrupt_jumps_per_minute / 20.0
        - duration_delta_percent / 10.0
    )
    progress(request_id, 100, "Song pitch and target identity check completed")
    return {
        "accepted": not reasons,
        "score": round(float(score), 6),
        "reasons": reasons,
        "metrics": {
            "sourceDurationSeconds": round(float(source_duration), 4),
            "convertedDurationSeconds": round(float(converted_duration), 4),
            "durationDeltaPercent": round(float(duration_delta_percent), 4),
            "onsetLagMs": round(float(lag_frames * 10.0), 2),
            "sourceVoicedFrames": int(source_voiced.sum()),
            "pairedVoicedFrames": int(paired_voiced.sum()),
            "voicedDropoutPercent": round(float(voiced_dropout_percent), 4),
            "medianPitchErrorCents": round(float(np.median(pitch_error_values)), 3),
            "pitchOver100CentsPercent": round(float(pitch_over_100_percent), 4),
            "medianPitchClassErrorCents": round(float(np.median(pitch_class_error_values)), 3),
            "abruptPitchJumpCount": int(abrupt.sum()),
            "abruptPitchJumpsPerMinute": round(float(abrupt_jumps_per_minute), 4),
            "sourceTargetSimilarity": round(float(source_similarity), 6),
            "targetSimilarity": round(float(target_similarity), 6),
            "targetSimilarityFloor": round(float(identity_floor), 6),
            "targetReferenceCount": len(reference_paths),
        },
        "f0Evaluators": {
            "rmvpe": {
                "available": True,
                "voicedFrames": int(source_voiced.sum()),
                "estimatorVersion": "rmvpe"
            },
            "fcpe": {
                "available": True,
                "voicedFrames": int(min(fcpe_source_voiced_frames, fcpe_converted_voiced_frames)),
                "medianDisagreementCents": round(float(fcpe_disagreement), 3),
                "estimatorVersion": "torchfcpe-0.0.4"
            }
        },
        "problemIntervals": problem_intervals,
        "engine": ENGINE_ID,
        "device": torch_info["device"],
    }


def analyze_speaker_identity_batch(request):
    import numpy as np
    import torch

    _, _, repo_dir = runtime_paths(request)
    source_path = Path(request.get("sourceAudioPath") or "").resolve()
    candidates = request.get("candidates") or []
    reference_paths = [
        Path(item).resolve()
        for item in request.get("targetReferenceAudioPaths") or []
        if item and Path(item).is_file()
    ][:16]
    if not source_path.is_file():
        raise RuntimeError("Speaker identity analysis requires readable source speech.")
    if not isinstance(candidates, list) or not candidates or len(candidates) > 16:
        raise RuntimeError("Speaker identity analysis requires 1-16 converted candidates.")
    if not reference_paths:
        fallback = Path(request.get("targetReferenceAudioPath") or "").resolve()
        if fallback.is_file():
            reference_paths = [fallback]
    if not reference_paths:
        raise RuntimeError("Speaker identity analysis requires at least one readable target reference.")

    candidate_entries = []
    candidate_ids = set()
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise RuntimeError("Speaker identity analysis received an invalid converted candidate.")
        candidate_id = str(candidate.get("id") or index + 1)
        candidate_path = Path(candidate.get("audioPath") or "").resolve()
        if candidate_id in candidate_ids or not candidate_path.is_file():
            raise RuntimeError("Speaker identity analysis received duplicate identifiers or unreadable audio.")
        candidate_ids.add(candidate_id)
        candidate_entries.append((candidate_id, candidate_path))

    torch_info = torch_state()
    device = torch.device("cuda" if torch_info["gpuAvailable"] else "cpu")
    speaker_model = _speaker_identity_model(repo_dir, device)
    target_centroid = _song_target_centroid(reference_paths, speaker_model, device)
    source_embeddings = _song_active_embeddings(speaker_model, _song_audio(source_path), device)
    source_similarity = float(np.median([np.dot(item, target_centroid) for item in source_embeddings]))
    identity_floor = _song_identity_floor(source_similarity)
    eres_model = None
    encoder_b_error = ""
    try:
        eres_model = _eres2net_identity_model(request, repo_dir, device)
    except Exception as error:
        encoder_b_error = str(error)
    target_centroid_b = _song_target_centroid(reference_paths, eres_model, device) if eres_model is not None else None
    source_similarity_b = (
        float(np.median([np.dot(item, target_centroid_b) for item in _song_active_embeddings(eres_model, _song_audio(source_path), device)]))
        if eres_model is not None else None
    )
    identity_floor_b = _song_identity_floor(source_similarity_b) if source_similarity_b is not None else None
    results = []
    for candidate_id, candidate_path in candidate_entries:
        embeddings = _song_active_embeddings(speaker_model, _song_audio(candidate_path), device)
        target_similarity = float(np.median([np.dot(item, target_centroid) for item in embeddings]))
        result = {
            "id": candidate_id,
            "accepted": target_similarity >= identity_floor,
            "targetSimilarity": round(target_similarity, 6),
            "identityGain": round(target_similarity - source_similarity, 6),
        }
        if eres_model is not None:
            embeddings_b = _song_active_embeddings(eres_model, _song_audio(candidate_path), device)
            target_similarity_b = float(np.median([np.dot(item, target_centroid_b) for item in embeddings_b]))
            result["encoderB"] = {
                "passed": target_similarity_b >= identity_floor_b,
                "targetSimilarity": round(target_similarity_b, 6),
                "identityGain": round(target_similarity_b - source_similarity_b, 6),
                "targetSimilarityFloor": round(identity_floor_b, 6),
                "targetReferenceCount": len(reference_paths),
                "embeddingCount": len(embeddings_b),
                "evaluatorVersion": "eres2netv2-sv-zh-cn-16k-common-v1.0.2"
            }
        results.append(result)
    return {
        "sourceTargetSimilarity": round(source_similarity, 6),
        "targetSimilarityFloor": round(identity_floor, 6),
        "targetReferenceCount": len(reference_paths),
        "device": torch_info["device"],
        "encoderBAvailable": eres_model is not None,
        "encoderBError": encoder_b_error,
        "evaluatorVersion": "campplus-campplus_cn_common+eres2netv2-sv-zh-cn-16k-common-v1.0.2" if eres_model is not None else "campplus-campplus_cn_common",
        "results": results,
    }


def convert_voice(request):
    request_id = request.get("id")
    _, _, repo_dir = runtime_paths(request)
    inference_path = repo_dir / "inference.py"
    if not inference_path.is_file():
        raise RuntimeError(f"Seed-VC inference.py was not found under {repo_dir}.")

    source_path = Path(request["sourceAudioPath"]).resolve()
    target_path = Path(request["targetReferenceAudioPath"]).resolve()
    output_path = Path(request["outputPath"]).resolve()
    generated_dir = output_path.parent / f"seed-vc-generated-{int(time.time() * 1000)}"
    settings = request.get("settings") or {}
    diffusion_steps = max(4, min(50, int(settings.get("diffusionSteps") or settings.get("diffusion_steps") or 50)))
    cfg_rate = max(0.0, min(1.0, float(settings.get("inferenceCfgRate") or settings.get("inference_cfg_rate") or 0.85)))
    chunk_crossfade_ms = max(180, min(1200, int(settings.get("chunkCrossfadeMs") or settings.get("chunk_crossfade_ms") or 750)))
    overlap_frames = max(16, min(104, round(chunk_crossfade_ms * 44100 / 1000 / 512)))
    effective_crossfade_ms = round(overlap_frames * 512 / 44100 * 1000)
    pitch_shift = max(-24, min(24, int(settings.get("pitchShift") or settings.get("pitch_shift") or 0)))
    preserve_pitch = settings.get("preserveEmotion", settings.get("preserve_emotion", True)) is not False
    checkpoint_override = str(settings.get("checkpointPath") or settings.get("checkpoint_path") or "").strip()
    config_override = str(settings.get("configPath") or settings.get("config_path") or "").strip()
    conversion_warnings = []
    torch_info = torch_state()
    use_fp16 = bool(torch_info["gpuAvailable"])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    generated_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["HF_HOME"] = env.get("HF_HOME") or str(repo_dir / "checkpoints" / "hf_home")
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["MPLCONFIGDIR"] = env.get("MPLCONFIGDIR") or str(Path(request.get("modelDir") or repo_dir / "checkpoints") / "cache" / "matplotlib")
    env["MAGIC_BOX_SEED_VC_OVERLAP_FRAMES"] = str(overlap_frames)
    seed_value = settings.get("seed")
    if seed_value is not None and str(seed_value).strip():
        try:
            env["MAGIC_BOX_SEED_VC_SEED"] = str(int(seed_value))
        except (TypeError, ValueError):
            raise RuntimeError("Seed-VC seed must be an integer when provided.")
    progress(request_id, 8, f"Loading Seed-VC singing model on {torch_info['device'].upper()}")
    inference_wrapper = Path(__file__).resolve().with_name("seed_vc_inference_wrapper.py")
    command = [
        sys.executable,
        str(inference_wrapper if inference_wrapper.is_file() else inference_path),
        *([str(inference_path)] if inference_wrapper.is_file() else []),
        "--source",
        str(source_path),
        "--target",
        str(target_path),
        "--output",
        str(generated_dir),
        "--diffusion-steps",
        str(diffusion_steps),
        "--length-adjust",
        "1.0",
        "--inference-cfg-rate",
        str(cfg_rate),
        "--f0-condition",
        "True" if preserve_pitch else "False",
        "--auto-f0-adjust",
        "False",
        "--semi-tone-shift",
        str(pitch_shift),
        "--fp16",
        "True" if use_fp16 else "False",
    ]
    checkpoint_matches = sorted((repo_dir / "checkpoints").glob(
        "models--Plachta--Seed-VC/snapshots/*/DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth"
    ))
    magicbox_config = repo_dir / "checkpoints" / "magicbox_seed_vc_svc.yml"
    selected_checkpoint = Path(checkpoint_override).resolve() if checkpoint_override else (checkpoint_matches[-1] if checkpoint_matches else None)
    selected_config = Path(config_override).resolve() if config_override else magicbox_config
    if selected_checkpoint and selected_checkpoint.is_file() and selected_config.is_file():
        # The pinned local checkpoint is the 44.1 kHz F0-conditioned SVC model.
        # Passing preserve_pitch=False to Seed-VC's inference.py changes its
        # internal runtime rate to 22.05 kHz after loading the source at 44.1
        # kHz, producing a doubled-duration Speech WAV. Keep the model/rate
        # contract coherent and make the fallback visible in the report.
        if not preserve_pitch:
            preserve_pitch = True
            conversion_warnings.append("f0_condition_forced_by_pinned_44k_checkpoint")
            command[command.index("--f0-condition") + 1] = "True"
        runtime_config = portable_seed_vc_config(repo_dir, selected_config, generated_dir) if not config_override else selected_config
        command.extend(["--checkpoint", str(selected_checkpoint), "--config", str(runtime_config)])
    completed = run_command_with_heartbeat(
        command,
        repo_dir,
        env,
        request_id,
        torch_info["device"],
    )
    if completed.returncode != 0:
        raise command_error("Seed-VC conversion", completed)

    generated = sorted(generated_dir.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not generated:
        raise RuntimeError("Seed-VC completed but did not create a WAV output.")
    shutil.copy2(generated[0], output_path)
    shutil.rmtree(generated_dir, ignore_errors=True)
    progress(request_id, 100, "Seed-VC conversion completed")
    return {
        "outputPath": str(output_path),
        "durationSeconds": wav_duration(output_path),
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "device": torch_info["device"],
        "gpuAvailable": torch_info["gpuAvailable"],
        "conversionStrategy": "seed-vc-zero-shot-svc-f0" if preserve_pitch else "seed-vc-zero-shot-vc",
        "diffusionSteps": diffusion_steps,
        "inferenceCfgRate": cfg_rate,
        "chunkCrossfadeMs": effective_crossfade_ms,
        "chunkOverlapFrames": overlap_frames,
        "warnings": conversion_warnings,
    }


def handle(request):
    action = str(request.get("action") or "").lower()
    if action == "health":
        return health(request)
    if action == "separate-stems-roformer":
        return separate_stems_roformer(request)
    if action in {"separate", "separate-stems"}:
        return separate_stems(request)
    if action in {"v2v", "convert"}:
        return convert_voice(request)
    if action == "analyze-song-conversion":
        return analyze_song_conversion(request)
    if action == "analyze-speaker-identity-batch":
        return analyze_speaker_identity_batch(request)
    if action == "evaluate-quality-batch":
        return evaluate_quality_batch(request)
    if action == "analyze-waveform-artifacts":
        return analyze_waveform_artifacts(request)
    if action == "calibrate-speaker-identity":
        return calibrate_speaker_identity(request)
    if action == "cancel":
        return {"cancelled": True}
    raise RuntimeError(f"Unsupported Seed-VC worker action: {action}")


def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = handle(request)
            emit({"id": request.get("id"), "ok": True, "result": result})
        except Exception as error:
            if os.environ.get("MAGIC_BOX_VTV_DEBUG") == "1":
                traceback.print_exc(file=sys.stderr)
            emit({"id": request.get("id") if request else None, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
