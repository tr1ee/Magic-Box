import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../server/index.mjs";

let context;
let root;
let previousSettings;
let previousFakeEngine;

function wavFixture() {
  const sampleRate = 16000;
  const frameCount = sampleRate;
  const buffer = Buffer.alloc(44 + frameCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frameCount * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frameCount * 2, 40);
  return buffer;
}

async function postJson(pathname, body) {
  const response = await fetch(`${context.url}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-voice-ingress-"));
  previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
  previousFakeEngine = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
  process.env.MAGIC_BOX_SETTINGS_FILE = path.join(root, "settings.json");
  process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = "1";
  context = await startServer({
    port: 0,
    dht: false,
    lsd: false,
    tracker: false,
    defaultDownloadDir: path.join(root, "downloads"),
    assistantDataDir: path.join(root, "assistant"),
    voiceIngressLimits: {
      profile: { fileBytes: 256 * 1024, requestBytes: 512 * 1024 },
      tts: { fileBytes: 64 * 1024, requestBytes: 128 * 1024 },
      v2v: { fileBytes: 256 * 1024, requestBytes: 512 * 1024 },
      song: { fileBytes: 256 * 1024, requestBytes: 512 * 1024 },
      rvcModel: { fileBytes: 256 * 1024, requestBytes: 1024 * 1024 }
    }
  });
});

after(async () => {
  await context?.close();
  await fs.rm(root, { recursive: true, force: true });
  if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
  else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
  if (previousFakeEngine === undefined) delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
  else process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = previousFakeEngine;
});

test("Voice ingress accepts one valid profile sample and rejects an unknown multipart field", async () => {
  const { response: profileResponse, payload: profile } = await postJson("/api/voice-clone/profiles", {
    name: "Ingress test profile",
    language: "en",
    consentConfirmed: true
  });
  assert.equal(profileResponse.status, 201);

  const validForm = new FormData();
  validForm.append("files", new Blob([wavFixture()], { type: "audio/wav" }), "sample.wav");
  const validResponse = await fetch(`${context.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, {
    method: "POST",
    body: validForm
  });
  const validPayload = await validResponse.json();
  assert.equal(validResponse.status, 202);
  assert.equal(validPayload.samples.length, 1);
  assert.equal(validPayload.job.type, "prepare-profile-source");

  const rejectedForm = new FormData();
  rejectedForm.append("unexpected", "not allowed");
  const rejectedResponse = await fetch(`${context.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, {
    method: "POST",
    body: rejectedForm
  });
  const rejectedPayload = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 400);
  assert.equal(rejectedPayload.code, "invalid_field");
});

test("RVC browser import rejects a model file that is not a typed .pth", async () => {
  const { payload: profile } = await postJson("/api/voice-clone/profiles", {
    name: "RVC browser import profile",
    language: "en",
    consentConfirmed: true
  });
  const form = new FormData();
  form.append("profileId", profile.id);
  form.append("modelFile", new Blob(["not-a-model"]), "wrong.txt");
  form.append("indexFile", new Blob(["index"]), "voice.index");
  form.append("smokeAudio", new Blob([wavFixture()], { type: "audio/wav" }), "smoke.wav");
  const response = await fetch(`${context.url}/api/voice-clone/rvc/models/import`, { method: "POST", body: form });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.code, "RVC_MODEL_INSPECTION_FAILED");
  assert.match(payload.error, /\.pth extension/i);
});

test("RVC Profile training reports the approved-audio gap before creating a job", async () => {
  const { payload: profile } = await postJson("/api/voice-clone/profiles", {
    name: "RVC training readiness profile",
    language: "en",
    consentConfirmed: true
  });
  const response = await fetch(`${context.url}/api/voice-clone/rvc/training-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: profile.id })
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.code, "RVC_TRAINING_DATA_INSUFFICIENT");
  assert.equal(payload.details.missingVoicedDurationSec, 600);
});
