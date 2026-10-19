import fs from "node:fs/promises";

const manifestPath = process.argv[2] || "artifacts/voice-poc-run2/listening-ab.json";
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const review = manifest.humanReview || {};
const errors = [];
const cases = new Set((manifest.cases || []).map((item) => item.id));

if (review.status !== "completed") errors.push("humanReview.status must be completed");
if (!cases.has(review.preferredCase)) errors.push(`humanReview.preferredCase must be one of ${[...cases].join(", ")}`);
for (const field of ["boundaryContinuity", "prosodyNaturalness", "speakerSimilarity"]) {
  const value = Number(review[field]);
  if (!Number.isInteger(value) || value < 1 || value > 5) errors.push(`humanReview.${field} must be an integer from 1 to 5`);
}
if (!["none", "minor", "clear"].includes(review.audibleClicksOrGaps)) {
  errors.push("humanReview.audibleClicksOrGaps must be none, minor, or clear");
}
if (typeof review.notes !== "string" || review.notes.trim().length < 8) errors.push("humanReview.notes must contain at least 8 characters");

if (errors.length) {
  console.error(JSON.stringify({ valid: false, manifestPath, errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ valid: true, manifestPath, preferredCase: review.preferredCase }, null, 2));
}
