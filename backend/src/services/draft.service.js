const fs = require("fs");
const path = require("path");
const {
  isPostgresStorageEnabled,
  resolvePostgresDescriptor,
  upsertJsonDraft,
  getJsonDraft,
  deleteJsonDraft,
  countDraftRows,
} = require("./db.service");

let didMigrateLegacyDrafts = false;

function parseBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "y", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(raw)) {
    return false;
  }
  return fallback;
}

function allowLegacyJsonMigration() {
  return parseBoolean(process.env.STORAGE_MIGRATE_JSON, false);
}

function resolveDraftJsonPath() {
  const configured = String(process.env.DRAFT_FILE || "drafts.json").trim();
  if (!configured) {
    return path.resolve(__dirname, "..", "..", "drafts.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(__dirname, "..", "..", configured);
}

function resolveDraftFilePath() {
  if (isPostgresStorageEnabled()) {
    return `${resolvePostgresDescriptor()}#draft_records`;
  }
  return resolveDraftJsonPath();
}

function ensureDraftFile() {
  const filePath = resolveDraftJsonPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "{}\n", "utf8");
  }
  return filePath;
}

function tryReadLegacyDraftMap() {
  try {
    const filePath = resolveDraftJsonPath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.error("[draft.service] tryReadLegacyDraftMap error:", error.message);
    return {};
  }
}

async function migrateLegacyDraftsToDbIfNeeded() {
  if (!isPostgresStorageEnabled() || didMigrateLegacyDrafts) {
    return;
  }

  if (!allowLegacyJsonMigration()) {
    didMigrateLegacyDrafts = true;
    return;
  }

  didMigrateLegacyDrafts = true;
  try {
    if ((await countDraftRows()) > 0) {
      return;
    }

    const legacyMap = tryReadLegacyDraftMap();
    const entries = Object.entries(legacyMap);
    if (!entries.length) {
      return;
    }

    for (const [draftId, payload] of entries) {
      const normalized = toPersistedDraft({
        ...(payload && typeof payload === "object" ? payload : {}),
        draftId,
      });
      if (!normalized.draftId) {
        continue;
      }
      await upsertJsonDraft(normalized.draftId, normalized.chatId, normalized);
    }

    console.log("[draft.service] Đã migrate drafts từ file JSON sang Postgres.");
  } catch (error) {
    console.error("[draft.service] migrate legacy drafts error:", error.message);
  }
}

async function loadDraftMap() {
  if (isPostgresStorageEnabled()) {
    await migrateLegacyDraftsToDbIfNeeded();
    return {};
  }

  try {
    const filePath = ensureDraftFile();
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.error("[draft.service] loadDraftMap error:", error.message);
    return {};
  }
}

function saveDraftMap(mapData) {
  if (isPostgresStorageEnabled()) {
    return mapData && typeof mapData === "object" && !Array.isArray(mapData) ? mapData : {};
  }

  const filePath = ensureDraftFile();
  const safe = mapData && typeof mapData === "object" && !Array.isArray(mapData) ? mapData : {};
  fs.writeFileSync(filePath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return safe;
}

function serializeImageAsset(asset) {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  if (asset.type === "buffer" && Buffer.isBuffer(asset.buffer)) {
    return {
      ...asset,
      buffer_base64: asset.buffer.toString("base64"),
      buffer: undefined,
    };
  }

  return { ...asset };
}

function deserializeImageAsset(asset) {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  if (asset.type === "buffer" && typeof asset.buffer_base64 === "string") {
    return {
      ...asset,
      buffer: Buffer.from(asset.buffer_base64, "base64"),
    };
  }

  return { ...asset };
}

function toPersistedDraft(draft) {
  const raw = draft && typeof draft === "object" ? draft : {};
  return {
    ...raw,
    draftId: String(raw.draftId || "").trim(),
    chatId: String(raw.chatId || "").trim(),
    imageAsset: serializeImageAsset(raw.imageAsset),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

function fromPersistedDraft(draft) {
  if (!draft || typeof draft !== "object") {
    return null;
  }
  return {
    ...draft,
    imageAsset: deserializeImageAsset(draft.imageAsset),
  };
}

async function upsertDraftRecord(draft) {
  const normalized = toPersistedDraft(draft);
  if (!normalized.draftId) {
    throw new Error("draftId is required");
  }

  if (isPostgresStorageEnabled()) {
    await migrateLegacyDraftsToDbIfNeeded();
    await upsertJsonDraft(normalized.draftId, normalized.chatId, normalized);
    return normalized;
  }

  const mapData = await loadDraftMap();
  mapData[normalized.draftId] = normalized;
  saveDraftMap(mapData);
  return normalized;
}

async function getDraftRecordById(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    return null;
  }

  if (isPostgresStorageEnabled()) {
    await migrateLegacyDraftsToDbIfNeeded();
    const stored = await getJsonDraft(id);
    return fromPersistedDraft(stored);
  }

  const mapData = await loadDraftMap();
  if (!mapData[id]) {
    return null;
  }
  return fromPersistedDraft(mapData[id]);
}

async function deleteDraftRecordById(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    return false;
  }

  if (isPostgresStorageEnabled()) {
    await migrateLegacyDraftsToDbIfNeeded();
    return await deleteJsonDraft(id);
  }

  const mapData = await loadDraftMap();
  if (!mapData[id]) {
    return false;
  }
  delete mapData[id];
  saveDraftMap(mapData);
  return true;
}

async function countPersistedDraftRecords() {
  if (isPostgresStorageEnabled()) {
    await migrateLegacyDraftsToDbIfNeeded();
    return await countDraftRows();
  }

  const mapData = await loadDraftMap();
  return Object.keys(mapData || {}).length;
}

async function clearAllDraftRecords() {
  if (isPostgresStorageEnabled()) {
    // Full storage clearing should use clearAllPostgresData in db.service.
    return false;
  }

  saveDraftMap({});
  return true;
}

module.exports = {
  resolveDraftFilePath,
  upsertDraftRecord,
  getDraftRecordById,
  deleteDraftRecordById,
  countPersistedDraftRecords,
  clearAllDraftRecords,
};
