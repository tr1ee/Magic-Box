import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { copySources, verifyModelFree, sha256 } from "./macos-package.mjs";
import { copyProductionDependencies } from "./copy-production-dependencies.mjs";

if (process.platform !== "darwin") throw new Error("DMG creation requires macOS. Use npm run desktop:mac:kit on Windows.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const command = (bin, args, options = {}) => run(bin, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options });
const arch = process.arch;
if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported Mac architecture.");
const output = path.join(root, "release", "macos");
await fs.mkdir(output, { recursive: true });
const work = await fs.mkdtemp(path.join(output, `build-${arch}-`));
const app = path.join(work, "MagicBox.app");
const contents = path.join(app, "Contents");
const resources = path.join(contents, "Resources");
const payload = path.join(resources, "app");
await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
await copySources(root, payload, ["server", "shared", "dist", "desktop/macos"], ["package.json", "package-lock.json", "README.md", "docs/USER_GUIDE.md", "docs/THIRD_PARTY.md", "docs/macos.md"]);
await copyProductionDependencies(root, payload);
await fs.copyFile(process.execPath, path.join(payload, "node"));
await fs.copyFile(path.join(root, "desktop/macos/Info.plist"), path.join(contents, "Info.plist"));
const version = JSON.parse(await fs.readFile(path.join(root, "package.json"))).version;
await command("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleShortVersionString ${version}`, path.join(contents, "Info.plist")]);

async function download(url, destination, checksum) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  await pipeline(response.body, createWriteStream(destination));
  if (await sha256(destination) !== checksum) throw new Error(`Checksum mismatch: ${destination}`);
}

// Build the small inference runtime locally. Upstream b9637 Mac binaries require
// macOS 26; a native source build avoids silently imposing that requirement.
// This step never downloads a GGUF/model.
const runtime = path.join(payload, "vendor/llama/b9637");
const archive = path.join(work, "llama.tar.gz");
console.log("Downloading verified build tools and native inference source (no models)...");
await download("https://github.com/ggml-org/llama.cpp/archive/refs/tags/b9637.tar.gz", archive,
  "762283319feb3de30886dc850d42f0e426b06600e7f9639d34e06506597309ca");
const unpack = path.join(work, "llama");
await fs.mkdir(unpack);
await command("/usr/bin/tar", ["-xzf", archive, "-C", unpack]);
const cmakeArchive = path.join(work, "cmake.tar.gz");
await download("https://github.com/Kitware/CMake/releases/download/v3.31.8/cmake-3.31.8-macos-universal.tar.gz", cmakeArchive,
  "d1449f969c54d5c00886d5b643340d493dfb3c81cb39ee29b35453395c11ebf7");
await command("/usr/bin/tar", ["-xzf", cmakeArchive, "-C", work]);
const cmake = path.join(work, "cmake-3.31.8-macos-universal/CMake.app/Contents/bin/cmake");
const nativeBuild = path.join(work, "llama-build");
const source = path.join(unpack, "llama.cpp-b9637");
await command(cmake, ["-S", source, "-B", nativeBuild, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0", "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON", "-DCMAKE_INSTALL_RPATH=@loader_path", "-DGGML_NATIVE=OFF", "-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_APP=OFF", "-DLLAMA_OPENSSL=OFF"]);
console.log("Compiling the native inference runtime. This may take several minutes...");
await new Promise((resolve, reject) => {
  const build = spawn(cmake, ["--build", nativeBuild, "--config", "Release", "--target", "llama-server", "-j", String(Math.min(8, os.availableParallelism()))], { stdio: "inherit" });
  build.once("error", reject);
  build.once("exit", code => code === 0 ? resolve() : reject(new Error(`Native inference build failed (${code}).`)));
});
// Keep only the server, its libraries and license, without build tools or sources.
await fs.mkdir(runtime, { recursive: true });
async function collectRuntime(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectRuntime(file);
    else if (entry.name === "llama-server" || /\.dylib$/.test(entry.name) || /license|copying/i.test(entry.name)) {
      await fs.copyFile(file, path.join(runtime, entry.name));
    }
  }
}
await collectRuntime(path.join(nativeBuild, "bin"));
await fs.copyFile(path.join(source, "LICENSE"), path.join(runtime, "LICENSE"));
await fs.access(path.join(runtime, "llama-server"));
await fs.chmod(path.join(runtime, "llama-server"), 0o755);
await command(path.join(runtime, "llama-server"), ["--version"]);
await fs.mkdir(path.join(payload, "vendor"), { recursive: true });
await download("https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos", path.join(payload, "vendor/yt-dlp"), "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202");
await fs.chmod(path.join(payload, "vendor/yt-dlp"), 0o755);
await command(path.join(payload, "vendor/yt-dlp"), ["--version"]);

// ffprobe-static 3.1.0 does not reliably ship Apple Silicon. Supply its native binary.
if (arch === "arm64") {
  const probe = path.join(work, "ffprobe.tgz");
  const response = await fetch("https://registry.npmjs.org/@ffprobe-installer/darwin-arm64/-/darwin-arm64-5.0.1.tgz");
  if (!response.ok) throw new Error("Native FFprobe download failed.");
  const buffer = Buffer.from(await response.arrayBuffer());
  const { createHash } = await import("node:crypto");
  if (createHash("sha512").update(buffer).digest("base64") !== "vwNCNjokH8hfkbl6m95zICHwkSzhEvDC3GVBcUp5HX8+4wsX10SP3B+bGur7XUzTIZ4cQpgJmEIAx6TUwRepMg==") throw new Error("FFprobe integrity check failed.");
  await fs.writeFile(probe, buffer);
  const probeDir = path.join(work, "ffprobe");
  await fs.mkdir(probeDir);
  await command("/usr/bin/tar", ["-xzf", probe, "-C", probeDir]);
  const target = path.join(payload, "node_modules/ffprobe-static/bin/darwin/arm64");
  await fs.mkdir(target, { recursive: true });
  await fs.copyFile(path.join(probeDir, "package/ffprobe"), path.join(target, "ffprobe"));
  await fs.copyFile(path.join(probeDir, "package/README.md"), path.join(target, "README.md"));
  await fs.chmod(path.join(target, "ffprobe"), 0o755);
}

const iconset = path.join(work, "AppIcon.iconset");
await fs.mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await command("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), path.join(root, "public/app-icon.png"), "--out", path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
  }
}
await command("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "AppIcon.icns")]);
await command("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", "-target", `${arch === "x64" ? "x86_64" : "arm64"}-apple-macosx14.0`, "-framework", "Cocoa", "-framework", "WebKit", path.join(root, "desktop/macos/MagicBox.swift"), "-o", path.join(contents, "MacOS/MagicBox")]);

// Ad-hoc local distribution. Do not claim Developer ID signing or notarization.
const macho = new Set(["feedfacf", "cffaedfe", "cafebabe", "bebafeca"]);
async function signCode(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await signCode(file);
    else if (entry.isFile()) {
      const handle = await fs.open(file, "r");
      const bytes = Buffer.alloc(4);
      await handle.read(bytes, 0, 4, 0);
      await handle.close();
      if (macho.has(bytes.toString("hex"))) await command("/usr/bin/codesign", ["--force", "--sign", "-", file]);
    }
  }
}
await signCode(contents);
const catalogPath = path.join(payload, "server/assistant/model-catalog.json");
const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
const requiredFiles = {};
for (const name of await fs.readdir(runtime)) requiredFiles[name] = await sha256(path.join(runtime, name));
catalog.runtime = { id: `llama.cpp-b9637-macos-${arch}`, version: "b9637", requiredFiles };
await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
const report = await verifyModelFree(payload);
await fs.writeFile(path.join(resources, "MODEL-FREE.json"), JSON.stringify({ ...report, arch, version, includedModels: [], personalDataIncluded: false }, null, 2));
await command("/usr/bin/codesign", ["--force", "--sign", "-", app]);
await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
await command(path.join(runtime, "llama-server"), ["--version"]);
await command(path.join(payload, "vendor/yt-dlp"), ["--version"]);
await command(path.join(payload, "node"), [path.join(root, "scripts/verify-production-dependencies.mjs"), payload]);

// Start exactly the packaged server with empty user data, then verify startup and models.
const smoke = path.join(work, "smoke");
await fs.mkdir(smoke);
const ready = path.join(smoke, "ready.json");
const child = spawn(path.join(payload, "node"), [path.join(payload, "desktop/macos/server-entry.mjs")], {
  cwd: smoke, env: { ...process.env, MAGIC_BOX_READY_FILE: ready, MAGIC_BOX_SETTINGS_FILE: path.join(smoke, "settings.json"), MAGIC_BOX_ASSISTANT_DATA_DIR: path.join(smoke, "assistant"), MAGIC_BOX_VOICE_DATA_ROOT: path.join(smoke, "voice_clone"), TORRENT_DOWNLOAD_DIR: path.join(smoke, "downloads") }, stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-16000); });
child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-16000); });
let spawnError;
child.on("error", error => { spawnError = error; });
try {
  let url;
  for (let i = 0; i < 180; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Packaged server exited: ${logs}`);
    const content = await fs.readFile(ready, "utf8").catch(() => null);
    if (content) { url = JSON.parse(content).url; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!url) throw new Error(`Packaged server startup timeout: ${logs}`);
  const health = await fetch(`${url}/api/health`).then(r => r.json());
  const config = await fetch(`${url}/api/config`).then(r => r.json());
  const html = await fetch(url).then(r => r.text());
  if (!health.ok || config.platform !== "darwin" || !html.includes('<div id="root">')) throw new Error("Packaged frontend/server smoke failed.");
  let models;
  for (let i = 0; i < 40; i++) {
    models = await fetch(`${url}/api/assistant/models`).then(r => r.json());
    if (models.status?.runtime !== "verifying") break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (models.status?.runtime !== "ready" || models.status?.generation !== "not-installed" || models.status?.embeddings !== "not-installed") throw new Error(`Model-free runtime verification failed: ${JSON.stringify(models.status)}`);
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => {
    if (child.exitCode !== null || spawnError) return resolve();
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 12000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

const image = path.join(work, "image");
await fs.mkdir(image);
await command("/usr/bin/ditto", [app, path.join(image, "MagicBox.app")]);
await fs.symlink("/Applications", path.join(image, "Applications"));
await fs.copyFile(path.join(root, "docs/macos.md"), path.join(image, "安装与模型说明.txt"));
const dmg = path.join(output, `MagicBox-${version}-macOS-${arch}-basic.dmg`);
const pending = path.join(work, "MagicBox.dmg");
await command("/usr/bin/hdiutil", ["create", "-volname", "Magic Box", "-srcfolder", image, "-format", "UDZO", "-ov", pending]);
await command("/usr/bin/hdiutil", ["verify", pending]);
// Verify the mounted artifact, not just the staging directory.
const mount = path.join(work, "mounted");
await command("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, pending]);
try {
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(mount, "MagicBox.app")]);
  await verifyModelFree(path.join(mount, "MagicBox.app/Contents/Resources/app"));
} finally { await command("/usr/bin/hdiutil", ["detach", mount]); }
await fs.copyFile(pending, dmg);
await fs.writeFile(`${dmg}.sha256`, `${await sha256(dmg)}  ${path.basename(dmg)}\n`);
await fs.writeFile(`${dmg}.json`, JSON.stringify({ ...report, arch, version, dmg, signature: "ad-hoc", notarized: false, dependencySmoke: true, serverSmoke: true, mountedImageVerified: true }, null, 2));
console.log(JSON.stringify({ dmg, ...report }, null, 2));
