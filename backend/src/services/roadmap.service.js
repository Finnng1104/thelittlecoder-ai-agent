const fs = require("fs");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function resolveRoadmapPath() {
  const configured = String(process.env.ROADMAP_FILE || "roadmap.json").trim();
  if (!configured) {
    return path.resolve(__dirname, "..", "..", "roadmap.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(__dirname, "..", "..", configured);
}

function ensureRoadmapFile() {
  const roadmapPath = resolveRoadmapPath();
  const dir = path.dirname(roadmapPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(roadmapPath)) {
    fs.writeFileSync(roadmapPath, "[]\n", "utf8");
  }
  return roadmapPath;
}

function loadRoadmap() {
  try {
    const roadmapPath = ensureRoadmapFile();
    const raw = fs.readFileSync(roadmapPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[roadmap.service] loadRoadmap error:", error.message);
    return [];
  }
}

function saveRoadmap(items) {
  const roadmapPath = ensureRoadmapFile();
  const safeItems = Array.isArray(items) ? items : [];
  fs.writeFileSync(roadmapPath, `${JSON.stringify(safeItems, null, 2)}\n`, "utf8");
  return safeItems;
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

function normalizeRoadmapPlan(plan, sourceTopic) {
  const rows = Array.isArray(plan) ? plan : [];
  return rows
    .map((item, index) => {
      const dayRaw = Number(item?.day);
      const day = Number.isFinite(dayRaw) && dayRaw > 0 ? Math.floor(dayRaw) : index + 1;
      const topic = String(item?.topic || "").trim();
      const imageHint = String(item?.image_hint || item?.imageHint || "").trim();
      if (!topic) {
        return null;
      }
      return {
        id: toRoadmapId(sourceTopic, day, index),
        day,
        topic,
        image_hint: imageHint,
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
      .sort((a, b) => Number(a.day || 0) - Number(b.day || 0))[0] || null
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
    return rows.find((item) => Number(item?.day) === parsed.value) || null;
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
