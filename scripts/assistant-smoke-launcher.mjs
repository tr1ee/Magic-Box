import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2] || "models";
const args = process.argv.slice(3);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const packageRoot = path.resolve(value("--package") || "release/chromium/MagicBox");
const nodePath = path.join(packageRoot, process.platform === "win32" ? "node.exe" : "node");
const scriptPath = path.join(packageRoot, "scripts", "assistant-model-smoke.mjs");
const evidencePath = path.resolve("release", `assistant-${mode}-smoke-packaged.json`);
await Promise.all([fs.access(nodePath), fs.access(scriptPath)]);

const child = spawn(nodePath, [scriptPath, path.join(packageRoot, "assistant"), evidencePath, "--package-root", packageRoot, "--mode", mode], { cwd: packageRoot, stdio: "inherit", windowsHide: true });
const exitCode = await new Promise((resolve, reject) => { child.once("exit", (code) => resolve(code ?? 1)); child.once("error", reject); });
if (exitCode) process.exit(exitCode);
