import test from "node:test";
import assert from "node:assert/strict";
import { aggregateClauseSecondaryAsr, selectBestTtsClauses, selectStrictTtsRecoveryClauses } from "../server/voice/tts-clause-selection.mjs";

const clause = (index, coverage, secondaryCoverage = coverage) => ({
  index, text: `sentence ${index}`, audioPath: `clause-${index}-${coverage}.wav`, boundaryStrategy: "exact-converted-clause",
  validation: { accepted: coverage >= 0.92, coverage, expectedTokenCount: 8, observedTokenCount: 8, secondaryAsr: { available: true, coverage: secondaryCoverage, expectedTokenCount: 8, observedTokenCount: 8 }, waveformHealth: { modulationScore: 0.1 } }
});
const candidate = (id, clauses) => ({ id, synthesis: { acceptedClauses: clauses } });
const strict = validation => validation.accepted === true;

test("never assembles padded validation context even when both ASRs report full coverage", () => {
  const choices = [candidate("identity", [clause(1, .75), { ...clause(2, 1), boundaryStrategy: "padded-validation-only" }, clause(3, .917)]),
    candidate("recovery", [clause(1, 1), clause(2, .75), clause(3, 1)])];
  assert.equal(selectStrictTtsRecoveryClauses(choices, strict), null);
  choices[0].synthesis.acceptedClauses[1].boundaryStrategy = "silence-aligned-converted-clause";
  assert.equal(selectStrictTtsRecoveryClauses(choices, strict)[1].sourceCandidateId, "identity");
  choices[0].synthesis.acceptedClauses[1].validation.secondaryAsr.observedTokenCount = 10;
  assert.equal(selectStrictTtsRecoveryClauses(choices, strict), null);
});

test("conversion recovery requires passing evidence from both recognizers for every clause", () => {
  const choices = [candidate("identity", [clause(1, .75), clause(2, 1), clause(3, .917)]),
    candidate("recovery", [clause(1, 1), clause(2, .75), clause(3, 1)])];
  assert.deepEqual(selectStrictTtsRecoveryClauses(choices, strict).map(item => item.sourceCandidateId), ["recovery", "identity", "recovery"]);
  choices[0].synthesis.acceptedClauses[1].validation.secondaryAsr.coverage = .75;
  assert.equal(selectStrictTtsRecoveryClauses(choices, strict), null);
  choices[0].synthesis.acceptedClauses[1].validation.secondaryAsr = null;
  assert.equal(selectStrictTtsRecoveryClauses(choices, strict), null);
});

test("assembles the good middle clause instead of inheriting a weaker whole candidate", () => {
  const selected = selectBestTtsClauses([
    candidate("gpt-base-1", [clause(1, .75), clause(2, 1), clause(3, .857)]),
    candidate("gpt-base-3", [clause(1, 1), clause(2, .75), clause(3, 1)])
  ], strict);
  assert.deepEqual(selected.map(item => item.sourceCandidateId), ["gpt-base-3", "gpt-base-1", "gpt-base-3"]);
  assert.deepEqual(selected.map(item => item.clause.index), [1, 2, 3]);
});

test("secondary ASR controls clause selection and assembly retains its worst evidence", () => {
  const selected = selectBestTtsClauses([
    candidate("first", [clause(1, 1, .5), clause(2, 1)]),
    candidate("second", [clause(1, 1), clause(2, .75)])
  ], strict);
  assert.deepEqual(selected.map(item => item.sourceCandidateId), ["second", "first"]);
  const merged = aggregateClauseSecondaryAsr([clause(1, 1).validation, clause(2, 1, .5).validation]);
  assert.equal(merged.coverage, .5);
  assert.equal(merged.expectedTokenCount, 16);
  assert.equal(aggregateClauseSecondaryAsr([clause(1, 1).validation, {}]).available, false);
});

test("never borrows a different text and skips redundant whole-candidate copies", () => {
  const first = candidate("first", [clause(1, 1), clause(2, .75)]);
  const second = candidate("second", [clause(1, .75), { ...clause(2, 1), text: "different words" }]);
  assert.equal(selectBestTtsClauses([first, second], strict), null);
  assert.equal(selectBestTtsClauses([first], strict), null);
  assert.equal(aggregateClauseSecondaryAsr([{}, {}]), null);
});
