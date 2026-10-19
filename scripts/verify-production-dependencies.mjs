import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = await fs.realpath(path.resolve(process.argv[2] || "release/chromium/MagicBox"));
const inside = (file) => {
  const relative = path.relative(root, file);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};
const escapes = new Set();
// A package under the repository could silently load missing modules from the
// repository's node_modules. Reject that fallback during release verification.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith("file:") && !inside(fileURLToPath(result.url))) {
      escapes.add(specifier);
      throw new Error(`Packaged dependency resolves outside the package: ${specifier}`);
    }
    return result;
  }
});
try {
  const require = createRequire(path.join(root, "package.json"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  for (const dependency of Object.keys(manifest.dependencies)) {
    // Match the Node-compatible PDF entry used by the server extraction worker.
    const entry = dependency === "pdfjs-dist" ? "pdfjs-dist/legacy/build/pdf.mjs" : dependency;
    const resolved = require.resolve(entry);
    assert.ok(inside(resolved), `${dependency} must resolve inside the package`);
    await import(pathToFileURL(resolved).href);
  }
  const run = promisify(execFile);
  for (const binary of [require("ffmpeg-static"), require("ffprobe-static").path]) {
    assert.ok(inside(binary));
    const { stdout } = await run(binary, ["-version"], { windowsHide: true });
    assert.match(stdout, /ff(?:mpeg|probe) version/);
  }
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 8);
  assert.ok(require("@napi-rs/canvas").createCanvas(8, 8).toBuffer("image/png").length > 0);
  const pdf = await require("pdf-lib").PDFDocument.create();
  pdf.addPage();
  assert.ok((await pdf.save()).length > 0);
  assert.equal(escapes.size, 0, `Dependency fallback detected: ${[...escapes].join(", ")}`);
  console.log(JSON.stringify({ verified: true, productionDependencies: Object.keys(manifest.dependencies).length, externalModuleFallbacks: 0, nativeImageAndPdfSmoke: true, mediaBinaries: true }));
} finally {
  hooks.deregister();
}
