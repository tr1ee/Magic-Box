import fs from "node:fs/promises";
import process from "node:process";

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const trace = process.argv[2] || process.env.VOICE_TRACE_FILE;
if (trace) {
  const stat = await fs.stat(trace).catch(() => null);
  add("trace-artifact", stat?.isFile() || stat?.isDirectory() ? "ready" : "missing", trace);
} else add("trace-artifact", "pending", "Pass a trace file/directory after a real device run.");
const profile = process.env.VOICE_PROFILE_EVALUATION || "artifacts/voice-profile-evaluation.json";
const profileData = JSON.parse(await fs.readFile(profile, "utf8").catch(() => "null"));
add("profile-integrity", profileData?.decision === "ready-for-pinned-ab" ? "ready" : "pending", profileData?.decision || "Run evaluate-voice-profile.mjs.");
const provider = process.env.TTS_PROVIDER_DECISION || "artifacts/tts-provider-decision.json";
const providerData = JSON.parse(await fs.readFile(provider, "utf8").catch(() => "null"));
add("provider-decision", providerData?.status === "evidence-supported" || providerData?.status === "insufficient-evidence" ? "recorded" : "pending", providerData?.status || "Run evaluate-tts-provider-decision.mjs.");
add("cold-start", "pending", "Requires five packaged launches with the same local model/profile and recorded first-audio p95.");
const coldStart = process.env.VOICE_COLD_START_REPORT || "artifacts/voice-preference-cold-start.json";
const coldStartData = JSON.parse(await fs.readFile(coldStart, "utf8").catch(() => "null"));
if (coldStartData) checks[checks.length - 1] = { name: "cold-start", status: Number(coldStartData.runs?.length) >= 5 && coldStartData.requestedPreferenceStable ? "ready" : "failed", detail: coldStartData };
const continuity = process.env.VOICE_CONTINUITY_REPORT || "artifacts/voice-continuity-gate.json";
const continuityData = JSON.parse(await fs.readFile(continuity, "utf8").catch(() => "null"));
add("continuous-voice", continuityData?.status === "passed" ? "ready" : "pending", continuityData || "Run verify-live-voice-continuity.mjs against real playback telemetry.");
const migration = process.env.VOICE_MIGRATION_REPORT || "artifacts/voice-preference-migration.json";
const migrationData = JSON.parse(await fs.readFile(migration, "utf8").catch(() => "null"));
add("migration", migrationData?.passed ? "ready" : "pending", migrationData || "Run the packaged migration smoke against a disposable release data root.");
const candidate = process.env.VOICE_GENERATION_CANDIDATE_REPORT || "artifacts/private-agent-candidate-comparison.json";
const candidateData = JSON.parse(await fs.readFile(candidate, "utf8").catch(() => "null"));
add("voice-generation-candidate", candidateData?.decision === "voice-only-candidate-poc-ready" ? "ready" : "pending", candidateData || "Run the isolated smaller-generation candidate POC.");
const matrix = process.env.PRIVATE_AGENT_MATRIX_REPORT || "artifacts/private-agent-resource-matrix.json";
const matrixData = JSON.parse(await fs.readFile(matrix, "utf8").catch(() => "null"));
const matrixRows = Array.isArray(matrixData?.matrix) ? matrixData.matrix : [];
const requiredMatrixNames = ["text_interactive", "voice_warming", "voice_responding", "idle_memory_saver"];
const matrixNamesPresent = requiredMatrixNames.every((name) => matrixRows.some((row) => row.name === name && ["executed", "observed"].includes(row.status)));
const matrixHasExecutedChat = ["text_interactive", "voice_responding"].every((name) => {
  const row = matrixRows.find((item) => item.name === name);
  return row?.status === "executed" && Number(row.detail?.chat?.firstTokenMs) >= 0;
});
const matrixHasResidency = matrixRows.some((row) => Object.values(row.detail?.modelStatus?.voiceResourceScheduler?.entries || {}).some((entry) => entry.resident === true && entry.modelId));
const matrixCoverageReady = Boolean(matrixData) && matrixNamesPresent && matrixHasExecutedChat && matrixHasResidency;
add("resource-matrix", matrixCoverageReady ? "ready" : (matrixData ? "partial" : "pending"), matrixData || "Run benchmark-private-agent-resource-matrix.mjs.");
const defaultChatRows = matrixRows.filter((row) => row.voice && row.detail?.chat?.firstTokenMs !== null && row.detail?.chat?.firstTokenMs !== undefined);
const defaultPerformancePending = defaultChatRows.some((row) => Number(row.detail.chat.firstTokenMs) > 12000);
add("default-generation-performance", defaultPerformancePending ? "pending" : (defaultChatRows.length ? "ready" : "pending"), defaultPerformancePending
  ? { reason: "The packaged default 9B first-token latency remains above the current interactive evidence window; keep the candidate opt-in until a deliberate default-model decision is made.", rows: defaultChatRows.map((row) => ({ name: row.name, firstTokenMs: row.detail.chat.firstTokenMs, tokenGapP95Ms: row.detail.chat.tokenGapP95Ms })) }
  : (defaultChatRows.length ? defaultChatRows : "Run the packaged default resource matrix."));
const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: checks.every((check) => ["ready", "recorded"].includes(check.status)) ? "passed" : "pending-real-evidence", checks };
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
