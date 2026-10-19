"""Build leakage-safe contiguous Song training clips from the existing train split.

Only entries already in the source dataset's train split are concatenated. The
original validation and locked-test entries are preserved unchanged.
"""

import hashlib
import json
import os
import sys
import wave
from pathlib import Path


def stable_hash(value):
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_wave(path):
    with wave.open(str(path), "rb") as handle:
        params = handle.getparams()
        frames = handle.readframes(handle.getnframes())
    if params.sampwidth != 2:
        raise RuntimeError(f"Expected 16-bit PCM WAV: {path}")
    if params.framerate != 44100:
        raise RuntimeError(f"Expected native 44.1 kHz WAV: {path}")
    return params, frames


def write_wave(path, params, frames):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setparams(params)
        handle.writeframes(frames)


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: build-vtv-song-contiguous-augmentation.py <source-dataset.json> <output-dataset.json> <output-root>")
    source_dataset_path = Path(sys.argv[1]).resolve()
    output_dataset_path = Path(sys.argv[2]).resolve()
    output_root = Path(sys.argv[3]).resolve()
    workspace_root = Path.cwd().resolve()
    dataset = json.loads(source_dataset_path.read_text(encoding="utf-8"))
    train_entries = list(dataset.get("splits", {}).get("train", []))
    if len(train_entries) < 2:
        raise RuntimeError("The source dataset needs at least two train entries.")

    silence_frames = round(0.05 * 44100)
    generated = []
    for index in range(0, len(train_entries) - 1, 2):
        left = train_entries[index]
        right = train_entries[index + 1]
        left_path = workspace_root / str(left["relativePath"]).replace("/", os.sep)
        right_path = workspace_root / str(right["relativePath"]).replace("/", os.sep)
        left_params, left_frames = read_wave(left_path)
        right_params, right_frames = read_wave(right_path)
        if left_params.nchannels != right_params.nchannels:
            raise RuntimeError("Augmentation requires matching channel counts.")
        silence = b"\x00" * (left_params.nchannels * left_params.sampwidth * silence_frames)
        frames = left_frames + silence + right_frames
        duration_seconds = len(frames) / (left_params.nchannels * left_params.sampwidth * left_params.framerate)
        if duration_seconds > 30:
            continue
        component_hash = stable_hash([left.get("audioSha256", ""), right.get("audioSha256", "")])
        relative_path = f"artifacts/vtv-public-data/vocalset-1.0-original-expanded/augmented-song-train/contiguous-{index + 1:03d}-{component_hash[:12]}.wav"
        output_path = workspace_root / relative_path.replace("/", os.sep)
        write_wave(output_path, left_params, frames)
        audio_hash = hashlib.sha256(output_path.read_bytes()).hexdigest()
        generated.append({
            "id": f"vocalset-f1-contiguous-train-{index + 1:03d}",
            "sourceSha256": component_hash,
            "audioSha256": audio_hash,
            "relativePath": relative_path,
            "durationSeconds": round(duration_seconds, 3),
            "voicedDurationSeconds": round(duration_seconds, 3),
            "sampleRate": 44100,
            "language": "und",
            "transcript": "",
            "mode": "song",
            "preparationStatus": "ready",
            "split": "train",
            "augmentation": {
                "type": "contiguous_train_pair_v1",
                "sourceEntryIds": [left["id"], right["id"]],
                "silenceSeconds": 0.05,
                "leakageSafe": True,
            },
        })

    if not generated:
        raise RuntimeError("No contiguous augmentation clips were generated.")
    entries = list(dataset["entries"]) + generated
    output = dict(dataset)
    output["entries"] = entries
    output["splits"] = dict(dataset["splits"])
    output["splits"]["train"] = list(dataset["splits"]["train"]) + generated
    output["totals"] = {
        "clipCount": len(entries),
        "durationSeconds": round(sum(float(item.get("durationSeconds", 0)) for item in entries), 3),
        "voicedDurationSeconds": round(sum(float(item.get("voicedDurationSeconds", 0)) for item in entries), 3),
    }
    output["leakageGroups"] = list(dataset.get("leakageGroups", [])) + [item["sourceSha256"] for item in generated]
    output["snapshotHash"] = stable_hash(entries)
    output["datasetId"] = f"vtv-dataset-{stable_hash({'profileId': output.get('profileId', ''), 'modelVersionId': output.get('modelVersionId', ''), 'mode': output.get('mode', 'song'), 'entries': entries})[:24]}"
    output["augmentation"] = {
        "type": "contiguous_train_pair_v1",
        "sourceDatasetId": dataset.get("datasetId", ""),
        "generatedCount": len(generated),
        "lockedTestUnchanged": True,
    }
    output_dataset_path.parent.mkdir(parents=True, exist_ok=True)
    output_dataset_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"datasetId": output["datasetId"], "generatedCount": len(generated), "trainCount": len(output["splits"]["train"]), "lockedTestCount": len(output["splits"]["lockedTest"])}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
