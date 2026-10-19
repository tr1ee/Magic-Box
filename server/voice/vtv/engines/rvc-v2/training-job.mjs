import { createHash } from "node:crypto";

export const RVC_TRAINING_STAGES = Object.freeze([
  "preprocess",
  "f0",
  "features",
  "train",
  "index",
  "package",
  "validate"
]);

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function stageState(id) {
  return { id, status: "queued", attempts: 0, startedAt: null, completedAt: null, evidence: null, error: null };
}

export function createRvcTrainingJob({ jobId = `rvc-training-${Date.now()}`, profileId = "", profileVersionId = "", datasetHash = "", runtimeRevision = "8f2fdbf", parameters = {} } = {}) {
  const normalized = { jobId: String(jobId), profileId: String(profileId), profileVersionId: String(profileVersionId), datasetHash: String(datasetHash), runtimeRevision: String(runtimeRevision), parameters };
  return {
    schemaVersion: 1,
    jobId: normalized.jobId,
    engineId: "rvc-v2-finetuned",
    profileId: normalized.profileId,
    profileVersionId: normalized.profileVersionId,
    datasetHash: normalized.datasetHash,
    runtimeRevision: normalized.runtimeRevision,
    parameters: normalized.parameters,
    status: "queued",
    cancelRequested: false,
    currentStage: null,
    stages: RVC_TRAINING_STAGES.map(stageState),
    history: [],
    createdAt: new Date().toISOString(),
    jobHash: hash(normalized)
  };
}

export function startRvcTrainingJob(job, at = new Date().toISOString()) {
  if (!job || job.status === "completed" || job.status === "cancelled") return job;
  const next = job.stages.find((stage) => stage.status !== "completed");
  if (!next) return { ...job, status: "completed", currentStage: null, completedAt: at };
  const stages = job.stages.map((stage) => stage.id === next.id ? { ...stage, status: "running", attempts: stage.attempts + 1, startedAt: stage.startedAt || at, error: null } : stage);
  return { ...job, status: "running", currentStage: next.id, cancelRequested: false, stages, history: [...job.history, { event: "started", stage: next.id, at }] };
}

export function completeRvcTrainingStage(job, stageId, evidence = {}, at = new Date().toISOString()) {
  if (!job || job.status === "cancelled") return job;
  const stage = job.stages.find((item) => item.id === stageId);
  if (!stage || (job.currentStage && job.currentStage !== stageId)) throw new Error(`RVC training stage is out of order: ${stageId}`);
  const stages = job.stages.map((item) => item.id === stageId ? { ...item, status: "completed", completedAt: at, evidence, error: null } : item);
  const next = stages.find((item) => item.status !== "completed");
  const updated = { ...job, stages, currentStage: next?.id || null, status: next ? "running" : "completed", completedAt: next ? null : at, history: [...job.history, { event: "completed", stage: stageId, at, evidence }] };
  return next ? startRvcTrainingJob(updated, at) : updated;
}

export function failRvcTrainingStage(job, stageId, error, at = new Date().toISOString()) {
  if (!job || job.status === "cancelled") return job;
  const stages = job.stages.map((stage) => stage.id === stageId ? { ...stage, status: "failed", error: String(error || "RVC training stage failed"), completedAt: null } : stage);
  return { ...job, status: "failed", currentStage: stageId, stages, history: [...job.history, { event: "failed", stage: stageId, at, error: String(error || "RVC training stage failed") }] };
}

export function requestRvcTrainingCancel(job, reason = "cancelled by user", at = new Date().toISOString()) {
  if (!job || ["completed", "cancelled"].includes(job.status)) return job;
  return { ...job, status: "cancelled", cancelRequested: true, currentStage: null, cancelReason: String(reason), cancelledAt: at, history: [...job.history, { event: "cancelled", at, reason: String(reason) }] };
}

export function resumeRvcTrainingJob(job, at = new Date().toISOString()) {
  if (!job || !["failed", "cancelled"].includes(job.status)) return job;
  const stages = job.stages.map((stage) => stage.status === "completed" ? stage : { ...stage, status: "queued", startedAt: null, completedAt: null, error: null });
  return startRvcTrainingJob({ ...job, stages, status: "queued", cancelRequested: false, cancelReason: null, cancelledAt: null, completedAt: null, history: [...job.history, { event: "resumed", at }] }, at);
}

export function buildRvcTrainingReport(job, extra = {}) {
  const completed = job?.stages?.filter((stage) => stage.status === "completed") || [];
  return {
    schemaVersion: 1,
    engineId: "rvc-v2-finetuned",
    jobId: job?.jobId || "",
    profileId: job?.profileId || "",
    datasetHash: job?.datasetHash || "",
    runtimeRevision: job?.runtimeRevision || "",
    status: job?.status || "unknown",
    completedStages: completed.map((stage) => stage.id),
    stages: job?.stages || [],
    resumable: ["failed", "cancelled"].includes(job?.status) && completed.length < RVC_TRAINING_STAGES.length,
    ...extra,
    reportHash: hash({ jobId: job?.jobId || "", stages: job?.stages || [], extra })
  };
}
