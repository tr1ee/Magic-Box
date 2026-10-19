import json
import math
import os
import re
import queue
import subprocess
import sys
import tempfile
import threading
import time
import wave
import copy
import contextlib
from collections import deque
from pathlib import Path


ENGINE_ID = "gpt-sovits-local"
MODEL_VERSION = "gpt-sovits-managed-v1"
_nltk_pos_fallback_used = False


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


def json_text(value, **kwargs):
    return json.dumps(clean_payload(value), ensure_ascii=True, **kwargs)


def respond(request_id, ok, result=None, error=None):
    payload = {"id": clean_text(request_id), "ok": ok}
    if ok:
        payload["result"] = clean_payload(result or {})
    else:
        payload["error"] = clean_text(error or "GPT-SoVITS worker failed.")
    sys.stdout.write(json_text(payload) + "\n")
    sys.stdout.flush()


def emit_progress(stage, message, progress, extra=None):
    payload = {
        "event": "progress",
        "stage": clean_text(stage),
        "message": clean_text(message),
        "progress": int(max(0, min(100, progress))),
    }
    if isinstance(extra, dict):
        payload.update(clean_payload(extra))
    sys.stdout.write(json_text(payload) + "\n")
    sys.stdout.flush()


def configure_environment(model_dir):
    model_root = Path(model_dir)
    cache_root = model_root / "cache"
    os.environ.setdefault("HF_HOME", str(cache_root / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(cache_root / "huggingface" / "hub"))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(cache_root / "huggingface" / "transformers"))
    os.environ.setdefault("TORCH_HOME", str(cache_root / "torch"))
    os.environ.setdefault("MPLCONFIGDIR", str(cache_root / "matplotlib"))
    os.environ.setdefault("NLTK_DATA", str(cache_root / "nltk_data"))
    os.environ.setdefault("NUMBA_CACHE_DIR", str(cache_root / "numba"))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    for value in ["HF_HOME", "HF_HUB_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME", "MPLCONFIGDIR", "NLTK_DATA", "NUMBA_CACHE_DIR"]:
        Path(os.environ[value]).mkdir(parents=True, exist_ok=True)


def normalized_language(value, fallback="zh"):
    key = str(value or fallback or "zh").strip().lower()
    if key in {"zh", "en", "ja"}:
        return key
    return fallback if fallback in {"zh", "en", "ja"} else "zh"


def gpt_language(value):
    key = normalized_language(value)
    return {
        "zh": "zh",
        "en": "en",
        "ja": "ja",
    }[key]


def repo_dir(model_dir):
    env_repo = os.environ.get("MAGIC_BOX_GPT_SOVITS_REPO")
    candidates = [
        Path(env_repo) if env_repo else None,
        Path(__file__).resolve().parent / "GPT-SoVITS",
        Path(model_dir) / "GPT-SoVITS",
        Path(model_dir).parent / "runtime" / "GPT-SoVITS",
    ]
    for candidate in candidates:
        if candidate and (candidate / "api_v2.py").is_file():
            return candidate
    raise RuntimeError("GPT-SoVITS runtime repo is missing. Run Voice Clone Model Setup for GPT-SoVITS.")


def tts_config_path(root):
    candidates = [
        root / "GPT_SoVITS" / "configs" / "tts_infer.yaml",
        root / "configs" / "tts_infer.yaml",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("GPT-SoVITS tts_infer.yaml was not found in the managed runtime.")


def required_model_paths(root):
    return [
        root / "GPT_SoVITS" / "pretrained_models" / "chinese-roberta-wwm-ext-large",
        root / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base",
        root
        / "GPT_SoVITS"
        / "pretrained_models"
        / "gsv-v2final-pretrained"
        / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
        root / "GPT_SoVITS" / "pretrained_models" / "gsv-v2final-pretrained" / "s2G2333k.pth",
        root / "GPT_SoVITS" / "text" / "G2PWModel",
    ]


def missing_model_paths(root):
    return [str(path) for path in required_model_paths(root) if not path.exists()]


def configure_repo_paths(root):
    gpt_package_root = root / "GPT_SoVITS"
    for candidate in [str(gpt_package_root), str(root)]:
        if candidate not in sys.path:
            sys.path.insert(0, candidate)
    (root / "GPT_SoVITS" / "pretrained_models" / "fast_langdetect").mkdir(parents=True, exist_ok=True)
    os.chdir(root)


def install_nltk_pos_tag_fallback(nltk_module):
    original_pos_tag = getattr(nltk_module, "pos_tag", None)
    if not callable(original_pos_tag) or getattr(original_pos_tag, "_magicbox_nltk_fallback", False):
        return False

    def safe_pos_tag(tokens, *args, **kwargs):
        global _nltk_pos_fallback_used
        try:
            return original_pos_tag(tokens, *args, **kwargs)
        except LookupError:
            _nltk_pos_fallback_used = True
            return [(token, "NN") for token in tokens]

    safe_pos_tag._magicbox_nltk_fallback = True
    safe_pos_tag._magicbox_original_pos_tag = original_pos_tag
    nltk_module.pos_tag = safe_pos_tag
    return True


def install_dependency_fallbacks():
    try:
        import jieba
        import jieba.posseg

        sys.modules.setdefault("jieba_fast", jieba)
        sys.modules.setdefault("jieba_fast.posseg", jieba.posseg)
    except Exception:
        pass
    try:
        import nltk

        nltk_data_dir = os.environ.get("NLTK_DATA")
        if nltk_data_dir and nltk_data_dir not in nltk.data.path:
            nltk.data.path.insert(0, nltk_data_dir)
        install_nltk_pos_tag_fallback(nltk)
    except Exception:
        pass


def ensure_subprocess_shims(model_dir):
    shim_root = Path(model_dir) / "cache" / "python_shims"
    jieba_fast_dir = shim_root / "jieba_fast"
    jieba_fast_dir.mkdir(parents=True, exist_ok=True)
    (jieba_fast_dir / "__init__.py").write_text(
        "from jieba import *\n",
        encoding="utf-8",
    )
    (jieba_fast_dir / "posseg.py").write_text(
        "from jieba.posseg import *\n",
        encoding="utf-8",
    )
    (jieba_fast_dir / "analyse.py").write_text(
        "from jieba.analyse import *\n",
        encoding="utf-8",
    )
    return shim_root


def configure_language_detector():
    try:
        import fast_langdetect

        fast_langdetect.infer._default_detector.config.model = "lite"
    except Exception:
        pass
    try:
        from split_lang.model import LangSectionType
        from split_lang.split import splitter
        from split_lang.split.utils import contains_ja_kana
        import split_lang.detect_lang.detector as detector

        def local_fast_lang_detect(text):
            value = str(text or "")
            if contains_ja_kana(value):
                return "ja"
            if any("\u4e00" <= char <= "\u9fff" for char in value):
                return "zh"
            if any(("A" <= char <= "Z") or ("a" <= char <= "z") for char in value):
                return "en"
            return "zh"

        def local_detect_lang_combined(text, lang_section_type):
            if lang_section_type is LangSectionType.ZH_JA:
                return "ja" if contains_ja_kana(str(text or "")) else "zh"
            return local_fast_lang_detect(text)

        def local_possible_detection_list(text):
            detected = local_fast_lang_detect(text)
            return [detected, "zh", "ja", "en"]

        detector.fast_lang_detect = local_fast_lang_detect
        detector.detect_lang_combined = local_detect_lang_combined
        detector.possible_detection_list = local_possible_detection_list
        splitter.detect_lang_combined = local_detect_lang_combined
        splitter.possible_detection_list = local_possible_detection_list
    except Exception:
        pass


def safe_int(value, default, minimum=None, maximum=None):
    try:
        number = int(value)
    except Exception:
        number = int(default)
    if minimum is not None:
        number = max(int(minimum), number)
    if maximum is not None:
        number = min(int(maximum), number)
    return number


def safe_exp_name(value):
    text = clean_text(value or "magicbox-profile").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    text = text.strip("._-")
    return (text or "magicbox-profile")[:80]


def training_uses_cuda():
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def torch_hardware_state():
    try:
        import torch

        cuda_available = bool(torch.cuda.is_available())
        total_memory = torch.cuda.get_device_properties(0).total_memory if cuda_available else 0
        return {
            "torchVersion": str(torch.__version__),
            "cudaVersion": str(torch.version.cuda or ""),
            "cudaAvailable": cuda_available,
            "device": "cuda" if cuda_available else "cpu",
            "gpuName": torch.cuda.get_device_name(0) if cuda_available else "",
            "gpuMemoryGB": round(total_memory / (1024 ** 3), 2) if total_memory else 0,
        }
    except Exception:
        return {
            "torchVersion": "",
            "cudaVersion": "",
            "cudaAvailable": False,
            "device": "cpu",
            "gpuName": "",
            "gpuMemoryGB": 0,
        }


def recommended_training_batch_size(cuda_available):
    if not cuda_available:
        return 2
    memory_gb = float(torch_hardware_state().get("gpuMemoryGB") or 0)
    return max(1, min(8, int(memory_gb // 2) or 1))


def mixed_precision_enabled(settings, cuda_available):
    if not cuda_available:
        return False
    if "half" in settings:
        return bool(settings.get("half"))
    env_value = os.environ.get("MAGIC_BOX_GPT_SOVITS_HALF")
    if env_value is not None and env_value != "":
        return env_value.lower() == "true"
    return True


def newest_file(directory, patterns):
    root = Path(directory)
    candidates = []
    for pattern in patterns:
        candidates.extend(path for path in root.glob(pattern) if path.is_file())
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def gpt_checkpoint_epoch(path):
    match = re.search(r"(?:^|[-_])e(?:poch)?[=_-]?(\d+)(?:[-_]|$)", Path(path).stem, flags=re.IGNORECASE)
    return int(match.group(1)) if match else 0


def gpt_checkpoint_calibration(language):
    key = normalized_language(language)
    if key == "en":
        return "Hello, today we are checking whether this cloned voice finishes naturally."
    if key == "ja":
        return "こんにちは、今日はクローン音声が自然に最後まで話せるか確認します。"
    return "你好，今天我们来测试优化后的克隆声音。"


def expected_speech_duration(text, language):
    key = normalized_language(language)
    if key == "en":
        units = len(re.findall(r"[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*", text))
        duration = units / 2.6
    else:
        units = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]", text))
        duration = units / (4.0 if key == "ja" else 3.5)
    pauses = len(re.findall(r"[,.;:!?\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a]", text)) * 0.25
    return max(2.0, min(12.0, duration + pauses))


def validate_gpt_checkpoint(request, profile_model, gpt_weights, sovits_weights, source, output_path):
    language = normalized_language(profile_model.get("language"), profile_model.get("promptLanguage") or "zh")
    calibration_text = gpt_checkpoint_calibration(language)
    target_duration = expected_speech_duration(calibration_text, language)
    record = {
        "path": str(gpt_weights),
        "source": source,
        "durationSeconds": 0,
        "targetDurationSeconds": round(target_duration, 3),
        "calibrationText": calibration_text,
        "language": language,
        "probeAudioPath": str(output_path),
        "healthy": False,
        "score": None,
        "error": "",
    }
    try:
        probe_model = {
            **profile_model,
            "gptWeightsPath": str(gpt_weights),
            "sovitsWeightsPath": str(sovits_weights),
        }
        with contextlib.redirect_stdout(sys.stderr):
            result = generate_tts({
                "modelDir": request["modelDir"],
                "text": calibration_text,
                "textLang": language,
                "promptLang": profile_model.get("promptLanguage") or language,
                "promptText": profile_model.get("promptText"),
                "refAudioPath": profile_model.get("referenceAudioPath"),
                "profileLanguage": language,
                "voiceModel": probe_model,
                "outputPath": str(output_path),
                "settings": {
                    "seed": 1234,
                    "topK": 15,
                    "topP": 1.0,
                    "temperature": 1.0,
                    "repetitionPenalty": 1.35,
                    "batchSize": 1,
                    "speed": 1.0,
                },
            })
        duration = float(result.get("durationSeconds") or 0)
        ratio = duration / target_duration if target_duration else 0
        record["durationSeconds"] = round(duration, 3)
        record["healthy"] = 0.55 <= ratio <= 1.75
        record["score"] = round(abs(math.log(max(ratio, 0.000001))), 6)
    except Exception as exc:
        record["error"] = clean_text(exc)
    return record


def select_stable_gpt_checkpoint(request, profile_model, gpt_dir, sovits_weights):
    emit_progress("validate-gpt", "Checking trained GPT checkpoints for complete natural speech", 93)
    validations = []
    seen = set()

    def available_candidate(path, source):
        candidate = Path(path) if path else None
        if not candidate or not candidate.is_file():
            return None
        resolved = str(candidate.resolve())
        if resolved.lower() in seen:
            return None
        seen.add(resolved.lower())
        return candidate, source

    new_candidates = []
    for candidate in sorted(Path(gpt_dir).glob("*.ckpt"), key=lambda path: (gpt_checkpoint_epoch(path), path.stat().st_mtime)):
        item = available_candidate(candidate, f"new-e{gpt_checkpoint_epoch(candidate) or 'unknown'}")
        if item:
            new_candidates.append(item)

    validation_dir = Path(request["modelPath"]).parent / "checkpoint-validation"
    validation_dir.mkdir(parents=True, exist_ok=True)
    for index, (candidate, source) in enumerate(new_candidates):
        safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", candidate.stem).strip(".-") or f"new-{index}"
        validations.append(validate_gpt_checkpoint(
            request,
            profile_model,
            candidate,
            sovits_weights,
            source,
            validation_dir / f"{safe_stem}-{index}.wav",
        ))

    healthy_new = [item for item in validations if item["healthy"]]
    if healthy_new:
        selected = min(healthy_new, key=lambda item: (item["score"], -gpt_checkpoint_epoch(item["path"])))
        return Path(selected["path"]), selected, validations

    summary = "; ".join(
        f"{item['source']}: {item['durationSeconds']}s"
        if not item["error"] else f"{item['source']}: {item['error']}"
        for item in validations
    )
    raise RuntimeError(
        "Fine Clone trained checkpoints but none passed the complete-speech validation. "
        f"The existing active profile was preserved. {summary}"
    )


def copy_text_part(part_path, output_path, header=None):
    source = Path(part_path)
    if not source.is_file():
        raise RuntimeError(f"GPT-SoVITS training step did not create {source.name}.")
    text = source.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        raise RuntimeError(f"GPT-SoVITS training step created an empty {source.name}.")
    if header:
        text = f"{header}\n{text}"
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"{clean_text(text)}\n", encoding="utf-8")


def validate_and_filter_prepared_dataset(run_dir):
    phoneme_path = Path(run_dir) / "2-name2text.txt"
    semantic_path = Path(run_dir) / "6-name2semantic.tsv"
    os.environ["version"] = "v2"
    os.environ["hz"] = "25hz"
    from AR.data.dataset import Text2SemanticDataset

    with contextlib.redirect_stdout(sys.stderr):
        prepared = Text2SemanticDataset(
            phoneme_path=str(phoneme_path),
            semantic_path=str(semantic_path),
            max_sec=54,
            pad_val=1024,
        )
    accepted_names = list(dict.fromkeys(prepared.__get_item_names__()))
    accepted = set(accepted_names)
    phoneme_lines = [line for line in phoneme_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    all_names = [line.split("\t", 1)[0] for line in phoneme_lines if "\t" in line]
    rejected_names = [name for name in all_names if name not in accepted]
    if len(accepted) < 3:
        raise RuntimeError("Fine Clone has fewer than 3 usable clips after phoneme/timing validation. Correct transcripts or include more clean sentence clips.")
    phoneme_path.write_text(
        "\n".join(line for line in phoneme_lines if line.split("\t", 1)[0] in accepted) + "\n",
        encoding="utf-8",
    )
    semantic_lines = [line for line in semantic_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    semantic_header = semantic_lines[0] if semantic_lines else "item_name\tsemantic_audio"
    semantic_body = [
        line for line in semantic_lines[1:]
        if line.split("\t", 1)[0] in accepted
    ]
    semantic_path.write_text(f"{semantic_header}\n" + "\n".join(semantic_body) + "\n", encoding="utf-8")
    return {
        "acceptedNames": accepted_names,
        "rejectedNames": rejected_names,
        "acceptedCount": len(accepted),
        "rejectedCount": len(rejected_names),
    }


ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class TrainingProgressObserver:
    def __init__(self, stage, label, total_epochs, progress_start, progress_end, batch_total=0, tensorboard_dir=None):
        self.stage = stage
        self.label = label
        self.total_epochs = max(1, int(total_epochs or 1))
        self.progress_start = int(progress_start)
        self.progress_end = int(progress_end)
        self.batch_total = max(0, int(batch_total or 0))
        self.tensorboard_dir = Path(tensorboard_dir) if tensorboard_dir else None
        self.current_epoch = 1
        self.current_batch = 0
        self.training_started = False
        self.last_advance_at = time.monotonic()
        self.last_emit_at = 0.0

    def _progress(self):
        batch_fraction = (self.current_batch / self.batch_total) if self.batch_total else 0
        completed = max(0, self.current_epoch - 1) + max(0, min(1, batch_fraction))
        ratio = max(0, min(1, completed / self.total_epochs))
        return self.progress_start + round((self.progress_end - self.progress_start) * ratio)

    def _emit(self, force=False):
        now = time.monotonic()
        if not force and now - self.last_emit_at < 1.0:
            return
        self.last_emit_at = now
        idle_seconds = max(0, round(now - self.last_advance_at))
        epoch = max(1, min(self.total_epochs, self.current_epoch))
        batch_text = f" · batch {self.current_batch}/{self.batch_total}" if self.batch_total else ""
        if idle_seconds >= 180:
            message = (
                f"{self.label} · epoch {epoch}/{self.total_epochs}{batch_text} · "
                f"this batch is still computing ({idle_seconds // 60} min without a new batch event)"
            )
            state = "long-running-batch"
        else:
            message = f"{self.label} · epoch {epoch}/{self.total_epochs}{batch_text}"
            state = "running"
        emit_progress(self.stage, message, self._progress(), {
            "trainingProgress": {
                "epoch": epoch,
                "epochs": self.total_epochs,
                "batch": self.current_batch,
                "batches": self.batch_total,
                "state": state,
                "noAdvanceSeconds": idle_seconds,
                "lastAdvanceAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - idle_seconds)),
            }
        })

    def _advance(self, epoch=None, batch=None, batches=None):
        previous = (self.current_epoch, self.current_batch, self.batch_total)
        if epoch is not None:
            self.current_epoch = max(1, min(self.total_epochs, int(epoch)))
        if batches is not None and int(batches) > 0:
            self.batch_total = int(batches)
        if batch is not None:
            self.current_batch = max(0, min(self.batch_total or int(batch), int(batch)))
        if previous != (self.current_epoch, self.current_batch, self.batch_total):
            self.last_advance_at = time.monotonic()
            self._emit()

    def observe(self, line):
        text = ANSI_ESCAPE_RE.sub("", str(line or "")).replace("\r", " ")
        start_match = re.search(r"start training from epoch\s+(\d+)", text, re.I)
        train_epoch_match = re.search(r"Train Epoch:\s*(\d+)", text, re.I)
        completed_epoch_match = re.search(r"====>\s*Epoch:\s*(\d+)", text, re.I)
        rich_match = re.search(r"Epoch\s+(\d+)\s*/\s*(\d+).*?(\d+)\s*/\s*(\d+)", text, re.I)
        if start_match:
            self.training_started = True
            self._advance(epoch=int(start_match.group(1)), batch=0)
        if train_epoch_match:
            self.training_started = True
            self._advance(epoch=int(train_epoch_match.group(1)))
        if rich_match:
            self.training_started = True
            # Lightning displays zero-based epochs (14/14 means epoch 15/15).
            displayed_epoch = min(int(rich_match.group(2)) + 1, int(rich_match.group(1)) + 1)
            self.total_epochs = max(self.total_epochs, int(rich_match.group(2)) + 1)
            self._advance(epoch=displayed_epoch, batch=int(rich_match.group(3)), batches=int(rich_match.group(4)))
        if self.training_started:
            batch_matches = re.findall(r"(?:^|\s)(\d+)\s*/\s*(\d+)(?:\s|\[)", text)
            if batch_matches:
                batch, batches = batch_matches[-1]
                self._advance(batch=int(batch), batches=int(batches))
        if completed_epoch_match:
            completed_epoch = int(completed_epoch_match.group(1))
            self.training_started = True
            self._advance(epoch=completed_epoch, batch=self.batch_total)
            if completed_epoch < self.total_epochs:
                self._advance(epoch=completed_epoch + 1, batch=0)

    def poll_tensorboard(self):
        if not self.tensorboard_dir or not self.tensorboard_dir.exists():
            return
        try:
            event_files = sorted(self.tensorboard_dir.rglob("events.out.tfevents.*"), key=lambda item: item.stat().st_mtime)
            if not event_files:
                return
            from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
            accumulator = EventAccumulator(str(event_files[-1]), size_guidance={"scalars": 20})
            accumulator.Reload()
            epoch_values = accumulator.Scalars("epoch")
            if not epoch_values:
                return
            latest = epoch_values[-1]
            epoch = int(latest.value) + 1
            batch = (int(latest.step) % self.batch_total) + 1 if self.batch_total else 0
            self.training_started = True
            self._advance(epoch=epoch, batch=batch)
        except Exception:
            # Progress telemetry must never make a healthy training process fail.
            return

    def heartbeat(self):
        self.poll_tensorboard()
        self._emit(force=True)


def run_training_command(root, command, env_updates, stage, message, progress, log_dir=None, progress_observer=None):
    emit_progress(stage, message, progress)
    env = os.environ.copy()
    env.update({key: str(value) for key, value in (env_updates or {}).items() if value is not None})
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    ffmpeg_path = env.get("MAGIC_BOX_FFMPEG_PATH")
    if ffmpeg_path:
        ffmpeg_dir = str(Path(ffmpeg_path).parent)
        current_path = env.get("PATH") or ""
        if ffmpeg_dir and ffmpeg_dir not in current_path.split(os.pathsep):
            env["PATH"] = os.pathsep.join([ffmpeg_dir, current_path]) if current_path else ffmpeg_dir
    pythonpath_entries = [str(Path(root) / "GPT_SoVITS"), str(root)]
    if env.get("PYTHONPATH"):
        pythonpath_entries.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(pythonpath_entries)
    log_handle = None
    log_path = None
    if log_dir:
        log_path = Path(log_dir) / f"{stage}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("w", encoding="utf-8", errors="replace")
        log_handle.write(f"$ {' '.join(str(part) for part in command)}\n\n")
        log_handle.flush()
    tail = deque(maxlen=40)
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = subprocess.Popen(
            command,
            cwd=str(root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        if process.stdout:
            output_queue = queue.Queue()
            output_complete = object()

            def read_process_output():
                try:
                    for output_line in process.stdout:
                        output_queue.put(output_line)
                finally:
                    output_queue.put(output_complete)

            reader = threading.Thread(target=read_process_output, name=f"{stage}-log-reader", daemon=True)
            reader.start()
            while True:
                try:
                    line = output_queue.get(timeout=15.0)
                except queue.Empty:
                    if progress_observer:
                        progress_observer.heartbeat()
                    continue
                if line is output_complete:
                    break
                clean_line = clean_text(line)
                tail.append(clean_line.rstrip())
                sys.stderr.write(clean_line)
                sys.stderr.flush()
                if log_handle:
                    log_handle.write(clean_line)
                    log_handle.flush()
                if progress_observer:
                    progress_observer.observe(clean_line)
        code = process.wait()
    finally:
        if log_handle:
            log_handle.close()
    if code != 0:
        tail_text = "\n".join(line for line in tail if line).strip()
        detail = tail_text[-1200:] if tail_text else "No GPT-SoVITS log output was captured."
        location = f" Log: {log_path}" if log_path else ""
        raise RuntimeError(f"{message} failed with exit code {code}.{location}\n{detail}")


def write_sovits_config(root, run_dir, exp_name, settings, cuda_available):
    base_path = root / "GPT_SoVITS" / "configs" / "s2.json"
    data = json.loads(base_path.read_text(encoding="utf-8"))
    train = data.setdefault("train", {})
    model = data.setdefault("model", {})
    data_section = data.setdefault("data", {})
    sovits_dir = Path(run_dir) / "SoVITS_weights_v2"
    s2_log_dir = Path(run_dir) / "logs_s2_v2"
    sovits_dir.mkdir(parents=True, exist_ok=True)
    s2_log_dir.mkdir(parents=True, exist_ok=True)
    (s2_log_dir / "eval").mkdir(parents=True, exist_ok=True)
    pretrained_root = root / "GPT_SoVITS" / "pretrained_models" / "gsv-v2final-pretrained"
    pretrained_g = pretrained_root / "s2G2333k.pth"
    pretrained_d = pretrained_root / "s2D2333k.pth"
    default_batch_size = recommended_training_batch_size(cuda_available)
    train["batch_size"] = safe_int(settings.get("sovitsBatchSize") or settings.get("batchSize") or os.environ.get("MAGIC_BOX_GPT_SOVITS_SOVITS_BATCH_SIZE"), default_batch_size, 1, 32)
    train["epochs"] = safe_int(settings.get("sovitsEpochs") or os.environ.get("MAGIC_BOX_GPT_SOVITS_SOVITS_EPOCHS"), 8, 1, 300)
    train["fp16_run"] = mixed_precision_enabled(settings, cuda_available)
    train["text_low_lr_rate"] = float(settings.get("textLowLrRate") or 0.4)
    train["pretrained_s2G"] = str(pretrained_g)
    train["pretrained_s2D"] = str(pretrained_d) if pretrained_d.is_file() else ""
    train["if_save_latest"] = True
    train["if_save_every_weights"] = True
    train["save_every_epoch"] = max(1, min(train["epochs"], safe_int(settings.get("sovitsSaveEveryEpoch") or 4, 4, 1, 300)))
    train["gpu_numbers"] = str(settings.get("gpuNumbers") or os.environ.get("MAGIC_BOX_GPT_SOVITS_GPU_NUMBERS") or "0")
    train["grad_ckpt"] = False
    model["version"] = "v2"
    data_section["exp_dir"] = str(run_dir)
    data["s2_ckpt_dir"] = str(run_dir)
    data["save_weight_dir"] = str(sovits_dir)
    data["name"] = exp_name
    data["version"] = "v2"
    config_dir = Path(run_dir) / "configs"
    config_path = config_dir / "s2-fine.json"
    semantic_config_path = config_dir / "s2-semantic.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(clean_payload(data), ensure_ascii=False, indent=2), encoding="utf-8")
    semantic_data = copy.deepcopy(data)
    semantic_data.setdefault("model", {}).pop("version", None)
    semantic_config_path.write_text(json.dumps(clean_payload(semantic_data), ensure_ascii=False, indent=2), encoding="utf-8")
    return config_path, semantic_config_path, pretrained_g, sovits_dir, train


def write_gpt_config(root, run_dir, exp_name, settings, cuda_available):
    import yaml

    base_path = root / "GPT_SoVITS" / "configs" / "s1longer-v2.yaml"
    data = yaml.load(base_path.read_text(encoding="utf-8"), Loader=yaml.FullLoader) or {}
    train = data.setdefault("train", {})
    data_section = data.setdefault("data", {})
    gpt_dir = Path(run_dir) / "GPT_weights_v2"
    gpt_log_dir = Path(run_dir) / "logs_s1_v2"
    gpt_dir.mkdir(parents=True, exist_ok=True)
    gpt_log_dir.mkdir(parents=True, exist_ok=True)
    pretrained_gpt = root / "GPT_SoVITS" / "pretrained_models" / "gsv-v2final-pretrained" / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
    default_batch_size = recommended_training_batch_size(cuda_available)
    train["batch_size"] = safe_int(settings.get("gptBatchSize") or settings.get("batchSize") or os.environ.get("MAGIC_BOX_GPT_SOVITS_GPT_BATCH_SIZE"), default_batch_size, 1, 32)
    train["epochs"] = safe_int(settings.get("gptEpochs") or os.environ.get("MAGIC_BOX_GPT_SOVITS_GPT_EPOCHS"), 15, 1, 300)
    train["save_every_n_epoch"] = max(1, min(train["epochs"], safe_int(settings.get("gptSaveEveryEpoch") or 5, 5, 1, 300)))
    train["precision"] = "16-mixed" if mixed_precision_enabled(settings, cuda_available) else "32"
    train["if_save_latest"] = True
    train["if_save_every_weights"] = True
    train["if_dpo"] = False
    train["half_weights_save_dir"] = str(gpt_dir)
    train["exp_name"] = exp_name
    data_section["num_workers"] = safe_int(
        settings.get("numWorkers") or os.environ.get("MAGIC_BOX_GPT_SOVITS_NUM_WORKERS"),
        data_section.get("num_workers") or 1,
        1,
        8,
    )
    data["pretrained_s1"] = str(pretrained_gpt)
    data["train_semantic_path"] = str(Path(run_dir) / "6-name2semantic.tsv")
    data["train_phoneme_path"] = str(Path(run_dir) / "2-name2text.txt")
    data["output_dir"] = str(Path(run_dir) / "logs_s1_v2")
    config_path = Path(run_dir) / "configs" / "s1-fine.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml.safe_dump(clean_payload(data), allow_unicode=True, sort_keys=False), encoding="utf-8")
    return config_path, pretrained_gpt, gpt_dir, train


def run_fine_clone_training(request, profile_model):
    root = repo_dir(request["modelDir"])
    missing_paths = missing_model_paths(root)
    if missing_paths:
        raise RuntimeError("GPT-SoVITS pretrained models are missing: " + "; ".join(missing_paths))
    configure_repo_paths(root)
    install_dependency_fallbacks()
    configure_language_detector()

    dataset_samples = request.get("datasetSamples") or []
    if not dataset_samples:
        raise RuntimeError("Fine Clone needs transcript-ready sentence clips.")
    dataset_list_path = Path(request.get("datasetListPath") or "")
    if not dataset_list_path.is_file():
        raise RuntimeError("Fine Clone training list was not found. Rebuild after adding transcript-ready sentence clips.")

    settings = request.get("settings") or {}
    base_training_dir = Path(request.get("trainingDir") or (Path(request["modelPath"]).parent.parent / "training"))
    exp_name = safe_exp_name(request.get("profileId") or request.get("profileName") or "magicbox-profile")
    run_stamp = time.strftime("%Y%m%d-%H%M%S")
    run_dir = base_training_dir / f"{exp_name}-{run_stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    log_dir = run_dir / "logs"
    shim_dir = ensure_subprocess_shims(request["modelDir"])

    cuda_available = training_uses_cuda()
    hardware = torch_hardware_state()
    use_mixed_precision = mixed_precision_enabled(settings, cuda_available)
    warnings = []
    if len(dataset_samples) < 10:
        warnings.append("Fine Clone is training with fewer than 10 transcript-ready sentence clips. Add more sentence transcripts for a closer voice match.")
    if not cuda_available:
        warnings.append("GPT-SoVITS Fine Clone is running on CPU. Training can take a long time; a CUDA GPU is strongly recommended.")

    s2_config_path, s2_semantic_config_path, pretrained_s2g, sovits_dir, sovits_train = write_sovits_config(root, run_dir, exp_name, settings, cuda_available)
    s1_config_path, pretrained_s1, gpt_dir, gpt_train = write_gpt_config(root, run_dir, exp_name, settings, cuda_available)

    base_env = {
        "inp_text": str(dataset_list_path),
        "inp_wav_dir": "",
        "exp_name": exp_name,
        "i_part": "0",
        "all_parts": "1",
        "opt_dir": str(run_dir),
        "_CUDA_VISIBLE_DEVICES": str(settings.get("gpuNumbers") or os.environ.get("MAGIC_BOX_GPT_SOVITS_GPU_NUMBERS") or "0"),
        "is_half": str(use_mixed_precision),
        "version": "v2",
        "PYTHONPATH": str(shim_dir),
    }
    python = sys.executable
    prepare_dir = root / "GPT_SoVITS" / "prepare_datasets"

    run_training_command(
        root,
        [python, "-s", str(prepare_dir / "1-get-text.py")],
        {
            **base_env,
            "bert_pretrained_dir": str(root / "GPT_SoVITS" / "pretrained_models" / "chinese-roberta-wwm-ext-large"),
        },
        "prepare-text",
        "Preparing GPT-SoVITS text and BERT features",
        38,
        log_dir=log_dir,
    )
    copy_text_part(run_dir / "2-name2text-0.txt", run_dir / "2-name2text.txt")

    run_training_command(
        root,
        [python, "-s", str(prepare_dir / "2-get-hubert-wav32k.py")],
        {
            **base_env,
            "cnhubert_base_dir": str(root / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base"),
        },
        "prepare-hubert",
        "Extracting GPT-SoVITS HuBERT and 32k audio features",
        50,
        log_dir=log_dir,
    )

    run_training_command(
        root,
        [python, "-s", str(prepare_dir / "3-get-semantic.py")],
        {
            **base_env,
            "pretrained_s2G": str(pretrained_s2g),
            "s2config_path": str(s2_semantic_config_path),
        },
        "prepare-semantic",
        "Extracting GPT-SoVITS semantic tokens",
        61,
        log_dir=log_dir,
    )
    copy_text_part(run_dir / "6-name2semantic-0.tsv", run_dir / "6-name2semantic.tsv", header="item_name\tsemantic_audio")
    dataset_validation = validate_and_filter_prepared_dataset(run_dir)
    accepted_names = set(dataset_validation["acceptedNames"])
    accepted_samples = [
        sample for sample in dataset_samples
        if Path(sample.get("audioPath") or "").name in accepted_names
    ]
    profile_model["datasetSamples"] = clean_payload(accepted_samples)
    if dataset_validation["rejectedCount"]:
        warnings.append(
            f"Excluded {dataset_validation['rejectedCount']} transcript clip(s) whose phoneme timing did not match the audio. Review those sentence transcripts before the next Fine Clone."
        )

    run_training_command(
        root,
        [python, "-s", str(root / "GPT_SoVITS" / "s2_train.py"), "--config", str(s2_config_path)],
        {"PYTHONPATH": str(shim_dir)},
        "train-sovits",
        "Training GPT-SoVITS SoVITS acoustic model",
        62,
        log_dir=log_dir,
        progress_observer=TrainingProgressObserver(
            "train-sovits",
            "Training SoVITS acoustic model",
            sovits_train["epochs"],
            62,
            79,
        ),
    )
    sovits_weights = newest_file(sovits_dir, ["*.pth"])
    if not sovits_weights:
        raise RuntimeError("SoVITS training completed but did not produce an inference checkpoint.")

    run_training_command(
        root,
        [python, "-s", str(root / "GPT_SoVITS" / "s1_train.py"), "--config_file", str(s1_config_path)],
        {"hz": "25hz", "_CUDA_VISIBLE_DEVICES": base_env["_CUDA_VISIBLE_DEVICES"], "PYTHONPATH": str(shim_dir)},
        "train-gpt",
        "Training GPT-SoVITS GPT semantic model",
        80,
        log_dir=log_dir,
        progress_observer=TrainingProgressObserver(
            "train-gpt",
            "Training GPT semantic model",
            gpt_train["epochs"],
            80,
            92,
            batch_total=max(1, math.ceil(len(accepted_samples) / max(1, gpt_train["batch_size"]))),
            tensorboard_dir=Path(run_dir) / "logs_s1_v2",
        ),
    )
    newest_gpt_weights = newest_file(gpt_dir, ["*.ckpt"])
    if not newest_gpt_weights:
        raise RuntimeError("GPT training completed but did not produce an inference checkpoint.")

    gpt_weights, gpt_checkpoint_selection, gpt_checkpoint_validation = select_stable_gpt_checkpoint(
        request,
        profile_model,
        gpt_dir,
        sovits_weights,
    )
    selected_gpt_source = gpt_checkpoint_selection["source"]
    if Path(gpt_weights) != Path(newest_gpt_weights):
        warnings.append(
            f"Fine Clone selected {selected_gpt_source} instead of the final GPT epoch because it produced more complete speech in the checkpoint check."
        )

    emit_progress("attach-checkpoints", "Attaching GPT-SoVITS Fine Clone checkpoints", 96)
    profile_model.update({
        "fineTuneDatasetPrepared": True,
        "fineTuneTrainingCompleted": True,
        "fineTuneRunDir": str(run_dir),
        "trainingDir": str(base_training_dir),
        "datasetListPath": str(dataset_list_path),
        "gptWeightsPath": str(gpt_weights),
        "sovitsWeightsPath": str(sovits_weights),
        "s1ConfigPath": str(s1_config_path),
        "s2ConfigPath": str(s2_config_path),
        "s2SemanticConfigPath": str(s2_semantic_config_path),
        "trainingStats": {
            "datasetSampleCount": len(accepted_samples),
            "submittedDatasetSampleCount": len(dataset_samples),
            "rejectedDatasetSampleCount": dataset_validation["rejectedCount"],
            "rejectedDatasetNames": dataset_validation["rejectedNames"],
            "gptEpochs": gpt_train["epochs"],
            "sovitsEpochs": sovits_train["epochs"],
            "gptBatchSize": gpt_train["batch_size"],
            "sovitsBatchSize": sovits_train["batch_size"],
            "cudaAvailable": cuda_available,
            "device": hardware["device"],
            "gpuName": hardware["gpuName"],
            "gpuMemoryGB": hardware["gpuMemoryGB"],
            "torchVersion": hardware["torchVersion"],
            "mixedPrecision": use_mixed_precision,
            "gptCheckpointSelection": clean_payload(gpt_checkpoint_selection),
            "gptCheckpointValidation": clean_payload(gpt_checkpoint_validation),
            "version": "v2",
        },
    })
    return warnings


def load_tts_config(root):
    import yaml

    config_path = tts_config_path(root)
    with config_path.open("r", encoding="utf-8") as handle:
        config = yaml.load(handle, Loader=yaml.FullLoader) or {}
    custom = dict(config.get("v2") or config.get("custom") or {})
    requested_device = os.environ.get("MAGIC_BOX_GPT_SOVITS_DEVICE", "").strip().lower()
    device = requested_device or ("cuda" if training_uses_cuda() else "cpu")
    custom["device"] = device
    custom["is_half"] = False if device == "cpu" else mixed_precision_enabled({}, True)
    custom["version"] = custom.get("version") or "v2"
    config["custom"] = custom
    return config


def write_wav(path, sample_rate, audio):
    import numpy as np

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    data = np.asarray(audio)
    if data.dtype != np.int16:
        if data.dtype.kind == "f":
            data = np.clip(data, -1.0, 1.0)
            data = (data * 32767).astype(np.int16)
        else:
            data = data.astype(np.int16)
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(1 if data.ndim == 1 else data.shape[1])
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(data.tobytes())


def wav_duration(path):
    with wave.open(str(path), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate() or 1
        return frames / rate


def split_tts_sentences(text, soft_boundaries=False, max_units=0):
    normalized = re.sub(r"\r\n?", "\n", clean_text(text)).strip()
    if not normalized:
        return []
    boundary_pattern = r"(?<=[。！？!?；;，,：:])|\n+" if soft_boundaries else r"(?<=[。！？!?；;])|\n+"
    raw_parts = [
        part.strip()
        for part in re.split(boundary_pattern, normalized)
        if part and part.strip()
    ]
    sentences = []
    pending = ""

    def joined(left, right):
        separator = " " if (
            left
            and right
            and re.search(r"[A-Za-z0-9][.!?;]?$", left)
            and re.match(r"[A-Za-z0-9]", right)
        ) else ""
        return f"{left}{separator}{right}"

    for part in raw_parts:
        units = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]", part))
        if units < 4:
            pending = joined(pending, part)
            continue
        sentences.append(joined(pending, part) if pending else part)
        pending = ""
    if pending:
        if sentences:
            sentences[-1] = joined(sentences[-1], pending)
        else:
            sentences.append(pending)

    # GPT-SoVITS can emit only a breath or a clipped syllable for very short
    # standalone phrases. Keep natural punctuation, but pair sub-six-character
    # clauses with a neighbour so a single short exclamation cannot fail the
    # whole generation job after otherwise healthy synthesis.
    safe_sentences = []
    pending = ""
    for sentence in sentences:
        candidate = joined(pending, sentence) if pending else sentence
        units = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]", candidate))
        if units < 6:
            pending = candidate
            continue
        safe_sentences.append(candidate)
        pending = ""
    if pending:
        if safe_sentences:
            safe_sentences[-1] = joined(safe_sentences[-1], pending)
        else:
            safe_sentences.append(pending)
    result = safe_sentences or sentences or [normalized]
    if max_units <= 0:
        return result

    capped = []
    for sentence in result:
        units = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]", sentence))
        if units <= max_units or not re.search(r"[\u3400-\u9fff\u3040-\u30ff]", sentence):
            capped.append(sentence)
            continue
        unit_positions = [
            index
            for index, character in enumerate(sentence)
            if re.match(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]", character)
        ]
        chunk_count = int(math.ceil(len(unit_positions) / max_units))
        base_size, extra = divmod(len(unit_positions), chunk_count)
        unit_sizes = [base_size + (1 if index < extra else 0) for index in range(chunk_count)]
        start = 0
        consumed_units = 0
        for chunk_index, chunk_units in enumerate(unit_sizes):
            consumed_units += chunk_units
            if chunk_index == len(unit_sizes) - 1:
                end = len(sentence)
            else:
                end = unit_positions[consumed_units - 1] + 1
                while end < len(sentence) and end not in unit_positions:
                    end += 1
            capped.append(sentence[start:end])
            start = end
    return capped or result


STYLE_PRESETS = {
    "neutral": {"speed": 0.0, "pitch": 0.0, "temperature": 0.0, "gain": 1.0},
    "calm": {"speed": -0.07, "pitch": -0.2, "temperature": -0.08, "gain": 0.92},
    "excited": {"speed": 0.11, "pitch": 0.8, "temperature": 0.12, "gain": 1.08},
    "happy": {"speed": 0.06, "pitch": 0.5, "temperature": 0.08, "gain": 1.04},
    "sad": {"speed": -0.10, "pitch": -0.6, "temperature": -0.10, "gain": 0.84},
    "angry": {"speed": 0.07, "pitch": -0.25, "temperature": 0.14, "gain": 1.12},
    "whisper": {"speed": -0.12, "pitch": -0.3, "temperature": -0.05, "gain": 0.66},
    "serious": {"speed": -0.05, "pitch": -0.4, "temperature": -0.06, "gain": 0.96},
}


def resolved_pitch_semitones(settings):
    pitch_value = settings.get("pitchSemitones")
    if pitch_value is None:
        pitch_value = settings.get("pitch")
    return max(-12.0, min(12.0, float(pitch_value if pitch_value is not None else 0.0)))


def styled_tts_settings(settings, style):
    next_settings = dict(settings or {})
    normalized_style = clean_text(style or "neutral").strip().lower()
    preset = STYLE_PRESETS.get(normalized_style, STYLE_PRESETS["neutral"])
    strength = max(0.0, min(1.0, float(next_settings.get("styleStrength", 0.7))))
    base_speed = max(0.6, min(1.5, float(next_settings.get("speed") or 1.0)))
    base_temperature = max(0.2, min(1.5, float(next_settings.get("temperature") or 0.85)))
    # Large post-synthesis pitch shifts damage consonants and can turn a clear
    # Chinese render into a low-coverage ASR result. Keep this control in the
    # range proven to preserve words; speed, sampling and gain carry most of
    # the emotion while Seed-VC preserves the resulting performance contour.
    base_pitch = max(-1.5, min(1.5, float(next_settings.get("pitch") or 0.0)))
    next_settings.update({
        "speed": max(0.6, min(1.5, base_speed + preset["speed"] * strength)),
        "temperature": max(0.2, min(1.5, base_temperature + preset["temperature"] * strength)),
        "pitchSemitones": max(-1.5, min(1.5, base_pitch + preset["pitch"] * strength)),
        "outputGain": max(0.45, min(1.25, 1.0 + (preset["gain"] - 1.0) * strength)),
        "voiceStyle": normalized_style,
        "styleStrength": strength,
    })
    return next_settings


def prepare_tts_sentence(text, language):
    sentence = clean_text(text).strip()
    if not sentence:
        return ""
    if sentence[0] not in "，,。.!！?？；;、：:":
        sentence = ("," if normalized_language(language) == "en" else "，") + sentence
    return sentence


def tts_inference_voice_model(model_dir, voice_model, text, settings):
    # A monolingual fine-tuned semantic checkpoint can mispronounce embedded
    # English repeatedly. On the last content retry use the installed original
    # multilingual GPT, retaining the profile's acoustic model and reference.
    mixed_script = bool(re.search(r"[\u3400-\u9fff\u3040-\u30ff]", text) and re.search(r"[A-Za-z]", text))
    if not (settings.get("recoverMultilingualSemantics") is True
            and int(settings.get("integrityAttempt") or 1) >= 3 and mixed_script):
        return voice_model, "profile"
    original_gpt = repo_dir(model_dir) / "GPT_SoVITS" / "pretrained_models" / "gsv-v2final-pretrained" / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
    if not original_gpt.is_file():
        raise RuntimeError("Multilingual speech recovery requires the installed pretrained GPT checkpoint.")
    return {**voice_model, "gptWeightsPath": str(original_gpt)}, "multilingual-semantic-recovery"


def mixed_language_recovery_parts(sentence, language, settings):
    if not (settings.get("recoverMultilingualSemantics") is True
            and int(settings.get("integrityAttempt") or 1) >= 3
            and re.search(r"[\u3400-\u9fff\u3040-\u30ff]", sentence) and re.search(r"[A-Za-z]", sentence)):
        return [(sentence, language)]
    parts = []
    for part in re.split(r"([A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z][A-Za-z0-9'’-]*)*)", sentence):
        if not part.strip():
            continue
        if not re.search(r"[\w\u3400-\u9fff\u3040-\u30ff]", part):
            if parts:
                previous, previous_language = parts[-1]
                parts[-1] = (previous + part, previous_language)
            continue
        parts.append((part, "en" if re.search(r"[A-Za-z]", part) else language))
    return parts


def tts_audio_activity(audio, sample_rate, text):
    import numpy as np

    data = np.asarray(audio)
    if not data.size or not sample_rate:
        return {
            "usable": False,
            "durationSeconds": 0.0,
            "voicedSeconds": 0.0,
            "requiredVoicedSeconds": 0.0,
            "rmsLevel": 0.0,
        }
    if data.ndim > 1:
        data = np.mean(data.astype(np.float32), axis=1)
    elif data.dtype.kind in {"i", "u"}:
        max_value = float(max(abs(np.iinfo(data.dtype).min), np.iinfo(data.dtype).max))
        data = data.astype(np.float32) / max_value
    else:
        data = data.astype(np.float32)
    data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    rms_level = float(np.sqrt(np.mean(np.square(data)))) if data.size else 0.0
    window_size = max(1, int(int(sample_rate) * 0.02))
    padded_size = int(math.ceil(data.size / window_size) * window_size)
    if padded_size > data.size:
        data = np.pad(data, (0, padded_size - data.size))
    windows = data.reshape(-1, window_size)
    rms = np.sqrt(np.mean(np.square(windows), axis=1))
    voice_threshold = max(0.0015, min(0.015, peak * 0.05))
    voiced_seconds = float(np.count_nonzero(rms >= voice_threshold) * window_size / int(sample_rate))
    units = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]", clean_text(text)))
    # This is only a fast non-silence gate. Full transcript coverage is
    # verified by the outer local ASR validator, so short conversational
    # clauses must not be rejected merely for being shorter than 220 ms.
    required_voiced_seconds = min(2.5, max(0.12, units * 0.055))
    duration_seconds = float(np.asarray(audio).shape[0] / int(sample_rate))
    return {
        "usable": peak >= 0.02 and rms_level >= 0.005 and voiced_seconds >= required_voiced_seconds,
        "durationSeconds": round(duration_seconds, 3),
        "voicedSeconds": round(voiced_seconds, 3),
        "requiredVoicedSeconds": round(required_voiced_seconds, 3),
        "rmsLevel": round(rms_level, 5),
    }


_pipeline = None
_pipeline_root = None
_pipeline_voice_key = None


def load_pipeline(model_dir, voice_model=None):
    global _pipeline, _pipeline_root, _pipeline_voice_key
    root = repo_dir(model_dir)
    missing_paths = missing_model_paths(root)
    if missing_paths:
        raise RuntimeError("GPT-SoVITS pretrained models are missing: " + "; ".join(missing_paths))
    if _pipeline is None or _pipeline_root != root:
        configure_repo_paths(root)
        install_dependency_fallbacks()
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        configure_language_detector()
        config = TTS_Config(load_tts_config(root))
        _pipeline = TTS(config)
        _pipeline_root = root
        _pipeline_voice_key = None
    voice_model = voice_model or {}
    gpt_weights = voice_model.get("gptWeightsPath") or voice_model.get("gpt_weights_path")
    sovits_weights = voice_model.get("sovitsWeightsPath") or voice_model.get("sovits_weights_path")
    voice_key = (str(gpt_weights or ""), str(sovits_weights or ""))
    if voice_key != _pipeline_voice_key:
        if gpt_weights and Path(gpt_weights).is_file() and hasattr(_pipeline, "init_t2s_weights"):
            _pipeline.init_t2s_weights(str(gpt_weights))
        if sovits_weights and Path(sovits_weights).is_file() and hasattr(_pipeline, "init_vits_weights"):
            _pipeline.init_vits_weights(str(sovits_weights))
        _pipeline_voice_key = voice_key
    return _pipeline


def warm_profile(request):
    load_pipeline(request["modelDir"], request.get("voiceModel") or {})
    return {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "warmed": True,
    }


def build_profile(request):
    reference_audio = Path(request["referenceAudioPath"])
    prompt_text = clean_text(request.get("promptText")).strip()
    prompt_language = normalized_language(request.get("promptLanguage"), request.get("language") or "zh")
    if not reference_audio.is_file():
        raise RuntimeError("GPT-SoVITS prompt audio was not found.")
    if not prompt_text:
        raise RuntimeError("GPT-SoVITS requires prompt text/transcript for the reference audio.")

    model_path = Path(request["modelPath"])
    model_path.parent.mkdir(parents=True, exist_ok=True)
    profile_model = {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "profileId": clean_text(request.get("profileId")),
        "profileName": clean_text(request.get("profileName")),
        "language": clean_text(request.get("language")),
        "qualityMode": clean_text(request.get("qualityMode") or "quick"),
        "referenceAudioPath": str(reference_audio),
        "promptText": prompt_text,
        "promptLanguage": prompt_language,
        "datasetSamples": clean_payload(request.get("datasetSamples") or []),
        "modelPath": str(model_path),
    }
    warnings = []
    if profile_model["qualityMode"] == "fine":
        warnings.extend(run_fine_clone_training(request, profile_model))
    model_path.write_text(json_text(profile_model, indent=2), encoding="utf-8")
    return {"profileModel": profile_model, "warnings": warnings}


def generate_tts(request):
    text = clean_text(request.get("text")).strip()
    prompt_text = clean_text(request.get("promptText") or request.get("voiceModel", {}).get("promptText")).strip()
    ref_audio = request.get("refAudioPath") or request.get("voiceModel", {}).get("referenceAudioPath")
    text_lang = normalized_language(request.get("textLang") or request.get("language"), request.get("profileLanguage") or "zh")
    prompt_lang = normalized_language(request.get("promptLang") or request.get("voiceModel", {}).get("promptLanguage"), request.get("profileLanguage") or text_lang)
    if not text:
        raise RuntimeError("No text was provided.")
    if not prompt_text or not ref_audio:
        raise RuntimeError("GPT-SoVITS requires prompt text and prompt audio.")
    output_path = Path(request["outputPath"])
    settings = request.get("settings") or {}
    inference_voice_model, semantic_strategy = tts_inference_voice_model(
        request["modelDir"], request.get("voiceModel") or {}, text, settings)
    pipeline = load_pipeline(request["modelDir"], inference_voice_model)
    speed = float(settings.get("speed") or 1.0)
    speed = max(0.6, min(1.5, speed))
    infer_request = {
        "text": text,
        "text_lang": gpt_language(text_lang),
        "ref_audio_path": str(ref_audio),
        "prompt_text": prompt_text,
        "prompt_lang": gpt_language(prompt_lang),
        "top_k": int(settings.get("topK") or 15),
        "top_p": float(settings.get("topP") or 1.0),
        "temperature": float(settings.get("temperature") or 1.0),
        "text_split_method": settings.get("textSplitMethod") or "cut0",
        "batch_size": int(settings.get("batchSize") or 1),
        "speed_factor": speed,
        "streaming_mode": False,
        "seed": int(settings.get("seed") or -1),
        "parallel_infer": True,
        "repetition_penalty": float(settings.get("repetitionPenalty") or 1.35),
        "media_type": "wav",
    }
    with tempfile.TemporaryDirectory(prefix="magicbox-gpt-sovits-") as temp_dir:
        temp_output = Path(temp_dir) / "output.wav"
        import numpy as np

        sentence_safe = settings.get("sentenceSafeSynthesis") is not False
        integrity_attempt = max(1, int(settings.get("integrityAttempt") or 1))
        sentences = split_tts_sentences(
            text,
            soft_boundaries=sentence_safe and integrity_attempt >= 2,
            max_units=18 if sentence_safe and integrity_attempt >= 3 else 0,
        ) if sentence_safe else [text]
        sentence_plan = [part for sentence in sentences for part in mixed_language_recovery_parts(sentence, text_lang, settings)]
        sample_rate = None
        audio_parts = []
        segment_diagnostics = []
        retry_count = 0
        max_attempts = max(1, min(4, int(settings.get("sentenceMaxAttempts") or 3)))
        for sentence_index, (sentence, sentence_language) in enumerate(sentence_plan):
            prepared_sentence = prepare_tts_sentence(sentence, sentence_language) if sentence_safe else sentence
            accepted_audio = None
            accepted_activity = None
            for attempt in range(max_attempts):
                sentence_request = {
                    **infer_request,
                    "text": prepared_sentence,
                    "text_lang": gpt_language(sentence_language),
                    "text_split_method": "cut0" if sentence_safe else infer_request["text_split_method"],
                }
                if sentence_request["seed"] >= 0 and attempt:
                    sentence_request["seed"] += attempt
                sentence_parts = []
                sentence_rate = None
                for chunk in pipeline.run(sentence_request):
                    if not chunk:
                        continue
                    chunk_rate, chunk_audio = chunk
                    if sentence_rate is None:
                        sentence_rate = int(chunk_rate)
                    elif int(chunk_rate) != sentence_rate:
                        raise RuntimeError("GPT-SoVITS returned mixed sample rates for one script segment.")
                    chunk_data = np.asarray(chunk_audio)
                    if chunk_data.size:
                        sentence_parts.append(chunk_data)
                if not sentence_parts or not sentence_rate:
                    activity = {
                        "usable": False,
                        "durationSeconds": 0.0,
                        "voicedSeconds": 0.0,
                        "requiredVoicedSeconds": 0.0,
                        "rmsLevel": 0.0,
                    }
                else:
                    sentence_audio = np.concatenate(sentence_parts)
                    activity = tts_audio_activity(sentence_audio, sentence_rate, sentence)
                    if activity["usable"]:
                        accepted_audio = sentence_audio
                        accepted_activity = activity
                        if sample_rate is None:
                            sample_rate = sentence_rate
                        elif sentence_rate != sample_rate:
                            raise RuntimeError("GPT-SoVITS returned mixed sample rates for one script.")
                        retry_count += attempt
                        break
                accepted_activity = activity
            if accepted_audio is None:
                raise RuntimeError(
                    f"GPT-SoVITS produced silent or incomplete audio for clause {sentence_index + 1} "
                    f"after {max_attempts} attempts."
                )
            audio_parts.append(accepted_audio)
            segment_diagnostics.append({
                "index": sentence_index + 1,
                "text": sentence,
                "language": sentence_language,
                "attempts": attempt + 1,
                "durationSeconds": accepted_activity["durationSeconds"],
                "voicedSeconds": accepted_activity["voicedSeconds"],
                "rmsLevel": accepted_activity["rmsLevel"],
            })
        if not audio_parts or not sample_rate:
            raise RuntimeError("GPT-SoVITS produced no audio.")
        audio = np.concatenate(audio_parts)
        if audio.dtype.kind in {"i", "u"}:
            max_value = float(max(abs(np.iinfo(audio.dtype).min), np.iinfo(audio.dtype).max))
            audio = audio.astype(np.float32) / max_value
        else:
            audio = audio.astype(np.float32, copy=False)
        pitch_semitones = resolved_pitch_semitones(settings)
        if abs(pitch_semitones) >= 0.05:
            import librosa

            audio = librosa.effects.pitch_shift(audio, sr=sample_rate, n_steps=pitch_semitones).astype(np.float32, copy=False)
        output_gain = max(0.45, min(1.25, float(settings.get("outputGain") or 1.0)))
        if abs(output_gain - 1.0) >= 0.001:
            audio = np.clip(audio * output_gain, -0.98, 0.98)
        write_wav(temp_output, sample_rate, audio)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(temp_output.read_bytes())
    warnings = []
    if retry_count:
        warnings.append(f"GPT-SoVITS retried {retry_count} incomplete clause generation(s).")
    if _nltk_pos_fallback_used:
        warnings.append(
            "English POS tagger data was unavailable, so GPT-SoVITS used the offline noun-tag fallback. "
            "Run Model Setup to install averaged_perceptron_tagger_eng for the best English homograph pronunciation."
        )
    return {
        "outputPath": str(output_path),
        "durationSeconds": wav_duration(output_path),
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "language": text_lang,
        "sentenceCount": len(sentence_plan),
        "retryCount": retry_count,
        "segmentDiagnostics": segment_diagnostics,
        "appliedStyle": clean_text(settings.get("voiceStyle") or "neutral"),
        "appliedStyleStrength": round(float(settings.get("styleStrength") or 0.0), 3),
        "appliedPitchSemitones": round(pitch_semitones, 3),
        "recoverySplit": "hard-capped" if integrity_attempt >= 3 else "soft-punctuation" if integrity_attempt >= 2 else "sentence",
        "semanticStrategy": semantic_strategy,
        "warnings": warnings,
    }


def generate_tts_batch(request):
    clauses = request.get("clauses") or []
    if not isinstance(clauses, list) or not clauses:
        raise RuntimeError("GPT-SoVITS clause synthesis needs at least one text clause.")
    if len(clauses) > 80:
        raise RuntimeError("GPT-SoVITS clause synthesis received too many text clauses.")
    candidates = []
    warnings = []
    for index, clause in enumerate(clauses):
        if not isinstance(clause, dict):
            raise RuntimeError("GPT-SoVITS clause synthesis received an invalid clause.")
        text = clean_text(clause.get("text")).strip()
        output_path = clean_text(clause.get("outputPath")).strip()
        if not text or not output_path:
            raise RuntimeError("Every GPT-SoVITS clause needs text and an output path.")
        clause_request = dict(request)
        clause_request["text"] = text
        clause_request["outputPath"] = output_path
        settings = styled_tts_settings(request.get("settings") or {}, clause.get("style"))
        settings["sentenceSafeSynthesis"] = True
        clause_request["settings"] = settings
        result = generate_tts(clause_request)
        candidates.append({
            "id": clean_text(clause.get("id") or str(index + 1)),
            "index": index + 1,
            "text": text,
            **result,
        })
        warnings.extend(result.get("warnings") or [])
    return {
        "candidates": candidates,
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "language": candidates[0].get("language") if candidates else "",
        "warnings": list(dict.fromkeys(warnings)),
    }


def health(request):
    root = repo_dir(request["modelDir"])
    missing_paths = missing_model_paths(root)
    runtime_ready = len(missing_paths) == 0
    hardware = torch_hardware_state()
    return {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "runtimeReady": runtime_ready,
        "installed": runtime_ready,
        "repoDir": str(root),
        "missingModelPaths": missing_paths,
        **hardware,
        "message": "GPT-SoVITS runtime is ready." if runtime_ready else "GPT-SoVITS pretrained models are missing.",
    }


def handle(request):
    configure_environment(request.get("modelDir") or os.environ.get("MAGIC_BOX_VOICE_ENGINE_MODEL_DIR") or ".")
    action = request.get("action")
    if action == "segment-tts-text":
        language = normalized_language(request.get("textLang") or request.get("language"), "zh")
        settings = request.get("settings") or {}
        integrity_attempt = max(1, int(settings.get("integrityAttempt") or 1))
        sentences = split_tts_sentences(
            request.get("text"),
            soft_boundaries=integrity_attempt >= 2,
            max_units=18 if integrity_attempt >= 3 else 0,
        )
        return {
            "sentences": sentences,
            "preparedSentences": [prepare_tts_sentence(sentence, language) for sentence in sentences],
            "settings": styled_tts_settings(settings, request.get("style")),
        }
    if action == "health":
        return health(request)
    if action == "warm-profile":
        return warm_profile(request)
    if action == "build-profile":
        return build_profile(request)
    if action == "tts":
        return generate_tts(request)
    if action == "tts-batch":
        return generate_tts_batch(request)
    if action == "cancel":
        return {"cancelled": True}
    raise RuntimeError(f"Unsupported GPT-SoVITS worker action: {action}")


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    for line in sys.stdin:
        request = None
        try:
            request = clean_payload(json.loads(line))
            respond(request.get("id"), True, handle(request))
        except Exception as exc:
            respond(request.get("id") if request else None, False, error=str(exc))


if __name__ == "__main__":
    main()
