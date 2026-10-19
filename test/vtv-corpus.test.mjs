import test from "node:test";
import assert from "node:assert/strict";
import { buildVtvCorpusManifest, validateVtvCorpusManifest, VTV_CORPUS_SCHEMA } from "../server/voice/vtv/corpus.mjs";

const hash = (value) => String(value).padEnd(64, "0").slice(0, 64);

test("VTV corpus manifest rejects incomplete and leaking real-case definitions", () => {
  const manifest = buildVtvCorpusManifest({
    corpusVersion: "test-v1",
    speech: [{ id: "speech-1", path: "a.wav", sha256: hash("a"), sourceSha256: hash("source"), targetProfileId: "p1", category: "neutral", durationSeconds: 4, sampleRate: 32000, channels: 1, legalUseConfirmed: true, split: "train" }, { id: "speech-2", path: "b.wav", sha256: hash("b"), sourceSha256: hash("source"), targetProfileId: "p1", category: "fast", durationSeconds: 4, sampleRate: 32000, channels: 1, legalUseConfirmed: true, split: "locked-test" }],
    song: [{ id: "song-1", path: "song.wav", sha256: hash("song"), sourceSha256: hash("song"), targetProfileId: "p1", category: "dense", durationSeconds: 4, sampleRate: 32000, channels: 2, legalUseConfirmed: true, split: "train" }]
  });
  assert.equal(manifest.schemaVersion, VTV_CORPUS_SCHEMA);
  assert.equal(manifest.gate.passed, false);
  assert.ok(manifest.gate.errors.includes("source_leakage_group_crosses_splits:" + hash("source")));
  assert.ok(manifest.gate.errors.includes("song_sample_rate_not_44100:song-1"));
  assert.equal(validateVtvCorpusManifest(manifest).valid, false);
});

test("VTV corpus manifest preserves mode-specific requirements for isolated corpus runs", () => {
  const speech = buildVtvCorpusManifest({
    corpusVersion: "speech-only",
    minimumSpeechCases: 1,
    minimumSpeechProfiles: 1,
    minimumSongCases: 0,
    minimumSongProfiles: 0,
    speech: [{ id: "speech-1", path: "speech.wav", sha256: hash("a"), sourceSha256: hash("b"), targetProfileId: "p1", category: "neutral", durationSeconds: 4, sampleRate: 32000, channels: 1, legalUseConfirmed: true, split: "locked-test" }]
  });
  assert.equal(speech.gate.passed, true);
  assert.equal(validateVtvCorpusManifest(speech).valid, true);

  const song = buildVtvCorpusManifest({
    corpusVersion: "song-only",
    minimumSpeechCases: 0,
    minimumSpeechProfiles: 0,
    minimumSongCases: 1,
    minimumSongProfiles: 1,
    song: [{ id: "song-1", path: "song.wav", sha256: hash("c"), sourceSha256: hash("d"), targetProfileId: "p1", category: "isolated", durationSeconds: 4, sampleRate: 44100, channels: 2, legalUseConfirmed: true, split: "locked-test" }]
  });
  assert.equal(song.gate.passed, true);
  assert.equal(validateVtvCorpusManifest(song).valid, true);
});
