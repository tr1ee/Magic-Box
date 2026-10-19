import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { copySources, kitDirectories, kitFiles, verifyModelFree, sha256 } from "./macos-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "release", "macos");
await fs.mkdir(output, { recursive: true });
// Fresh staging avoids stale data without deleting an existing release.
const stage = await fs.mkdtemp(path.join(output, "kit-"));
const kit = path.join(stage, "MagicBox-Mac-Build");
await copySources(root, kit, kitDirectories, kitFiles);
const verification = await verifyModelFree(kit);
await fs.writeFile(path.join(kit, "MODEL-FREE.json"), JSON.stringify(verification, null, 2));
const zip = path.join(output, "MagicBox-Mac-Build.zip");
if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-Command", "& { param($source, $destination) Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination }; [IO.Compression.ZipFile]::CreateFromDirectory($source, $destination) }", stage, zip], { stdio: "inherit" });
} else {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", kit, zip], { stdio: "inherit" });
}
await fs.writeFile(`${zip}.sha256`, `${await sha256(zip)}  ${path.basename(zip)}\n`);
console.log(JSON.stringify({ zip, staging: kit, ...verification }, null, 2));
