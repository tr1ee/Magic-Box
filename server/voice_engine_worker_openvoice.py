import json
import os
import sys
import tempfile
import traceback
import wave
from pathlib import Path


ENGINE_ID = "openvoice-v2-local"
MODEL_VERSION = "openvoice-v2-0417"

MELO_LANGUAGE_MAP = {
    "en": "EN_NEWEST",
    "zh": "ZH",
    "ja": "JP",
}

BERT_MODEL_LOCAL_DIRS = {
    "bert-base-multilingual-uncased": Path("bert") / "bert-base-multilingual-uncased",
    "tohoku-nlp/bert-base-japanese-v3": Path("bert") / "tohoku-nlp--bert-base-japanese-v3",
}
BERT_MODEL_BY_LANGUAGE = {
    "zh": "bert-base-multilingual-uncased",
    "ja": "tohoku-nlp/bert-base-japanese-v3",
}

_transformers_patched = False
_transformers_model_dir = None


def configure_runtime_environment(model_dir):
    root = Path(model_dir or os.environ.get("MAGIC_BOX_VOICE_ENGINE_MODEL_DIR") or ".")
    cache_dir = root / "cache"
    hf_home = cache_dir / "huggingface"
    os.environ.setdefault("HF_HOME", str(hf_home))
    os.environ.setdefault("HF_HUB_CACHE", str(hf_home / "hub"))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(hf_home / "transformers"))
    os.environ.setdefault("TORCH_HOME", str(cache_dir / "torch"))
    os.environ.setdefault("NLTK_DATA", str(cache_dir / "nltk_data"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    unidic_lite_mecabrc = Path(sys.executable).parent / "Lib" / "site-packages" / "unidic_lite" / "dicdir" / "mecabrc"
    if unidic_lite_mecabrc.is_file():
        os.environ.setdefault("MECABRC", str(unidic_lite_mecabrc))
    for value in (
        os.environ.get("HF_HOME"),
        os.environ.get("HF_HUB_CACHE"),
        os.environ.get("TRANSFORMERS_CACHE"),
        os.environ.get("TORCH_HOME"),
        os.environ.get("NLTK_DATA"),
    ):
        if value:
            Path(value).mkdir(parents=True, exist_ok=True)
    return cache_dir


def local_bert_model_dir(model_dir, model_id):
    relative = BERT_MODEL_LOCAL_DIRS.get(model_id)
    if not relative:
        return None
    return Path(model_dir) / relative


def has_local_bert_model(model_dir, model_id):
    local_dir = local_bert_model_dir(model_dir, model_id)
    if not local_dir:
        return False
    has_config = (local_dir / "config.json").is_file()
    has_weights = (local_dir / "pytorch_model.bin").is_file() or (local_dir / "model.safetensors").is_file()
    return has_config and has_weights


def require_language_bert_assets(model_dir, language):
    model_id = BERT_MODEL_BY_LANGUAGE.get(language)
    if not model_id or has_local_bert_model(model_dir, model_id):
        return
    local_dir = local_bert_model_dir(model_dir, model_id)
    raise RuntimeError(
        f"{language.upper()} TTS requires local BERT assets for {model_id}. "
        f"Re-run Voice Clone Model Setup or scripts/install-voice-openvoice.ps1 to repair {local_dir}."
    )


def configure_transformers_runtime(model_dir):
    global _transformers_model_dir, _transformers_patched
    _transformers_model_dir = Path(model_dir)
    allow_downloads = os.environ.get("MAGIC_BOX_VOICE_ALLOW_RUNTIME_DOWNLOADS") == "1"
    if not allow_downloads:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    if _transformers_patched:
        return
    try:
        from transformers import AutoModelForMaskedLM, AutoTokenizer
    except Exception:
        return

    original_model_from_pretrained = AutoModelForMaskedLM.from_pretrained
    original_tokenizer_from_pretrained = AutoTokenizer.from_pretrained

    def resolve_pretrained_path(value):
        local_dir = local_bert_model_dir(_transformers_model_dir, str(value))
        if local_dir and local_dir.is_dir():
            return str(local_dir)
        return value

    def model_from_pretrained(value, *args, **kwargs):
        if not allow_downloads:
            kwargs.setdefault("local_files_only", True)
        return original_model_from_pretrained(resolve_pretrained_path(value), *args, **kwargs)

    def tokenizer_from_pretrained(value, *args, **kwargs):
        if not allow_downloads:
            kwargs.setdefault("local_files_only", True)
        return original_tokenizer_from_pretrained(resolve_pretrained_path(value), *args, **kwargs)

    AutoModelForMaskedLM.from_pretrained = model_from_pretrained
    AutoTokenizer.from_pretrained = tokenizer_from_pretrained
    _transformers_patched = True


def respond(request_id, ok, result=None, error=None):
    payload = {"id": request_id, "ok": ok}
    if ok:
        payload["result"] = result or {}
    else:
        payload["error"] = error or "OpenVoice worker failed."
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def wav_duration(path):
    try:
        with wave.open(str(path), "rb") as handle:
            frame_rate = handle.getframerate() or 1
            return handle.getnframes() / frame_rate
    except Exception:
        return 0.0


def checkpoints_root(model_dir):
    root = Path(model_dir)
    candidates = [
        root / "checkpoints_v2",
        root / "openvoice-v2-checkpoints" / "checkpoints_v2",
    ]
    candidates.extend(root.glob("**/checkpoints_v2"))
    for candidate in candidates:
        if (candidate / "converter" / "config.json").is_file() and (candidate / "converter" / "checkpoint.pth").is_file():
            return candidate
    raise RuntimeError(f"OpenVoice V2 checkpoints were not found under {root}.")


def converter_paths(model_dir):
    root = checkpoints_root(model_dir)
    converter_dir = root / "converter"
    return {
        "root": root,
        "config": converter_dir / "config.json",
        "checkpoint": converter_dir / "checkpoint.pth",
    }


def choose_device():
    import torch

    return "cuda:0" if torch.cuda.is_available() else "cpu"


def load_converter(model_dir):
    from openvoice.api import ToneColorConverter

    paths = converter_paths(model_dir)
    device = choose_device()
    try:
        converter = ToneColorConverter(str(paths["config"]), device=device, enable_watermark=False)
    except TypeError:
        import wavmark

        class DisabledWatermark:
            def to(self, _device):
                return self

        original_load_model = wavmark.load_model
        try:
            wavmark.load_model = lambda *args, **kwargs: DisabledWatermark()
            converter = ToneColorConverter(str(paths["config"]), device=device)
        finally:
            wavmark.load_model = original_load_model
        converter.watermark_model = None
    converter.load_ckpt(str(paths["checkpoint"]))
    return converter, paths, device


def load_torch_se(path, device):
    import torch

    return torch.load(str(path), map_location=device)


def infer_language_from_text(value):
    text = str(value or "")
    for char in text:
        codepoint = ord(char)
        if 0x3040 <= codepoint <= 0x30FF:
            return "ja"
    for char in text:
        codepoint = ord(char)
        if 0x3400 <= codepoint <= 0x9FFF or 0xF900 <= codepoint <= 0xFAFF:
            return "zh"
    return "en"


def normalized_language(value, text=None, fallback=None):
    key = str(value or "auto").strip().lower()
    if key in MELO_LANGUAGE_MAP:
        return key
    if key == "auto" and str(text or "").strip():
        return infer_language_from_text(text)
    fallback_key = str(fallback or "").strip().lower()
    if fallback_key in MELO_LANGUAGE_MAP:
        return fallback_key
    if key == "auto":
        return infer_language_from_text(text)
    return "en"


def melo_language(value):
    return MELO_LANGUAGE_MAP[normalized_language(value)]


def melo_model_paths(model_dir, language):
    lang = melo_language(language)
    root = Path(model_dir) / "melotts" / lang
    config = root / "config.json"
    checkpoint = root / "checkpoint.pth"
    if config.is_file() and checkpoint.is_file():
        return {"config_path": str(config), "ckpt_path": str(checkpoint)}
    return {}


def choose_speaker(model, checkpoints, language):
    lang = melo_language(language)
    speaker_ids = getattr(getattr(model, "hps", None), "data", None).spk2id
    if not speaker_ids:
        raise RuntimeError(f"MeloTTS returned no speakers for {lang}.")

    preferred_keys = {
        "ZH": ["ZH", "ZH_MIX_EN", "ZH_FEMALE"],
        "JP": ["JP", "JP_FEMALE"],
        "EN_NEWEST": ["EN-Newest", "EN_NEWEST", "EN-US", "EN_BR", "EN_INDIA", "EN-AU"],
    }.get(lang, [])

    for preferred in preferred_keys:
        if preferred in speaker_ids:
            speaker_key = preferred
            break
    else:
        speaker_key = next(iter(speaker_ids.keys()))

    speaker_id = speaker_ids[speaker_key]
    se_name = speaker_key.lower().replace("_", "-")
    ses_dir = checkpoints["root"] / "base_speakers" / "ses"
    se_path = ses_dir / f"{se_name}.pth"
    if not se_path.is_file():
        available = sorted(ses_dir.glob("*.pth"))
        if not available:
            raise RuntimeError(f"No OpenVoice base speaker embeddings found in {ses_dir}.")
        se_path = available[0]
    return speaker_key, speaker_id, se_path


def build_profile(request):
    converter, _paths, device = load_converter(request["modelDir"])
    reference_paths = [request["referenceAudioPath"]]
    reference_paths.extend(request.get("auxiliaryReferenceAudioPaths") or [])
    reference_paths = [str(Path(path)) for path in reference_paths if path]
    if not reference_paths:
        raise RuntimeError("No reference audio was provided.")

    embedding_path = Path(request["speakerEmbeddingPath"])
    embedding_path.parent.mkdir(parents=True, exist_ok=True)
    converter.extract_se(reference_paths, se_save_path=str(embedding_path))
    model_path = Path(request["modelPath"])
    model_path.parent.mkdir(parents=True, exist_ok=True)
    profile_model = {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "profileId": request.get("profileId"),
        "profileName": request.get("profileName"),
        "language": request.get("language"),
        "referenceAudioPath": reference_paths[0],
        "auxiliaryReferenceAudioPaths": reference_paths[1:],
        "speakerEmbeddingPath": str(embedding_path),
        "modelPath": str(model_path),
        "device": device,
    }
    model_path.write_text(json.dumps(profile_model, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"profileModel": profile_model}


def load_tts_context(request, text):
    from melo.api import TTS

    converter, paths, device = load_converter(request["modelDir"])
    voice_model = request.get("voiceModel") or {}
    language = normalized_language(
        request.get("language"),
        text=text,
        fallback=request.get("profileLanguage") or voice_model.get("language"),
    )
    configure_transformers_runtime(request["modelDir"])
    require_language_bert_assets(request["modelDir"], language)

    model = TTS(language=melo_language(language), device=device, **melo_model_paths(request["modelDir"], language))
    setattr(model.hps.data, "disable_bert", language not in BERT_MODEL_BY_LANGUAGE)
    speaker_key, speaker_id, source_se_path = choose_speaker(model, paths, language)
    target_se = load_torch_se(request["voiceModel"]["speakerEmbeddingPath"], device)
    source_se = load_torch_se(source_se_path, device)
    return {
        "converter": converter,
        "device": device,
        "language": language,
        "model": model,
        "speakerKey": speaker_key,
        "speakerId": speaker_id,
        "targetSe": target_se,
        "sourceSe": source_se,
    }


def render_tts_output(context, text, output_path, settings):
    text = str(text or "").strip()
    if not text:
        raise RuntimeError("No text was provided.")
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    speed = float((settings or {}).get("speed") or 1.0)
    speed = max(0.7, min(1.3, speed))
    with tempfile.TemporaryDirectory(prefix="magicbox-openvoice-") as temp_dir:
        source_path = Path(temp_dir) / "base.wav"
        context["model"].tts_to_file(text, context["speakerId"], str(source_path), speed=speed)
        context["converter"].convert(
            audio_src_path=str(source_path),
            src_se=context["sourceSe"],
            tgt_se=context["targetSe"],
            output_path=str(output_path),
            message="@MagicBox",
        )
    return output_path


def clear_cuda_tts_context(context):
    if context["device"] == "cuda:0":
        import torch

        torch.cuda.empty_cache()


def tts_result(context, output_path):
    return {
        "outputPath": str(output_path),
        "durationSeconds": wav_duration(output_path),
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "language": context["language"],
        "warnings": [f"Language: {context['language'].upper()}", f"Base speaker: {context['speakerKey']}"],
    }


def generate_tts(request):
    text = str(request.get("text") or "").strip()
    if not text:
        raise RuntimeError("No text was provided.")
    context = load_tts_context(request, text)
    output_path = render_tts_output(context, text, request["outputPath"], request.get("settings") or {})
    clear_cuda_tts_context(context)
    return tts_result(context, output_path)


def generate_tts_batch(request):
    clauses = request.get("clauses") or []
    if not isinstance(clauses, list) or not clauses:
        raise RuntimeError("OpenVoice clause synthesis needs at least one text clause.")
    if len(clauses) > 80:
        raise RuntimeError("OpenVoice clause synthesis received too many text clauses.")
    first_text = str(clauses[0].get("text") or "").strip() if isinstance(clauses[0], dict) else ""
    if not first_text:
        raise RuntimeError("Every OpenVoice clause needs text and an output path.")
    context = load_tts_context(request, first_text)
    candidates = []
    try:
        for index, clause in enumerate(clauses):
            if not isinstance(clause, dict):
                raise RuntimeError("OpenVoice clause synthesis received an invalid clause.")
            text = str(clause.get("text") or "").strip()
            output_path = str(clause.get("outputPath") or "").strip()
            if not text or not output_path:
                raise RuntimeError("Every OpenVoice clause needs text and an output path.")
            rendered_path = render_tts_output(context, text, output_path, request.get("settings") or {})
            candidates.append({
                "id": str(clause.get("id") or index + 1),
                "index": index + 1,
                "text": text,
                **tts_result(context, rendered_path),
            })
    finally:
        clear_cuda_tts_context(context)
    return {
        "candidates": candidates,
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "language": context["language"],
        "warnings": [f"Language: {context['language'].upper()}", f"Base speaker: {context['speakerKey']}"],
    }


def convert_v2v(request):
    import torch

    converter, _paths, device = load_converter(request["modelDir"])
    voice_model = request.get("voiceModel") or {}
    language = normalized_language(
        request.get("language"),
        fallback=request.get("profileLanguage") or voice_model.get("language"),
    )
    output_path = Path(request["outputPath"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    target_se = load_torch_se(request["voiceModel"]["speakerEmbeddingPath"], device)
    with tempfile.TemporaryDirectory(prefix="magicbox-openvoice-v2v-") as temp_dir:
        source_se_path = Path(temp_dir) / "source_se.pth"
        source_se = converter.extract_se([request["sourceAudioPath"]], se_save_path=str(source_se_path))
        converter.convert(
            audio_src_path=request["sourceAudioPath"],
            src_se=source_se,
            tgt_se=target_se,
            output_path=str(output_path),
            message="@MagicBox",
        )

    if device == "cuda:0":
        torch.cuda.empty_cache()
    return {
        "outputPath": str(output_path),
        "durationSeconds": wav_duration(output_path),
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "language": language,
        "warnings": [f"Language: {language.upper()}", "Converted source tone color to target speaker embedding."],
    }


def health(request):
    import torch

    import openvoice  # noqa: F401
    import melo  # noqa: F401

    paths = converter_paths(request["modelDir"])
    cache_dir = configure_runtime_environment(request["modelDir"])
    return {
        "engine": ENGINE_ID,
        "modelVersion": MODEL_VERSION,
        "runtimeReady": True,
        "installed": True,
        "gpuAvailable": torch.cuda.is_available(),
        "device": choose_device(),
        "checkpointDir": str(paths["root"]),
        "cacheDir": str(cache_dir),
    }


def handle(request):
    configure_runtime_environment(request.get("modelDir"))
    action = request.get("action")
    if action == "health":
        return health(request)
    if action == "build-profile":
        return build_profile(request)
    if action == "tts":
        return generate_tts(request)
    if action == "tts-batch":
        return generate_tts_batch(request)
    if action == "v2v":
        return convert_v2v(request)
    if action == "cancel":
        return {"cancelled": True}
    raise RuntimeError(f"Unsupported OpenVoice worker action: {action}")


def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            respond(request.get("id"), True, handle(request))
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            respond(request.get("id") if request else None, False, error=str(exc))


if __name__ == "__main__":
    main()
