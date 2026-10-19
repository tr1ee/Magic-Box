import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(".");
const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
};
const mode = arg("--mode", "speech") === "song" ? "song" : "speech";
const casesPath = path.resolve(arg("--cases"));
const outputDir = path.resolve(arg("--output-dir", `artifacts/vtv-abx/${mode}`));
const reviewers = arg("--reviewers", "reviewer-1|reviewer-2").split("|").map((value) => value.trim()).filter(Boolean);
const dimensions = mode === "song"
  ? ["target-singer", "melody", "lyrics", "residual", "artifact", "mix"]
  : ["target-similarity", "naturalness", "content", "artifact", "consistency"];

if (!casesPath || !reviewers.length) {
  console.error("Usage: node scripts/build-vtv-abx-assignments.mjs --mode speech|song --cases <cases.json> [--reviewers reviewer-1|reviewer-2] [--output-dir <dir>]");
  process.exit(2);
}

const input = JSON.parse(await fs.readFile(casesPath, "utf8"));
const cases = Array.isArray(input) ? input : input.cases;
if (!Array.isArray(cases) || !cases.length) throw new Error("ABX cases must be a non-empty array.");

const hash = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const exists = async (filePath) => Boolean(await fs.stat(filePath).catch(() => null));
const sharedAudioDir = path.join(outputDir, "reviewer-package", "audio");
await fs.mkdir(sharedAudioDir, { recursive: true });
const allAssignments = [];
const privateMappings = [];
const responseTemplates = new Map(reviewers.map((reviewerId) => [reviewerId, []]));

for (const item of cases) {
  const caseId = String(item.caseId || item.id || "").trim();
  const referencePath = path.resolve(root, String(item.referencePath || ""));
  const candidateAPath = path.resolve(root, String(item.candidateAPath || item.aPath || ""));
  const candidateBPath = path.resolve(root, String(item.candidateBPath || item.bPath || ""));
  if (!caseId || !(await exists(referencePath)) || !(await exists(candidateAPath)) || !(await exists(candidateBPath))) {
    throw new Error(`ABX case is incomplete or has missing audio: ${caseId}`);
  }
  for (const reviewerId of reviewers) {
    for (const dimension of dimensions) {
      const assignmentSeed = `${mode}|${reviewerId}|${caseId}|${dimension}`;
      const assignmentHash = hash({ assignmentSeed, presentedLabels: ["A", "B"] });
      const assignmentId = `abx-${assignmentHash.slice(0, 20)}`;
      const swap = Number.parseInt(assignmentHash.slice(-2), 16) % 2 === 1;
      const paths = {
        reference: path.join(sharedAudioDir, `${assignmentId}-reference.wav`),
        A: path.join(sharedAudioDir, `${assignmentId}-A.wav`),
        B: path.join(sharedAudioDir, `${assignmentId}-B.wav`)
      };
      await fs.copyFile(referencePath, paths.reference);
      await fs.copyFile(swap ? candidateBPath : candidateAPath, paths.A);
      await fs.copyFile(swap ? candidateAPath : candidateBPath, paths.B);
      const relativePaths = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.relative(outputDir, value).replaceAll("\\", "/")]));
      const assignment = {
        schemaVersion: "vtv-abx-assignment-v1",
        assignmentId,
        assignmentHash,
        mode,
        caseId,
        dimension,
        presentedLabels: ["A", "B"],
        audio: relativePaths,
        instructions: "Listen to the reference first, then compare A and B. Record only A, B, or TIE; do not infer model identity from filenames."
      };
      allAssignments.push(assignment);
      privateMappings.push({
        assignmentId,
        reviewerId,
        caseId,
        dimension,
        labelA: swap ? String(item.modelBId || "candidate-b") : String(item.modelAId || "candidate-a"),
        labelB: swap ? String(item.modelAId || "candidate-a") : String(item.modelBId || "candidate-b")
      });
      responseTemplates.get(reviewerId).push({
        responseId: `${assignmentId}-response`,
        reviewerId,
        caseId,
        dimension,
        assignmentId,
        assignmentHash,
        presentedLabels: ["A", "B"],
        preferredLabel: "",
        artifactTags: [],
        recordedAt: "",
        notes: ""
      });
    }
  }
}

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "reviewer-package", "assignments.json"), `${JSON.stringify({ schemaVersion: "vtv-abx-assignment-package-v1", mode, dimensions, assignments: allAssignments }, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "reviewer-package", "README.txt"), "This is a blind ABX package. Keep reviewer-package private to the reviewer; do not share audit-map.json. Complete one response for every assignment and return responses-<reviewer>.json.\n", "utf8");
const embeddedAssignments = JSON.stringify(allAssignments).replace(/</gu, "\\u003c");
const reviewerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VTV Blind ABX Review</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#172033}button,select,input,textarea{font:inherit;padding:.5rem;margin:.25rem 0}button{cursor:pointer}.row{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}.card{border:1px solid #ccd3df;border-radius:12px;padding:1rem;margin:1rem 0}audio{width:100%}textarea{width:100%;min-height:4rem}.muted{color:#5d687a}.progress{height:8px;background:#e7ebf2;border-radius:8px}.progress>i{display:block;height:100%;background:#3267d6;border-radius:8px}</style></head>
<body><h1>VTV Blind ABX Review</h1><p class="muted">Do not infer model identity from filenames. Listen to the reference, then A and B. Record your independent preference.</p>
<div class="card"><label>Reviewer ID <input id="reviewer" placeholder="reviewer-1"></label><div class="progress"><i id="bar"></i></div><p id="position"></p><p id="case"></p><audio id="reference" controls></audio><div class="row"><button data-audio="A">Play A</button><button data-audio="B">Play B</button><button data-audio="reference">Play reference</button></div><p><label>Preference <select id="preference"><option value="">Choose…</option><option>A</option><option>B</option><option>TIE</option></select></label></p><label>Artifact tags (comma separated)<input id="tags" style="width:100%" placeholder="none, metallic, click, residual"></label><label>Notes<textarea id="notes"></textarea></label><div class="row"><button id="save">Save current response</button><button id="next">Next</button><button id="download">Download responses</button></div><p id="status" class="muted"></p></div>
<script>const assignments=${embeddedAssignments};let index=0;const responses=new Map();const reviewer=document.querySelector('#reviewer');const audio={reference:document.querySelector('#reference'),A:new Audio(),B:new Audio()};const el=id=>document.querySelector(id);function render(){const x=assignments[index];el('#position').textContent='Assignment '+(index+1)+' / '+assignments.length;el('#case').textContent=x.caseId+' · '+x.dimension;el('#bar').style.width=((index+1)/assignments.length*100)+'%';audio.reference.src=x.audio.reference;audio.A.src=x.audio.A;audio.B.src=x.audio.B;const old=responses.get(x.assignmentId)||{};el('#preference').value=old.preferredLabel||'';el('#tags').value=(old.artifactTags||[]).join(', ');el('#notes').value=old.notes||'';el('#status').textContent=old.preferredLabel?'Saved locally.':'Not recorded.'}function save(){const x=assignments[index],id=(reviewer.value||'').trim();if(!id){el('#status').textContent='Enter a reviewer ID first.';return false}const preferred=el('#preference').value;if(!['A','B','TIE'].includes(preferred)){el('#status').textContent='Choose A, B, or TIE.';return false}responses.set(x.assignmentId,{responseId:x.assignmentId+'-response',reviewerId:id,caseId:x.caseId,dimension:x.dimension,assignmentId:x.assignmentId,assignmentHash:x.assignmentHash,presentedLabels:['A','B'],preferredLabel:preferred,artifactTags:el('#tags').value.split(',').map(s=>s.trim()).filter(Boolean),recordedAt:new Date().toISOString(),notes:el('#notes').value.trim()});el('#status').textContent='Saved locally.';return true}function download(){const id=(reviewer.value||'').trim();if(!id){el('#status').textContent='Enter a reviewer ID first.';return}const payload={schemaVersion:'vtv-abx-response-template-v1',mode,reviewerId:id,responses:[...responses.values()]};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)+'\\n'],{type:'application/json'}));a.download='responses-'+id+'.json';a.click();URL.revokeObjectURL(a.href)}document.querySelectorAll('[data-audio]').forEach(b=>b.onclick=()=>{Object.values(audio).forEach(a=>a.pause());audio[b.dataset.audio].currentTime=0;audio[b.dataset.audio].play()});el('#save').onclick=save;el('#next').onclick=()=>{if(save()&&index<assignments.length-1){index++;render()}};el('#download').onclick=()=>{save();download()};render();</script></body></html>`;
const reviewerHtmlWithMode = reviewerHtml.replace("mode,reviewerId", `mode:${JSON.stringify(mode)},reviewerId`);
await fs.writeFile(path.join(outputDir, "reviewer-package", "reviewer.html"), reviewerHtmlWithMode, "utf8");
for (const [reviewerId, responses] of responseTemplates) {
  await fs.writeFile(path.join(outputDir, `responses-${reviewerId}.template.json`), `${JSON.stringify({ schemaVersion: "vtv-abx-response-template-v1", mode, reviewerId, responses }, null, 2)}\n`, "utf8");
}
await fs.writeFile(path.join(outputDir, "audit-map.json"), `${JSON.stringify({ schemaVersion: "vtv-abx-private-audit-map-v1", mode, sourceCasesPath: casesPath, mappings: privateMappings }, null, 2)}\n`, "utf8");
const summary = { schemaVersion: "vtv-abx-assignment-summary-v1", mode, reviewerCount: reviewers.length, caseCount: cases.length, dimensionCount: dimensions.length, assignmentCount: allAssignments.length, outputDir, reviewerPackage: path.join(outputDir, "reviewer-package") };
await fs.writeFile(path.join(outputDir, "assignment-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
