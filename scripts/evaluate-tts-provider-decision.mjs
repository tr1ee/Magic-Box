import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
const outputPath = process.argv[3] || "artifacts/tts-provider-decision.json";
if (!input) {
  console.error("Usage: node scripts/evaluate-tts-provider-decision.mjs <benchmark.json> [output.json]");
  process.exit(2);
}
const benchmark = JSON.parse(await fs.readFile(path.resolve(input), "utf8"));
const providers = benchmark.providers || benchmark.providerResults || {};
const rows = Object.entries(providers).map(([id, value]) => ({
  id,
  firstAudioP95Ms: Number(value.firstAudioP95Ms ?? value.firstAudioMsP95),
  midClauseGapP95Ms: Number(value.midClauseAudibleGapP95Ms),
  clippingRatio: Number(value.clippingRatio),
  similarity: Number(value.speakerSimilarity ?? value.similarity)
}));
const eligible = rows.filter((row) => Number.isFinite(row.firstAudioP95Ms)
  && Number.isFinite(row.midClauseGapP95Ms)
  && row.midClauseGapP95Ms <= 180
  && (!Number.isFinite(row.clippingRatio) || row.clippingRatio <= 0.001)
  && (!Number.isFinite(row.similarity) || row.similarity >= 0.8));
const result = {
  schemaVersion: 1,
  evaluatedAt: new Date().toISOString(),
  currentProvider: benchmark.currentProvider || "cosyvoice3-stream-local",
  providers: rows,
  decision: eligible.length ? eligible.sort((left, right) => left.firstAudioP95Ms - right.firstAudioP95Ms)[0].id : "retain-current",
  status: eligible.length ? "evidence-supported" : "insufficient-evidence",
  rule: "Do not switch provider without the same fixtures, profile, device class, and playback trace meeting continuity, clipping, and similarity gates."
};
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(path.resolve(outputPath), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
