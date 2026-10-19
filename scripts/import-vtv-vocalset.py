"""Import a reproducible, licensed VocalSet subset for Song VTV experiments."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


SAMPLE_RATE = 44_100
SOURCE_CASES = 8
EXPECTED_MD5_BY_RECORD = {
    "10.5281/zenodo.1193957": "c44f60d34b8724b9a6f6d15e0a3158a9",
}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--revision", default="10.5281/zenodo.1193957")
    parser.add_argument("--confirm-cc-by", action="store_true")
    parser.add_argument("--target-clips", type=int, default=24)
    parser.add_argument("--profile-id", default="")
    return parser.parse_args()


def read_audio(blob: bytes) -> np.ndarray:
    samples, sample_rate = sf.read(io.BytesIO(blob), dtype="float32", always_2d=False)
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim == 2:
        samples = samples.mean(axis=1, dtype=np.float32)
    if sample_rate != SAMPLE_RATE:
        samples = resample_poly(samples, SAMPLE_RATE, sample_rate).astype(np.float32)
    return np.column_stack([samples, samples]).astype(np.float32)


def write_wav(path: Path, samples: np.ndarray) -> tuple[str, float]:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, samples, SAMPLE_RATE, subtype="PCM_16", format="WAV")
    raw = path.read_bytes()
    return sha256(raw), float(len(samples) / SAMPLE_RATE)


def singer_name(member: str) -> str:
    stem = Path(member).stem
    return stem.split("_")[0].lower()


def main() -> None:
    parsed = args()
    if parsed.target_clips < 3:
        raise RuntimeError("At least three target clips are required for the independent reference pack.")
    archive = parsed.zip.resolve()
    root = parsed.output_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    repo_root = Path.cwd().resolve()
    archive_md5 = hashlib.md5(archive.read_bytes()).hexdigest()
    expected_md5 = EXPECTED_MD5_BY_RECORD.get(parsed.revision)
    if expected_md5 and archive_md5 != expected_md5:
        raise RuntimeError(f"VocalSet archive MD5 mismatch: expected {expected_md5}, got {archive_md5}.")
    with zipfile.ZipFile(archive) as bundle:
        members = sorted(name for name in bundle.namelist() if name.lower().endswith(".wav"))
        if not members:
            raise RuntimeError("VocalSet archive contains no WAV members.")
        by_singer: dict[str, list[str]] = {}
        for member in members:
            by_singer.setdefault(singer_name(member), []).append(member)
        eligible = sorted(((len(items), singer, items) for singer, items in by_singer.items() if len(items) >= parsed.target_clips), reverse=True)
        if len(eligible) < 2:
            raise RuntimeError("VocalSet does not contain two singers with enough clips for Song VTV.")
        target_singer = "f1" if any(item[1] == "f1" for item in eligible) else eligible[0][1]
        target_members = sorted(next(item[2] for item in eligible if item[1] == target_singer))[:parsed.target_clips]
        source_members = [items[0] for _, singer, items in eligible if singer != target_singer][:SOURCE_CASES]
        if len(source_members) < SOURCE_CASES:
            raise RuntimeError(f"Only {len(source_members)} independent source singers found; need {SOURCE_CASES}.")

        profile_id = parsed.profile_id.strip() or f"vocalset-{target_singer}-song-profile"
        profile_dir = root / "profiles" / profile_id
        samples: list[dict] = []
        reference_parts: list[np.ndarray] = []
        for index, member in enumerate(target_members, start=1):
            blob = bundle.read(member)
            digest = sha256(blob)
            audio = read_audio(blob)
            relative = Path("profiles") / profile_id / f"clip-{index:03d}-{digest[:12]}.wav"
            audio_hash, duration = write_wav(root / relative, audio)
            if index <= 3:
                reference_parts.append(audio[:, 0])
            samples.append({
                "id": f"{profile_id}-clip-{index:03d}",
                "relativePath": (root / relative).relative_to(repo_root).as_posix(),
                "sourceSha256": digest,
                "audioSha256": audio_hash,
                "durationSeconds": round(duration, 3),
                "voicedDurationSeconds": round(duration, 3),
                "sampleRate": SAMPLE_RATE,
                "language": "und",
                "transcript": "",
                "status": "ready",
                "preparationStatus": "ready",
                "datasetPath": member,
                "license": "CC BY 4.0",
            })

        reference = np.concatenate([
            part if index == 0 else np.concatenate([np.zeros(int(SAMPLE_RATE * 0.15), dtype=np.float32), part])
            for index, part in enumerate(reference_parts)
        ])
        reference_stereo = np.column_stack([reference, reference]).astype(np.float32)
        reference_relative = Path("references") / f"{profile_id}-reference.wav"
        reference_hash, reference_duration = write_wav(root / reference_relative, reference_stereo)
        reference_paths = [
            (repo_root / samples[index]["relativePath"]).as_posix()
            for index in range(min(3, len(samples)))
        ]
        profile_input = {
            "profileId": profile_id,
            "modelVersionId": f"{profile_id}-vtv-song-finetune-v1",
            "mode": "song",
            "samples": samples,
            "referencePack": {
                "mode": "song",
                "referencePath": (repo_root / root.relative_to(repo_root) / reference_relative).as_posix(),
                "referenceClipPaths": reference_paths,
                "referenceSha256": reference_hash,
                "durationSeconds": round(reference_duration, 3),
                "clipCount": len(reference_parts),
            },
        }
        profile_path = root / "profiles" / f"{profile_id}.json"
        profile_path.write_text(json.dumps(profile_input, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        cases: list[dict] = []
        for index, member in enumerate(source_members, start=1):
            blob = bundle.read(member)
            digest = sha256(blob)
            audio = read_audio(blob)
            case_id = f"vocalset-song-{index:02d}"
            relative = Path("cases") / f"{case_id}-{digest[:12]}.wav"
            audio_hash, duration = write_wav(root / relative, audio)
            cases.append({
                "id": case_id,
                "path": (root / relative).relative_to(repo_root).as_posix(),
                "sha256": audio_hash,
                "sourceSha256": digest,
                "targetProfileId": profile_id,
                "targetReferencePath": (repo_root / root.relative_to(repo_root) / reference_relative).as_posix(),
                "targetReferencePaths": reference_paths,
                "categories": ["song-vocal-isolated"],
                "durationSeconds": round(duration, 3),
                "sampleRate": SAMPLE_RATE,
                "channels": 2,
                "legalUseConfirmed": bool(parsed.confirm_cc_by),
                "split": "locked-test" if index <= 2 else "train",
                "notes": "VocalSet isolated vocal; CC BY 4.0; no accompaniment in this subset; full-song mix gate remains a separate requirement.",
            })

        provenance = {
            "schemaVersion": "vtv-public-corpus-provenance-v1",
            "dataset": {
                "doi": "10.5281/zenodo.1193957",
                "record": parsed.revision,
                "license": "CC BY 4.0",
                "attribution": "Wilkins, J., Seetharaman, P., Wahl, A., & Pardo, B. (2018). VocalSet: A Singing Voice Dataset (1.0). Zenodo.",
                "archive": str(archive.relative_to(repo_root).as_posix()),
                "archiveMd5": archive_md5,
                "expectedArchiveMd5": expected_md5,
            },
            "legalUseConfirmed": bool(parsed.confirm_cc_by),
            "targetSinger": target_singer,
            "sourceSingers": sorted({singer_name(member) for member in source_members}),
            "limitations": ["isolated_vocal_only", "no_accompaniment", "full_song_mix_gate_not_satisfied_by_this_subset"],
        }
        (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (root / "profiles.json").write_text(json.dumps({"profiles": [{"profileId": profile_id, "inputPath": profile_path.relative_to(repo_root).as_posix(), "referencePath": profile_input["referencePack"]["referencePath"], "referenceClipPaths": reference_paths, "sampleCount": len(samples)}]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (root / "corpus-input.json").write_text(json.dumps({
            "corpusVersion": "vocalset-1.0-cc-by4-isolated-vocal",
            "requiredSpeechCategories": [],
            "minimumSpeechCases": 0,
            "minimumSpeechProfiles": 0,
            "minimumSongCases": SOURCE_CASES,
            "minimumSongProfiles": 1,
            "speech": [],
            "song": cases,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"outputRoot": str(root), "targetSinger": target_singer, "songCases": len(cases), "legalUseConfirmed": bool(parsed.confirm_cc_by), "limitation": "isolated_vocal_only"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
