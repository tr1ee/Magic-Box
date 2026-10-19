import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const testFolder = resolve(root, "test");
const vitestCli = resolve(root, "node_modules", "vitest", "vitest.mjs");

function collectUiTests(folder) {
  return readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = resolve(folder, entry.name);
      if (entry.isDirectory()) {
        return collectUiTests(fullPath);
      }
      return entry.name.endsWith(".test.jsx") ? [fullPath] : [];
    });
}

const expectedUiTests = collectUiTests(testFolder)
  .map((filePath) => filePath.slice(root.length + 1).replaceAll("\\", "/"))
  .sort();

if (!expectedUiTests.includes("test/assistant-ui.test.jsx") || !expectedUiTests.includes("test/toolbox-carousel.test.jsx")) {
  throw new Error("UI discovery baseline must include the Assistant and toolbox-carousel suites.");
}

const result = spawnSync(process.execPath, [vitestCli, "list", "--config", "vitest.config.mjs"], {
  cwd: root,
  encoding: "utf8"
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`Vitest UI discovery failed with exit code ${result.status}.`);
}

const discovered = `${result.stdout}\n${result.stderr}`.replaceAll("\\", "/");
const missing = expectedUiTests.filter((testPath) => !discovered.includes(testPath));
const nodeSuites = ["test/server.test.mjs", "test/assistant.test.mjs"]
  .filter((testPath) => discovered.includes(testPath));

if (missing.length || nodeSuites.length) {
  const problems = [
    missing.length ? `missing UI suites: ${missing.join(", ")}` : "",
    nodeSuites.length ? `unexpected Node suites: ${nodeSuites.join(", ")}` : ""
  ].filter(Boolean);
  throw new Error(`UI-only Vitest discovery regression: ${problems.join("; ")}.`);
}

console.log(`Verified UI-only Vitest discovery for ${expectedUiTests.length} suite(s).`);
