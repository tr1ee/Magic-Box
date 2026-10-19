import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] || "release/windows-basic/MagicBox");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-basic-smoke-"));
const program = `
  const { startServer } = await import(${JSON.stringify(pathToFileURL(path.join(root, "server/index.mjs")).href)});
  const context = await startServer({host:'127.0.0.1',port:0});
  process.send({url:context.url});
  process.on('message', async () => { await context.close(); process.exit(0); });
`;
const child = spawn(path.join(root, process.platform === "win32" ? "node.exe" : "node"), ["--input-type=module", "-e", program], {
  cwd: temporary, env: { ...process.env, MAGIC_BOX_SETTINGS_FILE: path.join(temporary, "settings.json"), MAGIC_BOX_ASSISTANT_DATA_DIR: path.join(temporary, "assistant"), MAGIC_BOX_VOICE_DATA_ROOT: path.join(temporary, "voice_clone"), TORRENT_DOWNLOAD_DIR: path.join(temporary, "downloads") }, stdio: ["ignore", "pipe", "pipe", "ipc"]
});
let logs = "";
child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-10000); });
child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-10000); });
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Package startup timeout: ${logs}`)), 60000);
    child.once("message", message => { clearTimeout(timeout); resolve(message.url); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Package exited (${code}): ${logs}`)); });
  });
  const get = async route => { const response = await fetch(url + route); assert.equal(response.ok, true, route); return response.json(); };
  assert.equal((await get("/api/health")).ok, true);
  let models;
  for (let i = 0; i < 40; i++) {
    models = await get("/api/assistant/models");
    if (models.status.runtime !== "verifying") break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(models.status.runtime, "ready");
  assert.equal(models.status.generation, "not-installed");
  assert.equal(models.status.embeddings, "not-installed");
  assert.match(await fetch(url).then(r => r.text()), /<div id="root">/);
  console.log(JSON.stringify({ verified: true, packageRoot: root, emptyUserDataStartup: true, modelRuntimeReady: true, modelsInstalled: false, frontendServed: true }));
} finally {
  if (child.connected) child.send("close");
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => { child.kill(); resolve(); }, 12000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  await fs.rm(temporary, { recursive: true, force: true });
}
