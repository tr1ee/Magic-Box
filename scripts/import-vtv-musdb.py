"""Import a fixed MUSDB18 full-song subset for VTV Song regression.

MUSDB18 is distributed as stem MP4 files.  This importer extracts only a
small, deterministic test subset and keeps the dataset provenance local; the
archive is not copied into a distributable application package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


SAMPLE_RATE = 44_100
EXPECTED_SIZE = 4_684_228_845


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--tracks", type=int, default=8)
    parser.add_argument("--confirm-academic-use", action="store_true")
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--target-profile-json", type=Path, default=Path("artifacts/vtv-public-data/vocalset-1.0-original/extracted/profiles/vocalset-f1-song-profile.json"))
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_ffmpeg(explicit: Path | None) -> Path:
    candidates = [
        explicit,
        Path(os.environ["MAGICBOX_FFMPEG_PATH"]) if os.environ.get("MAGICBOX_FFMPEG_PATH") else None,
        Path("node_modules/ffmpeg-static/ffmpeg.exe"),
        Path("vendor/ffmpeg/bin/ffmpeg.exe"),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate.resolve()
    raise RuntimeError("ffmpeg is required; pass --ffmpeg or install the bundled runtime.")


def run_ffmpeg(ffmpeg: Path, args: list[str]) -> None:
    subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def extract_audio(ffmpeg: Path, stem_path: Path, stream: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(ffmpeg, [
        "-i", str(stem_path),
        "-map", stream,
        "-ar", str(SAMPLE_RATE),
        "-ac", "2",
        "-c:a", "pcm_s16le",
        str(output_path),
    ])


def extract_accompaniment(ffmpeg: Path, stem_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # MUSDB18 stream order is mixture, drums, bass, other, vocals.
    run_ffmpeg(ffmpeg, [
        "-i", str(stem_path),
        "-filter_complex", "[0:a:1][0:a:2][0:a:3]amix=inputs=3:duration=longest:normalize=0[accompaniment]",
        "-map", "[accompaniment]",
        "-ar", str(SAMPLE_RATE),
        "-ac", "2",
        "-c:a", "pcm_s16le",
        str(output_path),
    ])


def main() -> None:
    parsed = parse_args()
    archive = parsed.zip.resolve()
    root = parsed.output_root.resolve()
    repo_root = Path.cwd().resolve()
    if parsed.tracks < 2:
        raise RuntimeError("At least two fixed test tracks are required.")
    if not archive.exists():
        raise FileNotFoundError(archive)
    if archive.stat().st_size != EXPECTED_SIZE:
        raise RuntimeError(f"MUSDB18 archive is incomplete or unexpected size: {archive.stat().st_size} != {EXPECTED_SIZE}")
    ffmpeg = find_ffmpeg(parsed.ffmpeg)
    root.mkdir(parents=True, exist_ok=True)
    target_profile_path = (repo_root / parsed.target_profile_json).resolve() if not parsed.target_profile_json.is_absolute() else parsed.target_profile_json.resolve()
    if not target_profile_path.exists():
        raise RuntimeError(f"Target Song profile is required for full-song regression: {target_profile_path}")
    target_profile = json.loads(target_profile_path.read_text(encoding="utf-8"))
    target_profile_id = str(target_profile["profileId"])
    target_reference_path = str(target_profile["referencePack"]["referencePath"])
    target_reference_paths = [str(value) for value in target_profile["referencePack"].get("referenceClipPaths", [])]
    if not target_reference_paths or not all(Path(value).exists() for value in target_reference_paths):
        raise RuntimeError("Target Song reference pack is incomplete or contains missing clip paths.")

    with zipfile.ZipFile(archive) as bundle:
        members = sorted(
            name for name in bundle.namelist()
            if name.lower().endswith(".stem.mp4") and "/test/" in f"/{name.lower()}"
        )
        if len(members) < parsed.tracks:
            raise RuntimeError(f"MUSDB18 archive has only {len(members)} test stem files; need {parsed.tracks}.")
        selected = members[:parsed.tracks]
        cases: list[dict] = []
        with tempfile.TemporaryDirectory(prefix="vtv-musdb-") as staging_name:
            staging = Path(staging_name)
            for index, member in enumerate(selected, start=1):
                track_name = Path(member).name.removesuffix(".stem.mp4")
                safe_name = f"musdb18-test-{index:02d}"
                stem_path = staging / f"{safe_name}.stem.mp4"
                with bundle.open(member) as source, stem_path.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                source_hash = sha256_file(stem_path)
                case_dir = root / "cases"
                mixture_path = case_dir / f"{safe_name}-mixture.wav"
                vocal_path = case_dir / f"{safe_name}-vocals.wav"
                accompaniment_path = case_dir / f"{safe_name}-accompaniment.wav"
                extract_audio(ffmpeg, stem_path, "0:a:0", mixture_path)
                extract_audio(ffmpeg, stem_path, "0:a:4", vocal_path)
                extract_accompaniment(ffmpeg, stem_path, accompaniment_path)
                cases.append({
                    "id": safe_name,
                    "trackName": track_name,
                    "path": mixture_path.relative_to(repo_root).as_posix(),
                    "vocalStemPath": vocal_path.relative_to(repo_root).as_posix(),
                    "accompanimentStemPath": accompaniment_path.relative_to(repo_root).as_posix(),
                    "sha256": sha256_file(mixture_path),
                    "sourceSha256": source_hash,
                    "targetProfileId": target_profile_id,
                    "targetReferencePath": target_reference_path,
                    "targetReferencePaths": target_reference_paths,
                    "categories": ["song-full-mixture", "musdb18-test"],
                    "sampleRate": SAMPLE_RATE,
                    "channels": 2,
                    "legalUseConfirmed": bool(parsed.confirm_academic_use),
                    "split": "locked-test" if index <= 2 else "train",
                    "notes": "MUSDB18 mixture decoded from official stem MP4; academic/non-commercial dataset terms apply; not redistributed by the application.",
                })

    provenance = {
        "schemaVersion": "vtv-public-corpus-provenance-v1",
        "dataset": {
            "doi": "10.5281/zenodo.1117372",
            "record": "https://zenodo.org/records/1117372",
            "license": "MUSDB18 academic/non-commercial use terms; verify current record terms before redistribution",
            "attribution": "MUSDB18: A corpus for music source separation (Rafii et al.).",
            "archive": archive.relative_to(repo_root).as_posix(),
            "archiveSize": archive.stat().st_size,
            "archiveSha256": sha256_file(archive),
        },
        "legalUseConfirmed": bool(parsed.confirm_academic_use),
        "selectedSplit": "test",
        "selectedCount": len(cases),
        "limitations": ["academic_noncommercial_terms", "local_regression_subset", "not_for_redistribution"],
    }
    (root / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "corpus-input.json").write_text(json.dumps({
        "corpusVersion": "musdb18-1.0-full-mixture-test-subset",
        "requiredSpeechCategories": [],
        "minimumSpeechCases": 0,
        "minimumSpeechProfiles": 0,
        "minimumSongCases": len(cases),
        "minimumSongProfiles": 1,
        "speech": [],
        "song": cases,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputRoot": str(root), "cases": len(cases), "archiveSha256": provenance["dataset"]["archiveSha256"], "legalUseConfirmed": bool(parsed.confirm_academic_use)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
