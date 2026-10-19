import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assistantError, assertDirectoryNoLinks, boundedText, createId, isPathInside, isoNow, jsonParse, normalizePathKey, safeDisplayName, sendAssistantError, sha256 } from "./utils.mjs";

const TOOL_IDS = new Set(["images", "videos", "file-transfer", "format-factory"]);
const ACTION_TYPES = new Set(["tag", "summary", "copy", "move", "rename"]);
const TRIGGER_TYPES = new Set(["manual", "inbox-added", "tool-completed", "watch-folder"]);
const execFileAsync = promisify(execFile);

function serializeRecipe(row) {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    trigger: jsonParse(row.trigger_json, { type: "manual" }),
    conditions: jsonParse(row.conditions_json, []),
    actions: jsonParse(row.actions_json, []),
    enabled: Boolean(row.enabled),
    revision: Number(row.revision),
    approvedRevision: row.approved_revision === null ? undefined : Number(row.approved_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializePlan(row) {
  return {
    id: row.id,
    recipeId: row.recipe_id || undefined,
    recipeRevision: row.recipe_revision === null ? undefined : Number(row.recipe_revision),
    planHash: row.hash,
    state: row.state,
    operations: jsonParse(row.operations_json, []),
    warnings: jsonParse(row.warnings_json, []),
    sourceFingerprints: jsonParse(row.operations_json, []).map((operation) => ({ itemId: operation.itemId, fingerprint: operation.fingerprint })),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeTags(tags) {
  return [...new Set((tags || []).map((tag) => boundedText(tag, 64).toLowerCase()).filter(Boolean))].sort().slice(0, 50);
}

function validateDraft(input) {
  const draft = input || {};
  const name = boundedText(draft.name, 120);
  if (!name) throw assistantError("invalid_recipe", "A recipe name is required.", 400);
  const mode = draft.mode === "automatic-safe" ? "automatic-safe" : draft.mode === "suggest" ? "suggest" : null;
  if (!mode) throw assistantError("invalid_recipe", "Recipe mode must be suggest or automatic-safe.", 400);
  const trigger = draft.trigger || { type: "manual" };
  if (!TRIGGER_TYPES.has(trigger.type)) throw assistantError("invalid_recipe", "The recipe trigger is not supported.", 400);
  if (trigger.type === "tool-completed" && (!Array.isArray(trigger.tools) || trigger.tools.some((tool) => !TOOL_IDS.has(tool)))) throw assistantError("invalid_recipe", "Choose valid Magic Box tools for this trigger.", 400);
  if (trigger.type === "watch-folder" && !trigger.workspaceRootId) throw assistantError("invalid_recipe", "A watch-folder trigger needs an approved workspace root.", 400);
  const conditions = Array.isArray(draft.conditions) ? draft.conditions.slice(0, 20) : [];
  const actions = Array.isArray(draft.actions) ? draft.actions.slice(0, 20) : [];
  if (!actions.length || actions.some((action) => !ACTION_TYPES.has(action?.type))) throw assistantError("invalid_recipe", "A recipe needs at least one supported action.", 400);
  for (const action of actions) {
    if (action.type === "tag") {
      action.add = normalizeTags(action.add);
      action.remove = normalizeTags(action.remove);
      if (action.add.some((tag) => action.remove.includes(tag))) throw assistantError("invalid_recipe", "A tag cannot be added and removed in the same action.", 400);
    }
    if (["copy", "move"].includes(action.type) && !action.destinationRootId) throw assistantError("invalid_recipe", "Copy and move actions need an approved destination root.", 400);
    if (action.type === "rename" && !boundedText(action.template, 180)) throw assistantError("invalid_recipe", "Rename actions need a filename template.", 400);
  }
  if (mode === "automatic-safe" && actions.some((action) => !["tag", "summary", "copy"].includes(action.type))) {
    throw assistantError("automatic_action_not_safe", "Automatic recipes can only tag, summarize, or copy without per-run approval.", 422);
  }
  return { name, mode, trigger, conditions, actions };
}

function matchesConditions(row, conditions) {
  const tags = jsonParse(row.tags_json, []);
  const origins = jsonParse(row.origins_json, []);
  return conditions.every((condition) => {
    if (condition.type === "extension") return condition.values?.map((value) => value.toLowerCase()).includes(path.extname(row.display_name).toLowerCase());
    if (condition.type === "content-type") return condition.values?.includes(row.content_type);
    if (condition.type === "size") return (condition.minimum === undefined || row.size_bytes >= condition.minimum) && (condition.maximum === undefined || row.size_bytes <= condition.maximum);
    if (condition.type === "source-tool") return origins.some((origin) => origin.kind === "tool" && condition.values?.includes(origin.toolId));
    if (condition.type === "text-contains") return String(row.extracted_text || "").toLowerCase().includes(String(condition.value || "").toLowerCase());
    if (condition.type === "tag") return tags.includes(String(condition.value || "").toLowerCase());
    return false;
  });
}

async function vacantDestination(candidate) {
  try {
    await fs.lstat(candidate);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function collisionSafePath(directory, filename, reservations) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  for (let counter = 1; counter <= 10_000; counter += 1) {
    const name = counter === 1 ? filename : `${stem} (${counter})${extension}`;
    const candidate = path.join(directory, name);
    const key = normalizePathKey(candidate);
    if (!reservations.has(key) && await vacantDestination(candidate)) {
      reservations.add(key);
      return candidate;
    }
  }
  throw assistantError("path_not_allowed", "A non-conflicting destination filename could not be reserved.", 409);
}

async function sameFileIdentity(firstPath, secondPath) {
  try {
    const [first, second] = await Promise.all([fs.stat(firstPath), fs.stat(secondPath)]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch { return false; }
}

async function relocateNoReplace(sourcePath, destinationPath, expectedFingerprint, onLinked) {
  const packagedHelper = path.join(path.dirname(process.execPath), "MagicBox.FileOps.exe");
  if (process.platform === "win32") {
    try {
      await fs.access(packagedHelper);
      await execFileAsync(packagedHelper, ["relocate", sourcePath, destinationPath, expectedFingerprint], { windowsHide: true, timeout: 120_000 });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (/source_fingerprint_changed/i.test(String(error.stderr || error.message))) throw assistantError("stale_plan", "The source changed after preview.", 409);
        throw assistantError("stale_plan", "The planned destination is no longer available or the source changed.", 409);
      }
    }
  }
  if (await shaFile(sourcePath) !== expectedFingerprint) throw assistantError("stale_plan", "The source changed after preview.", 409);
  try { await fs.link(sourcePath, destinationPath); }
  catch (error) { throw assistantError("stale_plan", "The planned destination is no longer available.", 409); }
  await onLinked?.();
  if (await shaFile(destinationPath) !== expectedFingerprint || !await sameFileIdentity(sourcePath, destinationPath)) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    throw assistantError("stale_plan", "The source changed while the relocation was being committed.", 409);
  }
  await fs.unlink(sourcePath);
}

async function shaFile(filePath) {
  const { createReadStream } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function renderRename(template, row, counter = 1) {
  const extension = path.extname(row.display_name);
  const name = path.basename(row.display_name, extension);
  const now = new Date();
  const rendered = String(template)
    .replaceAll("{name}", name)
    .replaceAll("{extension}", extension.replace(/^\./, ""))
    .replaceAll("{yyyy}", String(now.getFullYear()))
    .replaceAll("{mm}", String(now.getMonth() + 1).padStart(2, "0"))
    .replaceAll("{dd}", String(now.getDate()).padStart(2, "0"))
    .replaceAll("{counter}", String(counter));
  const finalName = rendered.endsWith(extension) || template.includes("{extension}") ? rendered : `${rendered}${extension}`;
  const base = path.basename(finalName, path.extname(finalName)).toUpperCase();
  if (!finalName || finalName.length > 180 || finalName === "." || finalName === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(finalName) || /[. ]$/.test(finalName) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
    throw assistantError("invalid_recipe", "The rename template produced an invalid Windows filename.", 400);
  }
  return finalName;
}

export function createAutomationEngine({ manager, modelRuntime }) {
  const { store, core, router } = manager;
  core.setCapability("automation", "recovering");
  const eventSubscriberId = "automation-engine-v1";
  let processingEvents = false;
  let processingEventsPromise = null;
  let stopped = false;

  async function createRecipe(draftInput) {
    const draft = validateDraft(draftInput);
    const id = createId("recipe");
    const createdAt = isoNow();
    store.db.prepare("INSERT INTO recipes(id,name,mode,enabled,revision,approved_revision,trigger_json,conditions_json,actions_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, draft.name, draft.mode, 0, 1, null, JSON.stringify(draft.trigger), JSON.stringify(draft.conditions), JSON.stringify(draft.actions), createdAt, createdAt);
    await core.activity.append({ kind: "recipe", action: "recipe.changed", status: "completed", summary: `${draft.name} created`, related: { recipeId: id } });
    return serializeRecipe(store.db.prepare("SELECT * FROM recipes WHERE id=?").get(id));
  }

  async function updateRecipe(recipeId, expectedRevision, draftInput) {
    const row = store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId);
    if (!row) throw assistantError("recipe_not_found", "The recipe was not found.", 404);
    if (Number(expectedRevision) !== Number(row.revision)) throw assistantError("recipe_revision_changed", "The recipe changed; review the latest version.", 409);
    const draft = validateDraft(draftInput);
    store.db.prepare("UPDATE recipes SET name=?,mode=?,enabled=0,revision=revision+1,approved_revision=NULL,trigger_json=?,conditions_json=?,actions_json=?,updated_at=? WHERE id=?")
      .run(draft.name, draft.mode, JSON.stringify(draft.trigger), JSON.stringify(draft.conditions), JSON.stringify(draft.actions), isoNow(), recipeId);
    store.db.prepare("UPDATE plans SET state='invalidated',updated_at=? WHERE recipe_id=? AND state IN ('previewed','approved')").run(isoNow(), recipeId);
    return serializeRecipe(store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId));
  }

  async function enableRecipe(recipeId, revision, confirmation) {
    const row = store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId);
    if (!row) throw assistantError("recipe_not_found", "The recipe was not found.", 404);
    if (!confirmation || Number(revision) !== Number(row.revision)) throw assistantError("recipe_revision_changed", "Review and confirm the current recipe revision.", 409);
    store.db.prepare("UPDATE recipes SET enabled=1,approved_revision=revision,updated_at=? WHERE id=?").run(isoNow(), recipeId);
    await core.activity.append({ kind: "recipe", action: "recipe.changed", status: "completed", summary: `${row.name} enabled`, related: { recipeId } });
    return serializeRecipe(store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId));
  }

  async function disableRecipe(recipeId) {
    const row = store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId);
    if (!row) throw assistantError("recipe_not_found", "The recipe was not found.", 404);
    const invalidatedPlans = Number(store.db.prepare("SELECT COUNT(*) AS count FROM plans WHERE recipe_id=? AND state IN ('previewed','approved')").get(recipeId).count);
    store.transaction(() => {
      store.db.prepare("UPDATE recipes SET enabled=0,updated_at=? WHERE id=?").run(isoNow(), recipeId);
      store.db.prepare("UPDATE plans SET state='invalidated',updated_at=? WHERE recipe_id=? AND state IN ('previewed','approved')").run(isoNow(), recipeId);
    });
    return { recipe: serializeRecipe(store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId)), invalidatedPlans, cancellationRequestedJobs: 0 };
  }

  function removeRecipe(recipeId) {
    const inUse = Number(store.db.prepare("SELECT COUNT(*) AS count FROM plans WHERE recipe_id=? AND state IN ('previewed','approved','executing')").get(recipeId).count);
    if (inUse) throw assistantError("recipe_in_use", "Finish or invalidate active plans before deleting this recipe.", 409);
    const result = store.db.prepare("DELETE FROM recipes WHERE id=?").run(recipeId);
    if (!result.changes) throw assistantError("recipe_not_found", "The recipe was not found.", 404);
    return { removed: true };
  }

  async function preview({ recipeId, recipeDraft, itemIds }) {
    if (Boolean(recipeId) === Boolean(recipeDraft)) throw assistantError("invalid_recipe", "Choose exactly one saved recipe or draft.", 400);
    let draft;
    let recipe = null;
    if (recipeId) {
      const row = store.db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId);
      if (!row) throw assistantError("recipe_not_found", "The recipe was not found.", 404);
      recipe = serializeRecipe(row);
      draft = validateDraft(recipe);
    } else {
      draft = validateDraft(recipeDraft);
    }
    const ids = [...new Set(Array.isArray(itemIds) ? itemIds : [])].slice(0, 100);
    if (!ids.length) throw assistantError("invalid_recipe", "Choose at least one Inbox item to preview.", 400);
    const rows = ids.map((id) => store.db.prepare("SELECT * FROM items WHERE id=?").get(id)).filter(Boolean).filter((row) => matchesConditions(row, draft.conditions));
    const operations = [];
    const reservations = new Set();
    for (const row of rows) {
      let currentPath = row.canonical_path;
      let currentTags = jsonParse(row.tags_json, []);
      let currentMetadataRevision = Number(row.metadata_revision);
      for (const action of draft.actions) {
        const before = { path: currentPath, tags: currentTags, summary: row.summary };
        let after = { ...before };
        if (action.type === "tag") after.tags = normalizeTags([...currentTags.filter((tag) => !action.remove.includes(tag)), ...action.add]);
        if (["copy", "move"].includes(action.type)) {
          const root = store.db.prepare("SELECT * FROM workspace_roots WHERE id=?").get(action.destinationRootId);
          if (!root) throw assistantError("workspace_root_not_found", "The destination workspace root no longer exists.", 404);
          const canonicalRoot = await assertDirectoryNoLinks(root.canonical_path);
          const destinationDir = path.resolve(canonicalRoot, action.subdirectory || "");
          if (!isPathInside(canonicalRoot, destinationDir)) throw assistantError("path_not_allowed", "The destination escaped its approved workspace root.", 403);
          await assertDirectoryNoLinks(destinationDir);
          if (draft.trigger.type === "watch-folder") {
            const watchedRoot = store.db.prepare("SELECT canonical_path FROM workspace_roots WHERE id=?").get(draft.trigger.workspaceRootId);
            if (watchedRoot && isPathInside(watchedRoot.canonical_path, destinationDir)) throw assistantError("automation_cycle_risk", "A watched-folder recipe cannot write back into its watched tree.", 422);
          }
          after.path = await collisionSafePath(destinationDir, path.basename(currentPath), reservations);
        }
        if (["move", "rename"].includes(action.type)) {
          const workspaceOrigins = jsonParse(row.origins_json, []).filter((origin) => origin.kind === "workspace");
          if (row.source !== "workspace" || workspaceOrigins.length !== 1 || jsonParse(row.origins_json, []).length !== 1) {
            throw assistantError("path_not_allowed", "Move and rename require exactly one approved workspace origin.", 403);
          }
        }
        if (action.type === "rename") after.path = await collisionSafePath(path.dirname(currentPath), renderRename(action.template, row), reservations);
        if (["copy", "move", "rename"].includes(action.type) && normalizePathKey(after.path) === normalizePathKey(currentPath)) throw assistantError("invalid_recipe", "The planned source and destination are identical.", 400);
        operations.push({ itemId: row.id, action, before, after, fingerprint: row.fingerprint, revision: Number(row.revision), metadataRevision: currentMetadataRevision });
        if (operations.length > 100) throw assistantError("automation_plan_too_large", "One automation plan is limited to 100 operations.", 400);
        if (["tag", "summary"].includes(action.type)) currentMetadataRevision += 1;
        if (action.type !== "copy") currentPath = after.path;
        currentTags = after.tags;
      }
    }
    const planId = createId("plan");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const canonical = JSON.stringify({ recipeId: recipe?.id || null, recipeRevision: recipe?.revision || null, operations, expiresAt });
    const hash = sha256(canonical);
    const createdAt = isoNow();
    store.db.prepare("INSERT INTO plans(id,recipe_id,recipe_revision,state,hash,operations_json,warnings_json,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(planId, recipe?.id || null, recipe?.revision || null, "previewed", hash, JSON.stringify(operations), JSON.stringify(rows.length ? [] : ["no_matching_items"]), expiresAt, createdAt, createdAt);
    return serializePlan(store.db.prepare("SELECT * FROM plans WHERE id=?").get(planId));
  }

  function approve(planId, planHash, confirmation) {
    const row = store.db.prepare("SELECT * FROM plans WHERE id=?").get(planId);
    if (!row) throw assistantError("stale_plan", "The plan was not found.", 409);
    if (row.state !== "previewed" || row.hash !== planHash) throw assistantError("stale_plan", "The plan changed or is no longer previewable.", 409);
    if (new Date(row.expires_at).getTime() <= Date.now()) throw assistantError("plan_expired", "The plan expired; create a fresh preview.", 409);
    if (!confirmation) throw assistantError("approval_required", "Confirm the exact plan before execution.", 409);
    const approvalId = createId("approval");
    store.db.prepare("UPDATE plans SET state='approved',approval_hash=?,updated_at=? WHERE id=?").run(sha256(approvalId), isoNow(), planId);
    return { planId, approvalId, approvedAt: isoNow() };
  }

  function verifyOperationSource(operation) {
    const row = store.db.prepare("SELECT * FROM items WHERE id=?").get(operation.itemId);
    if (!row || row.fingerprint !== operation.fingerprint || Number(row.revision) !== Number(operation.revision) || Number(row.metadata_revision) !== Number(operation.metadataRevision) || normalizePathKey(row.canonical_path) !== normalizePathKey(operation.before.path)) {
      throw assistantError("stale_plan", "An item changed after preview; create a fresh plan.", 409);
    }
    return row;
  }

  function beginOperationJournal(planId, operationIndex, operation) {
    const id = createId("automation-operation");
    const createdAt = isoNow();
    store.db.prepare("INSERT INTO automation_operations(id,plan_id,operation_index,action,phase,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, planId, operationIndex, operation.action.type, "prepared", JSON.stringify({ operation }), createdAt, createdAt);
    return id;
  }

  function updateOperationJournal(id, phase, patch = {}) {
    const row = store.db.prepare("SELECT * FROM automation_operations WHERE id=?").get(id);
    if (!row) throw assistantError("automation_journal_missing", "The automation recovery journal is missing.", 500);
    const payload = { ...jsonParse(row.payload_json, {}), ...patch };
    store.db.prepare("UPDATE automation_operations SET phase=?,payload_json=?,error_json=NULL,updated_at=? WHERE id=?")
      .run(phase, JSON.stringify(payload), isoNow(), id);
  }

  function failOperationJournal(id, error) {
    store.db.prepare("UPDATE automation_operations SET phase='recovery-required',error_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify({ code: error.code || "automation_recovery_required", message: boundedText(error.message, 512) }), isoNow(), id);
  }

  async function executeOperation(planId, operationIndex, operation, signal) {
    if (signal.aborted) throw assistantError("job_cancelled", "Automation was cancelled.", 409);
    const row = verifyOperationSource(operation);
    const journalId = beginOperationJournal(planId, operationIndex, operation);
    if (operation.action.type === "tag") {
      const beforeTags = jsonParse(row.tags_json, []);
      store.db.prepare("UPDATE items SET tags_json=?,metadata_revision=metadata_revision+1,updated_at=? WHERE id=?").run(JSON.stringify(operation.after.tags), isoNow(), row.id);
      const result = { type: "tag", itemId: row.id, beforeTags, afterTags: operation.after.tags };
      updateOperationJournal(journalId, "core-committed", { result });
      return result;
    }
    if (operation.action.type === "summary") {
      if (modelRuntime.status().generation !== "ready") throw assistantError("assistant_model_unavailable", "Activate a local generation model before running summary automation.", 503);
      const beforeSummary = row.summary;
      const result = await modelRuntime.generate({ messages: [{ role: "system", content: "Summarize the provided local document in at most 120 words. Do not propose actions." }, { role: "user", content: boundedText(row.extracted_text || row.summary || row.display_name, 96 * 1024) }], context: [], maxOutputTokens: 512, signal });
      const afterSummary = boundedText(result.text, 2048);
      store.db.prepare("UPDATE items SET summary=?,metadata_revision=metadata_revision+1,updated_at=? WHERE id=?").run(afterSummary, isoNow(), row.id);
      const operationResult = { type: "summary", itemId: row.id, beforeSummary, afterSummary };
      updateOperationJournal(journalId, "core-committed", { result: operationResult });
      return operationResult;
    }
    const sourcePath = row.canonical_path;
    const destinationPath = operation.after.path;
    if (!await vacantDestination(destinationPath)) throw assistantError("stale_plan", "The planned destination is no longer available.", 409);
    const sourceStats = await fs.lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw assistantError("path_not_allowed", "The source is no longer a regular file.", 403);
    if (operation.action.type === "copy") {
      try {
        await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        failOperationJournal(journalId, error);
        throw error;
      }
      updateOperationJournal(journalId, "destination-created", { sourcePath, destinationPath });
      if (await core.hashFile(destinationPath) !== operation.fingerprint) {
        await fs.rm(destinationPath, { force: true });
        throw assistantError("stale_plan", "The source changed while the copy was being committed.", 409);
      }
      const copiedStats = await fs.stat(destinationPath);
      const root = store.db.prepare("SELECT * FROM workspace_roots WHERE id=?").get(operation.action.destinationRootId);
      const { itemId: copiedItemId } = await core.admitAndIndexReferencedItem({ canonical: destinationPath, stats: copiedStats, root, source: "workspace", indexOptions: { signal, commitGuard: () => Number(store.db.prepare("SELECT generation FROM workspace_roots WHERE id=?").get(root.id)?.generation) === Number(root.generation) } });
      const result = { type: "copy", itemId: row.id, copiedItemId, destinationPath, fingerprint: operation.fingerprint };
      updateOperationJournal(journalId, "core-committed", { result });
      return result;
    }
    if (operation.action.type === "move") {
      if (path.parse(sourcePath).root.toLowerCase() !== path.parse(destinationPath).root.toLowerCase()) throw assistantError("filesystem_not_supported", "Move is limited to the same local volume; use Copy instead.", 409);
      await relocateNoReplace(sourcePath, destinationPath, operation.fingerprint, () => updateOperationJournal(journalId, "destination-linked", { sourcePath, destinationPath }));
      updateOperationJournal(journalId, "relocated", { sourcePath, destinationPath });
      store.db.prepare("UPDATE items SET canonical_path=?,path_key=?,display_name=?,updated_at=? WHERE id=?").run(destinationPath, normalizePathKey(destinationPath), safeDisplayName(destinationPath), isoNow(), row.id);
      const result = { type: "move", itemId: row.id, sourcePath, destinationPath, fingerprint: operation.fingerprint };
      updateOperationJournal(journalId, "core-committed", { result });
      return result;
    }
    if (operation.action.type === "rename") {
      await relocateNoReplace(sourcePath, destinationPath, operation.fingerprint, () => updateOperationJournal(journalId, "destination-linked", { sourcePath, destinationPath }));
      updateOperationJournal(journalId, "relocated", { sourcePath, destinationPath });
      store.db.prepare("UPDATE items SET canonical_path=?,path_key=?,display_name=?,updated_at=? WHERE id=?").run(destinationPath, normalizePathKey(destinationPath), safeDisplayName(destinationPath), isoNow(), row.id);
      const result = { type: "rename", itemId: row.id, sourcePath, destinationPath, fingerprint: operation.fingerprint };
      updateOperationJournal(journalId, "core-committed", { result });
      return result;
    }
    throw assistantError("invalid_recipe", "The automation action is unsupported.", 400);
  }

  function execute({ planId, approvalId }) {
    const plan = store.db.prepare("SELECT * FROM plans WHERE id=?").get(planId);
    if (!plan) throw assistantError("stale_plan", "The plan was not found.", 409);
    if (plan.state === "executing") throw assistantError("plan_already_executing", "This plan is already executing.", 409);
    if (!["previewed", "approved"].includes(plan.state)) throw assistantError("stale_plan", "The plan is no longer executable.", 409);
    if (new Date(plan.expires_at).getTime() <= Date.now()) throw assistantError("plan_expired", "The plan expired; create a fresh preview.", 409);
    if (!plan.recipe_id) throw assistantError("approval_required", "Save the recipe and preview its concrete revision before execution.", 409);
    const recipeRow = store.db.prepare("SELECT * FROM recipes WHERE id=?").get(plan.recipe_id);
    if (!recipeRow || !recipeRow.enabled || Number(recipeRow.revision) !== Number(plan.recipe_revision) || Number(recipeRow.approved_revision) !== Number(recipeRow.revision)) throw assistantError("recipe_revision_changed", "The enabled recipe revision changed; preview again.", 409);
    const operations = jsonParse(plan.operations_json, []);
    const needsApproval = recipeRow.mode === "suggest" || operations.some((operation) => ["move", "rename"].includes(operation.action.type));
    if (needsApproval) {
      if (!approvalId || sha256(approvalId) !== plan.approval_hash) throw assistantError("approval_required", "Approve this exact plan before execution.", 409);
      store.db.prepare("UPDATE plans SET approval_hash=NULL WHERE id=?").run(planId);
    }
    store.db.prepare("UPDATE plans SET state='executing',updated_at=? WHERE id=?").run(isoNow(), planId);
    return core.startJob({ type: "automation", stage: "executing", message: `Running ${recipeRow.name}`, cancellable: true, requested: operations.length }, async ({ signal, report }) => {
      const completed = [];
      let failure = null;
      for (let index = 0; index < operations.length; index += 1) {
        if (signal.aborted) break;
        try {
          completed.push(await executeOperation(planId, index, operations[index], signal));
        } catch (error) {
          failure = error;
          break;
        }
        report({ progress: Math.round(100 * completed.length / operations.length), stage: "executing", message: `Completed ${completed.length} of ${operations.length}`, counts: { requested: operations.length, completed: completed.length, failed: failure ? 1 : 0, skipped: operations.length - completed.length - (failure ? 1 : 0) } });
      }
      const cancelled = signal.aborted;
      const status = cancelled ? "cancelled" : failure ? (completed.length ? "partial" : "failed") : "completed";
      store.db.prepare("UPDATE plans SET state=?,updated_at=? WHERE id=?").run(status === "partial" ? "failed" : status, isoNow(), planId);
      const retention = store.getRetention();
      const expiresAt = new Date(Date.now() + retention.undoDays * 86400000).toISOString();
      const activity = await core.activity.append({ kind: "automation", action: "automation.executed", status, summary: `${recipeRow.name}: ${completed.length} of ${operations.length} action(s) completed`, counts: { requested: operations.length, completed: completed.length, failed: failure ? 1 : 0, skipped: operations.length - completed.length - (failure ? 1 : 0) }, related: { recipeId: recipeRow.id, itemIds: [...new Set(completed.map((entry) => entry.itemId))] }, undo: { eligible: completed.length > 0, expiresAt } });
      if (completed.length) store.db.prepare("INSERT OR REPLACE INTO undo_entries(activity_id,action,payload_json,expires_at,used_at) VALUES(?,?,?,?,NULL)").run(activity.id, "automation", JSON.stringify(completed), expiresAt);
      store.db.prepare("UPDATE automation_operations SET phase='published',updated_at=? WHERE plan_id=? AND phase='core-committed'").run(isoNow(), planId);
      if (failure && !completed.length) throw failure;
      return { planId, activityId: activity.id, counts: { requested: operations.length, completed: completed.length, failed: failure ? 1 : 0, skipped: operations.length - completed.length - (failure ? 1 : 0) } };
    });
  }

  async function preflightUndo(operations) {
    const reversed = [...operations].reverse();
    const virtualItems = new Map();
    const pathState = new Map();
    const touchedPaths = new Set();
    for (const operation of reversed) {
      if (operation.type === "copy") touchedPaths.add(operation.destinationPath);
      if (["move", "rename"].includes(operation.type)) {
        touchedPaths.add(operation.sourcePath);
        touchedPaths.add(operation.destinationPath);
      }
    }
    for (const filePath of touchedPaths) {
      const key = normalizePathKey(filePath);
      try {
        const stats = await fs.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) throw assistantError("undo_stale", "A planned undo path is no longer a regular file.", 409);
        pathState.set(key, { path: filePath, fingerprint: await core.hashFile(filePath) });
      } catch (error) {
        if (error.code === "ENOENT") pathState.set(key, null);
        else throw error;
      }
    }
    const virtualItem = (itemId) => {
      if (!virtualItems.has(itemId)) {
        const row = core.getItemRow(itemId);
        virtualItems.set(itemId, row ? { ...row } : null);
      }
      return virtualItems.get(itemId);
    };
    for (const operation of reversed) {
      if (operation.type === "tag") {
        const row = virtualItem(operation.itemId);
        if (!row || JSON.stringify(jsonParse(row.tags_json, [])) !== JSON.stringify(operation.afterTags)) throw assistantError("undo_stale", "Tags changed after automation; undo was not applied.", 409);
        operation.undoExpected = { tagsJson: row.tags_json, metadataRevision: Number(row.metadata_revision) };
        row.tags_json = JSON.stringify(operation.beforeTags);
        row.metadata_revision = Number(row.metadata_revision) + 1;
      } else if (operation.type === "summary") {
        const row = virtualItem(operation.itemId);
        if (!row || row.summary !== operation.afterSummary) throw assistantError("undo_stale", "The summary changed after automation; undo was not applied.", 409);
        operation.undoExpected = { summary: row.summary, metadataRevision: Number(row.metadata_revision) };
        row.summary = operation.beforeSummary;
        row.metadata_revision = Number(row.metadata_revision) + 1;
      } else if (operation.type === "copy") {
        const row = virtualItem(operation.copiedItemId);
        const destinationKey = normalizePathKey(operation.destinationPath);
        if (!row || normalizePathKey(row.canonical_path) !== destinationKey || row.fingerprint !== operation.fingerprint || pathState.get(destinationKey)?.fingerprint !== operation.fingerprint) {
          throw assistantError("undo_stale", "The copied file changed; undo will not delete it.", 409);
        }
        operation.undoExpected = { pathKey: normalizePathKey(row.canonical_path), fingerprint: row.fingerprint, revision: Number(row.revision), metadataRevision: Number(row.metadata_revision) };
        virtualItems.set(operation.copiedItemId, null);
        pathState.set(destinationKey, null);
      } else if (["move", "rename"].includes(operation.type)) {
        const row = virtualItem(operation.itemId);
        const sourceKey = normalizePathKey(operation.sourcePath);
        const destinationKey = normalizePathKey(operation.destinationPath);
        if (pathState.get(sourceKey)) throw assistantError("undo_stale", "The original path is no longer vacant.", 409);
        if (!row || normalizePathKey(row.canonical_path) !== destinationKey || row.fingerprint !== operation.fingerprint || pathState.get(destinationKey)?.fingerprint !== operation.fingerprint) {
          throw assistantError("undo_stale", "The moved file changed after automation.", 409);
        }
        operation.undoExpected = { pathKey: normalizePathKey(row.canonical_path), fingerprint: row.fingerprint, revision: Number(row.revision), metadataRevision: Number(row.metadata_revision) };
        row.canonical_path = operation.sourcePath;
        pathState.set(sourceKey, { path: operation.sourcePath, fingerprint: operation.fingerprint });
        pathState.set(destinationKey, null);
      }
    }
    return reversed;
  }

  async function rollbackUndoFilesystem(applied) {
    const failures = [];
    for (const change of [...applied].reverse()) {
      try {
        if (change.kind === "relocation") await relocateNoReplace(change.restoredPath, change.originalPath, change.fingerprint);
        else if (change.kind === "copy-backup") await relocateNoReplace(change.backupPath, change.destinationPath, change.fingerprint);
      } catch (error) {
        failures.push({ path: change.originalPath || change.destinationPath, code: error.code || "rollback_failed" });
      }
    }
    return failures;
  }

  async function undo(activityId, confirmation) {
    if (!confirmation) throw assistantError("undo_stale", "Confirm the undo after reviewing its impact.", 409);
    const entry = store.db.prepare("SELECT * FROM undo_entries WHERE activity_id=?").get(activityId);
    if (!entry || entry.used_at || new Date(entry.expires_at).getTime() <= Date.now()) throw assistantError("undo_stale", "This action is no longer eligible for undo.", 409);
    const operations = jsonParse(entry.payload_json, []);
    const claim = `in-progress:${createId("undo")}`;
    if (!store.db.prepare("UPDATE undo_entries SET used_at=? WHERE activity_id=? AND used_at IS NULL").run(claim, activityId).changes) throw assistantError("undo_stale", "This undo is already running or no longer eligible.", 409);
    return core.startJob({ type: "automation", stage: "undoing", message: "Undoing approved automation", cancellable: false, requested: operations.length }, async () => {
      const applied = [];
      let reversed;
      try {
        reversed = await preflightUndo(operations);
        const reservations = new Set();
        for (const operation of reversed) {
          if (operation.type === "copy") {
            const backupPath = await collisionSafePath(path.dirname(operation.destinationPath), `.magicbox-undo-${path.basename(operation.destinationPath)}-${createId("backup")}.tmp`, reservations);
            await relocateNoReplace(operation.destinationPath, backupPath, operation.fingerprint);
            applied.push({ kind: "copy-backup", backupPath, destinationPath: operation.destinationPath, fingerprint: operation.fingerprint });
          } else if (["move", "rename"].includes(operation.type)) {
            await relocateNoReplace(operation.destinationPath, operation.sourcePath, operation.fingerprint);
            applied.push({ kind: "relocation", restoredPath: operation.sourcePath, originalPath: operation.destinationPath, fingerprint: operation.fingerprint });
          }
        }
        store.transaction(() => {
          for (const operation of reversed) {
            let result;
            if (operation.type === "tag") {
              result = store.db.prepare("UPDATE items SET tags_json=?,metadata_revision=metadata_revision+1,updated_at=? WHERE id=? AND tags_json=? AND metadata_revision=?")
                .run(JSON.stringify(operation.beforeTags), isoNow(), operation.itemId, operation.undoExpected.tagsJson, operation.undoExpected.metadataRevision);
            } else if (operation.type === "summary") {
              result = store.db.prepare("UPDATE items SET summary=?,metadata_revision=metadata_revision+1,updated_at=? WHERE id=? AND summary IS ? AND metadata_revision=?")
                .run(operation.beforeSummary, isoNow(), operation.itemId, operation.undoExpected.summary, operation.undoExpected.metadataRevision);
            }
            else if (operation.type === "copy") {
              store.db.prepare("DELETE FROM chunks_fts WHERE item_id=?").run(operation.copiedItemId);
              store.db.prepare("DELETE FROM chunks WHERE item_id=?").run(operation.copiedItemId);
              result = store.db.prepare("DELETE FROM items WHERE id=? AND path_key=? AND fingerprint=? AND revision=? AND metadata_revision=?")
                .run(operation.copiedItemId, operation.undoExpected.pathKey, operation.undoExpected.fingerprint, operation.undoExpected.revision, operation.undoExpected.metadataRevision);
            } else if (["move", "rename"].includes(operation.type)) {
              result = store.db.prepare("UPDATE items SET canonical_path=?,path_key=?,display_name=?,updated_at=? WHERE id=? AND path_key=? AND fingerprint=? AND revision=? AND metadata_revision=?")
                .run(operation.sourcePath, normalizePathKey(operation.sourcePath), safeDisplayName(operation.sourcePath), isoNow(), operation.itemId, operation.undoExpected.pathKey, operation.undoExpected.fingerprint, operation.undoExpected.revision, operation.undoExpected.metadataRevision);
            }
            if (!result?.changes) throw assistantError("undo_stale", "Assistant metadata changed after undo preflight; no partial undo was committed.", 409);
          }
          store.db.prepare("UPDATE undo_entries SET used_at=? WHERE activity_id=? AND used_at=?").run(isoNow(), activityId, claim);
        });
        for (const change of applied.filter((entry) => entry.kind === "copy-backup")) await fs.rm(change.backupPath).catch(() => {});
      } catch (error) {
        const rollbackFailures = await rollbackUndoFilesystem(applied);
        if (!rollbackFailures.length) store.db.prepare("UPDATE undo_entries SET used_at=NULL WHERE activity_id=? AND used_at=?").run(activityId, claim);
        if (rollbackFailures.length) throw assistantError("automation_recovery_required", "Undo could not be rolled back completely; affected paths were left untouched for manual recovery.", 409, false, { rollbackFailures });
        throw error;
      }
      await core.activity.append({ kind: "automation", action: "automation.undone", status: "completed", summary: `Undid ${operations.length} automation action(s)` });
      return { counts: { requested: operations.length, completed: operations.length, failed: 0, skipped: 0 } };
    });
  }

  async function propose({ instruction, itemIds }) {
    if (modelRuntime.status().generation !== "ready") throw assistantError("assistant_model_unavailable", "Activate a local generation model before asking for a recipe proposal.", 503);
    const items = [...new Set(itemIds || [])].slice(0, 16).map((id) => core.getItemRow(id)).filter(Boolean).map((row) => ({ displayName: row.display_name, contentType: row.content_type, sizeBytes: row.size_bytes, tags: jsonParse(row.tags_json, []), summary: row.summary }));
    const schema = `{ "name": string, "mode": "suggest"|"automatic-safe", "trigger": {"type":"manual"}, "conditions": [], "actions": [{"type":"tag","add":[],"remove":[]}|{"type":"summary"}|{"type":"copy","destinationRootId":string}|{"type":"move","destinationRootId":string}|{"type":"rename","template":string}] }`;
    const generated = await modelRuntime.generate({ messages: [{ role: "system", content: `Return exactly one JSON object matching this schema and no Markdown: ${schema}. Never propose delete, overwrite, shell, code, network, email, or browser actions.` }, { role: "user", content: `Instruction: ${boundedText(instruction, 4096)}\nApproved item metadata: ${JSON.stringify(items)}` }], context: [], maxOutputTokens: 768 });
    let draft;
    try { draft = validateDraft(JSON.parse(generated.text)); }
    catch (error) { if (error.code) throw error; throw assistantError("invalid_recipe", "The local model did not produce a valid safe recipe.", 422, true); }
    return { id: createId("proposal"), explanation: "Local model proposal; review every condition and action before creating it.", recipeDraft: draft, requiresApproval: true, model: generated.model };
  }

  async function regularFileExists(filePath) {
    try {
      const stats = await fs.lstat(filePath);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function recoverOperation(row) {
    const payload = jsonParse(row.payload_json, {});
    const operation = payload.operation;
    if (!operation) throw assistantError("automation_recovery_required", "An automation journal record is incomplete.", 500);
    if (row.phase === "core-committed") return;
    const current = core.getItemRow(operation.itemId);
    if (["tag", "summary"].includes(row.action)) {
      if (!current) return updateOperationJournal(row.id, "abandoned");
      if (row.action === "tag" && JSON.stringify(jsonParse(current.tags_json, [])) === JSON.stringify(operation.after.tags)) {
        return updateOperationJournal(row.id, "core-committed", { result: { type: "tag", itemId: operation.itemId, beforeTags: operation.before.tags, afterTags: operation.after.tags } });
      }
      if (row.action === "summary" && Number(current.metadata_revision) === Number(operation.metadataRevision) + 1 && current.summary !== operation.before.summary) {
        return updateOperationJournal(row.id, "core-committed", { result: { type: "summary", itemId: operation.itemId, beforeSummary: operation.before.summary, afterSummary: current.summary } });
      }
      return updateOperationJournal(row.id, "abandoned");
    }
    const sourcePath = operation.before.path;
    const destinationPath = operation.after.path;
    const sourceExists = await regularFileExists(sourcePath);
    const destinationExists = await regularFileExists(destinationPath);
    if (row.action === "copy") {
      if (!destinationExists) return updateOperationJournal(row.id, "abandoned");
      if (await core.hashFile(destinationPath) !== operation.fingerprint) throw assistantError("automation_recovery_required", "A copied destination changed during recovery.", 409);
      const root = store.db.prepare("SELECT * FROM workspace_roots WHERE id=?").get(operation.action.destinationRootId);
      if (!root) throw assistantError("automation_recovery_required", "The copy destination grant is no longer available.", 409);
      const copiedStats = await fs.stat(destinationPath);
      const { itemId: copiedItemId } = await core.admitAndIndexReferencedItem({ canonical: destinationPath, stats: copiedStats, root, source: "workspace", indexOptions: { commitGuard: () => Number(store.db.prepare("SELECT generation FROM workspace_roots WHERE id=?").get(root.id)?.generation) === Number(root.generation) } });
      return updateOperationJournal(row.id, "core-committed", { sourcePath, destinationPath, result: { type: "copy", itemId: operation.itemId, copiedItemId, destinationPath, fingerprint: operation.fingerprint } });
    }
    if (destinationExists && sourceExists && await sameFileIdentity(sourcePath, destinationPath)) {
      if (await core.hashFile(destinationPath) !== operation.fingerprint) throw assistantError("automation_recovery_required", "A linked relocation changed during recovery.", 409);
      await fs.unlink(sourcePath);
      return recoverOperation({ ...row, phase: "relocated", payload_json: JSON.stringify({ ...payload, sourcePath, destinationPath }) });
    }
    if (destinationExists && !sourceExists) {
      if (await core.hashFile(destinationPath) !== operation.fingerprint) throw assistantError("automation_recovery_required", "A relocated destination changed during recovery.", 409);
      if (!current || (normalizePathKey(current.canonical_path) !== normalizePathKey(sourcePath) && normalizePathKey(current.canonical_path) !== normalizePathKey(destinationPath))) {
        throw assistantError("automation_recovery_required", "The relocated item identity is ambiguous.", 409);
      }
      store.db.prepare("UPDATE items SET canonical_path=?,path_key=?,display_name=?,updated_at=? WHERE id=?").run(destinationPath, normalizePathKey(destinationPath), safeDisplayName(destinationPath), isoNow(), operation.itemId);
      return updateOperationJournal(row.id, "core-committed", { sourcePath, destinationPath, result: { type: row.action, itemId: operation.itemId, sourcePath, destinationPath, fingerprint: operation.fingerprint } });
    }
    if (sourceExists && !destinationExists) return updateOperationJournal(row.id, "abandoned");
    throw assistantError("automation_recovery_required", "The automation filesystem state is ambiguous and was left untouched.", 409);
  }

  async function recoverOperations() {
    store.db.prepare("UPDATE plans SET state='failed',updated_at=? WHERE state='executing'").run(isoNow());
    const rows = store.db.prepare("SELECT * FROM automation_operations WHERE phase NOT IN ('published','abandoned','recovery-required') ORDER BY created_at,id").all();
    for (const row of rows) {
      try { await recoverOperation(row); }
      catch (error) { failOperationJournal(row.id, error); }
    }
    const pendingPlans = store.db.prepare("SELECT DISTINCT plan_id FROM automation_operations WHERE phase='core-committed'").all();
    for (const { plan_id: planId } of pendingPlans) {
      const committed = store.db.prepare("SELECT * FROM automation_operations WHERE plan_id=? AND phase='core-committed' ORDER BY operation_index").all(planId);
      const results = committed.map((entry) => jsonParse(entry.payload_json, {}).result).filter(Boolean);
      if (!results.length) continue;
      const retention = store.getRetention();
      const expiresAt = new Date(Date.now() + retention.undoDays * 86_400_000).toISOString();
      const activity = await core.activity.append({ eventKey: `automation:recovery:${planId}`, activityGeneration: core.activity.currentGeneration(), kind: "automation", action: "automation.recovered", status: "completed", summary: `Recovered ${results.length} completed automation action(s) after restart`, counts: { requested: results.length, completed: results.length, failed: 0, skipped: 0 }, related: { planId, itemIds: [...new Set(results.map((result) => result.itemId))] }, undo: { eligible: true, expiresAt } });
      store.db.prepare("INSERT OR REPLACE INTO undo_entries(activity_id,action,payload_json,expires_at,used_at) VALUES(?,?,?,?,NULL)").run(activity.id, "automation", JSON.stringify(results), expiresAt);
      store.db.prepare("UPDATE automation_operations SET phase='published',updated_at=? WHERE plan_id=? AND phase='core-committed'").run(isoNow(), planId);
    }
    const unresolved = Number(store.db.prepare("SELECT COUNT(*) AS count FROM automation_operations WHERE phase='recovery-required'").get().count);
    core.setCapability("automation", unresolved ? "recovery-required" : "ready");
  }

  function recipeMatchesEvent(recipe, event) {
    const trigger = recipe.trigger;
    if (!recipe.enabled || trigger.type === "manual" || trigger.type !== event.type) return false;
    if (trigger.type === "tool-completed") return trigger.tools.includes(event.payload?.toolId);
    if (trigger.type === "watch-folder") return trigger.workspaceRootId === event.payload?.rootId;
    return true;
  }

  async function handleAutomationEvent(event) {
    if ((event.lineage || []).length >= 8) {
      await core.activity.append({ eventKey: `automation:event:${event.id}:depth`, kind: "automation", action: "automation.event-skipped", status: "failed", summary: "Automation event skipped because its lineage depth limit was reached" });
      return;
    }
    const itemIds = [...new Set(event.payload?.itemIds || [])].slice(0, 100);
    if (!itemIds.length) return;
    const recipes = store.db.prepare("SELECT * FROM recipes WHERE enabled=1 ORDER BY created_at,id").all().map(serializeRecipe).filter((recipe) => recipeMatchesEvent(recipe, event));
    for (const recipe of recipes) {
      try {
        const plan = await preview({ recipeId: recipe.id, itemIds });
        if (!plan.operations.length) {
          await core.activity.append({ eventKey: `automation:event:${event.id}:${recipe.id}:empty`, kind: "automation", action: "automation.event-skipped", status: "completed", summary: `${recipe.name}: no matching items`, related: { recipeId: recipe.id, planId: plan.id, itemIds } });
          continue;
        }
        if (recipe.mode === "automatic-safe") {
          const job = execute({ planId: plan.id });
          await core.activity.append({ eventKey: `automation:event:${event.id}:${recipe.id}:started`, kind: "automation", action: "automation.event-started", status: "completed", summary: `${recipe.name}: safe automatic run started`, related: { recipeId: recipe.id, planId: plan.id, jobId: job.id, itemIds } });
        } else {
          await core.activity.append({ eventKey: `automation:event:${event.id}:${recipe.id}:suggested`, kind: "automation", action: "automation.suggested", status: "completed", summary: `${recipe.name}: review ${plan.operations.length} suggested action(s)`, related: { recipeId: recipe.id, planId: plan.id, itemIds } });
        }
      } catch (error) {
        await core.activity.append({ eventKey: `automation:event:${event.id}:${recipe.id}:failed`, kind: "automation", action: "automation.event-failed", status: "failed", summary: `${recipe.name}: ${boundedText(error.message, 300)}`, related: { recipeId: recipe.id, itemIds } });
      }
    }
  }

  async function processEvents() {
    if (processingEvents || stopped) return processingEventsPromise || Promise.resolve();
    processingEvents = true;
    const run = (async () => {
      try {
        await recoveryPromise;
        while (!stopped) {
          const events = core.events.read({ subscriberId: eventSubscriberId, limit: 25 });
          if (!events.length) break;
          for (const event of events) {
            try { await handleAutomationEvent(event); }
            finally { core.events.acknowledge({ subscriberId: eventSubscriberId, sequence: event.sequence }); }
          }
        }
      } finally {
        processingEvents = false;
      }
    })();
    processingEventsPromise = run;
    try { await run; }
    finally { if (processingEventsPromise === run) processingEventsPromise = null; }
  }

  const recoveryPromise = recoverOperations();
  const eventTimer = setInterval(() => processEvents().catch(() => {}), 750);
  eventTimer.unref?.();
  queueMicrotask(() => processEvents().catch(() => {}));
  core.registerCloseHook(async () => {
    stopped = true;
    clearInterval(eventTimer);
    await recoveryPromise.catch(() => {});
    await processingEventsPromise?.catch(() => {});
  });

  function route(handler) {
    return async (request, response) => {
      try { await recoveryPromise; response.json(await handler(request, response)); }
      catch (error) { sendAssistantError(response, error); }
    };
  }

  router.get("/recipes", route(() => ({ recipes: store.db.prepare("SELECT * FROM recipes ORDER BY updated_at DESC,id").all().map(serializeRecipe) })));
  router.post("/recipes", route((request) => createRecipe(request.body?.draft)));
  router.put("/recipes/:recipeId", route((request) => updateRecipe(request.params.recipeId, request.body?.expectedRevision, request.body?.draft)));
  router.post("/recipes/:recipeId/enable", route((request) => enableRecipe(request.params.recipeId, request.body?.revision, request.body?.confirmation)));
  router.post("/recipes/:recipeId/disable", route((request) => disableRecipe(request.params.recipeId)));
  router.delete("/recipes/:recipeId", route((request) => removeRecipe(request.params.recipeId)));
  router.post("/automations/preview", route((request) => preview(request.body || {})));
  router.post("/automations/plans/:planId/approve", route((request) => approve(request.params.planId, request.body?.planHash, request.body?.confirmation)));
  router.post("/automations/execute", route((request) => execute(request.body || {})));
  router.get("/automations/plans/:planId", route((request) => {
    const row = store.db.prepare("SELECT * FROM plans WHERE id=?").get(request.params.planId);
    if (!row) throw assistantError("stale_plan", "The plan was not found.", 404);
    return serializePlan(row);
  }));
  router.post("/automations/propose", route((request) => propose(request.body || {})));
  router.post("/activity/:activityId/undo", route((request) => undo(request.params.activityId, request.body?.confirmation)));

  return { createRecipe, updateRecipe, enableRecipe, disableRecipe, preview, approve, execute, undo, propose };
}
