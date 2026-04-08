const fs = require("fs");
const path = require("path");
const {
  isPostgresStorageEnabled,
  resolvePostgresDescriptor,
  readJsonState,
  writeJsonState,
} = require("./db.service");

const EMPTY_STORE = Object.freeze({
  study: [],
  talk: [],
  state: {},
});
const ROADMAP_STATE_KEY = "roadmap_store";

function nowIso() {
  return new Date().toISOString();
}

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

function toAsciiLower(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeRoadmapSeriesType(value) {
  const raw = toAsciiLower(value);
  if (!raw) {
    return "";
  }

  if (["study", "learn", "learning", "hoc", "study_series"].includes(raw)) {
    return "study";
  }

  if (["talk", "story", "sharing", "chia-se", "tamsu", "tam-su"].includes(raw)) {
    return "talk";
  }

  if (["summary", "review", "weekly-summary", "tong-ket", "tongket"].includes(raw)) {
    return "summary";
  }

  return "";
}

function inferRoadmapSeriesTypeFromTopic(topic) {
  const normalized = toAsciiLower(topic);
  if (!normalized) {
    return "study";
  }

  if (
    /(tong ket|nhin lai|recap|weekly review|tuan nay hoc duoc|review tuan)/.test(normalized)
  ) {
    return "summary";
  }

  if (
    /(tam su|chia se|hanh trinh|cau chuyen|cam nhan|kinh nghiem|lessons learned|mental)/.test(
      normalized
    )
  ) {
    return "talk";
  }

  return "study";
}

function resolveRoadmapSeriesType(item = {}, fallbackType = "") {
  return (
    normalizeRoadmapSeriesType(item?.series_type || item?.type) ||
    normalizeRoadmapSeriesType(fallbackType) ||
    inferRoadmapSeriesTypeFromTopic(item?.topic || "")
  );
}

function resolveRoadmapJsonPath() {
  const configured = String(process.env.ROADMAP_FILE || "roadmap.json").trim();
  if (!configured) {
    return path.resolve(__dirname, "..", "..", "roadmap.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(__dirname, "..", "..", configured);
}

function resolveRoadmapPath() {
  if (isPostgresStorageEnabled()) {
    return `${resolvePostgresDescriptor()}#${ROADMAP_STATE_KEY}`;
  }
  return resolveRoadmapJsonPath();
}

function ensureRoadmapFile() {
  const roadmapPath = resolveRoadmapJsonPath();
  const dir = path.dirname(roadmapPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapPath, `${JSON.stringify(EMPTY_STORE, null, 2)}\n`, "utf8");
  }
  return roadmapPath;
}

function toRoadmapId(prefix, day, index) {
  const safePrefix = String(prefix || "topic")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 36);
  const seed = Date.now() + index;
  return `${safePrefix || "topic"}_${day}_${seed}`;
}

function normalizeRoadmapItem(item, index, bucketHint = "") {
  const topic = String(item?.topic || "").trim();
  if (!topic) {
    return null;
  }

  const seriesType = resolveRoadmapSeriesType(item, bucketHint);
  const dayRaw = Number(item?.day);
  const day = Number.isFinite(dayRaw) && dayRaw > 0 ? Math.floor(dayRaw) : null;
  const imageHint = String(item?.image_hint || item?.imageHint || "").trim();
  const createdAt = String(item?.created_at || "").trim() || nowIso();
  const updatedAt = String(item?.updated_at || "").trim() || createdAt;
  const itemId =
    String(item?.id || "").trim() ||
    toRoadmapId(item?.source_topic || topic, day || "na", index);

  const normalized = {
    ...item,
    id: itemId,
    topic,
    image_hint: imageHint,
    series_type: seriesType,
    status: String(item?.status || "draft").trim() || "draft",
    created_at: createdAt,
    updated_at: updatedAt,
  };

  if (seriesType === "study") {
    normalized.day = day || index + 1;
  } else {
    delete normalized.day;
  }

  return normalized;
}

function normalizeRoadmapStore(raw) {
  const baseState =
    raw && typeof raw === "object" && !Array.isArray(raw) && raw.state && typeof raw.state === "object"
      ? { ...raw.state }
      : {};

  const studySource = Array.isArray(raw?.study) ? raw.study : [];
  const talkSource = Array.isArray(raw?.talk) ? raw.talk : [];
  const summarySource = Array.isArray(raw?.summary) ? raw.summary : [];

  if (Array.isArray(raw)) {
    const normalizedRows = raw
      .map((item, index) => normalizeRoadmapItem(item, index))
      .filter(Boolean);
    const study = normalizedRows
      .filter((item) => item.series_type === "study")
      .sort((a, b) => Number(a.day || 0) - Number(b.day || 0));
    const talk = normalizedRows.filter((item) => item.series_type !== "study");
    return { study, talk, state: baseState };
  }

  const study = studySource
    .map((item, index) => normalizeRoadmapItem(item, index, "study"))
    .filter(Boolean)
    .map((item, index) => ({ ...item, day: Number(item.day || index + 1) }))
    .sort((a, b) => Number(a.day || 0) - Number(b.day || 0));

  const talkMerged = [...talkSource, ...summarySource];
  const talk = talkMerged
    .map((item, index) => normalizeRoadmapItem(item, index, "talk"))
    .filter(Boolean)
    .map((item) => {
      const nextItem = { ...item };
      if (nextItem.series_type === "study") {
        nextItem.series_type = "talk";
      }
      delete nextItem.day;
      return nextItem;
    });

  return {
    study,
    talk,
    state: baseState,
  };
}

function flattenRoadmapStore(store) {
  const normalized = normalizeRoadmapStore(store);
  return [
    ...normalized.study.map((item) => ({ ...item, series_type: "study" })),
    ...normalized.talk.map((item) => ({
      ...item,
      series_type: resolveRoadmapSeriesType(item, "talk"),
    })),
  ];
}

function hasMeaningfulStoreData(store) {
  return Boolean(
    (Array.isArray(store?.study) && store.study.length > 0) ||
      (Array.isArray(store?.talk) && store.talk.length > 0) ||
      (store?.state && typeof store.state === "object" && Object.keys(store.state).length > 0)
  );
}

function tryReadRoadmapStoreFromJsonFile() {
  try {
    const roadmapPath = resolveRoadmapJsonPath();
    if (!fs.existsSync(roadmapPath)) {
      return null;
    }
    const raw = fs.readFileSync(roadmapPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeRoadmapStore(parsed);
  } catch (error) {
    console.error("[roadmap.service] migrate legacy roadmap.json error:", error.message);
    return null;
  }
}

async function readRoadmapStore() {
  if (isPostgresStorageEnabled()) {
    try {
      const fromDb = normalizeRoadmapStore(
        await readJsonState(ROADMAP_STATE_KEY, EMPTY_STORE)
      );
      if (hasMeaningfulStoreData(fromDb)) {
        return fromDb;
      }

      if (allowLegacyJsonMigration()) {
        // Optional one-time migration from legacy file storage if DB is still empty.
        const fromFile = tryReadRoadmapStoreFromJsonFile();
        if (fromFile && hasMeaningfulStoreData(fromFile)) {
          await writeJsonState(ROADMAP_STATE_KEY, fromFile);
          console.log("[roadmap.service] Đã migrate roadmap từ file JSON sang Postgres.");
          return fromFile;
        }
      }

      return fromDb;
    } catch (error) {
      console.error("[roadmap.service] readRoadmapStore (postgres) error:", error.message);
      return normalizeRoadmapStore(EMPTY_STORE);
    }
  }

  try {
    const roadmapPath = ensureRoadmapFile();
    const raw = fs.readFileSync(roadmapPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeRoadmapStore(parsed);
  } catch (error) {
    console.error("[roadmap.service] readRoadmapStore error:", error.message);
    return normalizeRoadmapStore(EMPTY_STORE);
  }
}

async function writeRoadmapStore(store) {
  if (isPostgresStorageEnabled()) {
    const normalized = normalizeRoadmapStore(store);
    await writeJsonState(ROADMAP_STATE_KEY, normalized);
    return normalized;
  }

  const roadmapPath = ensureRoadmapFile();
  const normalized = normalizeRoadmapStore(store);
  fs.writeFileSync(roadmapPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function buildStoreFromFlatList(items, previousState = {}) {
  const rows = Array.isArray(items) ? items : [];
  const normalizedRows = rows
    .map((item, index) => normalizeRoadmapItem(item, index))
    .filter(Boolean);

  const study = normalizedRows
    .filter((item) => item.series_type === "study")
    .sort((a, b) => Number(a.day || 0) - Number(b.day || 0));

  const talk = normalizedRows
    .filter((item) => item.series_type !== "study")
    .map((item) => {
      const nextItem = { ...item };
      delete nextItem.day;
      return nextItem;
    });

  return {
    study,
    talk,
    state: {
      ...previousState,
    },
  };
}

async function loadRoadmap() {
  const store = await readRoadmapStore();
  return flattenRoadmapStore(store);
}

async function saveRoadmap(items) {
  if (Array.isArray(items)) {
    const existingStore = await readRoadmapStore();
    const nextStore = buildStoreFromFlatList(items, existingStore.state);
    await writeRoadmapStore(nextStore);
    return flattenRoadmapStore(nextStore);
  }

  const savedStore = await writeRoadmapStore(items);
  return flattenRoadmapStore(savedStore);
}

function normalizeRoadmapPlan(plan, sourceTopic) {
  const rows = Array.isArray(plan) ? plan : [];
  return rows
    .map((item, index) => {
      const dayRaw = Number(item?.day);
      const day = Number.isFinite(dayRaw) && dayRaw > 0 ? Math.floor(dayRaw) : index + 1;
      const topic = String(item?.topic || "").trim();
      const imageHint = String(item?.image_hint || item?.imageHint || "").trim();
      const seriesType =
        normalizeRoadmapSeriesType(item?.series_type || item?.type) ||
        inferRoadmapSeriesTypeFromTopic(topic);
      if (!topic) {
        return null;
      }
      return {
        id: toRoadmapId(sourceTopic, day, index),
        ...(seriesType === "study" ? { day } : {}),
        topic,
        image_hint: imageHint,
        series_type: seriesType,
        // Mac dinh la "draft" de admin duyet truoc khi scheduler lay len.
        status: "draft",
        source_topic: String(sourceTopic || "").trim(),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.day - b.day);
}

function getRoadmapStats(items) {
  const rows = Array.isArray(items) ? items : [];
  const stats = {
    total: rows.length,
    draft: 0,
    pending: 0,
    processing: 0,
    drafted: 0,
    posted: 0,
    failed: 0,
  };

  for (const item of rows) {
    const status = String(item?.status || "pending");
    if (Object.prototype.hasOwnProperty.call(stats, status)) {
      stats[status] += 1;
    }
  }
  return stats;
}

function findNextRoadmapItem(items, statuses = ["pending"]) {
  const rows = Array.isArray(items) ? items : [];
  const allowed = new Set(statuses);
  return (
    rows
      .filter((item) => allowed.has(String(item?.status || "pending")))
      .sort((a, b) => {
        const typeA = resolveRoadmapSeriesType(a) === "study" ? 0 : 1;
        const typeB = resolveRoadmapSeriesType(b) === "study" ? 0 : 1;
        if (typeA !== typeB) {
          return typeA - typeB;
        }

        const dayA = Number(a?.day || Number.MAX_SAFE_INTEGER);
        const dayB = Number(b?.day || Number.MAX_SAFE_INTEGER);
        if (dayA !== dayB) {
          return dayA - dayB;
        }

        const createdA = Date.parse(String(a?.created_at || a?.updated_at || "")) || 0;
        const createdB = Date.parse(String(b?.created_at || b?.updated_at || "")) || 0;
        return createdA - createdB;
      })[0] || null
  );
}

function parseTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    return { by: "day", value: Number(raw) };
  }
  return { by: "id", value: raw };
}

function findRoadmapItemByTarget(items, target) {
  const rows = Array.isArray(items) ? items : [];
  const parsed = parseTarget(target);
  if (!parsed) {
    return null;
  }

  if (parsed.by === "day") {
    return rows.find((item) => Number(item?.day) === parsed.value && resolveRoadmapSeriesType(item) === "study") || null;
  }
  return rows.find((item) => String(item?.id || "") === parsed.value) || null;
}

function updateRoadmapItem(items, itemId, patch = {}) {
  const rows = Array.isArray(items) ? items : [];
  const id = String(itemId || "").trim();
  if (!id) {
    return rows;
  }
  return rows.map((item) => {
    if (String(item?.id || "") !== id) {
      return item;
    }
    return {
      ...item,
      ...patch,
      updated_at: nowIso(),
    };
  });
}

function updateRoadmapItemByTarget(items, target, patch = {}) {
  const rows = Array.isArray(items) ? items : [];
  const found = findRoadmapItemByTarget(rows, target);
  if (!found) {
    return rows;
  }
  return updateRoadmapItem(rows, found.id, patch);
}

function removeRoadmapItemByTarget(items, target) {
  const rows = Array.isArray(items) ? items : [];
  const found = findRoadmapItemByTarget(rows, target);
  if (!found) {
    return rows;
  }
  return rows.filter((item) => String(item?.id || "") !== String(found.id));
}

module.exports = {
  loadRoadmap,
  saveRoadmap,
  normalizeRoadmapPlan,
  getRoadmapStats,
  findNextRoadmapItem,
  findRoadmapItemByTarget,
  updateRoadmapItem,
  updateRoadmapItemByTarget,
  removeRoadmapItemByTarget,
  resolveRoadmapPath,
};
