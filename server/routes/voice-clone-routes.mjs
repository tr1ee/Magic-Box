import {
  normalizeV2vEngine,
  normalizeVoiceLanguage,
  normalizeVtvSongEngineSelection,
  sanitizeUnicodeText
} from "../../shared/voiceClone.mjs";

const defaultMaxProfileSources = 20;
const defaultMaxVoiceTextLength = 5000;

function voiceRouteError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function responseError(response, error) {
  response.status(Number(error?.status) || 400).json({
    error: sanitizeUnicodeText(error?.message || "Voice request failed."),
    code: String(error?.code || "voice_request_failed")
  });
}

function callable(object, name, owner) {
  if (typeof object?.[name] !== "function") {
    throw new TypeError(`registerVoiceCloneRoutes requires ${owner}.${name}().`);
  }
}

function validateServices(services) {
  if (!services?.app || typeof services.app.post !== "function") {
    throw new TypeError("registerVoiceCloneRoutes requires an Express app with post().");
  }
  for (const [owner, methods] of Object.entries({
    voiceIngress: ["parse", "cleanup", "transfer"],
    profileStore: ["get", "save", "stageSample", "finalizePreparation"],
    mediaTools: ["decodeText", "inspectSourceInput", "analyzeSample"],
    voiceJobs: ["create", "run", "snapshot"],
    preparationGateway: ["runProfileSource"],
    engineGateway: ["runTts", "runV2v", "runSongV2v"],
    settings: ["defaultOutputDir"]
  })) {
    for (const method of methods) {
      callable(services[owner], method, owner);
    }
  }
}

function parseSettings(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    throw voiceRouteError("invalid_field", "Voice settings were not valid JSON.", 400);
  }
}

function normalizeOutputSettings(settings) {
  const outputFormat = String(settings?.outputFormat || settings?.output_format || "wav").toLowerCase();
  if (outputFormat !== "wav") {
    throw new Error("Voice Clone currently exports WAV output only. MP3 export can be added after the neural runtime is stable.");
  }
  return { ...settings, outputFormat: "wav" };
}

function normalizeSongMixGain(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1.8, Number(number.toFixed(2))));
}

function normalizeSongSettings(settings = {}) {
  const diffusionSteps = Number(settings.diffusionSteps ?? settings.diffusion_steps);
  const inferenceCfgRate = Number(settings.inferenceCfgRate ?? settings.inference_cfg_rate);
  const chunkCrossfadeMs = Number(settings.chunkCrossfadeMs ?? settings.chunk_crossfade_ms);
  const separationOverlap = Number(settings.separationOverlap ?? settings.separation_overlap);
  const hasModernSelection = Boolean(
    settings?.vtvEngineSelection
    || settings?.engineMode
    || Array.isArray(settings?.engineIds)
    || ["seed-vc-svc-v1", "rvc-v2-finetuned", "yingmusic-svc-zero-shot-v1"].includes(String(settings?.conversionEngine || settings?.conversion_engine || "").trim().toLowerCase())
  );
  return {
    ...settings,
    outputFormat: "wav",
    vocalVolume: normalizeSongMixGain(settings.vocalVolume ?? settings.vocal_volume, 1),
    accompanimentVolume: normalizeSongMixGain(settings.accompanimentVolume ?? settings.accompaniment_volume, 0.9),
    diffusionSteps: Number.isFinite(diffusionSteps) ? Math.max(12, Math.min(50, Math.round(diffusionSteps))) : 50,
    inferenceCfgRate: Number.isFinite(inferenceCfgRate) ? Math.max(0, Math.min(1, Number(inferenceCfgRate.toFixed(2)))) : 0.85,
    chunkCrossfadeMs: Number.isFinite(chunkCrossfadeMs) ? Math.max(180, Math.min(1200, Math.round(chunkCrossfadeMs))) : 750,
    separationOverlap: Number.isFinite(separationOverlap) ? Math.max(0.1, Math.min(0.75, Number(separationOverlap.toFixed(2)))) : 0.5,
    ...(hasModernSelection ? { vtvEngineSelection: normalizeVtvSongEngineSelection(settings) } : {})
  };
}

function normalizeTrimSeconds(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Trim range must use positive seconds.");
  }
  return Number(number.toFixed(3));
}

function parseTrimOptions(body = {}) {
  const start = normalizeTrimSeconds(body.trimStartSeconds ?? body.trim_start_seconds);
  const end = normalizeTrimSeconds(body.trimEndSeconds ?? body.trim_end_seconds);
  if (start !== null && end !== null && end <= start) {
    throw new Error("Trim end must be after trim start.");
  }
  return { start, end, applied: start !== null || end !== null };
}

function parseSampleMetadata(body = {}) {
  const raw = body.metadataJson ?? body.metadata_json ?? body.metadata;
  if (!raw) {
    return [];
  }
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw voiceRouteError("invalid_field", "Voice sample metadata was not valid JSON.", 400);
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

function trimOptionsFromMetadata(metadata = {}, fallback = {}) {
  return parseTrimOptions({
    trimStartSeconds: metadata.trimStartSeconds ?? metadata.trim_start_seconds ?? fallback.start,
    trimEndSeconds: metadata.trimEndSeconds ?? metadata.trim_end_seconds ?? fallback.end
  });
}

async function releaseIngress(voiceIngress, ingress) {
  if (ingress) {
    await voiceIngress.cleanup(ingress);
  }
}

function profileOrThrow(record) {
  if (!record?.profile) {
    throw voiceRouteError("voice_profile_not_found", "Voice profile was not found.", 404);
  }
  return record.profile;
}

function findFile(ingress, acceptedNames, missingMessage) {
  const file = ingress.files.find((item) => acceptedNames.includes(item.fieldname));
  if (!file) {
    throw voiceRouteError("invalid_media", missingMessage, 400);
  }
  return file;
}

export function registerVoiceCloneRoutes(services) {
  validateServices(services);
  const {
    app,
    voiceIngress,
    profileStore,
    mediaTools,
    voiceJobs,
    preparationGateway,
    engineGateway,
    settings
  } = services;

  app.post("/api/voice-clone/profiles/:profileId/samples", async (request, response) => {
    let ingress;
    let record;
    let committed = false;
    try {
      ingress = await voiceIngress.parse(request, "profile");
      record = await profileStore.get(String(request.params.profileId || ""));
      const profile = profileOrThrow(record);
      if (profile.consentConfirmed !== true) {
        throw new Error("Confirm that you own this voice or have permission to clone it.");
      }
      const files = ingress.files.filter((file) => file.fieldname === "files");
      if (!files.length) {
        throw voiceRouteError("invalid_media", "Choose at least one audio sample.", 400);
      }
      const maxSources = Number(record.maxSources || defaultMaxProfileSources);
      if ((record.samples?.length || 0) + files.length > maxSources) {
        throw voiceRouteError("too_many_files", `Profiles can contain up to ${maxSources} training sources.`, 400);
      }
      const trimOptions = parseTrimOptions(ingress.body);
      const metadataItems = parseSampleMetadata(ingress.body);
      const stagedSamples = [];
      for (const [index, file] of files.entries()) {
        const metadata = metadataItems[index] || {};
        const ownedFile = await voiceIngress.transfer(file, {
          kind: "profile",
          profile,
          trimOptions: trimOptionsFromMetadata(metadata, trimOptions),
          metadata
        });
        const analysis = await mediaTools.analyzeSample(ownedFile, { profile, metadata });
        const sample = await profileStore.stageSample(record, ownedFile, analysis, { metadata });
        stagedSamples.push(sample);
      }
      let saved = await profileStore.save(record);
      committed = true;
      const jobs = [];
      for (const sample of stagedSamples) {
        const preparationRevision = Number(sample?.preparation?.revision || 1);
        try {
          const job = voiceJobs.create({
            type: "prepare-profile-source",
            profileId: profile.id,
            sampleId: sample.id,
            preparationRevision
          });
          jobs.push(job);
        } catch (error) {
          const finalized = await profileStore.finalizePreparation({
            profileId: profile.id,
            sampleId: sample.id,
            preparationRevision,
            status: "needs-attention",
            errorCode: "preparation_queue_failed",
            message: "The original source was saved, but its local voice preparation could not start. Reprocess it from the profile when the local runtime is available."
          });
          if (finalized?.profile) {
            saved = {
              ...saved,
              profile: finalized.profile,
              samples: (saved?.samples || []).map((savedSample) => (
                savedSample?.id === finalized.sample?.id ? finalized.sample : savedSample
              ))
            };
          }
        }
      }
      const jobSnapshots = jobs.map((job) => voiceJobs.snapshot(job));
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      response.status(202).json({
        ...saved,
        job: jobSnapshots[0] || null,
        jobs: jobSnapshots
      });
      for (const job of jobs) {
        voiceJobs.run(job, () => preparationGateway.runProfileSource({
          job,
          profileId: profile.id,
          sampleId: job.sampleId,
          revision: job.preparationRevision
        }));
      }
    } catch (error) {
      if (record && !committed) {
        await profileStore.save(record, { rollback: true }).catch(() => {});
      }
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      responseError(response, error);
    } finally {
      await releaseIngress(voiceIngress, ingress);
    }
  });

  app.post("/api/voice-clone/tts-file", async (request, response) => {
    let ingress;
    try {
      ingress = await voiceIngress.parse(request, "tts");
      const body = ingress.body;
      const text = await mediaTools.decodeText(findFile(ingress, ["txtFile", "txt_file"], "Choose a .txt file."));
      if (!text.trim()) {
        throw voiceRouteError("invalid_media", "Text file was empty.", 400);
      }
      if (text.length > defaultMaxVoiceTextLength) {
        throw voiceRouteError("invalid_field", `Text is longer than the ${defaultMaxVoiceTextLength} character MVP limit.`, 400);
      }
      const record = await profileStore.get(String(body.profileId || body.profile_id || ""), { mode: "tts" });
      const profile = profileOrThrow(record);
      if (profile.status !== "ready" || !profile.voiceModel?.engine) {
        throw voiceRouteError("invalid_media", "Build this Target Voice Profile with a local neural engine before generating audio.", 400);
      }
      const job = voiceJobs.create({ type: "tts", profileId: profile.id });
      const payload = {
        profileId: profile.id,
        text,
        language: normalizeVoiceLanguage(body.language),
        settings: normalizeOutputSettings(parseSettings(body.settingsJson || body.settings_json)),
        outputDir: body.outputDir || body.output_dir,
        defaultOutputDir: settings.defaultOutputDir()
      };
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      voiceJobs.run(job, () => engineGateway.runTts({ job, payload }));
      response.status(202).json(voiceJobs.snapshot(job));
    } catch (error) {
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      responseError(response, error);
    } finally {
      await releaseIngress(voiceIngress, ingress);
    }
  });

  app.post("/api/voice-clone/v2v", async (request, response) => {
    let ingress;
    let job;
    let launched = false;
    try {
      ingress = await voiceIngress.parse(request, "v2v");
      const body = ingress.body;
      const settingsPayload = normalizeOutputSettings(parseSettings(body.settingsJson || body.settings_json));
      const modelVersionId = sanitizeUnicodeText(body.modelVersionId || body.model_version_id || "");
      const sourceTranscript = sanitizeUnicodeText(body.sourceTranscript || body.source_transcript || body.transcript || "").replace(/\s+/g, " ").trim();
      if (sourceTranscript) {
        throw voiceRouteError("invalid_field", "GPT-SoVITS transcript generation is Text to Voice, not source-audio conversion. Use Text to Voice for typed lyrics; true song vocal replacement needs an RVC/SVC conversion engine.", 400);
      }
      const conversionEngine = settingsPayload.vtvEngineSelection?.primaryEngineId
        || normalizeV2vEngine(settingsPayload.conversionEngine || settingsPayload.conversion_engine);
      const record = await profileStore.get(String(body.profileId || body.profile_id || ""), {
        mode: "v2v",
        modelVersionId,
        conversionEngine
      });
      const profile = profileOrThrow(record);
      job = voiceJobs.create({ type: "v2v", profileId: profile.id });
      const ownedFile = await voiceIngress.transfer(
        findFile(ingress, ["sourceAudio", "source_audio"], "Choose source audio."),
        { kind: "job", job, mode: "v2v" }
      );
      const source = await mediaTools.inspectSourceInput(ownedFile, { mode: "v2v" });
      job.inputDir = source.inputDir;
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      launched = true;
      const payload = {
        profileId: profile.id,
        modelVersionId,
        language: normalizeVoiceLanguage(body.language),
        settings: settingsPayload,
        outputDir: body.outputDir || body.output_dir,
        defaultOutputDir: settings.defaultOutputDir(),
        sourceAudioPath: source.storedPath,
        sourceAudioName: source.originalFileName,
        durationSeconds: source.durationSeconds,
        warnings: source.warnings
      };
      voiceJobs.run(job, () => engineGateway.runV2v({ job, payload }));
      response.status(202).json(voiceJobs.snapshot(job));
    } catch (error) {
      if (job && !launched) {
        await job.dispose?.();
      }
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      responseError(response, error);
    } finally {
      await releaseIngress(voiceIngress, ingress);
    }
  });

  app.post("/api/voice-clone/song-v2v", async (request, response) => {
    let ingress;
    let job;
    let launched = false;
    try {
      ingress = await voiceIngress.parse(request, "song");
      const body = ingress.body;
      const settingsPayload = normalizeSongSettings(normalizeOutputSettings(parseSettings(body.settingsJson || body.settings_json)));
      const modelVersionId = sanitizeUnicodeText(body.modelVersionId || body.model_version_id || "");
      const conversionEngine = settingsPayload.vtvEngineSelection?.primaryEngineId
        || normalizeV2vEngine(settingsPayload.conversionEngine || settingsPayload.conversion_engine);
      const record = await profileStore.get(String(body.profileId || body.profile_id || ""), {
        mode: "song-v2v",
        modelVersionId,
        conversionEngine,
        vtvEngineIds: settingsPayload.vtvEngineSelection?.engineIds
      });
      const profile = profileOrThrow(record);
      job = voiceJobs.create({ type: "song-v2v", profileId: profile.id });
      const ownedFile = await voiceIngress.transfer(
        findFile(ingress, ["sourceAudio", "source_audio", "sourceSong", "source_song"], "Choose source audio."),
        { kind: "job", job, mode: "song-v2v" }
      );
      const source = await mediaTools.inspectSourceInput(ownedFile, { mode: "song-v2v" });
      job.inputDir = source.inputDir;
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      launched = true;
      const payload = {
        profileId: profile.id,
        modelVersionId,
        language: normalizeVoiceLanguage(body.language),
        settings: settingsPayload,
        outputDir: body.outputDir || body.output_dir,
        defaultOutputDir: settings.defaultOutputDir(),
        sourceAudioPath: source.storedPath,
        sourceAudioName: source.originalFileName,
        durationSeconds: source.durationSeconds,
        channels: source.channels,
        warnings: source.warnings
      };
      voiceJobs.run(job, () => engineGateway.runSongV2v({ job, payload }));
      response.status(202).json(voiceJobs.snapshot(job));
    } catch (error) {
      if (job && !launched) {
        await job.dispose?.();
      }
      await releaseIngress(voiceIngress, ingress);
      ingress = null;
      responseError(response, error);
    } finally {
      await releaseIngress(voiceIngress, ingress);
    }
  });

  return {
    async close() {}
  };
}
