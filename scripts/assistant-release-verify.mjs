import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const packageRoot = path.resolve(value("--package") || "release/chromium/MagicBox");
const run = async (file, commandArgs) => {
  const child = spawn(file, commandArgs, { cwd: process.cwd(), stdio: "inherit", windowsHide: true, shell: false });
  const code = await new Promise((resolve, reject) => { child.once("exit", (next) => resolve(next ?? 1)); child.once("error", reject); });
  if (code) throw new Error(`${file} ${commandArgs.join(" ")} failed with exit code ${code}.`);
};

await run(process.execPath, ["scripts/verify-assistant-package.mjs", "--package", packageRoot]);
if (process.platform === "win32") {
  await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd run test:assistant"]);
  await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd run test:assistant-ui"]);
} else {
  await run("npm", ["run", "test:assistant"]);
  await run("npm", ["run", "test:assistant-ui"]);
}
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "assistant-package-manifest.json"), "utf8"));
const smoke = JSON.parse(await fs.readFile(path.resolve("release/assistant-models-smoke-packaged.json"), "utf8"));
assert.equal(smoke.package?.buildId, manifest.buildId, "Packaged model smoke does not belong to the current build.");
assert.equal(smoke.runtime, "ready");
assert.equal(smoke.offlineGuard?.nonLoopbackAttempts, 0);
assert.ok(smoke.installedModels?.every((model) => model.expectedSha256 === model.actualSha256));
assert.equal(smoke.chat?.grounding, "workspace");
console.log(JSON.stringify({ verified: true, buildId: manifest.buildId, packagedModelEvidence: "release/assistant-models-smoke-packaged.json" }, null, 2));
