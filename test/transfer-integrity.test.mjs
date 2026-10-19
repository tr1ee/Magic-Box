import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { createFileTransferManager } from "../server/file_transfer.mjs";

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-transfer-integrity-"));
  const manager = createFileTransferManager({ defaultDownloadDir: root, rootDir: process.cwd() });
  const app = express();
  app.use(express.json());
  app.use(manager.localRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${url}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const { session } = await start.json();
  const remote = new URL(session.loopbackUrl);
  const token = remote.pathname.split("/").pop();
  const pair = await fetch(`${remote.origin}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, code: session.pairingCode }) });
  const { auth } = await pair.json();
  return { url, session, remote: remote.origin, auth, token };
}

test("same-name files in one transfer batch retain both original contents", async (t) => {
  const f = await setup(t);
  const body = new FormData();
  body.append("files", new Blob(["first payload"]), "same.txt");
  body.append("files", new Blob(["second payload"]), "same.txt");
  const result = await fetch(`${f.url}/sessions/current/files`, { method: "POST", body });
  assert.equal(result.status, 201);
  const names = await fs.readdir(f.session.shareDir);
  assert.equal(names.length, 2, "same-name uploads must never overwrite one another");
  assert.deepEqual((await Promise.all(names.map((name) => fs.readFile(path.join(f.session.shareDir, name), "utf8")))).sort(), ["first payload", "second payload"]);
});

test("received media preview supports byte ranges for seeking and resuming", async (t) => {
  const f = await setup(t);
  const body = new FormData();
  body.append("files", new Blob(["0123456789"]), "clip.mp4");
  const result = await fetch(`${f.remote}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${f.auth}`, "X-Transfer-Token": f.token }, body });
  assert.equal(result.status, 201);
  const { session } = await result.json();
  const preview = await fetch(`${f.url}/sessions/current/received/${session.receivedFiles[0].id}/preview`, { headers: { Range: "bytes=2-5" } });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await preview.text(), "2345");
});

test("browser uploads preserve Chinese filenames on disk and in the room", async (t) => {
  const f = await setup(t);
  const body = new FormData();
  body.append("files", new Blob(["notes"]), "会议记录.txt");
  const response = await fetch(`${f.url}/sessions/current/files`, { method: "POST", body });
  assert.equal(response.status, 201);
  const { session } = await response.json();
  assert.equal(session.sharedFiles[0].name, "会议记录.txt");
  assert.equal(await fs.readFile(path.join(session.shareDir, "会议记录.txt"), "utf8"), "notes");
});
