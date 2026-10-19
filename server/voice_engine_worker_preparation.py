import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import threading
import unicodedata
import wave
from pathlib import Path


ENGINE_ID = "voice-preparation-local"
MODEL_VERSION = "voice-preparation-v1"
DEFAULT_ASR_MODEL = "small"
# Demucs 4.0.1's bundled remote/htdemucs.yaml resolves htdemucs to this
# content-addressed checkpoint. The installer pins that Demucs release.
HTDEMUCS_CHECKPOINT_FILENAME = "955717e8-8726e21a.th"
_OUTPUT_LOCK = threading.Lock()


def clean_text(value):
    text = str(value or "")
    return "".join("\ufffd" if 0xD800 <= ord(char) <= 0xDFFF else char for char in text)


def clean_payload(value):
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, list):
        return [clean_payload(item) for item in value]
    if isinstance(value, dict):
        return {clean_text(key): clean_payload(item) for key, item in value.items()}
    return value


def emit_progress(stage, message, progress):
    with _OUTPUT_LOCK:
        sys.stdout.write(json.dumps({
            "event": "progress",
            "stage": clean_text(stage),
            "message": clean_text(message),
            "progress": int(max(0, min(100, progress))),
        }, ensure_ascii=True) + "\n")
        sys.stdout.flush()


def respond(request_id, ok, result=None, error=None):
    payload = {"id": clean_text(request_id), "ok": bool(ok)}
    if ok:
        payload["result"] = clean_payload(result or {})
    else:
        payload["error"] = clean_text(error or "Voice Preparation worker failed.")
    with _OUTPUT_LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
        sys.stdout.flush()


class ProgressHeartbeat:
    """Keeps the UI informed while a native ASR or FFmpeg call is blocking."""

    def __init__(self, stage, message, progress, interval_seconds=8.0):
        self.stage = stage
        self.message = message
        self.progress = progress
        self.interval_seconds = max(0.1, float(interval_seconds))
        self.stop_event = threading.Event()
        self.thread = None

    def __enter__(self):
        emit_progress(self.stage, self.message, self.progress)
        self.thread = threading.Thread(target=self._run, name="voice-preparation-progress", daemon=True)
        self.thread.start()
        return self

    def __exit__(self, _error_type, _error, _traceback):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=max(0.2, min(2.0, self.interval_seconds * 2)))

    def _run(self):
        while not self.stop_event.wait(self.interval_seconds):
            emit_progress(self.stage, self.message, self.progress)


def safe_number(value, fallback, minimum=None, maximum=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(fallback)
    if minimum is not None:
        number = max(float(minimum), number)
    if maximum is not None:
        number = min(float(maximum), number)
    return number


def torch_runtime_state():
    state = {
        "device": "cpu",
        "gpuAvailable": False,
        "gpuName": "",
        "torchVersion": "",
        "torchCudaVersion": "",
    }
    try:
        import torch
    except Exception:
        return state
    state["torchVersion"] = clean_text(getattr(torch, "__version__", ""))
    state["torchCudaVersion"] = clean_text(getattr(getattr(torch, "version", None), "cuda", "") or "")
    try:
        cuda_available = bool(torch.cuda.is_available()) and os.environ.get("CUDA_VISIBLE_DEVICES") != "-1"
    except Exception:
        cuda_available = False
    if not cuda_available:
        return state
    state["device"] = "cuda"
    state["gpuAvailable"] = True
    try:
        state["gpuName"] = clean_text(torch.cuda.get_device_name(0))
    except Exception:
        pass
    return state


def separation_device_label(runtime_state):
    if runtime_state.get("device") == "cuda":
        return "NVIDIA GPU"
    return "CPU"


def format_elapsed_seconds(elapsed_seconds):
    total_seconds = max(0, int(round(elapsed_seconds)))
    minutes, seconds = divmod(total_seconds, 60)
    if minutes:
        return "%dm %02ds" % (minutes, seconds)
    return "%ds" % seconds


def separation_progress_percent(elapsed_seconds, source_duration_seconds, device):
    # This is a conservative activity indicator, not a fabricated ETA. It
    # keeps the separation stage visibly alive until the worker can advance to
    # transcription after Demucs has actually produced its stems.
    expected_seconds = max(45.0, source_duration_seconds * (2.0 if device == "cuda" else 10.0))
    ratio = min(0.98, max(0.0, elapsed_seconds) / expected_seconds)
    return int(round(18 + 36 * ratio))


def configure_faster_whisper_runtime(cache_dir=None):
    # The packaged Windows CPU ASR stack loads CTranslate2 and ONNX Runtime in
    # one worker process. Their OpenMP runtimes can otherwise abort before VAD
    # or transcription begins after the preparation runtime is upgraded to
    # CUDA PyTorch. Keep the compatibility setting local to this worker.
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    # Voice Preparation is installed as a self-contained local runtime. Never
    # let inference turn into a Hugging Face revision lookup: besides violating
    # the local-first contract, that lookup can fail an otherwise healthy
    # training run when the network or TLS connection is unavailable.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if cache_dir is not None:
        managed_cache = Path(cache_dir).resolve()
        managed_cache.mkdir(parents=True, exist_ok=True)
        transformers_cache = managed_cache.parent / "transformers"
        transformers_cache.mkdir(parents=True, exist_ok=True)
        os.environ["HF_HOME"] = str(managed_cache.parent)
        os.environ["HF_HUB_CACHE"] = str(managed_cache)
        os.environ["TRANSFORMERS_CACHE"] = str(transformers_cache)


def complete_faster_whisper_model(directory):
    directory = Path(directory)
    required_files = ("model.bin", "config.json", "tokenizer.json")
    try:
        return directory.is_dir() and all(
            (directory / filename).is_file() and (directory / filename).stat().st_size > 0
            for filename in required_files
        )
    except OSError:
        return False


def local_faster_whisper_model_path(cache_dir, model_name):
    """Resolve a managed Hugging Face snapshot without contacting the network."""
    cache_dir = Path(cache_dir).resolve()
    requested = str(model_name or DEFAULT_ASR_MODEL).strip()

    repository_ids = {
        "small": "Systran/faster-whisper-small",
        "Systran/faster-whisper-small": "Systran/faster-whisper-small",
    }
    repository_id = repository_ids.get(requested)
    if not repository_id:
        return None

    repository_cache = cache_dir / ("models--" + repository_id.replace("/", "--"))
    snapshots_dir = repository_cache / "snapshots"
    candidates = []

    # Prefer the exact snapshot recorded by Hugging Face when it is complete.
    reference_path = repository_cache / "refs" / "main"
    try:
        revision = reference_path.read_text(encoding="utf-8").strip()
        if revision and Path(revision).name == revision:
            candidates.append(snapshots_dir / revision)
    except (OSError, UnicodeError):
        pass

    try:
        snapshots = sorted(
            (item for item in snapshots_dir.iterdir() if item.is_dir()),
            key=lambda item: (item.stat().st_mtime_ns, item.name),
            reverse=True,
        )
        candidates.extend(snapshots)
    except OSError:
        pass

    seen = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            resolved.relative_to(cache_dir)
        except (OSError, ValueError):
            continue
        key = str(resolved).casefold()
        if key in seen:
            continue
        seen.add(key)
        if complete_faster_whisper_model(resolved):
            return resolved
    return None


def runtime_paths(request):
    model_dir = Path(request.get("modelDir") or os.environ.get("MAGIC_BOX_VOICE_ENGINE_MODEL_DIR") or ".").resolve()
    model_dir.mkdir(parents=True, exist_ok=True)
    return {
        "model_dir": model_dir,
        "cache_dir": model_dir / "cache",
        "ready_marker": model_dir / ".models-ready.json",
    }


def dependency_state(request):
    state = {
        "runtimeReady": True,
        "separationReady": False,
        "asrReady": False,
        "pypinyinVersion": "",
        "cn2anVersion": "",
        "modelsReady": False,
        "asrDevice": "cpu",
        **torch_runtime_state(),
    }
    paths = runtime_paths(request)
    try:
        import demucs  # noqa: F401
        state["separationReady"] = True
    except Exception:
        pass
    try:
        configure_faster_whisper_runtime(paths["cache_dir"] / "faster-whisper")
        import faster_whisper  # noqa: F401
        import pypinyin  # noqa: F401
        import cn2an  # noqa: F401
        from importlib.metadata import version

        pypinyin_version = version("pypinyin")
        cn2an_version = version("cn2an")
        state["pypinyinVersion"] = pypinyin_version
        state["cn2anVersion"] = cn2an_version
        if tuple(int(part) for part in pypinyin_version.split(".")[:2]) < (0, 50):
            raise RuntimeError("pypinyin 0.50 or newer is required")
        if tuple(int(part) for part in cn2an_version.split(".")[:3]) < (0, 5, 22):
            raise RuntimeError("cn2an 0.5.22 or newer is required")
        state["asrReady"] = True
    except Exception:
        pass
    marker = None
    try:
        marker = json.loads(paths["ready_marker"].read_text(encoding="utf-8"))
    except Exception:
        marker = None
    demucs_cache = paths["cache_dir"] / "torch" / "hub" / "checkpoints"
    # Demucs stores htdemucs under its content-addressed filename, not an
    # htdemucs-prefixed filename. Do not accept another Demucs model merely
    # because it shares the dedicated checkpoint cache.
    demucs_checkpoint = demucs_cache / HTDEMUCS_CHECKPOINT_FILENAME
    demucs_ready = demucs_checkpoint.is_file() and demucs_checkpoint.stat().st_size > 0
    whisper_cache = paths["cache_dir"] / "faster-whisper"
    whisper_ready = local_faster_whisper_model_path(whisper_cache, DEFAULT_ASR_MODEL) is not None
    state["modelsReady"] = bool(
        state["separationReady"]
        and state["asrReady"]
        and demucs_ready
        and whisper_ready
        and isinstance(marker, dict)
        and marker.get("engine") == ENGINE_ID
        and marker.get("modelVersion") == MODEL_VERSION
        and marker.get("modelsReady") is True
    )
    return state


def require_runtime(request):
    state = dependency_state(request)
    if not state["separationReady"]:
        raise RuntimeError("Demucs is not installed. Run Voice Preparation setup or repair.")
    if not state["asrReady"]:
        raise RuntimeError("faster-whisper is not installed. Run Voice Preparation setup or repair.")
    if not state["modelsReady"]:
        raise RuntimeError("Voice Preparation models are not ready. Finish local setup before preparing sources.")
    return state


def normalize_text(value):
    text = unicodedata.normalize("NFKC", clean_text(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def tokenise(value):
    text = normalize_text(value).casefold()
    tokens = []
    word = []
    for character in text:
        if "\u3400" <= character <= "\u9fff" or "\u3040" <= character <= "\u30ff":
            if word:
                tokens.append("".join(word))
                word = []
            tokens.append(character)
        elif character.isalnum() or character == "'":
            word.append(character)
        elif word:
            tokens.append("".join(word))
            word = []
    if word:
        tokens.append("".join(word))
    return tokens


def ordered_coverage(expected, observed):
    expected_tokens = tokenise(expected)
    observed_tokens = tokenise(observed)
    return ordered_token_coverage(expected_tokens, observed_tokens)


def ordered_token_coverage(expected_tokens, observed_tokens):
    if not expected_tokens:
        return 1.0
    # Count the longest ordered match, not merely the prefix before the first
    # missing word. Never reuse observed tokens or forgive a changed order.
    masks = {}
    for index, token in enumerate(observed_tokens):
        masks[token] = masks.get(token, 0) | (1 << index)
    expected_set = set(expected_tokens)
    merged = {}
    for start, token in enumerate(observed_tokens):
        if not re.fullmatch(r"[a-z0-9']+", token):
            continue
        combined = token
        for end in range(start + 1, min(len(observed_tokens), start + 4)):
            candidate = observed_tokens[end]
            if not re.fullmatch(r"[a-z0-9']+", candidate):
                break
            combined += candidate
            if combined in expected_set:
                merged.setdefault((combined, end + 1), []).append(start)
    if not merged:
        state = 0
        for token in expected_tokens:
            matches = masks.get(token, 0) | state
            state = matches & ~(matches - ((state << 1) | 1))
        return state.bit_count() / len(expected_tokens)

    # Preserve Whisper's split Latin names (MagicBox -> Magic Box), consuming
    # all joined tokens so a second expected word cannot match them again.
    previous = [0] * (len(observed_tokens) + 1)
    for token in expected_tokens:
        row = [0] * len(previous)
        for end, observed in enumerate(observed_tokens, 1):
            row[end] = max(previous[end], row[end - 1])
            if token == observed:
                row[end] = max(row[end], previous[end - 1] + 1)
            for start in merged.get((token, end), ()):
                row[end] = max(row[end], previous[start] + 1)
        previous = row
    return previous[-1] / len(expected_tokens)


def collapse_expressive_repetitions(values, minimum_run=3):
    """Treat long identical chants as one ASR-verifiable unit.

    Whisper commonly collapses "啦啦啦啦啦" or "ha ha ha" even when every
    repetition is audible. Runs shorter than three stay exact, and all
    surrounding words still have to match in order.
    """
    collapsed = []
    normalized = False
    index = 0
    while index < len(values):
        end = index + 1
        while end < len(values) and values[end] == values[index]:
            end += 1
        run_length = end - index
        if run_length >= minimum_run:
            collapsed.append(values[index])
            normalized = True
        else:
            collapsed.extend(values[index:end])
        index = end
    return collapsed, normalized


def observed_token_count_is_bounded(expected_count, observed_count):
    if expected_count <= 0 or observed_count <= 0:
        return False
    return observed_count <= max(expected_count + 1, int(math.ceil(expected_count * 1.35)))


def chinese_phonetic_options(value):
    import cn2an
    from pypinyin import Style, pinyin

    spoken_number_text = cn2an.transform(normalize_text(value), "an2cn")
    characters = [character for token in tokenise(spoken_number_text) for character in token]
    if not characters:
        return []
    return [
        frozenset(normalize_text(reading).casefold() for reading in readings)
        for readings in pinyin(
            "".join(characters),
            style=Style.TONE3,
            heteronym=True,
            neutral_tone_with_five=True,
            errors=lambda unsupported: list(unsupported),
        )
    ]


def ordered_option_coverage(expected_options, observed_options):
    if not expected_options:
        return 1.0
    masks = {}
    for index, options in enumerate(observed_options):
        for option in options:
            masks[option] = masks.get(option, 0) | (1 << index)
    state = 0
    for options in expected_options:
        matches = state
        for option in options:
            matches |= masks.get(option, 0)
        state = matches & ~(matches - ((state << 1) | 1))
    return state.bit_count() / len(expected_options)


def ffmpeg_path(request):
    command = request.get("ffmpegPath") or os.environ.get("MAGIC_BOX_FFMPEG_PATH") or "ffmpeg"
    return str(command)


def run_ffmpeg(request, args):
    completed = subprocess.run(
        [ffmpeg_path(request), "-hide_banner", "-loglevel", "error", "-y", *args],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("FFmpeg could not create a prepared audio artifact.")


def isolate_vocals(request, source_path, output_dir):
    stem_root = output_dir / "stems"
    source_name = source_path.stem
    runtime_state = torch_runtime_state()
    device = runtime_state["device"]
    command = [
        sys.executable,
        "-m",
        "demucs.separate",
        "-n",
        "htdemucs",
        "--two-stems",
        "vocals",
        "-d",
        device,
        "-o",
        str(stem_root),
        str(source_path),
    ]
    diagnostics_path = output_dir / "demucs.stderr.log"
    source_duration_seconds = safe_number(request.get("sourceDurationSeconds"), 0, 0)
    try:
        with diagnostics_path.open("w+", encoding="utf-8", errors="replace") as diagnostics:
            process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=diagnostics,
                text=True,
            )
            started_at = time.monotonic()
            next_heartbeat_at = 0.0
            while process.poll() is None:
                elapsed_seconds = time.monotonic() - started_at
                if elapsed_seconds >= next_heartbeat_at:
                    emit_progress(
                        "separating",
                        "Separating spoken vocal from background music on %s (%s elapsed)" % (
                            separation_device_label(runtime_state),
                            format_elapsed_seconds(elapsed_seconds),
                        ),
                        separation_progress_percent(elapsed_seconds, source_duration_seconds, device),
                    )
                    next_heartbeat_at = elapsed_seconds + 10.0
                time.sleep(0.5)
            return_code = process.returncode
    finally:
        diagnostics_path.unlink(missing_ok=True)
    if return_code != 0:
        raise RuntimeError("Local BGM/vocal separation did not finish. Keep the original and retry after repairing Voice Preparation.")
    candidate_dirs = list((stem_root / "htdemucs").glob("*"))
    source_dir = next((item for item in candidate_dirs if item.name == source_name), candidate_dirs[0] if candidate_dirs else None)
    if not source_dir:
        raise RuntimeError("Local BGM/vocal separation did not produce stems.")
    vocal_source = source_dir / "vocals.wav"
    accompaniment_source = source_dir / "no_vocals.wav"
    if not vocal_source.is_file() or not accompaniment_source.is_file():
        raise RuntimeError("Local BGM/vocal separation produced incomplete stems.")
    vocal_path = output_dir / "vocal.wav"
    accompaniment_path = output_dir / "accompaniment.wav"
    with ProgressHeartbeat("separating", "Normalizing the separated vocal track locally", 55):
        run_ffmpeg(request, ["-i", str(vocal_source), "-ac", "1", "-ar", "32000", str(vocal_path)])
    with ProgressHeartbeat("separating", "Normalizing the accompaniment track locally", 56):
        run_ffmpeg(request, ["-i", str(accompaniment_source), "-ac", "1", "-ar", "32000", str(accompaniment_path)])
    return vocal_path, accompaniment_path


_asr_model_cache = {}
_secondary_asr_model_cache = {}


def load_asr_model(request):
    paths = runtime_paths(request)
    cache_dir = paths["cache_dir"] / "faster-whisper"
    cache_dir.mkdir(parents=True, exist_ok=True)
    configure_faster_whisper_runtime(cache_dir)
    from faster_whisper import WhisperModel

    # Demucs is the long-running preparation step and safely uses PyTorch CUDA.
    # Keep faster-whisper on CPU unless this managed runtime explicitly ships a
    # CUDA-capable CTranslate2 build; that avoids turning a successful vocal
    # separation into an ASR device-compatibility failure.
    device = "cpu"
    compute_type = "int8"
    model_name = str(request.get("asrModel") or DEFAULT_ASR_MODEL)
    local_model_path = local_faster_whisper_model_path(cache_dir, model_name)
    if local_model_path is None:
        raise RuntimeError(
            "The managed faster-whisper model is missing or incomplete. "
            "Run Voice Preparation setup or repair before preparing sources."
        )
    cache_key = (str(local_model_path), device, compute_type)
    if cache_key not in _asr_model_cache:
        _asr_model_cache[cache_key] = WhisperModel(
            str(local_model_path),
            device=device,
            compute_type=compute_type,
            local_files_only=True,
        )
    return _asr_model_cache[cache_key]


def secondary_asr_enabled(request):
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    requested = request.get("secondaryAsrEnabled", settings.get("secondaryAsrEnabled"))
    if requested is None:
        requested = os.environ.get("VOICE_CLONE_SECONDARY_ASR_ENABLED", "0")
    return str(requested).strip().lower() in {"1", "true", "yes", "on"}


def secondary_asr_model_path(request):
    paths = runtime_paths(request)
    explicit = str(request.get("secondaryAsrModelPath") or os.environ.get("MAGIC_BOX_SECONDARY_ASR_MODEL_PATH") or "").strip()
    if explicit:
        candidate = Path(explicit).resolve()
    else:
        candidate = paths["model_dir"].parents[2] / "conversation" / "asr" / "models" / "whisper-large-v3-turbo-0a363e9"
    if not complete_faster_whisper_model(candidate):
        raise RuntimeError("The managed secondary ASR model is missing or incomplete.")
    return candidate


def load_secondary_asr_model(request):
    model_path = secondary_asr_model_path(request)
    configure_faster_whisper_runtime(model_path.parent)
    from faster_whisper import WhisperModel

    cache_key = (str(model_path), "cpu", "int8")
    if cache_key not in _secondary_asr_model_cache:
        _secondary_asr_model_cache[cache_key] = WhisperModel(
            str(model_path),
            device="cpu",
            compute_type="int8",
            local_files_only=True,
        )
    return _secondary_asr_model_cache[cache_key]


def warm_asr(request):
    load_asr_model(request)
    return {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "warmed": True,
    }


_waveform_health_cache = {}


def cached_waveform_health(audio_path):
    resolved = Path(audio_path).resolve()
    if not resolved.is_file():
        return None
    stat = resolved.stat()
    cache_key = str(resolved).casefold()
    signature = (stat.st_mtime_ns, stat.st_size)
    cached = _waveform_health_cache.get(cache_key)
    if cached and cached[0] == signature:
        return cached[1]
    health = waveform_health(resolved)
    _waveform_health_cache[cache_key] = (signature, health)
    return health


def warm_waveform(request):
    require_runtime(request)
    import numpy  # noqa: F401
    reference_path = str(request.get("referenceAudioPath") or "").strip()
    if reference_path:
        cached_waveform_health(reference_path)
    for baseline_path in (request.get("baselineAudioPaths") or [])[:64]:
        if str(baseline_path or "").strip():
            cached_waveform_health(baseline_path)
    return {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "warmed": True,
    }


def transcribe(request, audio_path, language, model=None, heartbeat=None, vad_filter=True):
    requested_language = str(language or "").strip().lower()
    language_arg = requested_language if requested_language in {"zh", "en", "ja"} else None
    def decode():
        active_model = model or load_asr_model(request)
        segments, _info = active_model.transcribe(
            str(audio_path),
            language=language_arg,
            vad_filter=vad_filter,
            word_timestamps=False,
            condition_on_previous_text=False,
            beam_size=5,
        )
        return list(segments)
    if heartbeat:
        stage, message, progress = heartbeat
        with ProgressHeartbeat(stage, message, progress):
            return decode()
    return decode()


def transcript_coverage(expected, observed, language):
    expected_tokens = tokenise(expected)
    observed_tokens = tokenise(observed)
    raw_coverage = ordered_token_coverage(expected_tokens, observed_tokens)
    coverage = raw_coverage
    expected_count = len(expected_tokens)
    observed_count = len(observed_tokens)
    phonetic_coverage = None
    if language == "zh":
        expected_phonetic = chinese_phonetic_options(expected)
        observed_phonetic = chinese_phonetic_options(observed)
        expected_count = len(expected_phonetic)
        observed_count = len(observed_phonetic)
        phonetic_coverage = ordered_option_coverage(expected_phonetic, observed_phonetic)
        coverage = max(coverage, phonetic_coverage)
    return {
        "coverage": coverage,
        "rawCoverage": raw_coverage,
        "expectedTokenCount": expected_count,
        "observedTokenCount": observed_count,
        "phoneticCoverage": phonetic_coverage,
    }


def confidence_from_segment(segment):
    average_log_probability = safe_number(getattr(segment, "avg_logprob", -1.2), -1.2, -8, 0)
    no_speech_probability = safe_number(getattr(segment, "no_speech_prob", 0.5), 0.5, 0, 1)
    language_probability = safe_number(getattr(segment, "compression_ratio", 1.5), 1.5, 0, 8)
    # Whisper reports average log-probability at or below zero. Map its useful
    # range (roughly -1.2 to 0) upward before applying the sigmoid; applying a
    # sigmoid directly to the negative value caps confidence at 0.5 and would
    # make the configured 0.65 quality gate impossible to satisfy.
    logprob_signal = 1.0 / (1.0 + math.exp(-((average_log_probability + 1.2) * 3.0)))
    speech = max(0.0, min(1.0, logprob_signal * (1.0 - no_speech_probability * 0.55)))
    transcript = max(0.0, min(1.0, speech * (1.0 if language_probability < 2.8 else 0.82)))
    return round(speech, 3), round(transcript, 3)


def sentence_has_terminal_boundary(text):
    return bool(re.search(r"[.!?\u3002\uff01\uff1f]$", normalize_text(text)))


def sentence_boundary(text, start_boundary_confirmed):
    if sentence_has_terminal_boundary(text) and start_boundary_confirmed:
        return "complete", 0.96
    if sentence_has_terminal_boundary(text):
        return "uncertain", 0.74
    return "uncertain", 0.62


def join_sentence_text(parts, language):
    cleaned = [normalize_text(part) for part in parts if normalize_text(part)]
    if language in {"zh", "ja"}:
        return normalize_text("".join(cleaned))
    return normalize_text(" ".join(cleaned))


def split_sentence_text_for_duration(text, part_count, language):
    """Return review text for time slices of an overlong ASR decoder segment.

    Faster-whisper normally gives us short VAD chunks.  When it instead gives
    one long, unpunctuated decoder segment, we must still export safe audio
    slices.  These text pieces are deliberately only a review aid: the caller
    marks their boundaries uncertain so a human must listen and save the
    transcript before the clip becomes eligible for training.
    """
    normalized = normalize_text(text)
    count = max(1, int(part_count or 1))
    if count == 1:
        return [normalized]
    if language in {"zh", "ja"}:
        units = list(normalized)
    else:
        units = re.findall(r"\S+", normalized)
    if not units:
        return [""] * count
    pieces = []
    for index in range(count):
        start = int(math.floor(len(units) * index / count))
        end = int(math.floor(len(units) * (index + 1) / count))
        pieces.append(join_sentence_text(units[start:end], language) if end > start else "")
    return pieces


def split_asr_segment_for_max_duration(asr_segment, language, maximum_duration):
    """Break a pathological long ASR segment into review-safe time slices."""
    start = max(0.0, safe_number(getattr(asr_segment, "start", 0), 0))
    end = max(start, safe_number(getattr(asr_segment, "end", start), start))
    transcript = normalize_text(getattr(asr_segment, "text", ""))
    speech_confidence, transcript_confidence = confidence_from_segment(asr_segment)
    duration = max(0.0, end - start)
    if duration <= maximum_duration:
        return [{
            "start": start,
            "end": end,
            "transcript": transcript,
            "speechConfidence": speech_confidence,
            "transcriptConfidence": transcript_confidence,
            "forcedBoundary": False,
        }]

    part_count = max(2, int(math.ceil(duration / maximum_duration)))
    transcript_parts = split_sentence_text_for_duration(transcript, part_count, language)
    return [{
        "start": start + duration * index / part_count,
        "end": start + duration * (index + 1) / part_count,
        "transcript": transcript_parts[index],
        "speechConfidence": speech_confidence,
        "transcriptConfidence": transcript_confidence,
        # The timing cap, rather than punctuation, made this cut.  It is safe
        # to review but must not be treated as an automatic sentence boundary.
        "forcedBoundary": True,
    } for index in range(part_count)]


def assemble_sentence_candidates(asr_segments, language, maximum_duration=10.0):
    # faster-whisper segments are VAD/decoder chunks, not guaranteed sentence
    # units. Keep accumulating them until a real terminal boundary appears,
    # but never merge an unpunctuated run beyond the configured training-safe
    # duration.  The capped pieces remain review-only until the user confirms
    # their transcript and sentence boundary.
    maximum_duration = safe_number(maximum_duration, 10.0, 0.5, 60)
    candidates = []
    current = None
    previous_terminal = False
    ordered_segments = sorted(asr_segments, key=lambda segment: safe_number(getattr(segment, "start", 0), 0))
    for asr_segment in ordered_segments:
        for piece in split_asr_segment_for_max_duration(asr_segment, language, maximum_duration):
            start = piece["start"]
            end = piece["end"]
            transcript = piece["transcript"]
            speech_confidence = piece["speechConfidence"]
            transcript_confidence = piece["transcriptConfidence"]
            if current and start > current["end"] + 0.45:
                # A gap without a preceding terminal punctuation is not evidence of
                # a complete boundary. Preserve it for review rather than guessing.
                current["endedWithTerminal"] = False
                candidates.append(current)
                current = None
                previous_terminal = False
            if current and end - current["start"] > maximum_duration:
                # Lack of punctuation must not turn a long ASR run into an
                # unusable 49-second pseudo-sentence.  Start a new review
                # candidate at the decoder boundary instead.
                current["endedWithTerminal"] = False
                current["resliced"] = True
                candidates.append(current)
                current = None
                previous_terminal = False
            if current is None:
                current = {
                    "start": start,
                    "end": end,
                    "parts": [transcript],
                    "speechConfidence": speech_confidence,
                    "transcriptConfidence": transcript_confidence,
                    "startBoundaryConfirmed": start <= 0.35 or previous_terminal,
                    "endedWithTerminal": False,
                    "resliced": bool(piece["forcedBoundary"]),
                }
                previous_terminal = False
            else:
                current["end"] = max(current["end"], end)
                current["parts"].append(transcript)
                current["speechConfidence"] = min(current["speechConfidence"], speech_confidence)
                current["transcriptConfidence"] = min(current["transcriptConfidence"], transcript_confidence)
                current["resliced"] = current["resliced"] or bool(piece["forcedBoundary"])
            if sentence_has_terminal_boundary(transcript) and not piece["forcedBoundary"]:
                current["endedWithTerminal"] = True
                candidates.append(current)
                current = None
                previous_terminal = True
            elif piece["forcedBoundary"]:
                current["endedWithTerminal"] = False
                current["resliced"] = True
                candidates.append(current)
                current = None
                previous_terminal = False
    if current is not None:
        candidates.append(current)
    for candidate in candidates:
        candidate["transcript"] = join_sentence_text(candidate["parts"], language)
        candidate["duration"] = round(max(0.0, candidate["end"] - candidate["start"]), 3)
    return candidates


def prepare_source(request):
    runtime_state = require_runtime(request)
    source_path = Path(str(request.get("sourceAudioPath") or "")).resolve()
    if not source_path.is_file():
        raise RuntimeError("The original voice source is no longer available.")
    output_dir_value = str(request.get("outputDir") or "").strip()
    if not output_dir_value:
        raise RuntimeError("Voice Preparation did not receive an output directory.")
    # Keep the server-provided path spelling. Path.resolve() expands Windows
    # junctions (for example AppData\\Local\\MagicBox -> a portable data disk),
    # which made otherwise safe derived files appear outside the job folder to
    # the Node process that owns and commits them.
    output_dir = Path(os.path.abspath(output_dir_value))
    output_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = output_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    minimum_duration = safe_number(request.get("minClipSeconds"), 2.5, 0.5, 30)
    maximum_duration = safe_number(request.get("maxClipSeconds"), 10.0, minimum_duration, 60)
    minimum_speech = safe_number(request.get("minimumSpeechConfidence"), 0.65, 0, 1)
    minimum_transcript = safe_number(request.get("minimumTranscriptConfidence"), 0.82, 0, 1)
    minimum_boundary = safe_number(request.get("minimumBoundaryConfidence"), 0.85, 0, 1)
    language = str(request.get("language") or "auto").strip().lower()
    trim_start = safe_number(request.get("trimStartSeconds"), 0, 0)
    trim_end_value = request.get("trimEndSeconds")
    trim_end = safe_number(trim_end_value, 0, 0) if trim_end_value is not None else None
    trim_applied = bool(request.get("trimApplied")) and (trim_start > 0 or (trim_end is not None and trim_end > trim_start))

    prepared_vocal_value = str(request.get("preparedVocalPath") or "").strip()
    prepared_accompaniment_value = str(request.get("preparedAccompanimentPath") or "").strip()
    prepared_vocal_path = Path(prepared_vocal_value).resolve() if prepared_vocal_value else None
    prepared_accompaniment_path = Path(prepared_accompaniment_value).resolve() if prepared_accompaniment_value else None
    if prepared_vocal_path and prepared_vocal_path.is_file() and prepared_accompaniment_path and prepared_accompaniment_path.is_file():
        emit_progress("transcribing", "Reusing the separated vocal track to re-slice sentence clips locally", 18)
        vocal_path = output_dir / "vocal.wav"
        accompaniment_path = output_dir / "accompaniment.wav"
        with ProgressHeartbeat("transcribing", "Preparing the existing vocal track for sentence re-slicing", 24):
            run_ffmpeg(request, ["-i", str(prepared_vocal_path), "-ac", "1", "-ar", "32000", str(vocal_path)])
        with ProgressHeartbeat("transcribing", "Preparing the existing accompaniment track locally", 26):
            run_ffmpeg(request, ["-i", str(prepared_accompaniment_path), "-ac", "1", "-ar", "32000", str(accompaniment_path)])
    else:
        emit_progress(
            "separating",
            "Separating the spoken vocal from background music on %s" % separation_device_label(runtime_state),
            18,
        )
        separation_source_path = source_path
        if trim_applied:
            separation_source_path = output_dir / "selected-source.wav"
            trim_args = []
            if trim_start > 0:
                trim_args.extend(["-ss", str(trim_start)])
            if trim_end is not None and trim_end > trim_start:
                trim_args.extend(["-t", str(trim_end - trim_start)])
            with ProgressHeartbeat("separating", "Applying the selected source range before vocal separation", 16):
                run_ffmpeg(request, [*trim_args, "-i", str(source_path), "-ac", "1", "-ar", "32000", str(separation_source_path)])
        vocal_path, accompaniment_path = isolate_vocals(request, separation_source_path, output_dir)
    emit_progress("transcribing", "Reviewing speech and sentence boundaries locally", 58)
    asr_segments = transcribe(
        request,
        vocal_path,
        language,
        heartbeat=("transcribing", "Reviewing speech and sentence boundaries locally", 62),
    )
    result_segments = []
    sentence_candidates = assemble_sentence_candidates(asr_segments, language, maximum_duration)
    candidate_count = max(1, len(sentence_candidates))
    for index, candidate in enumerate(sentence_candidates):
        start = candidate["start"]
        end = candidate["end"]
        duration = candidate["duration"]
        transcript = candidate["transcript"]
        speech_confidence = candidate["speechConfidence"]
        transcript_confidence = candidate["transcriptConfidence"]
        boundary, boundary_confidence = sentence_boundary(transcript, candidate["startBoundaryConfirmed"])
        reasons = []
        if not transcript:
            reasons.append("no_speech_detected")
        if duration < minimum_duration:
            reasons.append("clip_too_short")
        if duration > maximum_duration:
            reasons.append("sentence_too_long")
        if speech_confidence < minimum_speech:
            reasons.append("speech_confidence_low")
        if transcript_confidence < minimum_transcript:
            reasons.append("transcript_confidence_low")
        if not candidate["startBoundaryConfirmed"]:
            reasons.append("uncertain_sentence_start")
        if boundary_confidence < minimum_boundary:
            reasons.append("uncertain_sentence_boundary")
        if "no_speech_detected" in reasons:
            verdict = "rejected"
        elif reasons:
            verdict = "needs-review"
        else:
            verdict = "eligible"
        audio_path = ""
        if duration > 0:
            clip_path = clips_dir / ("%03d.wav" % (index + 1))
            review_progress = 72 + int(round(18 * ((index + 1) / candidate_count)))
            with ProgressHeartbeat(
                "review",
                "Exporting reviewed voice clip %d of %d locally" % (index + 1, candidate_count),
                review_progress,
            ):
                run_ffmpeg(request, ["-ss", str(start), "-to", str(end), "-i", str(vocal_path), "-ac", "1", "-ar", "32000", str(clip_path)])
            audio_path = str(clip_path)
        result_segments.append({
            "id": "clip-%03d" % (index + 1),
            "index": index,
            "audioPath": audio_path,
            "startSeconds": round(start, 3),
            "endSeconds": round(end, 3),
            "durationSeconds": duration,
            "transcript": transcript,
            "transcriptLanguage": language if language in {"zh", "en", "ja"} else "",
            "speechConfidence": speech_confidence,
            "transcriptConfidence": transcript_confidence,
            "boundary": boundary,
            "boundaryConfidence": round(boundary_confidence, 3),
            "qualityVerdict": verdict,
            "exclusionReasons": reasons,
            "resliced": bool(candidate.get("resliced")),
            "includeInTraining": verdict == "eligible",
            "preferredPrompt": False,
        })
    if not result_segments:
        result_segments.append({
            "id": "clip-001",
            "index": 0,
            "audioPath": "",
            "startSeconds": 0,
            "endSeconds": 0,
            "durationSeconds": 0,
            "transcript": "",
            "transcriptLanguage": language if language in {"zh", "en", "ja"} else "",
            "speechConfidence": 0,
            "transcriptConfidence": 0,
            "boundary": "uncertain",
            "boundaryConfidence": 0,
            "qualityVerdict": "rejected",
            "exclusionReasons": ["no_speech_detected"],
            "includeInTraining": False,
            "preferredPrompt": False,
        })
    emit_progress("review", "Prepared clips are ready for review", 92)
    return {
        "vocalPath": str(vocal_path),
        "accompanimentPath": str(accompaniment_path),
        "segments": result_segments,
        "runtime": {
            "engine": ENGINE_ID,
            "modelVersion": MODEL_VERSION,
            "separation": "demucs-htdemucs",
            "asr": "faster-whisper-%s" % str(request.get("asrModel") or DEFAULT_ASR_MODEL),
            "device": runtime_state["device"],
            "gpuAvailable": runtime_state["gpuAvailable"],
            "gpuName": runtime_state["gpuName"],
            "torchVersion": runtime_state["torchVersion"],
            "asrDevice": runtime_state["asrDevice"],
            "sourceTrimApplied": trim_applied,
            "sourceTrimStartSeconds": trim_start if trim_applied else 0,
            "sourceTrimEndSeconds": trim_end if trim_applied else None,
        },
        "warnings": [],
    }


def load_pcm_mono(audio_path):
    import numpy as np

    with wave.open(str(audio_path), "rb") as reader:
        channels = reader.getnchannels()
        width = reader.getsampwidth()
        sample_rate = reader.getframerate()
        frames = reader.readframes(reader.getnframes())
    if width == 2:
        values = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        values = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError("Voice integrity checks require a PCM WAV output.")
    if channels > 1:
        values = values[: len(values) - (len(values) % channels)].reshape(-1, channels).mean(axis=1)
    return values, sample_rate


def write_pcm_mono(audio_path, samples, sample_rate):
    import numpy as np

    target = Path(audio_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -0.98, 0.98)
    pcm = np.round(clipped * 32767.0).astype("<i2")
    with wave.open(str(target), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(int(sample_rate))
        writer.writeframes(pcm.tobytes())


def waveform_health(audio_path):
    import numpy as np

    samples, sample_rate = load_pcm_mono(audio_path)
    if len(samples) < sample_rate // 2:
        return {
            "activity": 0.0,
            "lineHumRatio": 1.0,
            "lineHumFrequencyHz": 0,
            "modulationScore": 1.0,
            "maxLocalModulationScore": 1.0,
            "persistentModulationSeconds": 0.0,
            "persistentModulationDetected": False,
            "highFrequencyRatio": 1.0,
            "highToPresenceRatio": 1.0,
            "electronicRoughnessDetected": True,
        }
    # 50 ms envelopes avoid manufacturing a 10 Hz amplitude wobble from
    # common 100/120 Hz vocal fundamentals while still resolving the 4-12 Hz
    # instability band used by the integrity contract.
    frame_size = max(128, int(sample_rate * 0.05))
    usable = len(samples) - (len(samples) % frame_size)
    frames = samples[:usable].reshape(-1, frame_size)
    envelope = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    voiced = envelope > max(0.008, float(np.median(envelope)) * 0.55)
    activity = float(np.mean(voiced))
    voiced_frames = frames[voiced]
    if len(voiced_frames):
        spectral_window = np.hanning(frame_size)
        voiced_spectrum = np.sum(np.abs(np.fft.rfft(voiced_frames * spectral_window, axis=1)) ** 2, axis=0)
        voiced_frequencies = np.fft.rfftfreq(frame_size, 1.0 / sample_rate)
        total_speech_band = (voiced_frequencies >= 80) & (voiced_frequencies < min(16000, sample_rate / 2))
        high_band = (voiced_frequencies >= 8000) & (voiced_frequencies < min(16000, sample_rate / 2))
        presence_band = (voiced_frequencies >= 1000) & (voiced_frequencies < 8000)
        total_speech_energy = float(np.sum(voiced_spectrum[total_speech_band])) + 1e-12
        presence_energy = float(np.sum(voiced_spectrum[presence_band])) + 1e-12
        high_frequency_ratio = float(np.sum(voiced_spectrum[high_band]) / total_speech_energy)
        high_to_presence_ratio = float(np.sum(voiced_spectrum[high_band]) / presence_energy)
    else:
        high_frequency_ratio = 1.0
        high_to_presence_ratio = 1.0
    # Electronic TTS fizz presents as a sustained 8-16 kHz shelf that is both
    # material in the total voiced spectrum and stronger than the 1-8 kHz
    # speech-presence region. Natural sibilants can trip either condition in
    # isolation, so both must be present before the refinement gate rejects it.
    # The 0.55 presence ratio separates the two confirmed degraded outputs
    # (0.5721/0.6741) from the current profile reference (about 0.44).
    electronic_roughness_detected = high_frequency_ratio > 0.08 and high_to_presence_ratio > 0.55
    window = samples[: min(len(samples), sample_rate * 12)]
    spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window)))) ** 2
    frequencies = np.fft.rfftfreq(len(window), 1.0 / sample_rate)
    low_band = (frequencies >= 20) & (frequencies <= 300)
    total_low = float(np.sum(spectrum[low_band])) + 1e-12
    line_ratio = 0.0
    line_frequency = 0
    # Count a first harmonic only after its 50/60 Hz fundamental is actually
    # detected. Otherwise ordinary 100/120 Hz vocal fundamentals would be
    # misclassified as electrical hum.
    for fundamental_hz in (50, 60):
        fundamental_band = np.abs(frequencies - fundamental_hz) <= 1.5
        harmonic_band = np.abs(frequencies - (fundamental_hz * 2)) <= 1.5
        neighbourhood = (frequencies >= fundamental_hz - 4) & (frequencies <= fundamental_hz + 4)
        fundamental_energy = float(np.sum(spectrum[fundamental_band]))
        neighbourhood_energy = float(np.sum(spectrum[neighbourhood])) + 1e-12
        fundamental_ratio = fundamental_energy / total_low
        tonal_dominance = fundamental_energy / neighbourhood_energy
        if fundamental_ratio < 0.015 or tonal_dominance < 0.55:
            continue
        candidate_ratio = float((fundamental_energy + np.sum(spectrum[harmonic_band])) / total_low)
        if candidate_ratio > line_ratio:
            line_ratio = candidate_ratio
            line_frequency = fundamental_hz
    envelope_rate = sample_rate / frame_size
    centered = envelope - float(np.mean(envelope))
    envelope_spectrum = np.abs(np.fft.rfft(centered * np.hanning(len(centered)))) ** 2
    envelope_frequencies = np.fft.rfftfreq(len(centered), 1.0 / envelope_rate)
    tremble_band = (envelope_frequencies >= 4) & (envelope_frequencies <= 12)
    envelope_band = (envelope_frequencies >= 1) & (envelope_frequencies <= 20)
    envelope_band_energy = float(np.sum(envelope_spectrum[envelope_band]))
    # A constant envelope has only floating-point residue after centering. Do
    # not turn that numerical noise into a misleading 4-12 Hz ratio.
    minimum_modulation_energy = max(1e-12, len(envelope) * (float(np.mean(envelope)) ** 2) * 1e-10)
    modulation_score = (
        float(np.sum(envelope_spectrum[tremble_band]) / envelope_band_energy)
        if envelope_band_energy > minimum_modulation_energy
        else 0.0
    )
    window_frames = max(1, int(1.2 * envelope_rate))
    # Mark only modulation windows that contain mostly voiced frames. The
    # duration below is a contiguous qualified speech span, not the count of
    # overlapping analysis windows (which under-reported a 1.2 s tremble as a
    # single 20 ms frame in the old implementation).
    unstable_spans = np.zeros(len(envelope), dtype=bool)
    max_local_modulation_score = 0.0
    for start in range(0, max(1, len(envelope) - window_frames + 1)):
        local = envelope[start:start + window_frames]
        if len(local) < window_frames:
            continue
        local_centered = local - float(np.mean(local))
        local_spectrum = np.abs(np.fft.rfft(local_centered * np.hanning(len(local_centered)))) ** 2
        local_frequencies = np.fft.rfftfreq(len(local_centered), 1.0 / envelope_rate)
        local_tremble = (local_frequencies >= 4) & (local_frequencies <= 12)
        local_band = (local_frequencies >= 1) & (local_frequencies <= 20)
        local_band_energy = float(np.sum(local_spectrum[local_band]))
        minimum_local_energy = max(1e-12, len(local) * (float(np.mean(local)) ** 2) * 1e-10)
        if local_band_energy <= minimum_local_energy:
            continue
        local_score = float(np.sum(local_spectrum[local_tremble]) / local_band_energy)
        local_voiced = voiced[start:start + window_frames]
        if float(np.mean(local_voiced)) >= 0.6:
            max_local_modulation_score = max(max_local_modulation_score, local_score)
            if local_score > 0.45:
                unstable_spans[start:start + window_frames] = True
    longest = 0
    current = 0
    for unstable in unstable_spans:
        if unstable:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    persistent_modulation_seconds = longest / envelope_rate
    return {
        "activity": round(activity, 3),
        "lineHumRatio": round(line_ratio, 3),
        "lineHumFrequencyHz": line_frequency,
        "modulationScore": round(modulation_score, 3),
        "maxLocalModulationScore": round(max_local_modulation_score, 3),
        "persistentModulationSeconds": round(persistent_modulation_seconds, 3),
        "persistentModulationDetected": bool(longest >= window_frames),
        "highFrequencyRatio": round(high_frequency_ratio, 4),
        "highToPresenceRatio": round(high_to_presence_ratio, 4),
        "electronicRoughnessDetected": bool(electronic_roughness_detected),
    }


def analyze_conversion_alignment(request):
    """Return bounded timing metrics without exposing source speech content."""
    import numpy as np

    source_path = Path(str(request.get("sourceAudioPath") or "")).resolve()
    converted_path = Path(str(request.get("convertedAudioPath") or "")).resolve()
    if not source_path.is_file() or not converted_path.is_file():
        raise RuntimeError("Voice conversion alignment needs readable PCM WAV inputs.")
    source, source_rate = load_pcm_mono(source_path)
    converted, converted_rate = load_pcm_mono(converted_path)
    if source_rate != converted_rate:
        raise RuntimeError("Voice conversion alignment inputs must use the same sample rate.")

    def leading_activity_seconds(samples, sample_rate):
        frame_size = max(160, int(sample_rate * 0.02))
        usable = len(samples) - (len(samples) % frame_size)
        if usable < frame_size:
            return 0.0
        frames = samples[:usable].reshape(-1, frame_size)
        envelope = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
        active_level = max(0.006, float(np.percentile(envelope, 75)) * 0.18)
        active = envelope >= active_level
        for index in range(max(1, len(active) - 2)):
            if int(np.sum(active[index:index + 3])) >= 2:
                return round((index * frame_size) / sample_rate, 4)
        return round(len(samples) / sample_rate, 4)

    source_duration = len(source) / source_rate
    converted_duration = len(converted) / converted_rate
    source_lead = leading_activity_seconds(source, source_rate)
    converted_lead = leading_activity_seconds(converted, converted_rate)
    return {
        "sourceDurationSeconds": round(source_duration, 4),
        "convertedDurationSeconds": round(converted_duration, 4),
        "sourceLeadingActivitySeconds": source_lead,
        "convertedLeadingActivitySeconds": converted_lead,
        "onsetLagMs": round((converted_lead - source_lead) * 1000.0, 1),
    }


def percentile(values, quantile):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return 0.0
    position = max(0.0, min(1.0, float(quantile))) * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def waveform_modulation_baseline(reference_health=None, baseline_healths=None):
    baseline_scores = []
    for baseline in baseline_healths or []:
        if not isinstance(baseline, dict) or safe_number(baseline.get("activity"), 0.0, 0.0, 1.0) < 0.2:
            continue
        score = safe_number(baseline.get("modulationScore"), 0.0, 0.0, 1.0)
        if score < 0.72:
            baseline_scores.append(score)
    if len(baseline_scores) >= 5:
        # Amplitude envelopes contain the speaker's real syllable rhythm. Use
        # a robust upper percentile from several trusted training clips rather
        # than treating one short prompt as the speaker's entire range. Values
        # at or above the strict instability boundary cannot teach the gate,
        # and the learned limit itself never crosses that boundary.
        baseline_score = percentile(baseline_scores, 0.90)
        relative_margin = max(0.12, baseline_score * 0.25)
        return {
            "score": baseline_score,
            "limit": min(0.72, baseline_score + relative_margin),
            "count": len(baseline_scores),
            "kind": "training-distribution",
        }
    if not reference_health:
        return {"score": None, "limit": None, "count": 0, "kind": "none"}
    reference_score = safe_number(reference_health.get("modulationScore"), 0.0, 0.0, 1.0)
    if reference_score >= 0.72:
        return {"score": reference_score, "limit": None, "count": 1, "kind": "unusable-reference"}
    relative_margin = max(0.12, reference_score * 0.30)
    return {
        "score": reference_score,
        "limit": min(1.0, reference_score + relative_margin),
        "count": 1,
        "kind": "reference",
    }


def waveform_instability_exceeds_reference(health, reference_health=None, baseline_healths=None):
    if not health.get("persistentModulationDetected"):
        return False, None
    baseline = waveform_modulation_baseline(reference_health, baseline_healths)
    if baseline["kind"] == "none":
        return True, None
    candidate_score = safe_number(health.get("modulationScore"), 0.0, 0.0, 1.0)
    if baseline["limit"] is None:
        return True, None
    return candidate_score > baseline["limit"], round(baseline["limit"], 3)


def repair_synthesis_audio(request, runtime_checked=False):
    if not runtime_checked:
        require_runtime(request)
    input_path = Path(str(request.get("audioPath") or "")).resolve()
    output_path = Path(str(request.get("outputPath") or "")).resolve()
    if not input_path.is_file() or not str(request.get("outputPath") or "").strip():
        raise RuntimeError("Voice remediation needs readable input and output WAV paths.")
    health = waveform_health(input_path)
    samples, sample_rate = load_pcm_mono(input_path)
    # DC removal is deliberately narrow: subtract only the scalar offset.
    cleaned = samples - float(samples.mean())
    applied_filters = ["dc_offset"]
    fundamental_hz = int(health.get("lineHumFrequencyHz") or 0)
    if fundamental_hz in {50, 60}:
        import numpy as np

        spectrum = np.fft.rfft(cleaned)
        frequencies = np.fft.rfftfreq(len(cleaned), 1.0 / sample_rate)
        for frequency in (fundamental_hz, fundamental_hz * 2):
            spectrum[np.abs(frequencies - frequency) <= 1.5] *= 0.1
            applied_filters.append(f"notch_{frequency}hz")
        cleaned = np.fft.irfft(spectrum, n=len(cleaned)).astype("float32")
    write_pcm_mono(output_path, cleaned, sample_rate)
    return {
        "outputPath": str(output_path),
        "appliedFilters": applied_filters,
        "lineHumFrequencyHz": fundamental_hz,
    }


def repair_synthesis_batch(request):
    require_runtime(request)
    candidates = request.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("Voice remediation needs at least one generated clause.")
    if len(candidates) > 80:
        raise RuntimeError("Voice remediation received too many generated clauses.")
    results = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise RuntimeError("Voice remediation received an invalid generated clause.")
        result = repair_synthesis_audio(candidate, runtime_checked=True)
        result["id"] = clean_text(candidate.get("id") or str(index + 1))
        results.append(result)
    return {"results": results}


def validate_synthesis(request, model=None, emit=True, runtime_checked=False):
    if not runtime_checked:
        require_runtime(request)
    output_path = Path(str(request.get("audioPath") or "")).resolve()
    if not output_path.is_file():
        raise RuntimeError("Generated speech was not available for integrity validation.")
    expected = normalize_text(request.get("expectedText"))
    language = str(request.get("language") or "auto").strip().lower()
    has_cjk = bool(re.search(r"[\u3400-\u9fff\u3040-\u30ff]", expected))
    has_latin = bool(re.search(r"[A-Za-z]", expected))
    # Keep the selected profile language for both independent ASR passes.
    # Automatic detection tends to turn short Chinese/Latin mixtures into an
    # unstable third language choice, which lowers the independent secondary
    # score even when the spoken content is correct.
    asr_language = language
    if emit:
        emit_progress("integrity", "Checking requested speech coverage and waveform health", 86)
    repeated_case = bool(re.search(r"(.)\1{2,}", re.sub(r"[^\w\u3400-\u9fff\u3040-\u30ff]+", "", expected)))
    observed_segments = transcribe(request, output_path, asr_language, model=model, vad_filter=not repeated_case)
    observed = " ".join(normalize_text(getattr(segment, "text", "")) for segment in observed_segments).strip()
    debug_asr = os.environ.get("MAGIC_BOX_VOICE_DEBUG_ASR", "0") == "1"
    secondary_result = None
    if secondary_asr_enabled(request):
        try:
            secondary_model = load_secondary_asr_model(request)
            secondary_segments = transcribe(
                request,
                output_path,
                asr_language,
                model=secondary_model,
                vad_filter=not repeated_case,
            )
            secondary_observed = " ".join(normalize_text(getattr(segment, "text", "")) for segment in secondary_segments).strip()
            secondary_metrics = transcript_coverage(expected, secondary_observed, language)
            secondary_result = {
                "available": True,
                "coverage": round(secondary_metrics["coverage"], 3),
                "rawCoverage": round(secondary_metrics["rawCoverage"], 3),
                "expectedTokenCount": secondary_metrics["expectedTokenCount"],
                "observedTokenCount": secondary_metrics["observedTokenCount"],
                "model": "faster-whisper-large-v3-turbo",
                "device": "cpu",
            }
            if debug_asr:
                secondary_result["debugObservedText"] = secondary_observed[:1000]
        except Exception as error:
            secondary_result = {
                "available": False,
                "error": clean_text(str(error))[:240],
                "model": "faster-whisper-large-v3-turbo",
            }
    expected_tokens = tokenise(expected)
    observed_tokens = tokenise(observed)
    unprompted_coverage = ordered_token_coverage(expected_tokens, observed_tokens)
    compact_expected_tokens, expressive_repetition_normalized = collapse_expressive_repetitions(expected_tokens)
    compact_observed_tokens, _ = collapse_expressive_repetitions(observed_tokens)
    expressive_coverage = ordered_token_coverage(compact_expected_tokens, compact_observed_tokens)
    coverage = max(unprompted_coverage, expressive_coverage) if expressive_repetition_normalized else unprompted_coverage
    phonetic_coverage = None
    expected_count = len(expected_tokens)
    observed_count = len(observed_tokens)
    if language == "zh":
        expected_phonetic_options = chinese_phonetic_options(expected)
        observed_phonetic_options = chinese_phonetic_options(observed)
        expected_count = len(expected_phonetic_options)
        observed_count = len(observed_phonetic_options)
    if language == "zh" and unprompted_coverage < 0.92:
        phonetic_coverage = ordered_option_coverage(
            expected_phonetic_options,
            observed_phonetic_options,
        )
        compact_expected_phonetics, phonetic_repetition_normalized = collapse_expressive_repetitions(expected_phonetic_options)
        compact_observed_phonetics, _ = collapse_expressive_repetitions(observed_phonetic_options)
        expressive_phonetic_coverage = ordered_option_coverage(
            compact_expected_phonetics,
            compact_observed_phonetics,
        )
        expressive_repetition_normalized = expressive_repetition_normalized or phonetic_repetition_normalized
        coverage = max(
            coverage,
            phonetic_coverage,
            expressive_phonetic_coverage if phonetic_repetition_normalized else 0.0,
        )
    health = waveform_health(output_path)
    reference_health = request.get("_referenceWaveformHealth") if isinstance(request.get("_referenceWaveformHealth"), dict) else None
    reference_path_value = str(request.get("referenceAudioPath") or "").strip()
    if reference_path_value and reference_health is None:
        reference_path = Path(reference_path_value).resolve()
        if reference_path.is_file():
            reference_health = cached_waveform_health(reference_path)
    baseline_healths = request.get("_baselineWaveformHealths") if isinstance(request.get("_baselineWaveformHealths"), list) else []
    modulation_baseline = waveform_modulation_baseline(reference_health, baseline_healths)
    unstable, relative_modulation_limit = waveform_instability_exceeds_reference(health, reference_health, baseline_healths)
    if reference_health:
        health["referenceModulationScore"] = reference_health.get("modulationScore", 0.0)
    if modulation_baseline["kind"] != "none":
        health["modulationBaselineKind"] = modulation_baseline["kind"]
        health["modulationBaselineCount"] = modulation_baseline["count"]
        health["modulationBaselineScore"] = round(modulation_baseline["score"], 3) if modulation_baseline["score"] is not None else None
        health["relativeModulationLimit"] = relative_modulation_limit
        health["exceedsModulationBaseline"] = unstable
        health["exceedsReferenceModulation"] = unstable
        health["referenceBaselineUsable"] = modulation_baseline["limit"] is not None
    reasons = []
    if coverage < 0.92:
        reasons.append("ordered_text_coverage_low")
    if not observed_token_count_is_bounded(expected_count, observed_count):
        reasons.append("unexpected_text_excess")
    if health["activity"] < 0.2:
        reasons.append("speech_activity_low")
    if health["lineHumRatio"] > 0.25:
        reasons.append("line_hum_detected")
    # A qualifying local span is authoritative. A long stable passage can
    # dilute the whole-file spectrum, but must not let a sustained 4-12 Hz
    # wobble in otherwise voiced speech pass the integrity gate.
    if unstable:
        reasons.append("unstable_amplitude_detected")
    if request.get("settings", {}).get("enforceSpectralQuality") is True and health.get("electronicRoughnessDetected"):
        reasons.append("electronic_roughness_detected")
    result = {
        "accepted": not reasons,
        "coverage": round(coverage, 3),
        "expectedTokenCount": expected_count,
        "observedTokenCount": observed_count,
        "waveformHealth": health,
        "reason": reasons[0] if reasons else "",
        "reasons": reasons,
    }
    secondary_authoritative = bool(
        secondary_result is not None
        and secondary_result.get("available") is True
        and float(secondary_result.get("coverage") or 0) >= 0.92
        and observed_token_count_is_bounded(
            int(secondary_result.get("expectedTokenCount") or 0),
            int(secondary_result.get("observedTokenCount") or 0),
        )
        and coverage < 0.92
    )
    if secondary_authoritative:
        # The small primary model can under-transcribe an otherwise complete
        # cloned voice, especially for expressive Chinese and mixed-script
        # text. Keep its raw evidence visible, but let the independent large
        # ASR decide content after it passes the same hard coverage and token
        # bounds. Genuine omissions still fail both recognizers.
        result["primaryAsrRawCoverage"] = round(coverage, 3)
        result["primaryAsrRawExpectedTokenCount"] = expected_count
        result["primaryAsrRawObservedTokenCount"] = observed_count
        result["secondaryAsrAuthoritative"] = True
        if has_cjk and has_latin:
            result["mixedScriptSecondaryAuthoritative"] = True
        result["coverage"] = secondary_result["coverage"]
        result["expectedTokenCount"] = secondary_result["expectedTokenCount"]
        result["observedTokenCount"] = secondary_result["observedTokenCount"]
        result["reasons"] = [reason for reason in result["reasons"] if reason not in {
            "ordered_text_coverage_low",
            "unexpected_text_excess",
        }]
        result["accepted"] = not result["reasons"]
        result["reason"] = result["reasons"][0] if result["reasons"] else ""
    if debug_asr:
        result["debugObservedText"] = observed[:1000]
    if phonetic_coverage is not None:
        result["unpromptedCoverage"] = round(unprompted_coverage, 3)
        result["phoneticCoverage"] = round(phonetic_coverage, 3)
        result["chineseOrthographyNormalized"] = phonetic_coverage >= 0.92
    if expressive_repetition_normalized:
        result["expressiveRepetitionNormalized"] = True
        result["expressiveCoverage"] = round(coverage, 3)
    if secondary_result is not None:
        result["secondaryAsr"] = secondary_result
        repeated_case = bool(re.search(r"(.)\1{2,}", re.sub(r"[^\w\u3400-\u9fff\u3040-\u30ff]+", "", expected)))
        bounded_expected = max(1, expected_count)
        primary_count_complete = observed_count >= bounded_expected and observed_token_count_is_bounded(bounded_expected, observed_count)
        secondary_count = int(secondary_result.get("observedTokenCount") or 0)
        secondary_expected = int(secondary_result.get("expectedTokenCount") or bounded_expected)
        secondary_count_complete = secondary_count >= secondary_expected and observed_token_count_is_bounded(secondary_expected, secondary_count)
        result["forcedAlignmentPass"] = bool(
            repeated_case
            and secondary_result.get("available") is True
            and coverage >= 0.99
            and secondary_result.get("coverage", 0) >= 0.99
            and primary_count_complete
            and secondary_count_complete
        )
    return result


def validate_synthesis_waveform(request, runtime_checked=False):
    if not runtime_checked:
        require_runtime(request)
    output_path = Path(str(request.get("audioPath") or "")).resolve()
    if not output_path.is_file():
        raise RuntimeError("Generated speech was not available for waveform validation.")
    expected = normalize_text(request.get("expectedText"))
    language = str(request.get("language") or "auto").strip().lower()
    expected_count = len(chinese_phonetic_options(expected)) if language == "zh" else len(tokenise(expected))
    health = waveform_health(output_path)
    reference_health = request.get("_referenceWaveformHealth") if isinstance(request.get("_referenceWaveformHealth"), dict) else None
    reference_path_value = str(request.get("referenceAudioPath") or "").strip()
    if reference_path_value and reference_health is None:
        reference_path = Path(reference_path_value).resolve()
        if reference_path.is_file():
            reference_health = cached_waveform_health(reference_path)
    baseline_healths = request.get("_baselineWaveformHealths") if isinstance(request.get("_baselineWaveformHealths"), list) else []
    modulation_baseline = waveform_modulation_baseline(reference_health, baseline_healths)
    unstable, relative_modulation_limit = waveform_instability_exceeds_reference(health, reference_health, baseline_healths)
    if reference_health:
        health["referenceModulationScore"] = reference_health.get("modulationScore", 0.0)
    if modulation_baseline["kind"] != "none":
        health["modulationBaselineKind"] = modulation_baseline["kind"]
        health["modulationBaselineCount"] = modulation_baseline["count"]
        health["modulationBaselineScore"] = round(modulation_baseline["score"], 3) if modulation_baseline["score"] is not None else None
        health["relativeModulationLimit"] = relative_modulation_limit
        health["exceedsModulationBaseline"] = unstable
        health["exceedsReferenceModulation"] = unstable
        health["referenceBaselineUsable"] = modulation_baseline["limit"] is not None
    reasons = []
    if health["activity"] < 0.2:
        reasons.append("speech_activity_low")
    if health["lineHumRatio"] > 0.25:
        reasons.append("line_hum_detected")
    if unstable:
        reasons.append("unstable_amplitude_detected")
    return {
        "accepted": not reasons,
        "coverage": 1.0,
        "expectedTokenCount": expected_count,
        "observedTokenCount": expected_count,
        "waveformHealth": health,
        "reason": reasons[0] if reasons else "",
        "reasons": reasons,
        "fastConversationValidation": True,
    }


def validate_synthesis_waveform_batch(request):
    require_runtime(request)
    candidates = request.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("Voice waveform validation needs at least one generated clause.")
    if len(candidates) > 80:
        raise RuntimeError("Voice waveform validation received too many generated clauses.")
    results = []
    reference_health_cache = {}
    baseline_health_cache = {}
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise RuntimeError("Voice waveform validation received an invalid generated clause.")
        candidate_request = dict(request)
        candidate_request.update(candidate)
        reference_path_value = str(candidate_request.get("referenceAudioPath") or "").strip()
        if reference_path_value:
            reference_path = Path(reference_path_value).resolve()
            reference_key = str(reference_path).casefold()
            if reference_key not in reference_health_cache:
                reference_health_cache[reference_key] = cached_waveform_health(reference_path)
            if reference_health_cache[reference_key] is not None:
                candidate_request["_referenceWaveformHealth"] = reference_health_cache[reference_key]
        baseline_healths = []
        for baseline_path_value in (candidate_request.get("baselineAudioPaths") or [])[:64]:
            baseline_path_text = str(baseline_path_value or "").strip()
            if not baseline_path_text:
                continue
            baseline_path = Path(baseline_path_text).resolve()
            baseline_key = str(baseline_path).casefold()
            if baseline_key not in baseline_health_cache:
                baseline_health_cache[baseline_key] = cached_waveform_health(baseline_path)
            if baseline_health_cache[baseline_key] is not None:
                baseline_healths.append(baseline_health_cache[baseline_key])
        if baseline_healths:
            candidate_request["_baselineWaveformHealths"] = baseline_healths
        result = validate_synthesis_waveform(candidate_request, runtime_checked=True)
        result["id"] = clean_text(candidate.get("id") or str(index + 1))
        results.append(result)
    return {"results": results}


def validate_synthesis_batch(request):
    require_runtime(request)
    candidates = request.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("Voice integrity validation needs at least one generated clause.")
    if len(candidates) > 80:
        raise RuntimeError("Voice integrity validation received too many generated clauses.")
    emit_progress("integrity", "Checking generated clauses for full speech coverage and waveform health", 78)
    model = load_asr_model(request)
    results = []
    reference_health_cache = {}
    baseline_health_cache = {}
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise RuntimeError("Voice integrity validation received an invalid generated clause.")
        candidate_request = dict(request)
        candidate_request.update(candidate)
        reference_path_value = str(candidate_request.get("referenceAudioPath") or "").strip()
        if reference_path_value:
            reference_path = Path(reference_path_value).resolve()
            reference_key = str(reference_path).casefold()
            if reference_key not in reference_health_cache:
                reference_health_cache[reference_key] = cached_waveform_health(reference_path)
            if reference_health_cache[reference_key] is not None:
                candidate_request["_referenceWaveformHealth"] = reference_health_cache[reference_key]
        baseline_healths = []
        baseline_paths = candidate_request.get("baselineAudioPaths") or []
        if isinstance(baseline_paths, list):
            for baseline_path_value in baseline_paths[:64]:
                baseline_path_text = str(baseline_path_value or "").strip()
                if not baseline_path_text:
                    continue
                baseline_path = Path(baseline_path_text).resolve()
                baseline_key = str(baseline_path).casefold()
                if baseline_key not in baseline_health_cache:
                    baseline_health_cache[baseline_key] = cached_waveform_health(baseline_path)
                if baseline_health_cache[baseline_key] is not None:
                    baseline_healths.append(baseline_health_cache[baseline_key])
        if baseline_healths:
            candidate_request["_baselineWaveformHealths"] = baseline_healths
        result = validate_synthesis(candidate_request, model=model, emit=False, runtime_checked=True)
        result["id"] = clean_text(candidate.get("id") or str(index + 1))
        results.append(result)
    return {"results": results}


def validate_conversion_batch(request):
    """Compare converted speech with a private ASR transcript of its source.

    The transcript never leaves this worker; callers receive only coverage,
    waveform metrics and token counts. This lets VTV fail closed when a voice
    conversion changes words even though the user did not supply a transcript.
    """
    require_runtime(request)
    source_path = Path(str(request.get("sourceAudioPath") or "")).resolve()
    if not source_path.is_file():
        raise RuntimeError("Voice conversion validation needs readable source audio.")
    candidates = request.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("Voice conversion validation needs at least one candidate.")
    if len(candidates) > 12:
        raise RuntimeError("Voice conversion validation received too many candidates.")
    language = str(request.get("language") or "auto").strip().lower()
    emit_progress("integrity", "Comparing converted speech with the private source transcript", 88)
    model = load_asr_model(request)
    source_segments = transcribe(request, source_path, language, model=model)
    expected = " ".join(normalize_text(getattr(segment, "text", "")) for segment in source_segments).strip()
    if not expected or not tokenise(expected):
        raise RuntimeError("Voice conversion source speech could not be transcribed locally.")
    results = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise RuntimeError("Voice conversion validation received an invalid candidate.")
        candidate_request = dict(request)
        candidate_request.update(candidate)
        candidate_request["expectedText"] = expected
        result = validate_synthesis(candidate_request, model=model, emit=False, runtime_checked=True)
        result["id"] = clean_text(candidate.get("id") or str(index + 1))
        results.append(result)
    source_token_count = len(chinese_phonetic_options(expected)) if language == "zh" else len(tokenise(expected))
    return {
        "sourceTranscriptTokenCount": source_token_count,
        "results": results,
    }


def unique_clause_word_span(words, expected):
    """Find a unique complete phrase; never infer boundaries from duration ratios."""
    expected_tokens = tokenise(expected)
    tokens, owners = [], []
    for index, word in enumerate(words):
        values = tokenise(word["text"])
        tokens.extend(values)
        owners.extend([index] * len(values))
    matches = [index for index in range(len(tokens) - len(expected_tokens) + 1)
               if expected_tokens and tokens[index:index + len(expected_tokens)] == expected_tokens]
    if len(matches) != 1:
        raise RuntimeError("Clause text does not have one unambiguous ASR span.")
    first, last = matches[0], matches[0] + len(expected_tokens) - 1
    # A word timestamp cannot safely split a word spanning two clauses.
    if (first and owners[first - 1] == owners[first]) or (last + 1 < len(owners) and owners[last + 1] == owners[last]):
        raise RuntimeError("Clause boundary falls inside an ASR word.")
    return float(words[owners[first]]["start"]), float(words[owners[last]]["end"])


def quiet_clause_boundary(audio, rate, anchor, edge):
    import numpy as np
    duration = len(audio) / rate
    if not math.isfinite(anchor) or anchor < 0 or anchor > duration + 0.05:
        raise RuntimeError("Invalid clause timestamp.")
    if (edge == "start" and anchor <= 0.04) or (edge == "end" and duration - anchor <= 0.04):
        return 0 if edge == "start" else len(audio)
    frame = max(1, round(rate * 0.01))
    rms = np.array([np.sqrt(np.mean(audio[i:i + frame] ** 2)) for i in range(0, len(audio), frame)])
    threshold = max(0.001, float(np.percentile(rms, 90)) * 0.035)
    quiet = rms <= threshold
    spans, start = [], None
    for index, value in enumerate(list(quiet) + [False]):
        if value and start is None:
            start = index
        elif not value and start is not None:
            end = index
            if end - start >= 4:
                lower = max(start * frame / rate, anchor - 0.24)
                upper = min(end * frame / rate, anchor + 0.24)
                if upper - lower >= 0.04:
                    spans.append((lower + upper) / 2)
            start = None
    if not spans:
        raise RuntimeError("No verified silence near the clause boundary; refusing to cut speech.")
    return min(len(audio), round(min(spans, key=lambda value: abs(value - anchor)) * rate))


def trim_synthesis_clause_batch(request):
    """Turn padded diagnostic slices into independent, revalidated recovery clips."""
    import numpy as np
    import wave
    candidates = request.get("candidates") or []
    if not 1 <= len(candidates) <= 80:
        raise RuntimeError("Invalid clause trim batch.")
    model = load_secondary_asr_model(request)
    results = []
    for candidate in candidates:
        result = {"id": candidate.get("id"), "accepted": False}
        try:
            source = Path(candidate["audioPath"]).resolve()
            destination = Path(candidate["outputPath"]).resolve()
            if source == destination:
                raise RuntimeError("Clause trim must preserve the source file.")
            with wave.open(str(source), "rb") as reader:
                if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
                    raise RuntimeError("Clause trim requires mono PCM16 audio.")
                rate = reader.getframerate()
                samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype="<i2").copy()
            segments, _ = model.transcribe(str(source), language=request.get("language") if request.get("language") in {"zh", "en", "ja"} else None,
                                          vad_filter=False, word_timestamps=True, condition_on_previous_text=False, beam_size=5)
            words = [{"text": word.word, "start": word.start, "end": word.end} for segment in segments for word in (segment.words or [])]
            first, last = unique_clause_word_span(words, candidate["expectedText"])
            audio = samples.astype(np.float64) / 32768
            start = quiet_clause_boundary(audio, rate, first, "start")
            end = quiet_clause_boundary(audio, rate, last, "end")
            if end - start < rate * 0.15:
                raise RuntimeError("Aligned clause is empty or too short.")
            cropped = audio[start:end].copy()
            # Five milliseconds entirely inside the verified boundary silence.
            fade = min(round(rate * 0.005), len(cropped) // 2)
            if start and fade:
                cropped[:fade] *= np.linspace(0, 1, fade)
            if end < len(audio) and fade:
                cropped[-fade:] *= np.linspace(1, 0, fade)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(destination), "wb") as writer:
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(rate)
                writer.writeframes(np.rint(cropped * 32768).clip(-32768, 32767).astype("<i2").tobytes())
            result.update(accepted=True, outputPath=str(destination), startSeconds=start / rate, endSeconds=end / rate,
                          boundaryStrategy="silence-aligned-converted-clause")
        except Exception as error:
            result["reason"] = clean_text(str(error))[:240]
        results.append(result)
    return {"results": results}


def handle_request(request):
    action = str(request.get("action") or "")
    if action == "health":
        state = dependency_state(request)
        return {
            "engine": ENGINE_ID,
            "modelVersion": MODEL_VERSION,
            "installed": state["modelsReady"],
            **state,
        }
    if action == "warm-asr":
        return warm_asr(request)
    if action == "warm-waveform":
        return warm_waveform(request)
    if action == "prepare-profile-source":
        return prepare_source(request)
    if action == "validate-synthesis":
        return validate_synthesis(request)
    if action == "validate-synthesis-batch":
        return validate_synthesis_batch(request)
    if action == "validate-synthesis-waveform-batch":
        return validate_synthesis_waveform_batch(request)
    if action == "validate-conversion-batch":
        return validate_conversion_batch(request)
    if action == "analyze-conversion-alignment":
        return analyze_conversion_alignment(request)
    if action == "repair-synthesis-batch":
        return repair_synthesis_batch(request)
    if action == "trim-synthesis-clause-batch":
        return trim_synthesis_clause_batch(request)
    if action == "cancel":
        return {"cancelled": True}
    raise RuntimeError("Unsupported Voice Preparation action.")


def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = handle_request(request)
            respond(request.get("id"), True, result=result)
        except Exception as error:
            respond(request.get("id") if isinstance(request, dict) else "", False, error=str(error))


if __name__ == "__main__":
    main()
