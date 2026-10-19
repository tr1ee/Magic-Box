"""MagicBox RVC v2 audio-loader patch.

The pinned RVC source invokes a system ``ffmpeg`` executable for every input.
MagicBox runtimes are isolated and must not depend on a user-level executable
being present on PATH. WAV training inputs are decoded with the pinned
soundfile/librosa dependencies first; non-WAV inputs retain the upstream
ffmpeg-python fallback for compatibility.
"""

import os
import platform

import av
import ffmpeg
import librosa
import numpy as np
import soundfile as sf


def wav2(i, o, format):
    inp = av.open(i, "r")
    if format == "m4a":
        format = "mp4"
    out = av.open(o, "w", format=format)
    if format == "ogg":
        format = "libvorbis"
    if format == "mp4":
        format = "aac"

    ostream = out.add_stream(format)

    for frame in inp.decode(audio=0):
        for p in ostream.encode(frame):
            out.mux(p)

    for p in ostream.encode(None):
        out.mux(p)

    out.close()
    inp.close()


def _load_wav_without_ffmpeg(file, sr):
    audio, input_sr = sf.read(file, dtype="float32", always_2d=False)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1, dtype=np.float32)
    if int(input_sr) != int(sr):
        audio = librosa.resample(audio, orig_sr=int(input_sr), target_sr=int(sr))
    return np.asarray(audio, dtype=np.float32).flatten()


def load_audio(file, sr):
    file = clean_path(file)
    if os.path.splitext(file)[1].lower() == ".wav":
        try:
            return _load_wav_without_ffmpeg(file, sr)
        except Exception as wav_error:
            wav_failure = wav_error
        else:
            wav_failure = None
    else:
        wav_failure = None

    try:
        # Upstream compatibility path for non-WAV media and malformed WAVs.
        out, _ = (
            ffmpeg.input(file, threads=0)
            .output("-", format="f32le", acodec="pcm_f32le", ac=1, ar=sr)
            .run(cmd=["ffmpeg", "-nostdin"], capture_stdout=True, capture_stderr=True)
        )
    except Exception as ffmpeg_error:
        if wav_failure is not None:
            raise RuntimeError(
                f"Failed to load audio without ffmpeg ({wav_failure}) or with ffmpeg ({ffmpeg_error})"
            )
        raise RuntimeError(f"Failed to load audio: {ffmpeg_error}")

    return np.frombuffer(out, np.float32).flatten()


def clean_path(path_str):
    if platform.system() == "Windows":
        path_str = path_str.replace("/", "\\")
    return path_str.strip(" ").strip('"').strip("\n").strip('"').strip(" ")
