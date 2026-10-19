import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const requiredPages = [
  "src/pages/FileTransferPage.jsx",
  "src/pages/VoiceClonePage.jsx",
  "src/pages/ImageDownloaderPage.jsx",
  "src/pages/VideoDownloaderPage.jsx",
  "src/pages/TorrentDownloaderPage.jsx",
  "src/pages/HistoryPage.jsx"
];

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function staticClosure(manifest, entryKey) {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) {
      return;
    }
    const entry = manifest[key];
    if (!entry) {
      throw new Error(`Manifest import ${key} is missing.`);
    }
    visited.add(key);
    for (const importedKey of entry.imports || []) {
      visit(importedKey);
    }
  };
  visit(entryKey);
  return visited;
}

const manifestPath = resolve(process.cwd(), readOption("--manifest") || "dist/.vite/manifest.json");
const entryBudget = Number(readOption("--entry-budget") || 300000);
if (!Number.isFinite(entryBudget) || entryBudget <= 0) {
  throw new Error("--entry-budget must be a positive byte count.");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) {
  throw new Error("Vite manifest does not contain an entry chunk.");
}

const staticKeys = staticClosure(manifest, entryKey);
const outputRoot = resolve(dirname(manifestPath), "..");
const staticFiles = new Set();
let initialJavascriptBytes = 0;
for (const key of staticKeys) {
  const file = manifest[key].file;
  if (!file?.endsWith(".js") || staticFiles.has(file)) {
    continue;
  }
  staticFiles.add(file);
  initialJavascriptBytes += statSync(resolve(outputRoot, file)).size;
}

const entry = manifest[entryKey];
const failures = [];
for (const pageSource of requiredPages) {
  const page = manifest[pageSource];
  if (!page) {
    failures.push(`${pageSource} has no manifest entry`);
    continue;
  }
  if (!entry.dynamicImports?.includes(pageSource) || !page.isDynamicEntry) {
    failures.push(`${pageSource} is not a direct dynamic entry`);
  }
  if (staticKeys.has(pageSource) || staticFiles.has(page.file)) {
    failures.push(`${pageSource} appears in the entry static-import closure`);
  }
  try {
    statSync(resolve(outputRoot, page.file));
  } catch {
    failures.push(`${pageSource} output file is missing (${page.file})`);
  }
}

if (initialJavascriptBytes > entryBudget) {
  failures.push(`initial JavaScript is ${initialJavascriptBytes} bytes, above the ${entryBudget}-byte budget`);
}

if (failures.length) {
  throw new Error(`Lazy tool page verification failed: ${failures.join("; ")}.`);
}

console.log(
  `Verified ${requiredPages.length} lazy tool pages outside the entry static closure; `
  + `initialJavascriptBytes=${initialJavascriptBytes} (budget=${entryBudget}).`
);
