import assert from "node:assert/strict";
import test from "node:test";
import {
  maxVoiceSentenceSegmentsPerSample,
  voicePreparationSegments
} from "../server/voice-preparation-segments.mjs";

test("long-form preparation preserves every returned transcript segment", () => {
  const segments = Array.from({ length: 320 }, (_, index) => ({
    id: `clip-${index + 1}`,
    transcript: `Sentence ${index + 1}`
  }));

  const prepared = voicePreparationSegments(segments);

  assert.equal(prepared.length, 320);
  assert.equal(prepared.at(-1).transcript, "Sentence 320");
  assert.strictEqual(prepared, segments);
});

test("pathological preparation output fails explicitly instead of truncating", () => {
  const segments = Array.from({ length: maxVoiceSentenceSegmentsPerSample + 1 }, () => ({}));

  assert.throws(
    () => voicePreparationSegments(segments),
    (error) => error?.code === "VOICE_PREPARATION_SEGMENT_LIMIT_EXCEEDED"
  );
});

test("missing preparation segments normalize to an empty list", () => {
  assert.deepEqual(voicePreparationSegments(null), []);
});
