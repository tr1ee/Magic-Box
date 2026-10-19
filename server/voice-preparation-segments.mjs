export const maxVoiceSentenceSegmentsPerSample = 4096;

export function voicePreparationSegments(segments) {
  const preparedSegments = Array.isArray(segments) ? segments : [];
  if (preparedSegments.length > maxVoiceSentenceSegmentsPerSample) {
    const error = new Error(
      `Voice Preparation produced ${preparedSegments.length} sentence clips, exceeding the supported limit of ${maxVoiceSentenceSegmentsPerSample}. Trim or split this source, then prepare it again.`
    );
    error.code = "VOICE_PREPARATION_SEGMENT_LIMIT_EXCEEDED";
    throw error;
  }
  return preparedSegments;
}
