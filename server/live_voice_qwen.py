"""Pinned Qwen 1.7B voice backend. Complete-sentence codec decoding preserves
the quality accepted in the listening comparison; the caller prefetches audio.
"""
import hashlib
import importlib.metadata
import re
import subprocess
import threading


class SpeechCancelled(Exception):
    pass


class QwenVoiceBackend:
    def __init__(self, runtime):
        self.runtime = runtime
        self.model = None
        self.lock = threading.RLock()
        self.profiles = {}
        self.cancel_event = None

    def load(self):
        with self.lock:
            if self.model is not None:
                return self.model
            if importlib.metadata.version("faster-qwen3-tts") != "0.4.0":
                raise RuntimeError("The Qwen voice cancellation adapter requires faster-qwen3-tts 0.4.0.")
            from faster_qwen3_tts import FasterQwen3TTS
            self.model = FasterQwen3TTS.from_pretrained(self.runtime["qwenModelDir"], local_files_only=True, max_seq_len=2048)
            # Check cancellation every acoustic token, including whole-sentence
            # generation. A new request resets graph KV state via prefill_kv.
            for graph in (self.model.predictor_graph, self.model.talker_graph):
                original = graph.run
                def checked(*args, _run=original, **kwargs):
                    if self.cancel_event is not None and self.cancel_event.is_set():
                        raise SpeechCancelled()
                    return _run(*args, **kwargs)
                graph.run = checked
            return self.model

    def warm(self, profile_id, config):
        with self.lock:
            reference = config.get("qualityReferenceAudioPath") or config.get("referenceAudioPath")
            transcript = config.get("qualityReferenceTranscript") or config.get("referenceTranscript")
            if not reference or not transcript:
                raise RuntimeError("Qwen voice requires a reference recording and its transcript.")
            key = hashlib.sha256((str(reference) + "\0" + str(transcript)).encode()).hexdigest()
            if self.profiles.get(profile_id, {}).get("key") == key:
                return self.profiles[profile_id]
            self.profiles[profile_id] = {"reference": reference, "transcript": transcript, "key": key}
            try:
                # Captures CUDA graphs and caches the exact reference prompt.
                self.generate(profile_id, "你好。", threading.Event())
            except Exception:
                self.profiles.pop(profile_id, None)
                raise
            return self.profiles[profile_id]

    def generate(self, profile_id, text, cancelled, speed=1.0):
        with self.lock:
            model = self.load()
            reference = self.profiles.get(profile_id)
            if reference is None:
                raise RuntimeError("The selected Qwen voice has not finished warming.")
            if cancelled.is_set():
                return None
            import torch
            import numpy as np
            torch.manual_seed(20260904)
            torch.cuda.manual_seed_all(20260904)
            self.cancel_event = cancelled
            try:
                arrays, rate = model.generate_voice_clone(
                    text=text, language="Chinese" if re.search(r"[\u4e00-\u9fff]", text) else "Auto", ref_audio=reference["reference"],
                    ref_text=reference["transcript"], non_streaming_mode=True,
                    max_new_tokens=512,
                )
                if cancelled.is_set():
                    return None
                if rate != 24000:
                    raise RuntimeError(f"Unexpected Qwen sample rate: {rate}")
                values = np.asarray(arrays[0], dtype=np.float32).reshape(-1)
                # The accepted comparison used this exact complete codec path.
                pcm = (np.clip(values, -1, 1) * 32767).astype("<i2").tobytes()
                if abs(speed - 1.0) > 0.001:
                    result = subprocess.run([
                        self.runtime["ffmpegPath"], "-hide_banner", "-loglevel", "error",
                        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
                        "-af", f"atempo={max(0.7, min(1.3, speed))}", "-f", "s16le", "pipe:1",
                    ], input=pcm, capture_output=True, check=True, timeout=10,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    pcm = result.stdout
                return pcm
            except SpeechCancelled:
                return None
            finally:
                self.cancel_event = None

    def unload(self):
        with self.lock:
            self.profiles.clear()
            self.model = None
