"""Import a small, auditable Common Voice speech corpus for VTV.

The importer deliberately requires --confirm-cc0 before marking cases as
legally usable. It extracts only the requested Parquet rows, keeps speakers
isolated, writes normalized 32 kHz mono WAVs, and emits the inputs consumed by
the existing VTV corpus/fine-tune tooling.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf
from scipy.signal import resample_poly


TARGET_SAMPLE_RATE = 32_000
MIN_CLIP_SECONDS = 2.5
MAX_CLIP_SECONDS = 10.0
TARGET_PROFILE_COUNT = 3
TARGET_CLIPS_PER_PROFILE = 24
SOURCE_CASE_COUNT = 12


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_id(prefix: str, value: str) -> str:
    return f"{prefix}-{hashlib.sha256(value.encode('utf-8')).hexdigest()[:16]}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--repo-id", default="OpenFormosa/common_voice_25_zh-TW")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--confirm-cc0", action="store_true")
    return parser.parse_args()


def decode_audio(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    samples, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim == 2:
        samples = samples.mean(axis=1, dtype=np.float32)
    if sample_rate != TARGET_SAMPLE_RATE:
        samples = resample_poly(samples, TARGET_SAMPLE_RATE, sample_rate).astype(np.float32)
        sample_rate = TARGET_SAMPLE_RATE
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 0.999:
        samples = (samples / max(peak, 1.0) * 0.98).astype(np.float32)
    return samples, sample_rate


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> tuple[str, float]:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, samples, sample_rate, subtype="PCM_16", format="WAV")
    data = path.read_bytes()
    return sha256_bytes(data), float(len(samples) / sample_rate)


def choose_rows(rows: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    by_speaker: dict[str, list[dict]] = {}
    for row in rows:
        client_id = str(row.get("client_id") or "").strip()
        duration = float(row.get("duration_ms") or 0) / 1000
        if not client_id or not (MIN_CLIP_SECONDS <= duration <= MAX_CLIP_SECONDS):
            continue
        if not row.get("audio", {}).get("bytes"):
            continue
        by_speaker.setdefault(client_id, []).append(row)

    ranked = sorted(
        (
            (sum(float(item.get("duration_ms") or 0) for item in speaker_rows), speaker_id, speaker_rows)
            for speaker_id, speaker_rows in by_speaker.items()
            if len(speaker_rows) >= TARGET_CLIPS_PER_PROFILE
        ),
        key=lambda item: (-item[0], item[1]),
    )
    if len(ranked) < TARGET_PROFILE_COUNT:
        raise RuntimeError(
            f"Only {len(ranked)} speakers have {TARGET_CLIPS_PER_PROFILE} usable clips; "
            f"need {TARGET_PROFILE_COUNT}."
        )

    target_groups: list[list[dict]] = []
    target_ids: set[str] = set()
    for _, speaker_id, speaker_rows in ranked[:TARGET_PROFILE_COUNT]:
        target_ids.add(speaker_id)
        target_groups.append(sorted(speaker_rows, key=lambda item: str(item.get("path") or ""))[:TARGET_CLIPS_PER_PROFILE])

    source_rows: list[dict] = []
    for _, speaker_id, speaker_rows in ranked[TARGET_PROFILE_COUNT:]:
        if speaker_id in target_ids:
            continue
        source_rows.append(sorted(speaker_rows, key=lambda item: str(item.get("path") or ""))[0])
        if len(source_rows) >= SOURCE_CASE_COUNT:
            break
    if len(source_rows) < SOURCE_CASE_COUNT:
        raise RuntimeError(f"Only {len(source_rows)} independent source speakers found; need {SOURCE_CASE_COUNT}.")
    return target_groups, source_rows


def main() -> None:
    args = parse_args()
    parquet_path = args.parquet.resolve()
    output_root = args.output_root.resolve()
    table = pq.read_table(parquet_path, columns=["client_id", "path", "sentence", "audio", "duration_ms"])
    rows = table.to_pylist()
    target_groups, source_rows = choose_rows(rows)
    output_root.mkdir(parents=True, exist_ok=True)
    repo_root = Path.cwd().resolve()
    legal_use_confirmed = bool(args.confirm_cc0)

    profiles: list[dict] = []
    profile_references: dict[str, str] = {}
    used_source_hashes: set[str] = set()

    for profile_index, group in enumerate(target_groups, start=1):
        profile_id = stable_id("cv25-zh-tw-profile", str(group[0]["client_id"]))
        profile_dir = output_root / "profiles" / profile_id
        samples: list[dict] = []
        reference_parts: list[np.ndarray] = []
        for clip_index, row in enumerate(group, start=1):
            original_bytes = bytes(row["audio"]["bytes"])
            source_hash = sha256_bytes(original_bytes)
            samples_name = f"clip-{clip_index:03d}-{source_hash[:12]}.wav"
            relative_path = Path("profiles") / profile_id / samples_name
            audio, sample_rate = decode_audio(original_bytes)
            output_path = output_root / relative_path
            audio_hash, duration = write_wav(output_path, audio, sample_rate)
            used_source_hashes.add(source_hash)
            samples.append(
                {
                    "id": f"{profile_id}-clip-{clip_index:03d}",
                    "relativePath": output_path.relative_to(repo_root).as_posix(),
                    "sourceSha256": source_hash,
                    "audioSha256": audio_hash,
                    "durationSeconds": round(duration, 3),
                    "voicedDurationSeconds": round(duration, 3),
                    "sampleRate": sample_rate,
                    "language": "zh-TW",
                    "transcript": str(row.get("sentence") or "").strip(),
                    "status": "ready",
                    "preparationStatus": "ready",
                    "datasetPath": str(row.get("path") or ""),
                    "license": "CC0-1.0",
                }
            )
            if clip_index <= 3:
                reference_parts.append(audio)

        reference = np.concatenate(
            [part if index == 0 else np.concatenate([np.zeros(int(TARGET_SAMPLE_RATE * 0.15), dtype=np.float32), part])
             for index, part in enumerate(reference_parts)]
        )
        reference_relative = Path("references") / f"{profile_id}-speech-reference.wav"
        reference_hash, reference_duration = write_wav(output_root / reference_relative, reference, TARGET_SAMPLE_RATE)
        profile_references[profile_id] = (repo_root / output_root.relative_to(repo_root) / reference_relative).as_posix()
        reference_clip_paths = [
            (repo_root / output_root.relative_to(repo_root) / Path("profiles") / profile_id / f"clip-{index:03d}-{sha256_bytes(bytes(row['audio']['bytes']))[:12]}.wav").as_posix()
            for index, row in enumerate(group[:3], start=1)
        ]
        profile_input = {
            "profileId": profile_id,
            "modelVersionId": f"{profile_id}-vtv-speech-finetune-v1",
            "mode": "speech",
            "samples": samples,
            "referencePack": {
                "mode": "speech",
                "referencePath": reference_relative.as_posix(),
                "referenceClipPaths": reference_clip_paths,
                "referenceSha256": reference_hash,
                "durationSeconds": round(reference_duration, 3),
                "clipCount": len(reference_parts),
            },
        }
        profile_input_path = output_root / "profiles" / f"{profile_id}.json"
        profile_input_path.write_text(json.dumps(profile_input, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        profiles.append({"profileId": profile_id, "inputPath": profile_input_path.relative_to(repo_root).as_posix(), "referencePath": profile_references[profile_id], "referenceClipPaths": reference_clip_paths, "sampleCount": len(samples)})

    corpus_cases: list[dict] = []
    for case_index, row in enumerate(source_rows, start=1):
        original_bytes = bytes(row["audio"]["bytes"])
        source_hash = sha256_bytes(original_bytes)
        audio, sample_rate = decode_audio(original_bytes)
        case_id = f"cv25-zh-tw-speech-{case_index:02d}"
        relative_path = Path("cases") / f"{case_id}-{source_hash[:12]}.wav"
        audio_hash, duration = write_wav(output_root / relative_path, audio, sample_rate)
        target_profile = profiles[(case_index - 1) % len(profiles)]
        case_path = (output_root / relative_path).relative_to(repo_root).as_posix()
        corpus_cases.append(
            {
                "id": case_id,
                "path": case_path,
                "sha256": audio_hash,
                "sourceSha256": source_hash,
                "targetProfileId": target_profile["profileId"],
                "targetReferencePath": target_profile["referencePath"],
                "targetReferencePaths": target_profile["referenceClipPaths"],
                "categories": ["neutral"],
                "durationSeconds": round(duration, 3),
                "sampleRate": sample_rate,
                "channels": 1,
                "legalUseConfirmed": legal_use_confirmed,
                "split": "locked-test" if case_index <= 4 else "train",
                "notes": "Common Voice Scripted Speech 25.0 zh-TW; CC0-1.0; independent source speaker; imported from pinned Parquet revision.",
            }
        )

    provenance = {
        "schemaVersion": "vtv-public-corpus-provenance-v1",
        "dataset": {
            "repoId": args.repo_id,
            "revision": args.revision,
            "license": "CC0-1.0",
            "sourceParquet": str(parquet_path.relative_to(repo_root).as_posix()),
            "sourceParquetSha256": sha256_bytes(parquet_path.read_bytes()),
            "readme": "artifacts/vtv-public-data/common-voice-25-zh-TW/README.md",
            "sourceReadme": "artifacts/vtv-public-data/common-voice-25-zh-TW/source/README.zh-TW.md",
        },
        "legalUseConfirmed": legal_use_confirmed,
        "speakerIsolation": {"targetProfileCount": len(profiles), "sourceCaseCount": len(corpus_cases), "targetAndSourceHashOverlap": sorted(used_source_hashes.intersection({case["sourceSha256"] for case in corpus_cases}))},
        "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }
    (output_root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_root / "corpus-input.json").write_text(json.dumps({
        "corpusVersion": "common-voice-25-zh-TW-25.0-pinned",
        "requiredSpeechCategories": ["neutral"],
        "minimumSpeechCases": SOURCE_CASE_COUNT,
        "minimumSpeechProfiles": TARGET_PROFILE_COUNT,
        "minimumSongCases": 0,
        "minimumSongProfiles": 0,
        "speech": corpus_cases,
        "song": [],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_root / "profiles.json").write_text(json.dumps({"profiles": profiles}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputRoot": str(output_root), "profiles": profiles, "speechCases": len(corpus_cases), "legalUseConfirmed": legal_use_confirmed}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
