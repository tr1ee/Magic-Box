import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../server/assistant/store.mjs";
import { createAssistantManager } from "../server/assistant/manager.mjs";

const dataDir = path.resolve(process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-voice-migration-")));
const outputPath = process.env.VOICE_MIGRATION_OUTPUT || "";
await fs.mkdir(dataDir, { recursive: true });
const legacyStore = new AssistantStore(dataDir);
legacyStore.setMeta("assistant_voice_preferences", JSON.stringify({ mode: "streaming", profileId: "legacy-profile", speed: 1.05, revision: 7 }));
legacyStore.close();

const manager = createAssistantManager({ dataDir, voiceProfileStorePath: path.join(dataDir, "profiles") });
await manager.ready;
const migrated = manager.voicePreferences();
const result = {
  schemaVersion: 1,
  dataDir,
  requestedMode: migrated.requestedMode,
  requestedProfileId: migrated.requestedProfileId,
  effectiveMode: migrated.effectiveMode,
  revision: migrated.revision,
  assistantDbPath: migrated.assistantDbPath,
  voiceProfileStorePath: migrated.voiceProfileStorePath,
  passed: migrated.requestedMode === "streaming" && migrated.requestedProfileId === "legacy-profile" && migrated.revision === 7
};
await manager.close();
console.log(JSON.stringify(result, null, 2));
if (outputPath) await fs.writeFile(path.resolve(outputPath), JSON.stringify(result, null, 2), "utf8");
if (!result.passed) process.exitCode = 1;
