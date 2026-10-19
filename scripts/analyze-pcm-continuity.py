"""Measure PCM/WAV continuity at known chunk or segment boundaries."""

from __future__ import annotations

import argparse
import array
import json
import math
import sys
import wave
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="16-bit mono PCM WAV")
    parser.add_argument("--boundaries", help="JSON array of boundary sample offsets")
    parser.add_argument("--chunk-samples", type=int, default=0)
    parser.add_argument("--expected-input-samples", type=int, default=0)
    parser.add_argument("--input-rate", type=int, default=0)
    parser.add_argument("--output", default="")
    return parser.parse_args()


def rms(values):
    return math.sqrt(sum(value * value for value in values) / max(1, len(values))) / 32768


def longest_zero_run(samples):
    longest = current = 0
    for value in samples:
        current = current + 1 if value == 0 else 0
        longest = max(longest, current)
    return longest


def main() -> int:
    args = parse_args()
    with wave.open(args.input, "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise SystemExit("continuity analysis requires 16-bit mono PCM WAV")
        sample_rate = source.getframerate()
        samples = array.array("h")
        samples.frombytes(source.readframes(source.getnframes()))
        if sys.byteorder != "little":
            samples.byteswap()
    if args.boundaries:
        boundaries = [int(value) for value in json.loads(Path(args.boundaries).read_text(encoding="utf-8"))]
    elif args.chunk_samples > 0:
        boundaries = list(range(args.chunk_samples, len(samples), args.chunk_samples))
    else:
        boundaries = []
    window = max(1, round(sample_rate * 0.01))
    details = []
    for boundary in boundaries:
        if boundary <= 0 or boundary >= len(samples):
            continue
        left = samples[max(0, boundary - window):boundary]
        right = samples[boundary:min(len(samples), boundary + window)]
        details.append({
            "sample": boundary,
            "amplitudeJumpFullScale": abs(samples[boundary] - samples[boundary - 1]) / 32768,
            "rmsBefore": rms(left),
            "rmsAfter": rms(right),
            "rmsRatio": rms(right) / max(1e-9, rms(left)),
        })
    expected = None
    drift = None
    if args.expected_input_samples and args.input_rate:
        expected = round(args.expected_input_samples * sample_rate / args.input_rate)
        drift = len(samples) - expected
    report = {
        "input": str(Path(args.input).resolve()),
        "sampleRate": sample_rate,
        "sampleCount": len(samples),
        "durationMs": round(len(samples) / sample_rate * 1000),
        "boundaryCount": len(details),
        "maxBoundaryAmplitudeJumpFullScale": max((item["amplitudeJumpFullScale"] for item in details), default=0),
        "maxBoundaryRmsRatio": max((item["rmsRatio"] for item in details), default=0),
        "longestZeroRunMs": round(longest_zero_run(samples) / sample_rate * 1000, 3),
        "expectedOutputSamples": expected,
        "sampleCountDrift": drift,
        "boundaries": details,
        "note": "F0 and spectral metrics require the model/device POC and are intentionally not inferred from missing audio."
    }
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

