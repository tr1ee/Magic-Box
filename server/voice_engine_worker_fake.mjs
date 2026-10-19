import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

function createFixtureWav({ durationSeconds = 1.6, frequency = 220 } = {}) {
  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const carrier = Math.sin(2 * Math.PI * frequency * (index / sampleRate));
    const overtone = Math.sin(2 * Math.PI * frequency * 2.01 * (index / sampleRate)) * 0.18;
    const envelope = Math.min(1, index / (sampleRate * 0.04), (sampleCount - index) / (sampleRate * 0.05));
    const value = Math.max(-1, Math.min(1, (carrier * 0.32 + overtone) * Math.max(0, envelope)));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

function silenceWavCopy(buffer) {
  const output = Buffer.from(buffer);
  const dataMarker = Buffer.from("data", "ascii");
  const dataOffset = output.indexOf(dataMarker, 12);
  if (dataOffset < 0 || dataOffset + 8 > output.length) return output;
  const dataSize = Math.min(output.readUInt32LE(dataOffset + 4), output.length - dataOffset - 8);
  output.fill(0, dataOffset + 8, dataOffset + 8 + dataSize);
  return output;
}

function fakeLanguage(value, fallback = "en") {
  const key = String(value || "").trim().toLowerCase();
  if (["zh", "en", "ja"].includes(key)) {
    return key;
  }
  const fallbackKey = String(fallback || "").trim().toLowerCase();
  return ["zh", "en", "ja"].includes(fallbackKey) ? fallbackKey : "en";
}

function fakeSynthesisIntegrity(request) {
  const fixture = String(request.integrityFixture || request.settings?.integrityFixture || "");
  const audioPath = String(request.audioPath || "");
  const finalOnlyFailures = fixture.startsWith("final-")
    ? (/validated-speech\.wav$/u.test(audioPath) ? fixture.slice("final-".length).split("+").filter(Boolean) : [])
    : null;
  const rankedTremble = fixture === "tremble-ranked";
  const malformedTrembleMetric = fixture === "tremble-malformed-metric";
  const inconsistentAcceptedCoverage = fixture === "accepted-low-coverage";
  const inconsistentAcceptedHum = fixture === "accepted-hum";
  const inconsistentAcceptedMetric = fixture === "accepted-malformed-metric";
  const finalInconsistentAcceptedCoverage = fixture === "final-accepted-low-coverage";
  const advisoryThenHard = fixture === "tremble-then-missing";
  const attemptNumber = Number(audioPath.match(/attempt-(\d+)\.wav$/u)?.[1]) || 0;
  const retriedClauseFailure = fixture === "clause-2-retry-once"
    && /clause-2-attempt-1\.wav$/u.test(String(request.audioPath || ""));
  const retriedMultiFailure = fixture === "missing-hum-retry-once"
    && /attempt-1\.wav$/u.test(String(request.audioPath || ""));
  const failures = retriedClauseFailure
    ? ["missing"]
    : fixture === "clause-2-retry-once"
      ? []
      : retriedMultiFailure
        ? ["missing", "hum"]
        : fixture === "missing-hum-retry-once"
          ? []
          : inconsistentAcceptedCoverage
            ? ["missing"]
            : inconsistentAcceptedHum
              ? ["hum"]
              : inconsistentAcceptedMetric
                ? []
            : finalInconsistentAcceptedCoverage
              ? (/validated-speech\.wav$/u.test(audioPath) ? ["missing"] : [])
              : advisoryThenHard
                ? (/validated-speech\.wav$/u.test(audioPath) ? [] : attemptNumber === 1 ? ["tremble"] : ["missing"])
          : finalOnlyFailures !== null
            ? finalOnlyFailures
            : rankedTremble || malformedTrembleMetric
              ? ["tremble"]
              : fixture ? fixture.split("+").filter(Boolean) : [];
  const supportedFailures = new Set(["missing", "silent", "hum", "tremble", "excess", "rough"]);
  const unknownFailure = failures.find((failure) => !supportedFailures.has(failure));
  if (unknownFailure) {
    throw new Error(`Unsupported fake Voice integrity fixture: ${unknownFailure}`);
  }
  const hasFailure = (failure) => failures.includes(failure);
  const trembleScore = rankedTremble
    ? ({ 1: 0.61, 2: 0.32, 3: 0.48 }[attemptNumber] || 0.56)
    : 0.62;
  const reasons = [
    ...(hasFailure("missing") ? ["ordered_text_coverage_low"] : []),
    ...(hasFailure("silent") ? ["speech_activity_low"] : []),
    ...(hasFailure("hum") ? ["line_hum_detected"] : []),
    ...(hasFailure("tremble") ? ["unstable_amplitude_detected"] : []),
    ...(hasFailure("excess") ? ["unexpected_text_excess"] : []),
    ...(hasFailure("rough") && request.settings?.enforceSpectralQuality ? ["electronic_roughness_detected"] : [])
  ];
  const accepted = inconsistentAcceptedCoverage
    || inconsistentAcceptedHum
    || inconsistentAcceptedMetric
    || (finalInconsistentAcceptedCoverage && reasons.length > 0)
    ? true
    : reasons.length === 0;
  const reason = reasons[0] || "";
  return {
    accepted,
    coverage: hasFailure("missing") ? 0.5 : 1,
    expectedTokenCount: 4,
    observedTokenCount: hasFailure("missing") ? 2 : hasFailure("excess") ? 8 : 4,
    waveformHealth: {
      activity: hasFailure("silent") ? 0 : 0.92,
      lineHumRatio: hasFailure("hum") ? 0.4 : 0.03,
      lineHumFrequencyHz: hasFailure("hum") ? 60 : 0,
      modulationScore: malformedTrembleMetric || inconsistentAcceptedMetric ? "0.32" : hasFailure("tremble") ? trembleScore : 0.08,
      baselineAudioPathCount: Array.isArray(request.baselineAudioPaths) ? request.baselineAudioPaths.length : 0,
      maxLocalModulationScore: hasFailure("tremble") ? trembleScore : 0.08,
      persistentModulationSeconds: hasFailure("tremble") ? 1.4 : 0,
      persistentModulationDetected: hasFailure("tremble"),
      highFrequencyRatio: hasFailure("rough") ? 0.11 : 0.025,
      highToPresenceRatio: hasFailure("rough") ? 0.7 : 0.18,
      electronicRoughnessDetected: hasFailure("rough")
    },
    reason,
    reasons
  };
}

async function handleRequest(request) {
  const engine = request.engine || "openvoice-v2-local";
  const modelVersion = engine === "gpt-sovits-local"
    ? "gpt-sovits-fake-ci"
    : engine === "seed-vc-svc-local"
      ? "seed-vc-svc-fake-ci"
      : engine === "voice-preparation-local"
        ? "voice-preparation-fake-ci"
      : "openvoice-v2-fake-ci";

  if (request.action === "health") {
    return {
      engine,
      modelVersion,
      runtimeReady: true,
      installed: true,
      conversionReady: true,
      separationReady: true,
      asrReady: true,
      modelsReady: true,
      device: process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU ? "cuda" : "cpu",
      gpuAvailable: Boolean(process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU)
    };
  }

  if (request.action === "separate" || request.action === "separate-stems") {
    await fs.mkdir(path.dirname(request.vocalPath), { recursive: true });
    await fs.mkdir(path.dirname(request.accompanimentPath), { recursive: true });
    const sourceAudio = await fs.readFile(request.sourceAudioPath);
    await fs.writeFile(request.vocalPath, sourceAudio);
    await fs.writeFile(request.accompanimentPath, request.action === "separate-stems" ? silenceWavCopy(sourceAudio) : sourceAudio);
    return {
      vocalPath: request.vocalPath,
      accompanimentPath: request.accompanimentPath,
      separationStrategy: "demucs-htdemucs",
      model: "htdemucs",
      device: process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU ? "cuda" : "cpu",
      warnings: ["Generated by the fake Demucs worker used for automated tests."]
    };
  }

  if (request.action === "analyze-song-conversion") {
    const fixture = String(request.settings?.songIntegrityFixture || "");
    const attempt = Math.max(1, Math.round(Number(request.attempt) || 1));
    const repairCandidateSelection = fixture === "repair-candidate-selection";
    const multiIntervalBudget = fixture === "many-interval-budget";
    const advisoryFallback = fixture === "song-advisory-fallback";
    const advisoryInvalidMetrics = fixture === "song-advisory-invalid-metrics";
    const advisoryInvalidDomain = fixture === "song-advisory-invalid-domain";
    const inconsistentStrict = fixture === "song-strict-inconsistent";
    const inconsistentStrictMetrics = fixture === "song-strict-inconsistent-metrics";
    const shouldFail = fixture === "always-fail"
      || (fixture === "fail-first" && request.phase === "full" && attempt === 1)
      || (repairCandidateSelection && request.phase !== "final")
      || multiIntervalBudget
      || advisoryFallback
      || advisoryInvalidMetrics
      || advisoryInvalidDomain;
    const identityFailure = fixture === "identity-fail";
    const accepted = inconsistentStrict || inconsistentStrictMetrics || (!shouldFail && !identityFailure);
    const shortRepairCandidate = (repairCandidateSelection || multiIntervalBudget) && request.phase === "repair";
    const fullAdvisoryCandidate = advisoryFallback && request.phase === "full";
    return {
      accepted,
      score: accepted ? 1.24 : fullAdvisoryCandidate ? 0.4 : identityFailure ? 0.31 : 0.42,
      reasons: inconsistentStrict
        ? ["target_identity_weak"]
        : accepted
        ? []
        : (fullAdvisoryCandidate || advisoryInvalidMetrics || advisoryInvalidDomain) ? ["pitch_discontinuity", "localized_pitch_failure"]
          : identityFailure ? ["target_identity_weak"] : ["voiced_pitch_dropout"],
      metrics: advisoryInvalidMetrics ? {} : {
        sourceDurationSeconds: Number(request.durationSeconds) || 2.4,
        convertedDurationSeconds: Number(request.durationSeconds) || 2.4,
        durationDeltaPercent: 0,
        onsetLagMs: 0,
        sourceVoicedFrames: 180,
        pairedVoicedFrames: inconsistentStrictMetrics ? 0 : accepted ? 176 : fullAdvisoryCandidate ? 175 : 120,
        voicedDropoutPercent: inconsistentStrictMetrics ? 0 : accepted ? 2.2222 : fullAdvisoryCandidate ? 1.2 : shortRepairCandidate ? 7.438 : 9.5,
        medianPitchErrorCents: advisoryInvalidDomain ? -1 : accepted ? 8.4 : 41.2,
        pitchOver100CentsPercent: accepted ? 1.1 : fullAdvisoryCandidate ? 1.9 : shortRepairCandidate ? 2.6786 : 8.2,
        abruptPitchJumpCount: advisoryInvalidDomain ? -5 : accepted ? 0 : fullAdvisoryCandidate ? 54 : shortRepairCandidate ? 2 : 5,
        abruptPitchJumpsPerMinute: accepted ? 0 : fullAdvisoryCandidate ? 11.86 : shortRepairCandidate ? 90 : 12.5,
        sourceTargetSimilarity: advisoryInvalidDomain ? 2 : shortRepairCandidate ? 0.353931 : 0.28,
        targetSimilarity: inconsistentStrict ? 0.4 : accepted ? 0.78 : fullAdvisoryCandidate ? 0.605 : shortRepairCandidate ? 0.482081 : identityFailure ? 0.4 : 0.6,
        targetSimilarityFloor: 0.55,
        targetReferenceCount: Math.max(1, request.targetReferenceAudioPaths?.length || 0)
      },
      problemIntervals: shouldFail && request.phase === "full" && !advisoryInvalidMetrics && !advisoryInvalidDomain
        ? (multiIntervalBudget
            ? Array.from({ length: 3 }, (_item, index) => ({
                startSeconds: index * 0.65,
                endSeconds: index * 0.65 + 0.5,
                issueSeconds: 0.12
              }))
            : [{ startSeconds: 0.4, endSeconds: 1.8, issueSeconds: 0.5 }])
        : [],
      f0Gate: {
        available: true,
        passed: true,
        status: "passed",
        rmvpeVoicedFrames: 180,
        fcpeVoicedFrames: 180,
        medianDisagreementCents: 18,
        reasons: []
      },
      engine,
      device: process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_GPU ? "cuda" : "cpu"
    };
  }

  if (request.action === "prepare-profile-source") {
    const fakeDelayMs = Math.max(0, Math.min(5000, Number(process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_PREPARATION_DELAY_MS) || 0));
    if (fakeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, fakeDelayMs));
    }
    const outputDir = path.resolve(String(request.outputDir || ""));
    const sourceAudioPath = path.resolve(String(request.sourceAudioPath || ""));
    if (!request.outputDir || !request.sourceAudioPath) {
      throw new Error("Fake Voice Preparation requires an original source and a revision output directory.");
    }
    const vocalPath = path.join(outputDir, "vocal.wav");
    const accompanimentPath = path.join(outputDir, "accompaniment.wav");
    const clipsDir = path.join(outputDir, "clips");
    const reusingPreparedVocal = Boolean(request.preparedVocalPath && request.preparedAccompanimentPath);
    await fs.mkdir(clipsDir, { recursive: true });
    await fs.copyFile(reusingPreparedVocal ? request.preparedVocalPath : sourceAudioPath, vocalPath);
    await fs.copyFile(reusingPreparedVocal ? request.preparedAccompanimentPath : sourceAudioPath, accompanimentPath);
    const sourceDurationSeconds = Math.max(0, Number(request.sourceDurationSeconds) || 4);
    const defaultTranscript = request.fixtureTranscript || (fakeLanguage(request.language, "en") === "zh" ? "本地准备语音样本。" : fakeLanguage(request.language, "en") === "ja" ? "ローカル音声サンプルです。" : "Prepared local voice sample.");
    const fixtureSegmentCount = Math.max(1, Math.ceil(sourceDurationSeconds / 8));
    const fixtureSegments = Array.isArray(request.fixtureSegments) ? request.fixtureSegments : Array.from(
      { length: fixtureSegmentCount },
      (_item, index) => {
        const startSeconds = Number((sourceDurationSeconds * index / fixtureSegmentCount).toFixed(3));
        const endSeconds = Number((sourceDurationSeconds * (index + 1) / fixtureSegmentCount).toFixed(3));
        return {
          transcript: defaultTranscript,
          startSeconds,
          endSeconds,
          speechConfidence: 0.96,
          transcriptConfidence: 0.96,
          boundary: "complete",
          boundaryConfidence: 0.96
        };
      }
    );
    await Promise.all(fixtureSegments.map((segment, index) => (
      segment.audioPath === null
        ? Promise.resolve()
        : fs.copyFile(sourceAudioPath, path.join(clipsDir, `${String(index + 1).padStart(3, "0")}.wav`))
    )));
    return {
      vocalPath,
      accompanimentPath,
      segments: fixtureSegments.map((segment, index) => {
        const transcript = String(segment.transcript || "").trim();
        const durationSeconds = Math.max(0, Number(segment.durationSeconds) || Number(segment.endSeconds) - Number(segment.startSeconds) || 0);
        const speechConfidence = Number(segment.speechConfidence ?? 0.96);
        const transcriptConfidence = Number(segment.transcriptConfidence ?? 0.96);
        const boundary = segment.boundary || "complete";
        const boundaryConfidence = Number(segment.boundaryConfidence ?? (boundary === "complete" ? 0.96 : 0.62));
        const reasons = Array.isArray(segment.exclusionReasons) ? segment.exclusionReasons : [];
        const eligible = Boolean(transcript && durationSeconds >= 2.5 && durationSeconds <= 10 && speechConfidence >= 0.65 && transcriptConfidence >= 0.82 && boundary === "complete" && boundaryConfidence >= 0.85 && !reasons.length);
        return {
          id: `clip-${String(index + 1).padStart(3, "0")}`,
          index,
          audioPath: segment.audioPath === null ? "" : path.join(clipsDir, `${String(index + 1).padStart(3, "0")}.wav`),
          startSeconds: Number(segment.startSeconds) || 0,
          endSeconds: Number(segment.endSeconds) || durationSeconds,
          durationSeconds,
          transcript,
          transcriptLanguage: fakeLanguage(request.language, "en"),
          speechConfidence,
          transcriptConfidence,
          boundary,
          boundaryConfidence,
          qualityVerdict: segment.qualityVerdict || (eligible ? "eligible" : transcript ? "needs-review" : "rejected"),
          exclusionReasons: reasons,
          includeInTraining: segment.includeInTraining ?? eligible,
          preferredPrompt: Boolean(segment.preferredPrompt)
        };
      }),
      runtime: {
        engine,
        modelVersion,
        separation: "demucs-fake",
        asr: "faster-whisper-fake",
        reusedPreparedVocal: reusingPreparedVocal,
        sourceTrimApplied: Boolean(request.trimApplied),
        sourceTrimStartSeconds: Boolean(request.trimApplied) ? Math.max(0, Number(request.trimStartSeconds) || 0) : 0,
        sourceTrimEndSeconds: Boolean(request.trimApplied) && Number.isFinite(Number(request.trimEndSeconds))
          ? Number(request.trimEndSeconds)
          : null
      },
      warnings: ["Generated by the fake Voice Preparation worker used for automated tests."]
    };
  }

  if (request.action === "validate-synthesis") {
    return fakeSynthesisIntegrity(request);
  }

  if (request.action === "evaluate-quality-batch") {
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    return {
      available: true,
      evaluatorVersions: {
        speaker: "eres2netv2-fake-ci",
        perceptual: "dnsmos-nisqa-utmos-fake-ci"
      },
      results: candidates.map((candidate, index) => ({
        id: String(candidate?.id || index + 1),
        encoderB: {
          passed: true,
          score: 0.82 - index * 0.01,
          identityGain: 0.25,
          targetSimilarity: 0.82 - index * 0.01,
          targetSimilarityFloor: 0.55,
          targetReferenceCount: Math.max(1, request.targetReferenceAudioPaths?.length || 1),
          embeddingCount: 4,
          evaluatorVersion: "eres2netv2-fake-ci"
        },
        perceptual: {
          available: true,
          status: "strict",
          score: 0.78 - index * 0.01,
          dnsMos: { ovrl: 3.8, sig: 3.9, bak: 3.7, p808: 3.8 },
          nisqa: { mos: 3.8, discontinuity: 0.01, coloration: 0.01 },
          utmos: 0.78 - index * 0.01,
          evaluatorVersion: "dnsmos-nisqa-utmos-fake-ci"
        }
      }))
    };
  }

  if (request.action === "validate-synthesis-batch" || request.action === "validate-synthesis-waveform-batch") {
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    if (request.settings?.forbidEmotionTagExpectedText
      && candidates.some((candidate) => /\((?:excited|happy|sad|angry|calm|whisper|serious|neutral)\)/iu.test(String(candidate?.expectedText || "")))) {
      throw new Error("Voice integrity validation received an unspoken emotion control tag.");
    }
    return {
      results: candidates.map((candidate, index) => ({
        id: String(candidate?.id || index + 1),
        ...fakeSynthesisIntegrity({ ...request, ...(candidate || {}) })
      }))
    };
  }

  if (request.action === "validate-conversion-batch") {
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    const contractFixture = String(request.settings?.conversionContractFixture || "");
    const sourceTranscriptTokenCount = contractFixture === "missing-source-count"
      ? undefined
      : contractFixture === "string-source-count"
        ? "10"
        : contractFixture === "zero-source-count"
          ? 0
          : 10;
    let results = candidates.map((candidate, index) => ({
      id: String(candidate?.id || index + 1),
      ...fakeSynthesisIntegrity({ ...request, ...(candidate || {}) }),
      expectedTokenCount: 10,
      observedTokenCount: 10
    }));
    if (contractFixture === "duplicate-candidate" && results.length > 1) {
      results[1].id = results[0].id;
    } else if (contractFixture === "partial-candidates") {
      results = results.slice(0, -1);
    } else if (contractFixture === "invalid-observed-count" && results.length) {
      results[0].observedTokenCount = 0;
    } else if (contractFixture === "duplicated-observed-count" && results.length) {
      results[0].observedTokenCount = 20;
    }
    return {
      ...(sourceTranscriptTokenCount === undefined ? {} : { sourceTranscriptTokenCount }),
      results
    };
  }

  if (request.action === "analyze-conversion-alignment") {
    const fixture = String(request.settings?.conversionAlignmentFixture || "");
    return {
      sourceDurationSeconds: 2,
      convertedDurationSeconds: fixture === "short-duration" ? 1.2 : 2,
      sourceLeadingActivitySeconds: 0.1,
      convertedLeadingActivitySeconds: fixture === "large-lag" ? 0.6 : fixture === "correctable-lag" ? 0.2 : 0.1,
      onsetLagMs: fixture === "large-lag" ? 500 : fixture === "correctable-lag" ? 100 : 0
    };
  }

  if (request.action === "analyze-speaker-identity-batch") {
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    const flatIdentity = request.settings?.refinementIdentityFixture === "flat";
    const sourceTargetSimilarity = 0.4;
    const targetSimilarityFloor = 0.55;
    return {
      sourceTargetSimilarity,
      targetSimilarityFloor,
      targetReferenceCount: Math.max(1, Array.isArray(request.targetReferenceAudioPaths) ? request.targetReferenceAudioPaths.length : 1),
      device: "fake",
      results: candidates.map((candidate, index) => {
        const id = String(candidate?.id || index + 1);
        const targetBlendRatio = id === "target-100"
          ? 1
          : Math.max(0, Math.min(1, Number(id.match(/(\d+)$/)?.[1] || 0) / 100));
        const targetSimilarity = flatIdentity
          ? 0.42
          : Math.min(0.95, sourceTargetSimilarity + targetBlendRatio * 0.5);
        return {
          id,
          accepted: targetSimilarity >= targetSimilarityFloor,
          targetSimilarity,
          identityGain: targetSimilarity - sourceTargetSimilarity
        };
      })
    };
  }

  if (request.action === "repair-synthesis-batch") {
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    const results = [];
    for (const [index, candidate] of candidates.entries()) {
      const audioPath = String(candidate?.audioPath || "");
      const outputPath = String(candidate?.outputPath || "");
      if (!audioPath || !outputPath) {
        throw new Error("Fake Voice remediation needs readable input and output WAV paths.");
      }
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.copyFile(audioPath, outputPath);
      results.push({
        id: String(candidate?.id || index + 1),
        outputPath,
        appliedFilters: ["dc_offset", "notch_60hz", "notch_120hz"],
        lineHumFrequencyHz: Number(candidate?.lineHumFrequencyHz) || 60
      });
    }
    return { results };
  }

  if (request.action === "build-profile") {
    const fakeBuildDelayMs = Math.max(0, Math.min(5000, Number(request.settings?.fakeBuildDelayMs || process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_BUILD_DELAY_MS) || 0));
    if (fakeBuildDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, fakeBuildDelayMs));
    }
    if (engine === "gpt-sovits-local") {
      if (!request.promptText || !request.promptLanguage || !request.referenceAudioPath) {
        throw new Error("GPT-SoVITS fake worker requires prompt audio, prompt text, and prompt language.");
      }
      const checkpointProbePath = request.qualityMode === "fine"
        ? path.join(path.dirname(request.modelPath), "checkpoint-validation", "fake-gpt-calibration.wav")
        : "";
      if (checkpointProbePath) {
        await fs.mkdir(path.dirname(checkpointProbePath), { recursive: true });
        await fs.writeFile(checkpointProbePath, createFixtureWav({ durationSeconds: 2.4 }));
      }
      const checkpointValidation = request.qualityMode === "fine" ? [{
        path: path.join(path.dirname(request.modelPath), "fake-gpt.ckpt"),
        source: "new-e15",
        durationSeconds: 2.4,
        targetDurationSeconds: 2.4,
        calibrationText: "A complete local checkpoint calibration sentence.",
        language: fakeLanguage(request.language, "en"),
        probeAudioPath: checkpointProbePath,
        healthy: true,
        score: 0,
        error: ""
      }] : [];
      const checkpointIntegrityFixture = request.qualityMode === "fine"
        ? String(process.env.MAGIC_BOX_VOICE_ENGINE_FAKE_FINE_CHECKPOINT_INTEGRITY_FIXTURE || "")
        : "";
      const model = {
        engine,
        modelVersion,
        profileId: request.profileId,
        profileName: request.profileName,
        language: request.language,
        qualityMode: request.qualityMode,
        referenceAudioPath: request.referenceAudioPath,
        promptText: request.promptText,
        promptLanguage: request.promptLanguage,
        datasetSamples: request.datasetSamples || [],
        fineTuneDatasetPrepared: request.qualityMode === "fine",
        fineTuneTrainingCompleted: request.qualityMode === "fine",
        trainingDir: request.qualityMode === "fine" ? (request.trainingDir || path.join(path.dirname(request.modelPath), "training")) : "",
        datasetListPath: request.qualityMode === "fine" ? (request.datasetListPath || "") : "",
        gptWeightsPath: request.qualityMode === "fine" ? path.join(path.dirname(request.modelPath), "fake-gpt.ckpt") : "",
        sovitsWeightsPath: request.qualityMode === "fine" ? path.join(path.dirname(request.modelPath), "fake-sovits.pth") : "",
        trainingStats: request.qualityMode === "fine" ? {
          datasetSampleCount: Array.isArray(request.datasetSamples) ? request.datasetSamples.length : 0,
          gptEpochs: 15,
          sovitsEpochs: 8,
          gptBatchSize: 2,
          sovitsBatchSize: 2,
          cudaAvailable: false,
          version: "v2",
          gptCheckpointSelection: checkpointValidation[0] || null,
          gptCheckpointValidation: checkpointValidation
        } : null,
        checkpointIntegrityFixture,
        createdAt: new Date().toISOString(),
        fakeWorker: true
      };
      await fs.mkdir(path.dirname(request.modelPath), { recursive: true });
      if (model.gptWeightsPath) {
        await fs.writeFile(model.gptWeightsPath, "fake gpt weights", "utf8");
      }
      if (model.sovitsWeightsPath) {
        await fs.writeFile(model.sovitsWeightsPath, "fake sovits weights", "utf8");
      }
      await fs.writeFile(request.modelPath, JSON.stringify(model, null, 2), "utf8");
      return {
        profileModel: model,
        warnings: request.qualityMode === "fine" ? ["Fake GPT-SoVITS fine training completed for automated tests."] : []
      };
    }
    const model = {
      engine,
      modelVersion,
      profileId: request.profileId,
      profileName: request.profileName,
      language: request.language,
      referenceAudioPath: request.referenceAudioPath,
      auxiliaryReferenceAudioPaths: request.auxiliaryReferenceAudioPaths || [],
      speakerEmbeddingPath: request.speakerEmbeddingPath,
      createdAt: new Date().toISOString(),
      fakeWorker: true
    };
    await fs.mkdir(path.dirname(request.modelPath), { recursive: true });
    await fs.writeFile(request.modelPath, JSON.stringify(model, null, 2), "utf8");
    if (request.speakerEmbeddingPath) {
      await fs.writeFile(request.speakerEmbeddingPath, JSON.stringify({ fakeEmbedding: [0.1, 0.2, 0.3] }), "utf8");
    }
    return { profileModel: model };
  }

  if (request.action === "tts-batch") {
    const clauses = Array.isArray(request.clauses) ? request.clauses : [];
    const candidates = [];
    for (const [index, clause] of clauses.entries()) {
      const result = await handleRequest({
        ...request,
        action: "tts",
        text: clause?.text,
        outputPath: clause?.outputPath,
        style: clause?.style
      });
      candidates.push({
        id: String(clause?.id || index + 1),
        index: index + 1,
        text: String(clause?.text || ""),
        ...result
      });
    }
    return {
      candidates,
      engine,
      modelVersion,
      language: candidates[0]?.language || fakeLanguage(request.language, request.profileLanguage || request.voiceModel?.language),
      warnings: ["Generated by the fake neural worker used for automated tests."]
    };
  }

  if (request.action === "tts" || request.action === "v2v") {
    if (request.action === "v2v" && request.settings?.diagnosticFixture === "cuda-oom") {
      throw new Error("CUDA out of memory while allocating the Seed-VC refinement model.");
    }
    if (request.action === "v2v" && request.settings?.diagnosticFixture === "conversion-fail") {
      throw new Error("Seed-VC conversion fixture failed before producing audio.");
    }
    const fakeDelayMs = Math.max(0, Math.min(5000, Number(request.settings?.fakeDelayMs) || 0));
    if (fakeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, fakeDelayMs));
    }
    const language = fakeLanguage(request.language, request.profileLanguage || request.voiceModel?.language);
    const textLength = String(request.text || "").length;
    const durationSeconds = request.action === "tts"
      ? Math.max(0.8, Math.min(6, textLength / 14 || 1.2))
      : Math.max(0.8, Math.min(8, Number(request.durationSeconds) || 1.5));
    const frequency = request.action === "tts" ? 196 : 246;
    await fs.mkdir(path.dirname(request.outputPath), { recursive: true });
    await fs.writeFile(request.outputPath, createFixtureWav({ durationSeconds, frequency }));
    return {
      outputPath: request.outputPath,
      durationSeconds,
      engine,
      modelVersion,
      language,
      synthesisPreset: {
        integrityAttempt: Number(request.settings?.integrityAttempt) || 1,
        speed: Number(request.settings?.speed) || 1,
        style: String(request.style || "neutral"),
        styleStrength: Number(request.settings?.styleStrength) || 0,
        pitchSemitones: Number(request.settings?.pitch) || 0
      },
      appliedStyle: String(request.style || "neutral"),
      appliedStyleStrength: Number(request.settings?.styleStrength) || 0,
      appliedPitchSemitones: Number(request.settings?.pitch) || 0,
      recoverySplit: Number(request.settings?.integrityAttempt) >= 3
        ? "hard-capped"
        : Number(request.settings?.integrityAttempt) >= 2 ? "soft-punctuation" : "sentence",
      warnings: ["Generated by the fake neural worker used for automated tests."],
      gptSoVitsRequest: engine === "gpt-sovits-local" ? {
        text_lang: request.textLang,
        prompt_lang: request.promptLang,
        prompt_text: request.promptText,
        ref_audio_path: request.refAudioPath
      } : null
    };
  }

  if (request.action === "cancel") {
    return { cancelled: true };
  }

  throw new Error(`Unsupported fake worker action: ${request.action}`);
}

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

reader.on("line", async (line) => {
  let request = null;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id: request?.id || null,
      ok: false,
      error: error.message || "Fake voice worker failed."
    })}\n`);
  }
});
