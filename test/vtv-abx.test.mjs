import test from "node:test";
import assert from "node:assert/strict";
import { summarizeVtvAbxEvidence, validateVtvAbxEvidence } from "../server/voice/vtv/abx.mjs";

test("VTV ABX evidence requires two blind reviewers and complete coverage", () => {
  const incomplete = validateVtvAbxEvidence({ mode: "speech", corpus: [{ id: "case-1" }], responses: [] });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.errors.includes("reviewer_count_below_minimum"));

  const responses = [];
  for (const reviewerId of ["r1", "r2"]) {
    for (const dimension of ["target-similarity", "naturalness", "content", "artifact", "consistency"]) {
      responses.push({
        reviewerId,
        caseId: "case-1",
        dimension,
        preferredLabel: "A",
        presentedLabels: ["A", "B"],
        assignmentId: `assignment-${reviewerId}`,
        assignmentHash: "0123456789abcdef0123456789abcdef",
        recordedAt: "2026-08-25T00:00:00.000Z"
      });
    }
  }
  const valid = validateVtvAbxEvidence({ mode: "speech", corpus: [{ id: "case-1" }], responses });
  assert.equal(valid.valid, true);
  assert.equal(valid.reviewerCount, 2);
  assert.equal(summarizeVtvAbxEvidence(valid).totals.A, 10);
});
