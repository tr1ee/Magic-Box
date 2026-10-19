import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageRvcBrowserUploads } from "../server/voice/vtv/engines/rvc-v2/browser-import.mjs";

test("RVC browser uploads are staged with extensions required by model inspection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-rvc-browser-"));
  try {
    const files = await Promise.all(["model.part", "index.part", "smoke.part"].map(async (name) => {
      const filePath = path.join(directory, name);
      await fs.writeFile(filePath, name);
      return filePath;
    }));
    const staged = await stageRvcBrowserUploads({
      ingressDir: directory,
      modelFile: { path: files[0], originalname: "voice.pth" },
      indexFile: { path: files[1], originalname: "voice.index" },
      smokeAudio: { path: files[2], originalname: "smoke.flac" }
    });
    assert.equal(path.extname(staged.modelPath), ".pth");
    assert.equal(path.extname(staged.indexPath), ".index");
    assert.equal(path.extname(staged.smokeInputPath), ".flac");
    assert.equal((await fs.stat(staged.modelPath)).isFile(), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("RVC browser import can use an approved Profile clip instead of a third upload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-rvc-browser-two-file-"));
  try {
    const modelPath = path.join(directory, "model.part");
    const indexPath = path.join(directory, "index.part");
    await Promise.all([fs.writeFile(modelPath, "model"), fs.writeFile(indexPath, "index")]);
    const staged = await stageRvcBrowserUploads({
      ingressDir: directory,
      modelFile: { path: modelPath, originalname: "voice.pth" },
      indexFile: { path: indexPath, originalname: "voice.index" }
    });
    assert.equal(staged.smokeInputPath, "");
    assert.equal((await fs.stat(staged.modelPath)).isFile(), true);
    assert.equal((await fs.stat(staged.indexPath)).isFile(), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
