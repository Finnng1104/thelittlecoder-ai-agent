const fs = require("fs");
const path = require("path");

function resolveDraftFilePath() {
  const configured = String(process.env.DRAFT_FILE || "drafts.json").trim();
  if (!configured) {
    return path.resolve(__dirname, "..", "..", "drafts.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(__dirname, "..", "..", configured);
}

function ensureDraftFile() {
  const filePath = resolveDraftFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "{}\n", "utf8");
  }
  return filePath;
}

function loadDraftMap() {
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

function upsertDraftRecord(draft) {
  const normalized = toPersistedDraft(draft);
  if (!normalized.draftId) {
    throw new Error("draftId is required");
  }

  const mapData = loadDraftMap();
  mapData[normalized.draftId] = normalized;
  saveDraftMap(mapData);
  return normalized;
}

function getDraftRecordById(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    return null;
  }
  const mapData = loadDraftMap();
  if (!mapData[id]) {
    return null;
  }
  return fromPersistedDraft(mapData[id]);
}

function deleteDraftRecordById(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    return false;
  }

  const mapData = loadDraftMap();
  if (!mapData[id]) {
    return false;
  }
  delete mapData[id];
  saveDraftMap(mapData);
  return true;
}

module.exports = {
  resolveDraftFilePath,
  upsertDraftRecord,
  getDraftRecordById,
  deleteDraftRecordById,
};

