import assert from "node:assert/strict";
import test from "node:test";
import { registerVoiceCloneRoutes } from "../server/routes/voice-clone-routes.mjs";

function responseSpy() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createRouteHarness({ failPreparationCreate = false, songSettings = null } = {}) {
  const calls = [];
  const profileGets = [];
  const routes = new Map();
  const profile = {
    id: "profile-1",
    status: "ready",
    consentConfirmed: true,
    voiceModel: { engine: "openvoice" }
  };
  const app = {
    post(path, handler) {
      routes.set(path, handler);
    }
  };
  const services = {
    app,
    voiceIngress: {
      async parse(_request, schema) {
        calls.push(`parse:${schema}`);
        const fileField = schema === "profile" ? "files" : schema === "tts" ? "txtFile" : schema === "song" ? "sourceSong" : "sourceAudio";
        return {
          body: {
            profileId: profile.id,
            ...(schema === "song" && songSettings ? { settingsJson: JSON.stringify(songSettings) } : {})
          },
          files: [{ fieldname: fileField, originalname: fileField === "txtFile" ? "speech.txt" : "voice.wav", size: 12 }],
          id: `${schema}-ingress`
        };
      },
      async cleanup(ingress) {
        calls.push(`cleanup:${ingress.id}`);
      },
      async transfer(_file, ownership) {
        calls.push(`transfer:${ownership.kind}:${ownership.mode || "profile"}`);
        if (ownership.kind === "profile") {
          return { sample: { id: "sample-1", profileId: profile.id } };
        }
        return {
          source: {
            storedPath: "C:\\owned\\source.wav",
            inputDir: "C:\\owned",
            originalFileName: "source.wav",
            durationSeconds: 4,
            channels: 2,
            warnings: []
          }
        };
      }
    },
    profileStore: {
      async get(profileId, options = {}) {
        calls.push(`get:${profileId}:${options.mode || "profile"}`);
        profileGets.push({ profileId, options });
        return { profile, samples: [], maxSources: 20, addedSamples: [] };
      },
      async stageSample(record, _ownedFile, _analysis) {
        calls.push("stage-sample");
        const sample = {
          id: "sample-1",
          profileId: profile.id,
          preparation: { revision: 1, status: "queued" }
        };
        record.addedSamples.push(sample);
        return sample;
      },
      async finalizePreparation({ sampleId, status, errorCode }) {
        calls.push(`finalize:${sampleId}:${status}:${errorCode || ""}`);
        return {
          profile: { id: profile.id },
          sample: {
            id: sampleId,
            profileId: profile.id,
            preparation: { revision: 1, status }
          }
        };
      },
      async save(_record, options = {}) {
        calls.push(options.rollback ? "save:rollback" : "save:commit");
        return { profile: { id: profile.id }, samples: [{ id: "sample-1" }] };
      }
    },
    mediaTools: {
      async decodeText() {
        calls.push("decode-text");
        return "A local test sentence.";
      },
      async inspectSourceInput(ownedFile) {
        calls.push("inspect-source");
        return ownedFile.source;
      },
      async analyzeSample(ownedFile) {
        calls.push("analyze-sample");
        return { sample: ownedFile.sample };
      }
    },
    voiceJobs: {
      create({ type, profileId, sampleId, preparationRevision }) {
        calls.push(`create:${type}:${profileId}:${sampleId || ""}:${preparationRevision || ""}`);
        if (failPreparationCreate && type === "prepare-profile-source") {
          throw new Error("Preparation queue was unavailable.");
        }
        return { id: `${type}-job`, type, profileId, sampleId, preparationRevision, dispose: async () => calls.push(`dispose:${type}`) };
      },
      run(job, operation) {
        calls.push(`run:${job.type}`);
        void Promise.resolve().then(operation);
      },
      snapshot(job) {
        calls.push(`snapshot:${job.type}`);
        return { id: job.id, type: job.type, status: "pending" };
      }
    },
    engineGateway: {
      async runTts() {
        calls.push("engine:tts");
      },
      async runV2v() {
        calls.push("engine:v2v");
      },
      async runSongV2v() {
        calls.push("engine:song-v2v");
      }
    },
    preparationGateway: {
      async runProfileSource({ job, profileId, sampleId, revision }) {
        calls.push(`prepare:${job.type}:${profileId}:${sampleId}:${revision}`);
      }
    },
    settings: {
      defaultOutputDir() {
        calls.push("default-output-dir");
        return "C:\\MagicBox\\downloads";
      }
    }
  };
  registerVoiceCloneRoutes(services);
  return { calls, profileGets, routes, services };
}

async function invoke(harness, path) {
  const response = responseSpy();
  await harness.routes.get(path)({ params: { profileId: "profile-1" } }, response);
  await Promise.resolve();
  return response;
}

test("Voice Clone route module uses only its injected services for all multipart routes", async () => {
  const profileHarness = createRouteHarness();
  const profileResponse = await invoke(profileHarness, "/api/voice-clone/profiles/:profileId/samples");
  assert.equal(profileResponse.statusCode, 202);
  assert.deepEqual(profileResponse.body.job, {
    id: "prepare-profile-source-job",
    type: "prepare-profile-source",
    status: "pending"
  });
  assert.deepEqual(profileHarness.calls.filter((call) => typeof call === "string"), [
    "parse:profile",
    "get:profile-1:profile",
    "transfer:profile:profile",
    "analyze-sample",
    "stage-sample",
    "save:commit",
    "create:prepare-profile-source:profile-1:sample-1:1",
    "snapshot:prepare-profile-source",
    "cleanup:profile-ingress",
    "run:prepare-profile-source",
    "prepare:prepare-profile-source:profile-1:sample-1:1"
  ]);

  const ttsHarness = createRouteHarness();
  const ttsResponse = await invoke(ttsHarness, "/api/voice-clone/tts-file");
  assert.equal(ttsResponse.statusCode, 202);
  assert.deepEqual(ttsHarness.calls.slice(0, 7), [
    "parse:tts",
    "decode-text",
    "get:profile-1:tts",
    "create:tts:profile-1::",
    "default-output-dir",
    "cleanup:tts-ingress",
    "run:tts"
  ]);
  assert.equal(ttsHarness.calls.includes("engine:tts"), true);

  const v2vHarness = createRouteHarness();
  const v2vResponse = await invoke(v2vHarness, "/api/voice-clone/v2v");
  assert.equal(v2vResponse.statusCode, 202);
  assert.equal(v2vHarness.calls.includes("transfer:job:v2v"), true);
  assert.equal(v2vHarness.calls.includes("inspect-source"), true);
  assert.equal(v2vHarness.calls.includes("engine:v2v"), true);

  const songHarness = createRouteHarness();
  const songResponse = await invoke(songHarness, "/api/voice-clone/song-v2v");
  assert.equal(songResponse.statusCode, 202);
  assert.equal(songHarness.calls.includes("transfer:job:song-v2v"), true);
  assert.equal(songHarness.calls.includes("inspect-source"), true);
  assert.equal(songHarness.calls.includes("engine:song-v2v"), true);
});

test("modern Song VTV selection reaches profile validation with its explicit engine set", async () => {
  const harness = createRouteHarness({
    songSettings: {
      vtvEngineSelection: {
        mode: "compare",
        engineIds: ["rvc-v2-finetuned", "yingmusic-svc-zero-shot-v1"],
        primaryEngineId: "rvc-v2-finetuned"
      }
    }
  });
  const response = await invoke(harness, "/api/voice-clone/song-v2v");
  assert.equal(response.statusCode, 202);
  const getCall = harness.profileGets[0];
  assert.equal(getCall.options.conversionEngine, "rvc-v2-finetuned");
  assert.deepEqual(getCall.options.vtvEngineIds, ["rvc-v2-finetuned", "yingmusic-svc-zero-shot-v1"]);
});

test("Voice Clone profile upload preserves a committed source when preparation cannot queue", async () => {
  const harness = createRouteHarness({ failPreparationCreate: true });
  const response = await invoke(harness, "/api/voice-clone/profiles/:profileId/samples");
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.jobs.length, 0);
  assert.equal(harness.calls.includes("save:rollback"), false);
  assert.equal(harness.calls.includes("finalize:sample-1:needs-attention:preparation_queue_failed"), true);
  assert.equal(response.body.samples[0].preparation.status, "needs-attention");
});

test("Voice Clone route factory rejects missing ownership services and preserves typed errors", async () => {
  assert.throws(
    () => registerVoiceCloneRoutes({ app: { post() {} } }),
    /voiceIngress\.parse/u
  );

  const harness = createRouteHarness();
  harness.services.voiceIngress.parse = async () => {
    const error = new Error("The voice upload exceeds the request size limit.");
    error.code = "batch_too_large";
    error.status = 413;
    throw error;
  };
  harness.routes.clear();
  registerVoiceCloneRoutes(harness.services);
  const response = await invoke(harness, "/api/voice-clone/tts-file");
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.body, {
    error: "The voice upload exceeds the request size limit.",
    code: "batch_too_large"
  });
});
