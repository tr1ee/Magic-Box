export function aggregateClauseSecondaryAsr(validations) {
  const values = validations.map(value => value?.secondaryAsr);
  if (!values.some(Boolean)) return null;
  if (values.some(value => value?.available !== true || !Number.isFinite(value.coverage))) {
    return { available: false, error: "An assembled clause is missing secondary ASR evidence." };
  }
  return {
    ...values[0], coverage: Math.min(...values.map(value => value.coverage)),
    expectedTokenCount: values.reduce((sum, value) => sum + (Number(value.expectedTokenCount) || 0), 0),
    observedTokenCount: values.reduce((sum, value) => sum + (Number(value.observedTokenCount) || 0), 0)
  };
}

export function selectBestTtsClauses(candidates, strictlyAccepted, eligible = () => true) {
  const template = candidates[0]?.synthesis?.acceptedClauses;
  if (!template || template.length < 2 || candidates.length < 2) return null;
  const selected = template.map((expected, index) => {
    const choices = candidates.flatMap(candidate => {
      const clauses = candidate.synthesis?.acceptedClauses;
      const clause = clauses?.[index];
      if (clauses?.length !== template.length || clause?.text !== expected.text || clause?.index !== expected.index || !eligible(clause)) return [];
      const validation = clause.validation;
      const secondary = validation?.secondaryAsr;
      const secondaryCoverage = secondary ? (secondary.available === true ? Number(secondary.coverage) || 0 : 0) : 1;
      return [{ clause, sourceCandidateId: candidate.id, rank: [
        Number(strictlyAccepted(validation) && secondaryCoverage >= 0.92),
        Math.min(Number(validation?.coverage) || 0, secondaryCoverage),
        -(Number(validation?.waveformHealth?.modulationScore) || 0)
      ] }];
    });
    choices.sort((left, right) => {
      for (let index = 0; index < left.rank.length; index++) if (left.rank[index] !== right.rank[index]) return right.rank[index] - left.rank[index];
      return left.sourceCandidateId.localeCompare(right.sourceCandidateId);
    });
    return choices[0];
  });
  if (selected.some(value => !value) || new Set(selected.map(value => value.sourceCandidateId)).size < 2) return null;
  return selected;
}

export function selectStrictTtsRecoveryClauses(candidates, strictlyAccepted) {
  const selected = selectBestTtsClauses(candidates, strictlyAccepted, clause =>
    ["exact-converted-clause", "silence-aligned-converted-clause"].includes(clause.boundaryStrategy));
  if (!selected || selected.some(({ clause }) => !strictlyAccepted(clause.validation)
    || !(Number(clause.validation?.coverage) >= 0.92)
    || clause.validation?.secondaryAsr?.available !== true
    || !(Number(clause.validation.secondaryAsr.coverage) >= 0.92)
    || ![clause.validation, clause.validation.secondaryAsr].every(value =>
      Number.isFinite(value.expectedTokenCount) && value.expectedTokenCount > 0
      && value.observedTokenCount === value.expectedTokenCount))) return null;
  return selected;
}
