import { createHash } from "node:crypto";
import { VTV_PIPELINE_VERSION } from "./constants.mjs";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function hashVtvLineage(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function createVtvLineage({
  mode,
  sourceSha256 = "",
  referencePackId = "",
  referencePackSha256 = "",
  modelArtifactId = "",
  modelCheckpointSha256 = "",
  runtimeManifestHash = "",
  jobBaseSeed = null,
  normalizedSettings = {},
  pipelineVersion = VTV_PIPELINE_VERSION
} = {}) {
  const lineage = {
    pipelineVersion,
    mode: String(mode || ""),
    sourceSha256: String(sourceSha256 || ""),
    referencePackId: String(referencePackId || ""),
    referencePackSha256: String(referencePackSha256 || ""),
    modelArtifactId: String(modelArtifactId || ""),
    modelCheckpointSha256: String(modelCheckpointSha256 || ""),
    runtimeManifestHash: String(runtimeManifestHash || ""),
    jobBaseSeed: Number.isInteger(jobBaseSeed) ? jobBaseSeed >>> 0 : null,
    normalizedSettings
  };
  return { ...lineage, lineageHash: hashVtvLineage(lineage) };
}
