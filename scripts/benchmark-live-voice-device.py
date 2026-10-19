"""Capture a real Windows WASAPI output endpoint while playing a live-voice WAV.

This is intentionally separate from the product runtime. It uses the isolated
``vendor/voice-device-audio`` packages and records only waveform diagnostics,
not the source text or raw audio in the JSON report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import wave
import warnings
from pathlib import Path
from threading import Event, Thread

import numpy as np
import soundcard as sc


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError("The device harness requires 16-bit PCM WAV input.")
    values = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        values = values.reshape(-1, channels).mean(axis=1)
    return values, rate


def resample(values: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return values
    # Keep the harness independent of the managed runtime's SciPy/NumPy ABI.
    # The product's browser path is what is being tested; this conversion only
    # supplies samples to the selected hardware endpoint.
    output_length = max(1, round(len(values) * target_rate / source_rate))
    source_positions = np.arange(len(values), dtype=np.float64)
    target_positions = np.linspace(0, max(0, len(values) - 1), output_length)
    return np.interp(target_positions, source_positions, values).astype(np.float32)


def choose_speaker(selector: str):
    speakers = sc.all_speakers()
    if selector:
        lowered = selector.casefold()
        for speaker in speakers:
            if lowered in speaker.name.casefold():
                return speaker
        raise RuntimeError(f"No output endpoint matched {selector!r}.")
    return sc.default_speaker()


def interior_quiet_ms(values: np.ndarray, rate: int, threshold: float) -> float:
    absolute = np.abs(values)
    active = np.flatnonzero(absolute >= threshold)
    if len(active) < 2:
        return 0.0
    interior = absolute[int(active[0]): int(active[-1]) + 1]
    longest = 0
    current = 0
    for value in interior:
        if value < threshold:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest / rate * 1000


def measure(values: np.ndarray, rate: int, speaker, loopback) -> dict:
    # Stereo playback exercises the same channel negotiation Windows uses for
    # the browser's mono AudioContext destination.
    stereo = np.repeat(values[:, None], 2, axis=1)
    capture_seconds = len(values) / rate + 1.5
    captured: list[np.ndarray] = []
    post_warnings: list[warnings.WarningMessage] = []
    ready = Event()

    def capture() -> None:
        with loopback.recorder(samplerate=rate, channels=2, blocksize=1024) as recorder:
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("always")
                pre_roll = recorder.record(numframes=int(0.25 * rate))
            ready.set()
            with warnings.catch_warnings(record=True) as observed_warnings:
                warnings.simplefilter("always")
                post_roll = recorder.record(numframes=int((capture_seconds - 0.25) * rate))
                post_warnings.extend(observed_warnings)
            captured.append(np.concatenate([pre_roll, post_roll], axis=0))

    thread = Thread(target=capture, daemon=True)
    started = time.perf_counter()
    thread.start()
    if not ready.wait(timeout=3.0):
        raise RuntimeError("WASAPI loopback recorder did not become ready.")
    with speaker.player(samplerate=rate, channels=2, blocksize=1024) as player:
        player.play(stereo)
    thread.join(timeout=max(5.0, capture_seconds + 3.0))
    elapsed = (time.perf_counter() - started) * 1000.0
    if not captured:
        raise RuntimeError("WASAPI loopback returned no samples.")
    observed = np.asarray(captured[0], dtype=np.float32)
    mono = observed.mean(axis=1) if observed.ndim == 2 else observed
    abs_values = np.abs(mono)
    threshold = max(0.002, float(np.percentile(abs_values, 90)) * 0.02)
    active = np.flatnonzero(abs_values >= threshold)
    first_active = int(active[0]) if len(active) else -1
    last_active = int(active[-1]) if len(active) else -1
    captured_quiet_ms = interior_quiet_ms(mono, rate, threshold)
    source_threshold = max(0.002, float(np.percentile(np.abs(values), 90)) * 0.02)
    source_quiet_ms = interior_quiet_ms(values, rate, source_threshold)
    # Natural Mandarin prosody can contain a pause. Compare the device capture
    # to the exact played waveform so those expected pauses are not mistaken for
    # an endpoint underrun; only an extra gap over 120 ms fails the gate.
    extra_quiet_ms = max(0.0, captured_quiet_ms - source_quiet_ms)
    return {
        "sampleRate": rate,
        "capturedSamples": int(len(mono)),
        "elapsedMs": round(elapsed),
        "playbackObserved": bool(len(active)),
        "onsetMs": round(first_active / rate * 1000, 2) if first_active >= 0 else None,
        "observedDurationMs": round((last_active - first_active) / rate * 1000, 2) if last_active > first_active else 0,
        "rms": round(float(np.sqrt(np.mean(np.square(mono)))), 6),
        "peak": round(float(np.max(abs_values)), 6) if len(abs_values) else 0,
        "clippingRatio": round(float(np.mean(abs_values >= 0.999)), 8) if len(abs_values) else 0,
        "sourceQuietMs": round(source_quiet_ms, 3),
        "longestBelowThresholdMs": round(captured_quiet_ms, 3),
        "extraQuietMs": round(extra_quiet_ms, 3),
        "playbackWarnings": [str(item.message) for item in post_warnings],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    parser.add_argument("--device", default=os.environ.get("VOICE_DEVICE_NAME", ""))
    parser.add_argument("--rates", default="44100,48000")
    parser.add_argument("--output", type=Path, default=Path("artifacts/live-voice-device-benchmark.json"))
    args = parser.parse_args()
    values, source_rate = read_wav(args.wav)
    speaker = choose_speaker(args.device)
    loopback = next((mic for mic in sc.all_microphones(include_loopback=True) if mic.id == speaker.id), None)
    if loopback is None:
        raise RuntimeError(f"No WASAPI loopback endpoint was found for {speaker.name!r}.")
    rates = [int(value.strip()) for value in args.rates.split(",") if value.strip()]
    results = []
    for rate in rates:
        prepared = resample(values, source_rate, rate)
        result = measure(prepared, rate, speaker, loopback)
        result["sourceRate"] = source_rate
        results.append(result)
    report = {
        "schemaVersion": 1,
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": speaker.name,
        "deviceId": speaker.id,
        "loopback": True,
        "inputWav": args.wav.name,
        "inputWavSha256": hashlib.sha256(args.wav.read_bytes()).hexdigest(),
        "results": results,
        "pass": all(
            item["playbackObserved"]
            and item["clippingRatio"] < 0.001
            and item["extraQuietMs"] < 120
            and not item["playbackWarnings"]
            for item in results
        ),
        "note": "WASAPI loopback confirms the Windows endpoint path; it does not replace subjective listening at the transducer.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["pass"] else 1)


if __name__ == "__main__":
    main()
