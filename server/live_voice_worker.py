"""Persistent local multilingual ASR + streaming CosyVoice worker.

The process speaks newline-delimited JSON on stdio. Audio payloads are base64
PCM so the Node WebSocket boundary remains the only binary protocol boundary.
Model imports and weights are lazy and remain resident until runtime.unload.
"""

from __future__ import annotations

import base64
import faulthandler
import hashlib
import io
import json
import logging
import math
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import types
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional


RUNTIME = json.loads(os.environ.get("MAGIC_BOX_LIVE_VOICE_RUNTIME", "{}") or "{}")
QWEN_ENABLED = RUNTIME.get("ttsProvider") == "qwen3-tts-stream-local"
_protocol_stdout = sys.stdout
_qwen_backend = None
OUTPUT_RATE = 24000
INPUT_RATE = 16000
VAD_SILENCE_SECONDS = 0.650
PARTIAL_ASR_INTERVAL_SECONDS = 0.700
SEGMENT_AUDIO_WATCHDOG_SECONDS = 2.0
CANCELLATION_QUIESCENCE_SECONDS = 0.5
CANCELLATION_ADAPTER_REVISION = "cosyvoice3-074ca6d-cancel-v1"
if QWEN_ENABLED:
    CANCELLATION_ADAPTER_REVISION = "qwen3-faster-0.4.0-token-cancel-v1"

_stdout_lock = threading.Lock()
_inference_lock = threading.Lock()
_model_lock = threading.Lock()
_profile_warm_lock = threading.Lock()
_cosy_model = None
_asr_model = None
_loaded_asr_id = ""
_vad_model = None
_cosy_model_type = None
_preloaded_tokenizer = None
_force_small_asr = False
_asr_kernels_warmed = False
_warmed_profile_ids = set()
_warmed_profile_keys = set()
_warmed_profile_metadata: Dict[str, dict] = {}
_t2s_converter = None
_active_cosy_cancel: Optional[threading.Event] = None
_cancellation_adapter_installed = False
_sessions: Dict[str, dict] = {}
_turns: Dict[str, "Turn"] = {}
_BINARY_IPC = os.environ.get("MAGIC_BOX_WORKER_BINARY_IPC", "0") == "1"
_BINARY_MAGIC = b"MBV5"
_SESSION_LOCAL_HOP = os.environ.get("VOICE_SESSION_LOCAL_HOP", "0") == "1"
_SESSION_LOCAL_HOP_MAX = max(15, int(os.environ.get("VOICE_SESSION_LOCAL_HOP_MAX", "50") or 50))
_SESSION_LOCAL_HOP_SCALE = max(1, int(os.environ.get("VOICE_SESSION_LOCAL_HOP_SCALE", "2") or 2))


def spoken_token_count(value: str) -> int:
    """Count stable spoken units for causal metrics without persisting text."""
    text = str(value or "")
    cjk = sum(1 for character in text if "\u4e00" <= character <= "\u9fff")
    latin = len(re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)?|\d+(?:[.,:/-]\d+)*", text))
    return max(0, cjk + latin)


class TextChunkStream:
    """Blocking append/finish/cancel stream for one CosyVoice inference."""

    def __init__(self, maxsize: int = 24):
        self._queue: "queue.Queue[Optional[str]]" = queue.Queue(maxsize=maxsize)
        self._closed = False
        self._cancelled = threading.Event()
        self.append_count = 0
        self.yield_count = 0
        self.yield_chars = 0
        self.yield_tokens = 0

    def append(self, value: str, acknowledgement=None) -> bool:
        if self._closed or self._cancelled.is_set():
            return False
        text = str(value or "")
        if not text.strip():
            return True
        try:
            self._queue.put_nowait((text, acknowledgement))
        except queue.Full:
            return False
        self.append_count += 1
        return True

    def close(self) -> bool:
        if self._closed:
            return True
        self._closed = True
        try:
            self._queue.put_nowait(None)
            return True
        except queue.Full:
            return False

    def cancel(self) -> None:
        self._cancelled.set()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    def qsize(self) -> int:
        return self._queue.qsize()

    def __iter__(self):
        while not self._cancelled.is_set():
            try:
                item = self._queue.get(timeout=0.3)
            except queue.Empty:
                yield ""  # Let the passage planner flush a stalled partial sentence.
                continue
            if item is None:
                return
            value, acknowledgement = item
            if acknowledgement and not self._cancelled.is_set():
                emit(acknowledgement)
            self.yield_count += 1
            self.yield_chars += len(value)
            self.yield_tokens += spoken_token_count(value)
            yield value


def bounded_speech_passages(chunks):
    """Keep a logical reply continuous while bounding each acoustic inference.

    Empty chunks mark input idle time, not EOF. Content is conserved; prefer
    punctuation and spaces, keep decimals intact, and cap unpunctuated input.
    """
    pending = ""
    first = True
    for chunk in chunks:
        pending += chunk
        while pending:
            cjk = bool(re.search(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", pending))
            limit = (36 if first else 88) if cjk else (160 if first else 320)
            minimum = (14 if first else 48) if cjk else (45 if first else 130)
            boundaries = [m.end() for m in re.finditer(r"[。！？!?；;\n]|(?<!\d)\.(?!\d)", pending[:limit])]
            cut = next((n for n in boundaries if n >= minimum), 0)
            if not cut and len(pending) >= limit:
                weak = [m.end() for m in re.finditer(r"[，,、：:\s]", pending[:limit])]
                cut = next((n for n in reversed(boundaries + weak) if n >= minimum), limit)
            if not cut and not chunk:
                cut = len(pending)
            if not cut:
                break
            value, pending = pending[:cut], pending[cut:]
            if value:
                yield value
                first = first and not value.strip()
    if pending:
        yield pending


def wait_for_playback_budget(turn):
    """Bound prefetch and release GPU between passages; cancellation wakes it."""
    while turn.playback_paced and turn.generated_seconds - turn.played_seconds > 12:
        if turn.cancelled.wait(0.05):
            return False
        if time.monotonic() - turn.playback_updated_at > 15:
            raise RuntimeError("Playback stopped reporting progress. Restart reading to continue.")
    return not turn.cancelled.is_set()


def emit(event: dict) -> None:
    payload = b""
    if _BINARY_IPC and isinstance(event.get("pcm"), str):
        try:
            payload = base64.b64decode(event.pop("pcm"), validate=True)
            event = {**event, "pcmBytes": len(payload)}
        except Exception:
            payload = b""
    with _stdout_lock:
        encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if _BINARY_IPC:
            _protocol_stdout.buffer.write(_BINARY_MAGIC + len(encoded).to_bytes(4, "little") + len(payload).to_bytes(4, "little") + encoded + payload)
            _protocol_stdout.buffer.flush()
        else:
            _protocol_stdout.write(encoded.decode("utf-8") + "\n")
            _protocol_stdout.flush()


def diagnostic(message: str) -> None:
    sys.stderr.write(str(message).replace("\n", " ") + "\n")
    sys.stderr.flush()


def turn_key(session_id: str, turn_id: str) -> str:
    return f"{session_id}:{turn_id}"


@dataclass
class Turn:
    session_id: str
    turn_id: str
    mode: str
    generation: int = 0
    pcm: bytearray = field(default_factory=bytearray)
    reply_id: str = ""
    segments: "queue.Queue[Optional[dict]]" = field(default_factory=lambda: queue.Queue(maxsize=3))
    # A persistent CosyVoice3 session consumes text tokens from this queue
    # while one inference call remains alive.  The queue is bounded so a
    # fast UI cannot grow unbounded memory while the GPU is catching up.
    persistent_text: TextChunkStream = field(default_factory=TextChunkStream)
    persistent: bool = False
    playback_paced: bool = False
    generated_seconds: float = 0.0
    played_seconds: float = 0.0
    playback_updated_at: float = field(default_factory=time.monotonic)
    persistent_finished: bool = False
    persistent_commit_seq: int = 0
    persistent_audio_chunks: int = 0
    cancelled: threading.Event = field(default_factory=threading.Event)
    stopped: threading.Event = field(default_factory=threading.Event)
    had_speech: bool = False
    vad_started_emitted: bool = False
    vad_ended_emitted: bool = False
    silence_started_at: float = 0.0
    vad_iterator: object = None
    vad_pending: bytearray = field(default_factory=bytearray)
    active_segment_cancel: Optional[threading.Event] = None
    synthesis_thread: Optional[threading.Thread] = None
    reply_committed: bool = False
    expected_segments: int = 0
    completed_segments: int = 0
    cancel_requested_at: float = 0.0
    partial_last_started_at: float = 0.0
    partial_inflight: bool = False
    final_started: bool = False
    last_partial_text: str = ""
    inference_instance_id: str = ""
    speaker_prompt_hash: str = ""
    reference_set_hash: str = ""
    model_tts_call_count: int = 0
    prompt_extraction_count: int = 0
    inference_ids: set = field(default_factory=set)
    text_generator_yield_count: int = 0
    text_generator_chars: int = 0
    text_generator_tokens: int = 0
    hop_history: list = field(default_factory=list)
    cuda_cleanup_count: int = 0


def trace_profile_metadata(profile_id: str, model_config: dict) -> dict:
    reference_paths = [str(item) for item in (model_config.get("referenceAudioPaths") or []) if str(item)]
    if model_config.get("referenceAudioPath") and str(model_config.get("referenceAudioPath")) not in reference_paths:
        reference_paths.insert(0, str(model_config.get("referenceAudioPath")))
    reference_set_hash = hashlib.sha256(json.dumps(reference_paths[:5], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]
    prompt_material = {
        "profileId": profile_id,
        "speakerPromptId": str(model_config.get("speakerPromptId", "")),
        "referenceTranscript": str(model_config.get("referenceTranscript", "")),
        "primaryReferenceSegmentId": str(model_config.get("primaryReferenceSegmentId", model_config.get("manualPrimaryReferenceSegmentId", ""))),
    }
    prompt_hash = hashlib.sha256(json.dumps(prompt_material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]
    return {"speakerPromptHash": prompt_hash, "referenceSetHash": reference_set_hash}


def set_session_hop(turn: Turn, inference_model, hop: int, max_hop: int, scale: int, phase: str) -> None:
    """Record the currently shared CosyVoice hop state without changing behavior."""
    if inference_model is None or not hasattr(inference_model, "token_hop_len"):
        return
    inference_model.token_hop_len = hop
    inference_model.token_max_hop_len = max_hop
    inference_model.stream_scale_factor = scale
    turn.hop_history.append({"phase": phase, "tokenHopLen": hop, "tokenMaxHopLen": max_hop, "streamScaleFactor": scale})


def capture_hop_state(inference_model) -> Optional[dict]:
    if inference_model is None or not hasattr(inference_model, "token_hop_len"):
        return None
    return {
        "tokenHopLen": int(getattr(inference_model, "token_hop_len", 0) or 0),
        "tokenMaxHopLen": int(getattr(inference_model, "token_max_hop_len", 0) or 0),
        "streamScaleFactor": int(getattr(inference_model, "stream_scale_factor", 0) or 0),
    }


def restore_hop_state(turn: Turn, inference_model, previous: Optional[dict]) -> None:
    if not _SESSION_LOCAL_HOP or inference_model is None or not previous:
        return
    inference_model.token_hop_len = previous["tokenHopLen"]
    inference_model.token_max_hop_len = previous["tokenMaxHopLen"]
    inference_model.stream_scale_factor = previous["streamScaleFactor"]
    turn.hop_history.append({"phase": "session-local-restore", **previous})


def configure_reply_hop(turn: Turn, inference_model, phase: str, default_max: int, default_scale: int) -> Optional[dict]:
    previous = capture_hop_state(inference_model)
    if _SESSION_LOCAL_HOP:
        set_session_hop(turn, inference_model, 15, _SESSION_LOCAL_HOP_MAX, _SESSION_LOCAL_HOP_SCALE, f"{phase}-session-local")
    else:
        set_session_hop(turn, inference_model, 15, default_max, default_scale, phase)
    return previous


def begin_model_tts_call(turn: Turn, phase: str) -> str:
    turn.model_tts_call_count += 1
    # A reply keeps one player/session but each bounded acoustic passage is a
    # separate model call. Report those identities honestly for diagnostics.
    inference_id = f"{turn.turn_id}:inference:{turn.model_tts_call_count}"
    turn.inference_instance_id = inference_id
    turn.inference_ids.add(inference_id)
    emit({
        "type": "tts.model_call_started",
        "sessionId": turn.session_id,
        "turnId": turn.turn_id,
        "replyId": turn.reply_id,
        "inferenceInstanceId": inference_id,
        "modelTtsCallCount": turn.model_tts_call_count,
        "phase": phase,
        "persistent": turn.persistent,
    })
    return inference_id


def cosyvoice_capabilities() -> dict:
    if QWEN_ENABLED:
        return {"provider": "qwen3-tts-stream-local", "supportsTextGenerator": False, "supportsStreamingAudio": False, "supportsTrueBistream": False, "supportsPersistentText": True, "acousticScheduler": "passage-prefetch", "codecMode": "complete-sentence"}
    model = _cosy_model
    inference_model = getattr(model, "model", None) if model is not None else None
    llm = getattr(inference_model, "llm", None)
    content_free = getattr(model, "inference_instruct2", None) if model is not None else None
    zero_shot = getattr(model, "inference_zero_shot", None) if model is not None else None
    return {
        "supportsTextGenerator": callable(content_free),
        "supportsStreamingAudio": callable(content_free),
        "supportsTrueBistream": callable(getattr(llm, "inference_bistream", None)),
        "supportsInferenceZeroShot": callable(zero_shot),
        "sessionLocalHopEnabled": _SESSION_LOCAL_HOP,
        "sessionLocalHopMax": _SESSION_LOCAL_HOP_MAX,
        "sessionLocalHopScale": _SESSION_LOCAL_HOP_SCALE,
        "modelTtsCallsForThreeAppends": None,
        "inferenceIdStable": None,
    }


def import_cosyvoice():
    global _cosy_model_type
    if _cosy_model_type is not None:
        return _cosy_model_type
    repository = str(RUNTIME.get("cosyVoiceRepository", "")).strip()
    if repository and repository not in sys.path:
        sys.path.insert(0, repository)
        matcha = str(Path(repository) / "third_party" / "Matcha-TTS")
        if matcha not in sys.path:
            sys.path.insert(0, matcha)
    try:
        from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore
        _cosy_model_type = AutoModel
    except ImportError:
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2  # type: ignore
            _cosy_model_type = CosyVoice2
        except ImportError:
            from cosyvoice.cli.cosyvoice import CosyVoice  # type: ignore
            _cosy_model_type = CosyVoice
    return _cosy_model_type


def preload_native_runtime() -> None:
    """Initialize Windows native extension modules on the main thread."""
    global _preloaded_tokenizer
    diagnostic("Live voice worker: initializing native runtime")
    import numpy  # noqa: F401  # type: ignore
    import torch  # noqa: F401  # type: ignore
    if QWEN_ENABLED:
        # Third-party graph-capture progress must never enter framed IPC.
        sys.stdout = sys.stderr
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        cache_dir = str(RUNTIME.get("qwenCacheDir") or Path(RUNTIME["qwenModelDir"]).resolve().parents[1] / "runtime" / "numba-cache")
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        os.environ["NUMBA_CACHE_DIR"] = cache_dir
        faulthandler.dump_traceback_later(30, file=sys.stderr)
        from faster_whisper import WhisperModel  # noqa: F401
        from faster_qwen3_tts import FasterQwen3TTS  # noqa: F401
        from qwen_tts import Qwen3TTSModel  # noqa: F401
        faulthandler.cancel_dump_traceback_later()
        diagnostic("Live voice worker: Qwen native runtime ready")
        return
    import_cosyvoice()
    from cosyvoice.tokenizer.tokenizer import CosyVoice3Tokenizer  # type: ignore
    from transformers import AutoTokenizer  # type: ignore
    tokenizer_path = Path(str(RUNTIME.get("cosyVoiceModelDir", ""))) / "CosyVoice-BlankEN"
    _preloaded_tokenizer = CosyVoice3Tokenizer(str(tokenizer_path))
    slow_tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), use_fast=False)
    slow_tokenizer.add_special_tokens(_preloaded_tokenizer.special_tokens)
    _preloaded_tokenizer.tokenizer = slow_tokenizer
    _preloaded_tokenizer.encode("")
    from faster_whisper import WhisperModel  # noqa: F401  # type: ignore
    diagnostic("Live voice worker: native runtime ready")


def load_cosy_model():
    global _cosy_model
    with _model_lock:
        if _cosy_model is not None:
            return _cosy_model
        model_dir = str(RUNTIME.get("cosyVoiceModelDir", "")).strip()
        if not model_dir or not Path(model_dir).exists():
            raise RuntimeError("Fun-CosyVoice 3 model is not installed or failed checksum verification.")
        try:
            faulthandler.dump_traceback_later(30, repeat=True, file=sys.stderr)
            diagnostic("CosyVoice loader: importing the pinned runtime")
            model_type = import_cosyvoice()
            diagnostic("CosyVoice loader: runtime imported; loading pinned weights")
            trt_plan = Path(model_dir) / "flow.decoder.estimator.fp16.mygpu.plan"
            if not trt_plan.is_file() or trt_plan.stat().st_size == 0:
                raise RuntimeError("The validated CosyVoice TensorRT engine is missing. Repair the streaming voice runtime before use.")
            kwargs = {"model_dir": model_dir, "fp16": True, "load_trt": True}
            try:
                _cosy_model = model_type(**kwargs)
            except TypeError:
                _cosy_model = model_type(model_dir)
            diagnostic("CosyVoice loader: TensorRT estimator enabled")
            frontend = getattr(_cosy_model, "frontend", None)
            if frontend is not None and _preloaded_tokenizer is not None:
                frontend.tokenizer = _preloaded_tokenizer
            tokenizer_wrapper = getattr(frontend, "tokenizer", None)
            huggingface_tokenizer = getattr(tokenizer_wrapper, "tokenizer", None)
            if tokenizer_wrapper is not None and huggingface_tokenizer is not None:
                def stable_encode(text, **_kwargs):
                    return huggingface_tokenizer.encode(str(text), add_special_tokens=True)
                tokenizer_wrapper.encode = stable_encode
            inference_model = getattr(_cosy_model, "model", None)
            if inference_model is not None and hasattr(inference_model, "token_hop_len"):
                inference_model.token_hop_len = 15
                inference_model.token_max_hop_len = 25
                inference_model.stream_scale_factor = 1
            _install_cancellation_adapter(_cosy_model)
            # Reject an out-of-profile shape before TensorRT sees it. Longer
            # replies are handled by the bounded passage scheduler below.
            decoder = inference_model.flow.decoder
            original_estimator = decoder.forward_estimator
            max_frames = inference_model.get_trt_kwargs()["max_shape"][0][-1]
            def checked_estimator(x, *args, **kwargs):
                if x.shape[-1] > max_frames:
                    raise RuntimeError("Speech passage exceeds the TensorRT length limit; shorten the passage.")
                return original_estimator(x, *args, **kwargs)
            decoder.forward_estimator = checked_estimator
            logging.getLogger("cosyvoice").setLevel(logging.WARNING)
            diagnostic("CosyVoice loader: pinned weights loaded")
        finally:
            faulthandler.cancel_dump_traceback_later()
        return _cosy_model


def qwen_backend():
    global _qwen_backend
    with _model_lock:
        if _qwen_backend is None:
            from live_voice_qwen import QwenVoiceBackend
            _qwen_backend = QwenVoiceBackend(RUNTIME)
    return _qwen_backend


def load_asr_model():
    global _asr_model, _loaded_asr_id, _force_small_asr
    with _model_lock:
        if _asr_model is not None:
            return _asr_model
        from faster_whisper import WhisperModel  # type: ignore
        preferred = str(RUNTIME.get("whisperTurboModelDir", "")).strip()
        fallback = str(RUNTIME.get("whisperSmallModelDir", "")).strip()
        if QWEN_ENABLED:
            # Keep the 12 GiB GPU available to TTS and the dialogue model.
            _asr_model = WhisperModel(fallback, device="cpu", compute_type="int8", cpu_threads=8)
            _loaded_asr_id = "small-cpu-int8"
            return _asr_model
        model_path = fallback if _force_small_asr else preferred if preferred and Path(preferred).exists() else fallback
        if not model_path:
            raise RuntimeError("Whisper large-v3-turbo is not installed and no verified small multilingual fallback is available.")
        _loaded_asr_id = "large-v3-turbo" if model_path == preferred else "small"
        try:
            _asr_model = WhisperModel(model_path, device="cuda", compute_type="float16")
        except RuntimeError as error:
            if model_path != preferred or not fallback or not Path(fallback).exists() or not any(token in str(error).lower() for token in ("cuda", "memory", "allocation")):
                raise
            diagnostic(f"Whisper turbo exceeded the CUDA memory limit; activating multilingual small fallback: {error}")
            _force_small_asr = True
            _loaded_asr_id = "small"
            _asr_model = WhisperModel(fallback, device="cuda", compute_type="float16")
        return _asr_model


def process_gpu_memory_mb() -> float:
    try:
        output = subprocess.check_output([
            "nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"
        ], text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        total = 0.0
        for line in output.splitlines():
            parts = [item.strip() for item in line.split(",")]
            if len(parts) == 2 and int(parts[0]) == os.getpid():
                total += float(parts[1])
        if total > 0:
            return total
    except Exception:
        pass
    try:
        output = subprocess.check_output([
            "nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"
        ], text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        values = [float(line.strip()) for line in output.splitlines() if line.strip()]
        return max(values, default=0.0)
    except Exception:
        return 0.0


def gpu_total_memory_mb() -> float:
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return float(torch.cuda.get_device_properties(0).total_memory) / (1024 * 1024)
    except Exception:
        pass
    return 0.0


def enforce_vram_gate() -> float:
    global _asr_model, _loaded_asr_id, _force_small_asr
    peak_mb = process_gpu_memory_mb()
    total_mb = gpu_total_memory_mb()
    # Keep enough headroom for Qwen generation and CosyVoice synthesis. When
    # the combined desktop workload is already using most of a consumer GPU,
    # Whisper large can page/thrash and turn a short microphone turn into a
    # minute-long wait. The bundled multilingual small model is the reliable
    # low-latency fallback in that situation.
    # The release contract is an absolute 10.5 GiB ceiling.  A 72% fraction
    # of a 12 GiB card is unnecessarily conservative and silently downgrades
    # large-v3-turbo even when the measured combined workload fits below the
    # documented limit.  Keep the hard ceiling and retain the OOM fallback in
    # load_asr_model for genuinely constrained devices.
    vram_limit_mb = 10.5 * 1024
    fallback = str(RUNTIME.get("whisperSmallModelDir", "")).strip()
    if peak_mb > vram_limit_mb and _loaded_asr_id == "large-v3-turbo" and fallback and Path(fallback).exists():
        diagnostic(f"Combined GPU memory reached {peak_mb:.0f} MB of {total_mb:.0f} MB; activating multilingual Whisper small for responsive microphone input.")
        _asr_model = None
        _force_small_asr = True
        _loaded_asr_id = ""
        load_asr_model()
        peak_mb = process_gpu_memory_mb()
    return peak_mb


def load_vad_iterator():
    global _vad_model
    with _model_lock:
        if _vad_model is None:
            from silero_vad import load_silero_vad  # type: ignore
            _vad_model = load_silero_vad(onnx=True)
    from silero_vad import VADIterator  # type: ignore
    return VADIterator(_vad_model, threshold=0.5, sampling_rate=INPUT_RATE, min_silence_duration_ms=650, speech_pad_ms=80)


def wav_bytes_from_pcm(pcm: bytes, sample_rate: int = INPUT_RATE) -> bytes:
    stream = io.BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)
    return stream.getvalue()


def simplified_chinese(text: str, language: str = "", segment_languages=None) -> str:
    """Normalize detected Chinese speech to Mainland Simplified orthography."""
    global _t2s_converter
    detected = str(language or "").strip().lower()
    segments = [str(item or "").strip().lower() for item in (segment_languages or [])]
    if not (detected.startswith("zh") or any(item.startswith("zh") for item in segments)):
        return str(text or "")
    try:
        if _t2s_converter is None:
            from opencc import OpenCC  # type: ignore
            _t2s_converter = OpenCC("t2s")
        return _t2s_converter.convert(str(text or ""))
    except Exception:
        diagnostic("OpenCC t2s normalization was unavailable; preserving the detected transcript.")
        return str(text or "")


def transcribe(turn: Turn, final: bool) -> None:
    if turn.cancelled.is_set() or not turn.pcm or (not final and (turn.stopped.is_set() or turn.final_started)):
        return
    if final:
        turn.final_started = True
    else:
        turn.partial_inflight = True
    snapshot = bytes(turn.pcm)
    try:
        if final:
            emit({"type": "asr.final.started", "sessionId": turn.session_id, "turnId": turn.turn_id, "pcmSamples": len(snapshot) // 2})
        with _inference_lock:
            model = load_asr_model()
            segments, info = model.transcribe(
                io.BytesIO(wav_bytes_from_pcm(snapshot)),
                beam_size=1,
                vad_filter=final,
                condition_on_previous_text=False,
                language=None,
                multilingual=True,
                language_detection_segments=2,
            )
            parts = []
            segment_languages = []
            for segment in segments:
                text = str(getattr(segment, "text", "")).strip()
                if text:
                    parts.append(text)
                    language = getattr(segment, "language", None)
                    if language:
                        segment_languages.append(language)
        if turn.cancelled.is_set() or (not final and turn.final_started):
            return
        detected_language = getattr(info, "language", None)
        text = simplified_chinese(" ".join(parts).strip(), detected_language, segment_languages)
        event_type = "transcript.final" if final else "transcript.partial"
        if not final:
            turn.last_partial_text = text
        emit({
            "type": event_type,
            "sessionId": turn.session_id,
            "turnId": turn.turn_id,
            "text": text,
            "unstable": not final,
            "language": detected_language,
            "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
            "segmentLanguages": segment_languages,
            "asrModel": _loaded_asr_id,
            "noSpeech": final and not bool(text),
        })
    except Exception as error:
        emit({"type": "error", "sessionId": turn.session_id, "turnId": turn.turn_id, "code": "asr_failed", "message": str(error), "retryable": True})
    finally:
        if final:
            _turns.pop(turn_key(turn.session_id, turn.turn_id), None)
        else:
            turn.partial_inflight = False


def maybe_schedule_partial(turn: Turn) -> None:
    if os.environ.get("VOICE_PARTIAL_ASR", "0") != "1" or turn.cancelled.is_set() or turn.stopped.is_set() or turn.final_started:
        return
    now = time.monotonic()
    if turn.partial_inflight or now - turn.partial_last_started_at < PARTIAL_ASR_INTERVAL_SECONDS:
        return
    if len(turn.pcm) < INPUT_RATE * 2 * 0.45:
        return
    turn.partial_last_started_at = now
    threading.Thread(target=transcribe, args=(turn, False), daemon=True, name=f"asr-partial-{turn.turn_id}").start()


def stop_input(turn: Turn) -> None:
    if turn.stopped.is_set():
        return
    turn.stopped.set()
    turn.final_started = True
    if turn.had_speech and not turn.vad_ended_emitted:
        turn.vad_ended_emitted = True
        emit({"type": "vad.speech.ended", "sessionId": turn.session_id, "turnId": turn.turn_id})
    emit({"type": "input.ended", "sessionId": turn.session_id, "turnId": turn.turn_id, "reason": "endpoint"})
    threading.Thread(target=transcribe, args=(turn, True), daemon=True, name=f"asr-final-{turn.turn_id}").start()


def observe_vad(turn: Turn, pcm: bytes) -> None:
    if len(pcm) < 2:
        return
    now = time.monotonic()
    try:
        import numpy as np  # type: ignore
        import torch  # type: ignore
        if turn.vad_iterator is None:
            turn.vad_iterator = load_vad_iterator()
        turn.vad_pending.extend(pcm)
        while len(turn.vad_pending) >= 1024 and not turn.stopped.is_set():
            frame = bytes(turn.vad_pending[:1024])
            del turn.vad_pending[:1024]
            samples = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
            event = turn.vad_iterator(torch.from_numpy(samples), return_seconds=True)
            if event and "start" in event:
                turn.had_speech = True
                if not turn.vad_started_emitted:
                    turn.vad_started_emitted = True
                    emit({"type": "vad.speech.started", "sessionId": turn.session_id, "turnId": turn.turn_id})
            if event and "end" in event:
                stop_input(turn)
    except Exception:
        # Keep a conservative local energy fallback if the verified Silero
        # runtime itself fails; ASR remains local and the UI receives a warning.
        sample_count = len(pcm) // 2
        total = 0.0
        for index in range(0, sample_count * 2, 2):
            sample = int.from_bytes(pcm[index:index + 2], "little", signed=True) / 32768.0
            total += sample * sample
        rms = math.sqrt(total / max(1, sample_count))
        if rms >= 0.012:
            turn.had_speech = True
            if not turn.vad_started_emitted:
                turn.vad_started_emitted = True
                emit({"type": "vad.speech.started", "sessionId": turn.session_id, "turnId": turn.turn_id, "fallback": "energy"})
            turn.silence_started_at = 0.0
        elif turn.had_speech:
            if not turn.silence_started_at:
                turn.silence_started_at = now
            else:
                # Shorten the endpoint after a completed phrase, but keep a
                # longer tail for a partial clause so users can continue speaking.
                adaptive_silence = 0.42 if re.search(r"[。！？.!?]$", turn.last_partial_text or "") else VAD_SILENCE_SECONDS
                if now - turn.silence_started_at >= adaptive_silence:
                    stop_input(turn)


def audio_to_pcm(value) -> bytes:
    try:
        import numpy as np  # type: ignore
        import torch  # type: ignore
        tensor = value.detach().float().cpu() if isinstance(value, torch.Tensor) else torch.as_tensor(value).float().cpu()
        array = tensor.squeeze().numpy()
        array = np.clip(array, -1.0, 1.0)
        return (array * 32767.0).astype("<i2").tobytes()
    except Exception as error:
        raise RuntimeError(f"CosyVoice returned an unsupported audio tensor: {error}") from error


def _install_cancellation_adapter(model_wrapper) -> None:
    """Patch only the pinned CosyVoice3 LLM job with token-level cancellation."""
    global _cancellation_adapter_installed
    inference_model = getattr(model_wrapper, "model", None)
    if _cancellation_adapter_installed or getattr(inference_model, "_magicbox_cancel_adapter", False):
        _cancellation_adapter_installed = True
        return
    required = ("tts_speech_token_dict", "llm_end_dict", "llm_context", "silent_tokens", "llm")
    if inference_model is None or inference_model.__class__.__name__ != "CosyVoice3Model" or any(not hasattr(inference_model, name) for name in required):
        raise RuntimeError("The pinned CosyVoice cancellation adapter does not match this runtime revision.")

    def cancellable_llm_job(this, text, prompt_text, llm_prompt_speech_token, llm_embedding, uuid):
        import torch  # type: ignore
        cancel_event = _active_cosy_cancel
        cur_silent_token_num, max_silent_token_num = 0, 5
        try:
            with this.llm_context, torch.cuda.amp.autocast(this.fp16 is True and not hasattr(this.llm, "vllm")):
                if isinstance(text, types.GeneratorType):
                    token_generator = this.llm.inference_bistream(
                        text=text,
                        prompt_text=prompt_text.to(this.device),
                        prompt_text_len=torch.tensor([prompt_text.shape[1]], dtype=torch.int32).to(this.device),
                        prompt_speech_token=llm_prompt_speech_token.to(this.device),
                        prompt_speech_token_len=torch.tensor([llm_prompt_speech_token.shape[1]], dtype=torch.int32).to(this.device),
                        embedding=llm_embedding.to(this.device),
                    )
                else:
                    token_generator = this.llm.inference(
                        text=text.to(this.device),
                        text_len=torch.tensor([text.shape[1]], dtype=torch.int32).to(this.device),
                        prompt_text=prompt_text.to(this.device),
                        prompt_text_len=torch.tensor([prompt_text.shape[1]], dtype=torch.int32).to(this.device),
                        prompt_speech_token=llm_prompt_speech_token.to(this.device),
                        prompt_speech_token_len=torch.tensor([llm_prompt_speech_token.shape[1]], dtype=torch.int32).to(this.device),
                        embedding=llm_embedding.to(this.device),
                        uuid=uuid,
                    )
                for token in token_generator:
                    if cancel_event is not None and cancel_event.is_set():
                        break
                    if token in this.silent_tokens:
                        cur_silent_token_num += 1
                        if cur_silent_token_num > max_silent_token_num:
                            continue
                    else:
                        cur_silent_token_num = 0
                    token_store = this.tts_speech_token_dict.get(uuid)
                    if token_store is None:
                        break
                    token_store.append(token)
        finally:
            if uuid in this.llm_end_dict:
                this.llm_end_dict[uuid] = True

    inference_model.llm_job = types.MethodType(cancellable_llm_job, inference_model)
    inference_model._magicbox_cancel_adapter = True
    _cancellation_adapter_installed = True
    diagnostic(f"CosyVoice cancellation adapter active: {CANCELLATION_ADAPTER_REVISION}")


def cosy_orphan_count() -> int:
    inference_model = getattr(_cosy_model, "model", None)
    if inference_model is None:
        return 0
    identifiers = set()
    for name in ("tts_speech_token_dict", "llm_end_dict", "mel_overlap_dict", "hift_cache_dict", "flow_cache_dict"):
        store = getattr(inference_model, name, None)
        if isinstance(store, dict):
            identifiers.update(store.keys())
    return len(identifiers)


def purge_cosy_caches(known_ids) -> int:
    inference_model = getattr(_cosy_model, "model", None)
    if inference_model is None:
        return 0
    removed = set()
    lock = getattr(inference_model, "lock", _model_lock)
    with lock:
        for name in ("tts_speech_token_dict", "llm_end_dict", "mel_overlap_dict", "hift_cache_dict", "flow_cache_dict"):
            store = getattr(inference_model, name, None)
            if not isinstance(store, dict):
                continue
            for identifier in list(store.keys()):
                if identifier not in known_ids:
                    store.pop(identifier, None)
                    removed.add(identifier)
    return len(removed)


def segment_language(text: str) -> str:
    value = str(text or "")
    if any("\u4e00" <= character <= "\u9fff" for character in value):
        return "zh"
    if any("\u3040" <= character <= "\u30ff" for character in value):
        return "ja"
    if any("\uac00" <= character <= "\ud7af" for character in value):
        return "ko"
    return "en"


def style_instruction(style_name: str) -> str:
    if style_name == "expressive":
        return "You are a helpful assistant. Speak with lively and expressive prosody in neutral standard Mandarin, without regional accent, while articulating every Mandarin syllable clearly.<|endofprompt|>"
    if style_name == "calm":
        return "You are a helpful assistant. Speak with calm, restrained prosody in neutral standard Mandarin, without regional accent, with clear and precise pronunciation.<|endofprompt|>"
    return "You are a helpful assistant. Speak naturally in neutral standard Mandarin, without regional accent, with clear and precise pronunciation.<|endofprompt|>"


def segment_style(session: dict):
    expressiveness = float(session.get("expressiveness", 0.7) or 0.7)
    if expressiveness >= 0.8:
        return "expressive", style_instruction("expressive")
    # The pinned profile's default 0.7 style path is too breathy for Chinese
    # consonant/vowel boundaries (Whisper consistently hears “语音” as “云”).
    # Keep high expressiveness available, but use the clearer restrained prompt
    # through the normal/default range so intelligibility wins over ornament.
    if expressiveness <= 0.7:
        return "calm", style_instruction("calm")
    return "natural", style_instruction("natural")


def generate_segment_attempt(turn: Turn, segment: dict, attempt_cancel: threading.Event, output: queue.Queue) -> None:
    global _active_cosy_cancel
    known_ids = set()
    try:
        with _inference_lock:
            model = load_cosy_model()
            inference_model = getattr(model, "model", None)
            for name in ("tts_speech_token_dict", "llm_end_dict", "mel_overlap_dict", "hift_cache_dict", "flow_cache_dict"):
                store = getattr(inference_model, name, None)
                if isinstance(store, dict):
                    known_ids.update(store.keys())
            previous_hop = configure_reply_hop(turn, inference_model, "segment-start", 25, 1)
            _active_cosy_cancel = attempt_cancel
            session = _sessions.get(turn.session_id, {})
            profile_id = str(session.get("profileId", ""))
            style_name, instruction = segment_style(session)
            style_id = f"{profile_id}::{style_name}"
            frontend = getattr(model, "frontend", None)
            speaker_store = getattr(frontend, "spk2info", None)
            if isinstance(speaker_store, dict) and style_id not in speaker_store and profile_id in speaker_store:
                frontend_extract = getattr(frontend, "_extract_text_token", None)
                if callable(frontend_extract):
                    prompt_token, prompt_token_len = frontend_extract(instruction)
                    speaker_store[style_id] = {**speaker_store[profile_id], "prompt_text": prompt_token, "prompt_text_len": prompt_token_len}
                    turn.prompt_extraction_count += 1
                    turn.prompt_extraction_count += 1
            content_free = getattr(model, "inference_instruct2", None)
            if not callable(content_free):
                raise RuntimeError("The content-safe bounded CosyVoice path is unavailable.")
            import torch  # type: ignore
            # Keep speaker identity reproducible across turns.  A reply UUID in
            # the seed makes the same profile sound like a different speaker on
            # every response, which is especially visible in short streaming
            # chunks.  Text and prosody still determine the acoustic content;
            # the seed only stabilizes the sampling path for this voice style.
            seed_material = f"{profile_id}\0{style_name}\0voice-stable-v1\0{segment.get('sequence', 0)}"
            stable_seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:8], 16)
            torch.manual_seed(stable_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(stable_seed)
            inference_id = begin_model_tts_call(turn, "bounded-segment")
            kwargs = {"stream": True}
            speed = float(session.get("speed", 1.0) or 1.0)
            if abs(speed - 1.0) > 0.001:
                kwargs["speed"] = speed
            try:
                results = content_free(
                    str(segment.get("text", "")).strip(), instruction, "",
                    zero_shot_spk_id=style_id, text_frontend=True, **kwargs,
                )
                first_result = True
                for result in results:
                    speech = result.get("tts_speech") if isinstance(result, dict) else result
                    pcm = audio_to_pcm(speech)
                    if pcm and not attempt_cancel.is_set() and not turn.cancelled.is_set():
                        output.put({"kind": "audio", "pcm": pcm, "first": first_result})
                    if first_result and inference_model is not None and hasattr(inference_model, "token_hop_len"):
                        set_session_hop(turn, inference_model, 50 if _SESSION_LOCAL_HOP else 25, 50 if _SESSION_LOCAL_HOP else 25, 1, "segment-steady")
                    first_result = False
                output.put({"kind": "done"})
            finally:
                restore_hop_state(turn, inference_model, previous_hop)
    except Exception as error:
        output.put({"kind": "error", "error": str(error), "trace": traceback.format_exc()})
    finally:
        attempt_cancel.set()
        removed = purge_cosy_caches(known_ids)
        if removed:
            diagnostic(f"CosyVoice cache cleanup removed {removed} orphan inference state(s)")
        if _active_cosy_cancel is attempt_cancel:
            _active_cosy_cancel = None


def synthesize_segment(turn: Turn, segment: dict) -> bool:
    text = str(segment.get("text", "")).strip()
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
    segment_started = time.perf_counter()
    emit({
        "type": "tts.segment.started", "sessionId": turn.session_id, "turnId": turn.turn_id,
        "replyId": turn.reply_id, "segmentId": segment.get("segmentId"), "sequence": segment.get("sequence"),
        "queueDepth": turn.segments.qsize(), "textLength": len(text), "textHash": text_hash,
        "language": segment_language(text),
    })
    for attempt in range(1, 3):
        attempt_cancel = threading.Event()
        turn.active_segment_cancel = attempt_cancel
        output: queue.Queue = queue.Queue()
        task = threading.Thread(
            target=generate_segment_attempt, args=(turn, segment, attempt_cancel, output),
            daemon=True, name=f"tts-segment-{turn.turn_id}-{segment.get('sequence', 0)}-{attempt}",
        )
        task.start()
        first_audio_at = 0.0
        last_audio_at = time.perf_counter()
        audio_bytes = 0
        failed = None
        timed_out = False
        while task.is_alive() or not output.empty():
            if turn.cancelled.is_set():
                attempt_cancel.set()
            try:
                item = output.get(timeout=0.05)
            except queue.Empty:
                item = None
            now = time.perf_counter()
            if item and item.get("kind") == "audio":
                pcm = item["pcm"]
                audio_bytes += len(pcm)
                if not first_audio_at:
                    first_audio_at = now
                last_audio_at = now
                emit({
                    "type": "tts.audio", "sessionId": turn.session_id, "turnId": turn.turn_id,
                    "replyId": turn.reply_id, "segmentId": segment.get("segmentId"), "sequence": segment.get("sequence"),
                    "first": bool(item.get("first")), "boundary": segment.get("boundary", "strong"),
                    "queueDepth": turn.segments.qsize(),
                    "firstAudioLatencyMs": round((first_audio_at - segment_started) * 1000),
                    "pcm": base64.b64encode(pcm).decode("ascii"),
                })
            elif item and item.get("kind") == "error":
                failed = item
                diagnostic(item.get("trace", ""))
            if turn.cancelled.is_set():
                attempt_cancel.set()
            elif now - last_audio_at >= SEGMENT_AUDIO_WATCHDOG_SECONDS and task.is_alive():
                timed_out = True
                attempt_cancel.set()
            if failed or timed_out or turn.cancelled.is_set():
                break
        if attempt_cancel.is_set() and task.is_alive():
            task.join(CANCELLATION_QUIESCENCE_SECONDS)
        else:
            task.join()
        turn.active_segment_cancel = None
        if turn.cancelled.is_set():
            return False
        if task.is_alive():
            emit({
                "type": "runtime.restart.required", "sessionId": turn.session_id, "turnId": turn.turn_id,
                "code": "gpu_quiescence_timeout", "cancellationQuiescenceMs": round(CANCELLATION_QUIESCENCE_SECONDS * 1000),
                "orphanWorkCount": max(1, cosy_orphan_count()),
            })
            return False
        if not failed and not timed_out and audio_bytes > 0:
            synthesis_ms = round((time.perf_counter() - segment_started) * 1000)
            audio_duration_ms = round(audio_bytes / 2 / OUTPUT_RATE * 1000)
            emit({
                "type": "tts.segment.completed", "sessionId": turn.session_id, "turnId": turn.turn_id,
                "replyId": turn.reply_id, "segmentId": segment.get("segmentId"), "sequence": segment.get("sequence"),
                "queueDepth": turn.segments.qsize(), "synthesisMs": synthesis_ms, "audioDurationMs": audio_duration_ms,
                "rtf": round(synthesis_ms / max(1, audio_duration_ms), 4), "attempt": attempt,
                "textLength": len(text), "textHash": text_hash, "language": segment_language(text),
            })
            diagnostic(f"TTS segment {segment.get('sequence', 0)} hash={text_hash} chars={len(text)} synthesisMs={synthesis_ms} audioMs={audio_duration_ms}")
            return True
        if attempt == 1 and not first_audio_at:
            emit({
                "type": "tts.segment.retry", "sessionId": turn.session_id, "turnId": turn.turn_id,
                "replyId": turn.reply_id, "segmentId": segment.get("segmentId"), "sequence": segment.get("sequence"),
                "reason": "no_audio_watchdog" if timed_out else "segment_failed", "attempt": 2,
            })
            continue
        emit({
            "type": "error", "sessionId": turn.session_id, "turnId": turn.turn_id,
            "code": "tts_segment_timeout" if timed_out else "tts_segment_failed",
            "message": "The local cloned voice stopped because a bounded speech segment produced no audio within two seconds.",
            "retryable": True, "segmentId": segment.get("segmentId"), "sequence": segment.get("sequence"),
        })
        emit({
            "type": "runtime.restart.required", "sessionId": turn.session_id, "turnId": turn.turn_id,
            "code": "segment_watchdog", "orphanWorkCount": cosy_orphan_count(),
        })
        return False
    return False


def synthesize_reply(turn: Turn) -> None:
    time.sleep(0.005)
    if turn.cancelled.is_set():
        return
    session = _sessions.get(turn.session_id, {})
    model_config = session.get("conversationModel") or {}
    metadata = trace_profile_metadata(str(session.get("profileId", "")), model_config)
    if QWEN_ENABLED:
        metadata.update(_warmed_profile_metadata.get(str(session.get("profileId", "")), {}))
    turn.speaker_prompt_hash = metadata["speakerPromptHash"]
    turn.reference_set_hash = metadata["referenceSetHash"]
    turn.inference_instance_id = f"{turn.turn_id}:inference:1"
    reference_audio = str(model_config.get("referenceAudioPath", ""))
    prompt_text = str(model_config.get("referenceTranscript", "")).strip()
    if not reference_audio or not Path(reference_audio).exists() or not prompt_text:
        emit({"type": "error", "sessionId": turn.session_id, "turnId": turn.turn_id, "code": "speaker_prompt_missing", "message": "The cached conversation speaker prompt is incomplete.", "retryable": True})
        _turns.pop(turn_key(turn.session_id, turn.turn_id), None)
        return
    emit({
        "type": "tts.reply.ready", "sessionId": turn.session_id, "turnId": turn.turn_id,
        "replyId": turn.reply_id, "schedulerMode": "persistent-stream" if turn.persistent else "bounded-segments",
        "adapterRevision": CANCELLATION_ADAPTER_REVISION,
        "persistent": turn.persistent,
        "profileId": str(session.get("profileId", "")),
        "inferenceInstanceId": turn.inference_instance_id,
        "speakerPromptHash": turn.speaker_prompt_hash,
        "referenceSetHash": turn.reference_set_hash,
        "modelTtsCallCount": turn.model_tts_call_count,
        "promptExtractionCount": turn.prompt_extraction_count,
        "trueBistreamRequested": False,
        "acousticScheduler": "passage-prefetch" if turn.persistent else "bounded-segments",
    })
    if turn.persistent:
        synthesize_persistent_reply(turn)
        return
    completed = True
    try:
        while not turn.cancelled.is_set():
            segment = turn.segments.get()
            if segment is None:
                break
            if not synthesize_segment(turn, segment):
                completed = False
                break
            turn.completed_segments += 1
        if completed and not turn.cancelled.is_set():
            emit({
                "type": "tts.reply.completed", "sessionId": turn.session_id, "turnId": turn.turn_id,
                "replyId": turn.reply_id, "segmentCount": turn.completed_segments,
                "orphanWorkCount": cosy_orphan_count(),
                "modelTtsCallCount": turn.model_tts_call_count,
                "promptExtractionCount": turn.prompt_extraction_count,
                "inferenceIds": sorted(turn.inference_ids),
                "inferenceIdStable": len(turn.inference_ids) <= 1,
                "textGeneratorYieldCount": turn.text_generator_yield_count,
                "textGeneratorTokens": turn.text_generator_tokens,
                "hopHistory": turn.hop_history,
                "cudaCleanupCount": turn.cuda_cleanup_count,
            })
    except Exception as error:
        diagnostic(traceback.format_exc())
        emit({"type": "error", "sessionId": turn.session_id, "turnId": turn.turn_id, "code": "tts_failed", "message": str(error), "retryable": True})
    finally:
        _turns.pop(turn_key(turn.session_id, turn.turn_id), None)


def _persistent_text_generator(turn: Turn):
    """Yield text chunks from the blocking stream until finish or cancel."""
    for value in turn.persistent_text:
        if not value:
            yield ""
            continue
        turn.text_generator_yield_count = turn.persistent_text.yield_count
        turn.text_generator_chars = turn.persistent_text.yield_chars
        turn.text_generator_tokens = turn.persistent_text.yield_tokens
        emit({
            "type": "tts.text_generator_yielded",
            "sessionId": turn.session_id,
            "turnId": turn.turn_id,
            "replyId": turn.reply_id,
            "inferenceInstanceId": turn.inference_instance_id,
            "textChars": len(value),
            "textTokens": spoken_token_count(value),
            "textGeneratorYieldCount": turn.text_generator_yield_count,
            "textQueueDepth": turn.persistent_text.qsize(),
            "textNormalizationBypassed": True,
            "normalizerStage": "node.spoken-renderer",
        })
        yield value
    turn.persistent_finished = True


def generate_persistent_attempt(turn: Turn, attempt_cancel: threading.Event, output: queue.Queue) -> None:
    """One playback reply, bounded acoustic passages, continuous prefetch."""
    global _active_cosy_cancel
    try:
        first_result = True
        for passage_index, passage in enumerate(bounded_speech_passages(_persistent_text_generator(turn)), 1):
            if not passage.strip():
                continue
            if attempt_cancel.is_set() or not wait_for_playback_budget(turn):
                break
            lock_started = time.perf_counter()
            while not _inference_lock.acquire(timeout=0.05):
                if attempt_cancel.is_set() or turn.cancelled.is_set():
                    return
            try:
                generate_passage(turn, passage, passage_index, attempt_cancel, output, first_result, lock_started)
                first_result = False
            finally:
                _inference_lock.release()
        output.put({"kind": "done"})
    except Exception as error:
        output.put({"kind": "error", "error": str(error), "trace": traceback.format_exc()})
    finally:
        attempt_cancel.set()


def generate_passage(turn, passage, passage_index, attempt_cancel, output, first_result, lock_started):
    if QWEN_ENABLED:
        begin_model_tts_call(turn, "passage-prefetch")
        session = _sessions.get(turn.session_id, {})
        pcm = qwen_backend().generate(str(session.get("profileId", "")), passage, attempt_cancel, float(session.get("speed", 1.0) or 1.0))
        if not pcm or turn.cancelled.is_set():
            return
        for offset in range(0, len(pcm), OUTPUT_RATE):  # half-second PCM frames
            frame = pcm[offset:offset + OUTPUT_RATE]
            while not turn.cancelled.is_set() and not attempt_cancel.is_set():
                try:
                    output.put({"kind": "audio", "pcm": frame, "first": first_result, "inferenceInstanceId": turn.inference_instance_id}, timeout=0.05)
                    turn.generated_seconds += len(frame) / 2 / OUTPUT_RATE
                    first_result = False
                    break
                except queue.Full:
                    continue
            if turn.cancelled.is_set() or attempt_cancel.is_set():
                return
        emit({"type": "tts.passage.completed", "sessionId": turn.session_id, "turnId": turn.turn_id, "passageIndex": passage_index, "audioEndMs": round(turn.generated_seconds * 1000), "schedulerMode": "passage-prefetch"})
        return
    global _active_cosy_cancel
    known_ids = set()
    results = None
    previous_hop = None
    inference_model = None
    try:
            emit({"type": "worker_lock_acquired", "sessionId": turn.session_id, "turnId": turn.turn_id, "replyId": turn.reply_id, "inferenceInstanceId": turn.inference_instance_id, "workerLockWaitMs": round((time.perf_counter() - lock_started) * 1000)})
            model = load_cosy_model()
            inference_model = getattr(model, "model", None)
            for name in ("tts_speech_token_dict", "llm_end_dict", "mel_overlap_dict", "hift_cache_dict", "flow_cache_dict"):
                store = getattr(inference_model, name, None)
                if isinstance(store, dict):
                    known_ids.update(store.keys())
            session = _sessions.get(turn.session_id, {})
            profile_id = str(session.get("profileId", ""))
            style_name, instruction = segment_style(session)
            style_id = f"{profile_id}::{style_name}"
            frontend = getattr(model, "frontend", None)
            speaker_store = getattr(frontend, "spk2info", None)
            if isinstance(speaker_store, dict) and style_id not in speaker_store and profile_id in speaker_store:
                frontend_extract = getattr(frontend, "_extract_text_token", None)
                if callable(frontend_extract):
                    prompt_token, prompt_token_len = frontend_extract(instruction)
                    speaker_store[style_id] = {**speaker_store[profile_id], "prompt_text": prompt_token, "prompt_text_len": prompt_token_len}
            content_free = getattr(model, "inference_instruct2", None)
            if not callable(content_free):
                raise RuntimeError("The pinned persistent CosyVoice path is unavailable.")
            import torch  # type: ignore
            # Use a profile/style seed instead of the transient reply UUID so
            # speaker identity does not drift between otherwise equivalent
            # persistent replies.
            seed_material = f"{profile_id}\0{style_name}\0voice-stable-v1\0passage-{passage_index}"
            stable_seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:8], 16)
            torch.manual_seed(stable_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(stable_seed)
            # Keep the first persistent hop small; the pinned TensorRT runtime
            # expects the larger max hop and scale factor for the streaming
            # generator to close cleanly on long replies.
            previous_hop = configure_reply_hop(turn, inference_model, "persistent-start", 31, 2)
            _active_cosy_cancel = attempt_cancel
            begin_model_tts_call(turn, "passage-prefetch")
            emit({"type": "tts.inference_started", "sessionId": turn.session_id, "turnId": turn.turn_id, "replyId": turn.reply_id, "inferenceInstanceId": turn.inference_instance_id, "speakerPromptHash": turn.speaker_prompt_hash, "referenceSetHash": turn.reference_set_hash, "persistent": True, "modelTtsCallCount": turn.model_tts_call_count, "promptExtractionCount": turn.prompt_extraction_count, "capabilityProbe": cosyvoice_capabilities()})
            try:
                results = content_free(
                    passage, instruction, "",
                    zero_shot_spk_id=style_id, text_frontend=False, stream=True,
                )
                for result in results:
                    speech = result.get("tts_speech") if isinstance(result, dict) else result
                    pcm = audio_to_pcm(speech)
                    if pcm and not attempt_cancel.is_set() and not turn.cancelled.is_set():
                        while not turn.cancelled.is_set() and not attempt_cancel.is_set():
                            try:
                                output.put({"kind": "audio", "pcm": pcm, "first": first_result, "inferenceInstanceId": turn.inference_instance_id}, timeout=0.05)
                                turn.generated_seconds += len(pcm) / 2 / OUTPUT_RATE
                                break
                            except queue.Full:
                                continue
                    if turn.cancelled.is_set() or attempt_cancel.is_set():
                        break
                    first_result = False
                if not turn.cancelled.is_set():
                    emit({"type": "tts.passage.completed", "sessionId": turn.session_id, "turnId": turn.turn_id, "passageIndex": passage_index, "audioEndMs": round(turn.generated_seconds * 1000), "schedulerMode": "passage-prefetch"})
            finally:
                if results is not None and hasattr(results, "close"):
                    results.close()
                restore_hop_state(turn, inference_model, previous_hop)
    finally:
        removed = purge_cosy_caches(known_ids)
        if removed:
            diagnostic(f"CosyVoice cache cleanup removed {removed} orphan inference state(s)")
        if _active_cosy_cancel is attempt_cancel:
            _active_cosy_cancel = None


def synthesize_persistent_reply(turn: Turn) -> None:
    started = time.perf_counter()
    attempt_cancel = threading.Event()
    turn.active_segment_cancel = attempt_cancel
    output: queue.Queue = queue.Queue(maxsize=8)
    task = threading.Thread(
        target=generate_persistent_attempt, args=(turn, attempt_cancel, output),
        daemon=True, name=f"tts-persistent-{turn.turn_id}",
    )
    task.start()
    first_audio_at = 0.0
    audio_bytes = 0
    failed = None
    try:
        while task.is_alive() or not output.empty():
            if turn.cancelled.is_set():
                attempt_cancel.set()
            try:
                item = output.get(timeout=0.05)
            except queue.Empty:
                continue
            if item.get("kind") == "audio":
                pcm = item["pcm"]
                audio_bytes += len(pcm)
                if not first_audio_at:
                    first_audio_at = time.perf_counter()
                emit({
                    "type": "tts.audio", "sessionId": turn.session_id, "turnId": turn.turn_id,
                    "replyId": turn.reply_id, "segmentId": f"{turn.reply_id}:persistent",
                    "sequence": turn.persistent_commit_seq, "commitSeq": turn.persistent_commit_seq,
                    "first": bool(item.get("first")), "boundary": "stream",
                    "queueDepth": turn.persistent_text.qsize(),
                    "firstAudioLatencyMs": round((first_audio_at - started) * 1000),
                    "inferenceInstanceId": item["inferenceInstanceId"],
                    "speakerPromptHash": turn.speaker_prompt_hash,
                    "referenceSetHash": turn.reference_set_hash,
                    "pcm": base64.b64encode(pcm).decode("ascii"),
                })
                turn.persistent_audio_chunks += 1
            elif item.get("kind") == "error":
                failed = item
                diagnostic(item.get("trace", ""))
                break
        if attempt_cancel.is_set() and task.is_alive():
            task.join(CANCELLATION_QUIESCENCE_SECONDS)
        else:
            task.join()
        if turn.cancelled.is_set():
            return
        if task.is_alive():
            emit({"type": "runtime.restart.required", "sessionId": turn.session_id, "turnId": turn.turn_id, "code": "persistent_quiescence_timeout", "orphanWorkCount": max(1, cosy_orphan_count())})
            return
        if failed or audio_bytes <= 0:
            emit({
                "type": "error", "sessionId": turn.session_id, "turnId": turn.turn_id,
                "code": "tts_persistent_failed", "message": (failed or {}).get("error", "The persistent local voice session produced no audio."), "retryable": True,
            })
            return
        emit({
            "type": "tts.reply.completed", "sessionId": turn.session_id, "turnId": turn.turn_id,
            "replyId": turn.reply_id, "segmentCount": turn.persistent_commit_seq,
            "audioChunkCount": turn.persistent_audio_chunks,
            "acousticScheduler": "passage-prefetch",
            "passageCount": turn.model_tts_call_count,
            "synthesisMs": round((time.perf_counter() - started) * 1000),
            "audioDurationMs": round(audio_bytes / 2 / OUTPUT_RATE * 1000),
            "orphanWorkCount": cosy_orphan_count(),
            "modelTtsCallCount": turn.model_tts_call_count,
            "promptExtractionCount": turn.prompt_extraction_count,
            "inferenceIds": sorted(turn.inference_ids),
            "inferenceIdStable": len(turn.inference_ids) == 1,
            "textGeneratorYieldCount": turn.text_generator_yield_count,
            "textGeneratorTokens": turn.text_generator_tokens,
            "hopHistory": turn.hop_history,
            "cudaCleanupCount": turn.cuda_cleanup_count,
            "capabilityProbe": {
                **cosyvoice_capabilities(),
                "modelTtsCallsForThreeAppends": turn.model_tts_call_count if turn.persistent_commit_seq >= 3 else None,
                "inferenceIdStable": len(turn.inference_ids) == 1,
            },
        })
    finally:
        turn.active_segment_cancel = None
        _turns.pop(turn_key(turn.session_id, turn.turn_id), None)


def watch_turn_quiescence(turn: Turn) -> None:
    started = time.perf_counter()
    task = turn.synthesis_thread
    if task and task.is_alive():
        task.join(CANCELLATION_QUIESCENCE_SECONDS)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    orphan_count = cosy_orphan_count()
    if task and task.is_alive():
        emit({
            "type": "runtime.restart.required", "sessionId": turn.session_id, "turnId": turn.turn_id,
            "code": "cancel_quiescence_timeout", "cancellationQuiescenceMs": elapsed_ms,
            "orphanWorkCount": max(1, orphan_count),
        })
    else:
        emit({
            "type": "tts.cancel.quiesced", "sessionId": turn.session_id, "turnId": turn.turn_id,
            "cancellationQuiescenceMs": elapsed_ms, "orphanWorkCount": orphan_count,
        })


def unload_models() -> None:
    global _cosy_model, _asr_model, _loaded_asr_id, _vad_model, _force_small_asr, _asr_kernels_warmed, _warmed_profile_ids, _warmed_profile_metadata
    with _model_lock:
        if _qwen_backend is not None:
            _qwen_backend.unload()
        _cosy_model = None
        _asr_model = None
        _loaded_asr_id = ""
        _vad_model = None
        _force_small_asr = False
        _asr_kernels_warmed = False
        _warmed_profile_ids = set()
        _warmed_profile_keys.clear()
        _warmed_profile_metadata = {}
        try:
            import gc
            import torch  # type: ignore
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


def health(message: dict) -> None:
    if QWEN_ENABLED:
        try:
            qwen_backend().load()
            load_asr_model()
            load_vad_iterator()
            emit({"type": "runtime.health", "requestId": message.get("requestId"), "schemaVersion": 2, "tts": "ready", "asr": "ready", "asrModel": _loaded_asr_id, "warm": True, "peakVramMB": process_gpu_memory_mb(), "schedulerMode": "passage-prefetch", "orphanWorkCount": 0, "capabilities": cosyvoice_capabilities(), "activeModelRevisions": {"tts": RUNTIME.get("qwenModelRevision"), "asr": _loaded_asr_id}})
        except Exception as error:
            emit({"type": "runtime.health", "requestId": message.get("requestId"), "tts": "unavailable", "asr": "unavailable", "warm": False, "error": str(error)})
        return
    try:
        load_cosy_model()
        load_asr_model()
        vad = load_vad_iterator()
        del vad
        peak_vram_mb = enforce_vram_gate()
        emit({
            "type": "runtime.health", "requestId": message.get("requestId"), "schemaVersion": 2,
            "tts": "ready", "asr": "ready", "asrModel": _loaded_asr_id, "warm": True,
            "peakVramMB": peak_vram_mb, "schedulerMode": "persistent-stream" if os.environ.get("VOICE_PERSISTENT_TTS_SESSION") == "1" else "bounded-segments",
            "orphanWorkCount": cosy_orphan_count(), "cancellationAdapterRevision": CANCELLATION_ADAPTER_REVISION,
            "capabilities": cosyvoice_capabilities(),
            "activeModelRevisions": {
                "tts": str(RUNTIME.get("cosyVoiceModelRevision", RUNTIME.get("cosyVoiceRevision", ""))),
                "asr": _loaded_asr_id,
            },
        })
    except Exception as error:
        emit({"type": "runtime.health", "requestId": message.get("requestId"), "tts": "unavailable" if _cosy_model is None else "ready", "asr": "unavailable" if _asr_model is None else "ready", "warm": False, "error": str(error)})


def _warm_profile_once(message: dict) -> None:
    global _asr_kernels_warmed, _warmed_profile_metadata
    started = time.perf_counter()
    if QWEN_ENABLED:
        profile_id = str(message.get("profileId", ""))
        try:
            faulthandler.dump_traceback_later(30, file=sys.stderr)
            diagnostic(f"Qwen warm profile: {profile_id}")
            with _inference_lock:
                reference = qwen_backend().warm(profile_id, message.get("conversationModel") or {})
            _warmed_profile_keys.add(str(message.get("warmupKey") or profile_id))
            metadata = {"speakerPromptHash": reference["key"][:16], "referenceSetHash": reference["key"][:16], "ttsProvider": "qwen3-tts-stream-local", "modelVersion": RUNTIME.get("qwenModelRevision")}
            _warmed_profile_metadata[profile_id] = metadata
            emit({"type": "profile.warm", "requestId": message.get("requestId"), "profileId": profile_id, "warmed": True, "warmLatencyMs": round((time.perf_counter() - started) * 1000), "speakerFeaturesCached": True, **metadata})
        except Exception as error:
            diagnostic(traceback.format_exc())
            emit({"type": "profile.warm", "requestId": message.get("requestId"), "profileId": profile_id, "warmed": False, "error": str(error)})
        finally:
            faulthandler.cancel_dump_traceback_later()
        return
    model_config = message.get("conversationModel") or {}
    profile_id = str(message.get("profileId", ""))
    warmup_key = str(message.get("warmupKey", "")) or profile_id
    reference_audio = str(model_config.get("referenceAudioPath", ""))
    reference_audio_paths = [str(item) for item in (model_config.get("referenceAudioPaths") or []) if str(item) and Path(str(item)).exists()]
    if reference_audio and Path(reference_audio).exists() and reference_audio not in reference_audio_paths:
        reference_audio_paths.insert(0, reference_audio)
    reference_audio_paths = reference_audio_paths[:5]
    reference_transcripts = [str(item or "").strip() for item in (model_config.get("referenceTranscripts") or [])][:len(reference_audio_paths)]
    reference_segment_ids = [str(item or "") for item in (model_config.get("sourceSegmentIds") or [])][:len(reference_audio_paths)]
    reference_diagnostics = [dict(item) for item in (model_config.get("referenceDiagnostics") or []) if isinstance(item, dict)][:len(reference_audio_paths)]
    while len(reference_transcripts) < len(reference_audio_paths):
        reference_transcripts.append("")
    while len(reference_segment_ids) < len(reference_audio_paths):
        reference_segment_ids.append("")
    while len(reference_diagnostics) < len(reference_audio_paths):
        reference_diagnostics.append({})
    manual_primary_id = str(model_config.get("manualPrimaryReferenceSegmentId", ""))
    speaker_feature_path = str(model_config.get("speakerFeaturePath", ""))
    speaker_prompt_id = str(model_config.get("speakerPromptId", ""))
    prompt_text = str(model_config.get("referenceTranscript", "")).strip()
    selected_primary_index = 0
    included_indices = list(range(len(reference_audio_paths)))
    embedding_distances = [0.0 for _ in reference_audio_paths]
    try:
        diagnostic(f"Warming conversation profile {profile_id}: loading CosyVoice")
        with _inference_lock:
            model = load_cosy_model()
            diagnostic(f"Warming conversation profile {profile_id}: CosyVoice loaded; loading Whisper")
            load_asr_model()
            enforce_vram_gate()
            diagnostic(f"Warming conversation profile {profile_id}: models loaded; caching speaker features")
            feature_cached = False
            frontend = getattr(model, "frontend", None)
            speaker_store = getattr(frontend, "spk2info", None)
            if speaker_feature_path and Path(speaker_feature_path).exists() and isinstance(speaker_store, dict):
                import torch  # type: ignore
                cached_artifact = torch.load(speaker_feature_path, map_location=getattr(frontend, "device", "cpu"), weights_only=False)
                cached_speakers = cached_artifact.get("speakers") if isinstance(cached_artifact, dict) and cached_artifact.get("schemaVersion") == 4 and cached_artifact.get("speakerPromptId") == speaker_prompt_id else None
                if isinstance(cached_speakers, dict):
                    speaker_store.update(cached_speakers)
                    feature_cached = profile_id in speaker_store
                    selected_primary_index = int(cached_artifact.get("primaryReferenceIndex", 0) or 0)
                    included_indices = [int(item) for item in (cached_artifact.get("includedReferenceIndices") or included_indices)]
                    embedding_distances = [float(item or 0) for item in (cached_artifact.get("embeddingDistances") or embedding_distances)]
                elif cached_artifact and not (isinstance(cached_artifact, dict) and "schemaVersion" in cached_artifact):
                    speaker_store[profile_id] = cached_artifact
                    feature_cached = True
            if not feature_cached:
                embedding_extract = getattr(frontend, "_extract_spk_embedding", None)
                embeddings = []
                if callable(embedding_extract) and reference_audio_paths:
                    import torch  # type: ignore
                    embeddings = [embedding_extract(audio_path) for audio_path in reference_audio_paths]
                    normalized = [item / torch.clamp(torch.linalg.vector_norm(item), min=1e-6) for item in embeddings]
                    distance_rows = []
                    for left in normalized:
                        distance_rows.append([float(1 - torch.sum(left * right)) for right in normalized])
                    medoid_index = min(range(len(distance_rows)), key=lambda index: sum(distance_rows[index]))
                    embedding_distances = distance_rows[medoid_index]
                    sorted_distances = sorted(embedding_distances)
                    median_distance = sorted_distances[len(sorted_distances) // 2]
                    deviations = sorted(abs(value - median_distance) for value in embedding_distances)
                    mad = deviations[len(deviations) // 2] if deviations else 0.0
                    threshold = median_distance + (2 * max(mad, 1e-6))
                    included_indices = [index for index, value in enumerate(embedding_distances) if value <= threshold]
                    if not included_indices:
                        included_indices = [medoid_index]
                    manual_index = reference_segment_ids.index(manual_primary_id) if manual_primary_id in reference_segment_ids else -1
                    if manual_index >= 0:
                        selected_primary_index = manual_index
                    else:
                        def primary_score(index):
                            diagnostic_row = reference_diagnostics[index] if index < len(reference_diagnostics) else {}
                            return float(diagnostic_row.get("rankScore", 0) or 0) - embedding_distances[index] * 0.2
                        selected_primary_index = max(included_indices, key=primary_score)
                selected_primary_index = min(max(0, selected_primary_index), max(0, len(reference_audio_paths) - 1))
                primary_audio = reference_audio_paths[selected_primary_index] if reference_audio_paths else reference_audio
                primary_text = reference_transcripts[selected_primary_index] if selected_primary_index < len(reference_transcripts) and reference_transcripts[selected_primary_index] else prompt_text
                cosy_prompt_text = primary_text if "<|endofprompt|>" in primary_text else f"You are a helpful assistant.<|endofprompt|>{primary_text}"
                add_speaker = getattr(model, "add_zero_shot_spk", None)
                if callable(add_speaker):
                    add_speaker(cosy_prompt_text, primary_audio, profile_id)
            base_features = speaker_store.get(profile_id) if isinstance(speaker_store, dict) else None
            frontend_extract = getattr(frontend, "_extract_text_token", None)
            if isinstance(base_features, dict) and callable(frontend_extract):
                if not feature_cached and embeddings:
                    import torch  # type: ignore
                    included_embeddings = [embeddings[index] for index in included_indices]
                    centroid = torch.stack(included_embeddings, dim=0).mean(dim=0)
                    centroid_norm = torch.linalg.vector_norm(centroid)
                    target_norm = torch.stack([torch.linalg.vector_norm(item) for item in included_embeddings]).mean()
                    if float(centroid_norm) > 1e-6:
                        centroid = centroid * (target_norm / centroid_norm)
                    base_features = {**base_features, "llm_embedding": centroid, "flow_embedding": centroid}
                    speaker_store[profile_id] = base_features
                style_prompts = {
                    f"{profile_id}::{style_name}": style_instruction(style_name)
                    for style_name in ("natural", "expressive", "calm")
                }
                for style_id, style_prompt in style_prompts.items():
                    prompt_token, prompt_token_len = frontend_extract(style_prompt)
                    speaker_store[style_id] = {**base_features, "prompt_text": prompt_token, "prompt_text_len": prompt_token_len}

                if speaker_feature_path:
                    import torch  # type: ignore
                    Path(speaker_feature_path).parent.mkdir(parents=True, exist_ok=True)
                    temporary_path = f"{speaker_feature_path}.{os.getpid()}.tmp"
                    cached_ids = (profile_id, f"{profile_id}::natural", f"{profile_id}::expressive", f"{profile_id}::calm")
                    torch.save({
                        "schemaVersion": 4,
                        "speakerPromptId": speaker_prompt_id,
                        "referenceCount": max(1, len(reference_audio_paths)),
                        "primaryReferenceIndex": selected_primary_index,
                        "includedReferenceIndices": included_indices,
                        "embeddingDistances": embedding_distances,
                        "speakers": {speaker_id: speaker_store[speaker_id] for speaker_id in cached_ids if speaker_id in speaker_store},
                    }, temporary_path)
                    os.replace(temporary_path, speaker_feature_path)
                feature_cached = True
            if not _asr_kernels_warmed:
                asr_model = load_asr_model()
                warm_pcm = bytearray(INPUT_RATE // 2 * 2)
                for index in range(INPUT_RATE // 2):
                    value = int(math.sin(index * 0.075) * 400)
                    warm_pcm[index * 2:index * 2 + 2] = value.to_bytes(2, "little", signed=True)
                warm_segments, _ = asr_model.transcribe(io.BytesIO(wav_bytes_from_pcm(bytes(warm_pcm))), beam_size=1, vad_filter=False, condition_on_previous_text=False, language="en")
                list(warm_segments)
                _asr_kernels_warmed = True
            if profile_id not in _warmed_profile_ids:
                # Exercise the same first-hop and steady-state tensor shapes used by
                # live turns. A one-word warm-up leaves the first real reply paying
                # CUDA/vocoder shape initialization costs.
                inference_model = getattr(model, "model", None)
                if inference_model is not None and hasattr(inference_model, "token_hop_len"):
                    inference_model.token_hop_len = 20
                    inference_model.token_max_hop_len = 25
                    inference_model.stream_scale_factor = 1
                content_free = getattr(model, "inference_cross_lingual", None)
                warm_chunk_count = 0
                if callable(content_free):
                    for clean_result in content_free(
                        "You are a helpful assistant.<|endofprompt|>Hello. Your local voice is ready.",
                        "",
                        zero_shot_spk_id=profile_id,
                        stream=True,
                        text_frontend=True,
                    ):
                        warm_chunk_count += 1
                        if warm_chunk_count == 1 and inference_model is not None and hasattr(inference_model, "token_hop_len"):
                            inference_model.token_hop_len = 25
                            inference_model.token_max_hop_len = 25
                            inference_model.stream_scale_factor = 1
                _warmed_profile_ids.add(profile_id)
            selected_primary_id = reference_segment_ids[selected_primary_index] if selected_primary_index < len(reference_segment_ids) else ""
            included_set = set(included_indices)
            resolved_reference_diagnostics = []
            for index, segment_id in enumerate(reference_segment_ids):
                source = reference_diagnostics[index] if index < len(reference_diagnostics) else {}
                resolved_reference_diagnostics.append({
                    "segmentId": segment_id,
                    "speechConfidence": float(source.get("speechConfidence", 0) or 0),
                    "transcriptConfidence": float(source.get("transcriptConfidence", 0) or 0),
                    "signalToNoiseDb": float(source.get("signalToNoiseDb", 0) or 0),
                    "clippingRatio": float(source.get("clippingRatio", 0) or 0),
                    "silenceRatio": float(source.get("silenceRatio", 0) or 0),
                    "durationSeconds": float(source.get("durationSeconds", 0) or 0),
                    "embeddingDistanceFromMedoid": round(embedding_distances[index], 6) if index < len(embedding_distances) else 0,
                    "includedInCentroid": index in included_set,
                    "primary": index == selected_primary_index,
                    "exclusion": "" if index in included_set else "embedding_outlier",
                })
            _warmed_profile_metadata[profile_id] = {
                "promptSchemaVersion": 2,
                "primaryReferenceSegmentId": selected_primary_id,
                "referenceDiagnostics": resolved_reference_diagnostics,
                "excludedReferenceSegmentIds": [reference_segment_ids[index] for index in range(len(reference_segment_ids)) if index not in included_set],
            }
            _warmed_profile_keys.add(warmup_key)
        diagnostic(f"Warming conversation profile {profile_id}: ready")
        emit({
            "type": "profile.warm", "requestId": message.get("requestId"), "profileId": profile_id,
            "warmed": True, "warmLatencyMs": round((time.perf_counter() - started) * 1000), "speakerFeaturesCached": feature_cached,
            "warmupKey": warmup_key,
            "speakerReferenceCount": max(1, len(reference_audio_paths)),
            **_warmed_profile_metadata.get(profile_id, {}),
        })
    except Exception as error:
        diagnostic(traceback.format_exc())
        emit({"type": "profile.warm", "requestId": message.get("requestId"), "profileId": profile_id, "warmed": False, "error": str(error)})


def warm_profile(message: dict) -> None:
    profile_id = str(message.get("profileId", ""))
    warmup_key = str(message.get("warmupKey", "")) or profile_id
    with _profile_warm_lock:
        if profile_id and warmup_key in _warmed_profile_keys:
            diagnostic(f"Warming conversation profile {profile_id}: already ready")
            if message.get("requestId"):
                emit({
                    "type": "profile.warm", "requestId": message.get("requestId"), "profileId": profile_id,
                    "warmed": True, "warmLatencyMs": 0, "speakerFeaturesCached": True,
                    **_warmed_profile_metadata.get(profile_id, {}),
                })
            return
        _warm_profile_once(message)


def benchmark_speaker_similarity(message: dict) -> None:
    request_id = message.get("requestId")
    profile_id = str(message.get("profileId", ""))
    temporary_path = ""
    reference_temporary_path = ""
    try:
        pcm = message.get("_pcm_bytes")
        if not isinstance(pcm, (bytes, bytearray)):
            pcm = base64.b64decode(message.get("pcm", ""), validate=True)
        if not pcm or len(pcm) > OUTPUT_RATE * 2 * 30:
            raise RuntimeError("Speaker benchmark PCM must contain no more than 30 seconds of local audio.")
        model_config = message.get("conversationModel") or {}
        reference_audio = str(model_config.get("referenceAudioPath", ""))
        reference_text = str(message.get("referenceText", "")).strip()
        with _inference_lock:
            model = load_cosy_model()
            frontend = getattr(model, "frontend", None)
            embedding_extract = getattr(frontend, "_extract_spk_embedding", None)
            speaker_store = getattr(frontend, "spk2info", None)
            base_features = speaker_store.get(profile_id) if isinstance(speaker_store, dict) else None
            target = base_features.get("flow_embedding") if isinstance(base_features, dict) else None
            if not callable(embedding_extract) or target is None:
                raise RuntimeError("The cached speaker embedding is unavailable for benchmarking.")
            with tempfile.NamedTemporaryFile(prefix="magicbox-speaker-", suffix=".wav", delete=False) as temporary:
                temporary_path = temporary.name
            with wave.open(temporary_path, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(OUTPUT_RATE)
                output.writeframes(pcm)
            generated = embedding_extract(temporary_path)
            reference = embedding_extract(reference_audio)
            reference_paths = [
                str(item) for item in (model_config.get("referenceAudioPaths") or [])
                if str(item) and Path(str(item)).exists()
            ][:5]
            reference_embeddings = [embedding_extract(item) for item in reference_paths]
            import hashlib
            import torch  # type: ignore

            def cosine(left, right):
                left_flat = left.flatten().float()
                right_flat = right.flatten().float()
                return float(torch.dot(left_flat, right_flat) / torch.clamp(torch.linalg.vector_norm(left_flat) * torch.linalg.vector_norm(right_flat), min=1e-6))

            non_streaming_similarity = cosine(reference, target)
            non_streaming_bytes = 0
            if reference_text:
                style_name, instruction = segment_style({"expressiveness": 0.7})
                style_id = f"{profile_id}::{style_name}"
                stable_seed = int(hashlib.sha256(f"{profile_id}\0{style_name}\0voice-stable-v1\0nonstream-reference".encode("utf-8")).hexdigest()[:8], 16)
                torch.manual_seed(stable_seed)
                if torch.cuda.is_available():
                    torch.cuda.manual_seed_all(stable_seed)
                non_streaming_parts = []
                for result in model.inference_instruct2(
                    reference_text, instruction, "", zero_shot_spk_id=style_id,
                    text_frontend=True, stream=False,
                ):
                    speech = result.get("tts_speech") if isinstance(result, dict) else result
                    part = audio_to_pcm(speech)
                    if part:
                        non_streaming_parts.append(part)
                non_streaming_pcm = b"".join(non_streaming_parts)
                non_streaming_bytes = len(non_streaming_pcm)
                if non_streaming_pcm:
                    with tempfile.NamedTemporaryFile(prefix="magicbox-speaker-nonstream-", suffix=".wav", delete=False) as temporary:
                        reference_temporary_path = temporary.name
                    with wave.open(reference_temporary_path, "wb") as output:
                        output.setnchannels(1)
                        output.setsampwidth(2)
                        output.setframerate(OUTPUT_RATE)
                        output.writeframes(non_streaming_pcm)
                    non_streaming = embedding_extract(reference_temporary_path)
                    non_streaming_similarity = cosine(non_streaming, target)
            emit({
                "type": "benchmark.speaker", "requestId": request_id,
                "speakerSimilarity": round(cosine(generated, target), 6),
                "nonStreamingReferenceSimilarity": round(non_streaming_similarity, 6),
                "rawReferenceSimilarity": round(cosine(reference, target), 6),
                "nonStreamingAudioBytes": non_streaming_bytes,
                "generatedToPrimaryReferenceSimilarity": round(cosine(generated, reference), 6),
                "generatedToReferenceSimilarities": [round(cosine(generated, item), 6) for item in reference_embeddings],
                "referenceToTargetSimilarities": [round(cosine(item, target), 6) for item in reference_embeddings],
            })
    except Exception as error:
        emit({"type": "benchmark.speaker", "requestId": request_id, "error": str(error)})
    finally:
        if temporary_path:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
        if reference_temporary_path:
            try:
                os.unlink(reference_temporary_path)
            except OSError:
                pass


def handle(message: dict) -> bool:
    message_type = str(message.get("type", ""))
    session_id = str(message.get("sessionId", ""))
    turn_id = str(message.get("turnId", ""))
    key = turn_key(session_id, turn_id)
    if message_type == "runtime.close":
        return False
    if message_type == "runtime.health":
        threading.Thread(target=health, args=(message,), daemon=True, name="runtime-health").start()
    elif message_type == "profile.warm":
        threading.Thread(target=warm_profile, args=(message,), daemon=True, name="profile-warm").start()
    elif message_type == "benchmark.speaker":
        threading.Thread(target=benchmark_speaker_similarity, args=(message,), daemon=True, name="benchmark-speaker").start()
    elif message_type == "runtime.unload":
        for turn in list(_turns.values()):
            turn.cancelled.set()
            if turn.active_segment_cancel:
                turn.active_segment_cancel.set()
            turn.persistent_text.cancel()
            try:
                turn.segments.put_nowait(None)
            except queue.Full:
                pass
        unload_models()
        emit({"type": "runtime.unloaded", "requestId": message.get("requestId")})
    elif message_type == "session.start":
        _sessions[session_id] = dict(message)
    elif message_type == "session.close":
        _sessions.pop(session_id, None)
        for active_key, active_turn in list(_turns.items()):
            if active_turn.session_id == session_id:
                active_turn.cancelled.set()
                if active_turn.active_segment_cancel:
                    active_turn.active_segment_cancel.set()
                active_turn.persistent_text.cancel()
                _turns.pop(active_key, None)
    elif message_type == "input.start":
        _turns[key] = Turn(session_id, turn_id, "input", int(message.get("generation", 0) or 0))
    elif message_type == "input.audio":
        turn = _turns.get(key)
        if turn and not turn.cancelled.is_set() and not turn.stopped.is_set():
            pcm = message.get("_pcm_bytes")
            if not isinstance(pcm, (bytes, bytearray)):
                pcm = base64.b64decode(message.get("pcm", ""), validate=True)
            turn.pcm.extend(pcm)
            observe_vad(turn, pcm)
            maybe_schedule_partial(turn)
    elif message_type == "input.stop":
        turn = _turns.get(key)
        if turn:
            stop_input(turn)
    elif message_type == "tts.reply.start":
        turn = Turn(
            session_id=session_id, turn_id=turn_id, mode="tts",
            generation=int(message.get("generation", 0) or 0), reply_id=str(message.get("replyId", turn_id)),
            persistent=bool(message.get("persistent", False)),
            playback_paced=message.get("playbackPaced") is True,
        )
        _turns[key] = turn
        turn.synthesis_thread = threading.Thread(target=synthesize_reply, args=(turn,), daemon=True, name=f"tts-reply-{turn_id}")
        turn.synthesis_thread.start()
    elif message_type == "tts.segment":
        turn = _turns.get(key)
        if turn and turn.mode == "tts" and not turn.cancelled.is_set():
            if turn.persistent:
                try:
                    sequence = int(message.get("sequence", 0) or 0)
                    if sequence <= turn.persistent_commit_seq:
                        emit({"type": "error", "sessionId": session_id, "turnId": turn_id, "code": "worker_text_out_of_order", "message": "Persistent text commits must increase monotonically.", "retryable": False})
                        return True
                    turn.persistent_commit_seq = sequence
                    acknowledgement = {"type": "tts.text.accepted", "sessionId": session_id, "turnId": turn_id, "replyId": turn.reply_id, "sequence": sequence, "commitSeq": sequence}
                    if not turn.persistent_text.append(str(message.get("text", "")), acknowledgement):
                        raise queue.Full
                except queue.Full:
                    emit({"type": "error", "sessionId": session_id, "turnId": turn_id, "code": "worker_text_backpressure", "message": "The persistent local speech queue is full.", "retryable": True})
                return True
            try:
                turn.segments.put_nowait({
                    "replyId": str(message.get("replyId", turn.reply_id)),
                    "segmentId": str(message.get("segmentId", "")),
                    "sequence": int(message.get("sequence", 0) or 0),
                    "text": str(message.get("text", "")),
                    "boundary": str(message.get("boundary", "strong")),
                })
            except queue.Full:
                emit({
                    "type": "error", "sessionId": session_id, "turnId": turn_id,
                    "code": "worker_segment_backpressure", "message": "The bounded local speech queue is full.", "retryable": True,
                })
    elif message_type == "tts.reply.commit":
        turn = _turns.get(key)
        if turn and turn.mode == "tts":
            if turn.persistent:
                turn.reply_committed = True
                try:
                    if not turn.persistent_text.close():
                        raise queue.Full
                except queue.Full:
                    emit({"type": "error", "sessionId": session_id, "turnId": turn_id, "code": "worker_finish_backpressure", "message": "The persistent local speech queue could not accept the finish marker.", "retryable": True})
                return True
            turn.reply_committed = True
            turn.expected_segments = int(message.get("segmentCount", 0) or 0)
            try:
                turn.segments.put_nowait(None)
            except queue.Full:
                emit({
                    "type": "error", "sessionId": session_id, "turnId": turn_id,
                    "code": "worker_commit_backpressure", "message": "The bounded local speech queue could not accept the reply commit.", "retryable": True,
                })
    elif message_type in ("tts.text.append", "tts.input.finish"):
        # Protocol-v5 aliases are accepted directly by the worker so a
        # client can negotiate persistent sessions without the v4 queue path.
        turn = _turns.get(key)
        if turn and turn.mode == "tts" and turn.persistent and not turn.cancelled.is_set():
            if message_type == "tts.text.append":
                sequence = int(message.get("commitSeq", message.get("sequence", 0)) or 0)
                if sequence <= turn.persistent_commit_seq:
                    emit({"type": "error", "sessionId": session_id, "turnId": turn_id, "code": "worker_text_out_of_order", "message": "Persistent text commits must increase monotonically.", "retryable": False})
                else:
                    turn.persistent_commit_seq = sequence
                    try:
                        acknowledgement = {"type": "tts.text.accepted", "sessionId": session_id, "turnId": turn_id, "replyId": turn.reply_id, "sequence": sequence, "commitSeq": sequence}
                        if not turn.persistent_text.append(str(message.get("text", "")), acknowledgement):
                            raise queue.Full
                    except queue.Full:
                        emit({"type": "error", "sessionId": session_id, "turnId": turn_id, "code": "worker_text_backpressure", "message": "The persistent local speech queue is full.", "retryable": True})
            else:
                turn.reply_committed = True
                try:
                    if not turn.persistent_text.close():
                        raise queue.Full
                except queue.Full:
                    emit({"type": "error", "sessionId": session_id, "turnId": turn_id, "code": "worker_finish_backpressure", "message": "The persistent local speech queue could not accept the finish marker.", "retryable": True})
    elif message_type == "playback.progress":
        turn = _turns.get(key)
        if turn and turn.playback_paced and not turn.cancelled.is_set():
            reported = float(message.get("playedMs", 0) or 0) / 1000
            if math.isfinite(reported) and 0 <= reported <= turn.generated_seconds + 1:
                turn.played_seconds = max(turn.played_seconds, reported)
                turn.playback_updated_at = time.monotonic()
    elif message_type == "turn.cancel":
        turn = _turns.get(key)
        if turn:
            turn.cancel_requested_at = time.perf_counter()
            turn.cancelled.set()
            if turn.active_segment_cancel:
                turn.active_segment_cancel.set()
            turn.persistent_text.cancel()
            try:
                turn.segments.put_nowait(None)
            except queue.Full:
                pass
            emit({"type": "turn.cancelled", "sessionId": session_id, "turnId": turn_id, "acknowledgementMs": 0})
            threading.Thread(target=watch_turn_quiescence, args=(turn,), daemon=True, name=f"tts-cancel-watch-{turn_id}").start()
        else:
            emit({"type": "turn.cancelled", "sessionId": session_id, "turnId": turn_id, "acknowledgementMs": 0})
    return True


def main() -> None:
    preload_native_runtime()
    if _BINARY_IPC:
        stream = sys.stdin.buffer
        def messages():
            while True:
                magic = stream.read(4)
                if not magic:
                    return
                if magic != _BINARY_MAGIC:
                    remainder = stream.readline()
                    try:
                        yield json.loads((magic + remainder).decode("utf-8"))
                    except Exception:
                        continue
                    continue
                lengths = stream.read(8)
                if len(lengths) != 8:
                    return
                header_len = int.from_bytes(lengths[:4], "little")
                payload_len = int.from_bytes(lengths[4:], "little")
                header = stream.read(header_len)
                payload = stream.read(payload_len)
                if len(header) != header_len or len(payload) != payload_len:
                    return
                try:
                    message = json.loads(header.decode("utf-8"))
                    if payload:
                        message["_pcm_bytes"] = payload
                    yield message
                except Exception:
                    continue
        input_messages = messages()
    else:
        input_messages = (json.loads(raw_line) for raw_line in sys.stdin)
    for message in input_messages:
        try:
            if not handle(message):
                break
        except Exception as error:
            diagnostic(traceback.format_exc())
            emit({"type": "error", "code": "worker_protocol_error", "message": str(error), "retryable": False})
    unload_models()


if __name__ == "__main__":
    main()
