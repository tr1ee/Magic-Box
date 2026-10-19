import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const packageRoot = path.resolve(value("--package") || process.cwd());
const { startServer } = await import(pathToFileURL(path.join(packageRoot, "server", "index.mjs")).href);
const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-package-voice-smoke-"));
const previousSettings = process.env.MAGIC_BOX_SETTINGS_FILE;
const previousFakeEngine = process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;

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

let context;
try {
  process.env.MAGIC_BOX_SETTINGS_FILE = path.join(smokeRoot, "settings.json");
  process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = "1";
  context = await startServer({
    port: 0,
    dht: false,
    lsd: false,
    tracker: false,
    defaultDownloadDir: path.join(smokeRoot, "downloads"),
    assistantDataDir: path.join(smokeRoot, "assistant"),
    voiceIngressLimits: {
      profile: { fileBytes: 256 * 1024, requestBytes: 512 * 1024 },
      tts: { fileBytes: 64 * 1024, requestBytes: 128 * 1024 },
      v2v: { fileBytes: 256 * 1024, requestBytes: 512 * 1024 },
      song: { fileBytes: 256 * 1024, requestBytes: 512 * 1024 }
    }
  });
  const profileResponse = await fetch(`${context.url}/api/voice-clone/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Package ingress smoke", language: "en", consentConfirmed: true })
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 201);

  const form = new FormData();
  form.append("files", new Blob([wavFixture()], { type: "audio/wav" }), "package-smoke.wav");
  const validResponse = await fetch(`${context.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, {
    method: "POST",
    body: form
  });
  const validPayload = await validResponse.json();
  assert.equal(validResponse.status, 202);
  assert.equal(validPayload.samples.length, 1);
  assert.equal(validPayload.job.type, "prepare-profile-source");

  const rejectedForm = new FormData();
  rejectedForm.append("unexpected", "rejected");
  const rejectedResponse = await fetch(`${context.url}/api/voice-clone/profiles/${encodeURIComponent(profile.id)}/samples`, {
    method: "POST",
    body: rejectedForm
  });
  const rejectedPayload = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 400);
  assert.equal(rejectedPayload.code, "invalid_field");
  console.log(JSON.stringify({ verified: true, voiceIngress: { validStatus: validResponse.status, rejectedStatus: rejectedResponse.status, rejectedCode: rejectedPayload.code } }));
} finally {
  await context?.close();
  await fs.rm(smokeRoot, { recursive: true, force: true });
  if (previousSettings === undefined) delete process.env.MAGIC_BOX_SETTINGS_FILE;
  else process.env.MAGIC_BOX_SETTINGS_FILE = previousSettings;
  if (previousFakeEngine === undefined) delete process.env.MAGIC_BOX_VOICE_ENGINE_FAKE;
  else process.env.MAGIC_BOX_VOICE_ENGINE_FAKE = previousFakeEngine;
}
