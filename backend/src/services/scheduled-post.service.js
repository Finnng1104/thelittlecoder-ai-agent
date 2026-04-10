const fs = require("fs");
const path = require("path");
const {
  isPostgresStorageEnabled,
  resolvePostgresDescriptor,
  readJsonState,
  writeJsonState,
} = require("./db.service");

const SCHEDULED_POST_STATE_KEY = "scheduled_posts_store";

function nowIso() {
  return new Date().toISOString();
}

function resolveScheduledPostJsonPath() {
  const configured = String(
    process.env.SCHEDULED_POST_FILE || "scheduled-posts.json",
  ).trim();
  if (!configured) {
    return path.resolve(__dirname, "..", "..", "scheduled-posts.json");
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(__dirname, "..", "..", configured);
}

function resolveScheduledPostPath() {
  if (isPostgresStorageEnabled()) {
    return `${resolvePostgresDescriptor()}#${SCHEDULED_POST_STATE_KEY}`;
  }
  return resolveScheduledPostJsonPath();
}

function ensureScheduledPostFile() {
  const filePath = resolveScheduledPostJsonPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]\n", "utf8");
  }
  return filePath;
}

function serializeImageAsset(asset) {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  if (Buffer.isBuffer(asset.buffer)) {
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

  if (typeof asset.buffer_base64 === "string") {
    return {
      ...asset,
      buffer: Buffer.from(asset.buffer_base64, "base64"),
    };
  }

  return { ...asset };
}

function createScheduledPostId(prefix = "sched") {
  const safePrefix =
    String(prefix || "sched")
      .replace(/[^\w-]/g, "")
      .slice(0, 12) || "sched";
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${ts}_${rnd}`;
}

function normalizeStatus(value) {
  const raw = String(value || "pending").trim().toLowerCase();
  if (["pending", "posted", "failed", "cancelled"].includes(raw)) {
    return raw;
  }
  return "pending";
}

function normalizeScheduledPost(item, index = 0) {
  const raw = item && typeof item === "object" ? item : {};
  const content = String(raw.content || raw.postText || "").trim();
  const chatId = String(raw.chatId || raw.chat_id || "").trim();
  const scheduledAt = String(
    raw.scheduledAt || raw.scheduled_at || "",
  ).trim();

  if (!content || !chatId || !scheduledAt) {
    return null;
  }

  const createdAt = String(raw.createdAt || raw.created_at || "").trim() || nowIso();
  const updatedAt = String(raw.updatedAt || raw.updated_at || "").trim() || createdAt;

  return {
    id:
      String(raw.id || "").trim() ||
      createScheduledPostId(`sched${index}`),
    chatId,
    content,
    imageAsset: serializeImageAsset(raw.imageAsset),
    scheduledAt,
    scheduledLabel: String(
      raw.scheduledLabel || raw.scheduled_label || "",
    ).trim(),
    status: normalizeStatus(raw.status),
    source: String(raw.source || "telegram").trim() || "telegram",
    createdAt,
    updatedAt,
    postedAt: String(raw.postedAt || raw.posted_at || "").trim(),
    cancelledAt: String(raw.cancelledAt || raw.cancelled_at || "").trim(),
    failedAt: String(raw.failedAt || raw.failed_at || "").trim(),
    facebookPostId: String(
      raw.facebookPostId || raw.facebook_post_id || "",
    ).trim(),
    errorMessage: String(
      raw.errorMessage || raw.error_message || "",
    ).trim(),
  };
}

function normalizeScheduledPostList(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows
    .map((item, index) => normalizeScheduledPost(item, index))
    .filter(Boolean);
}

async function loadScheduledPosts() {
  if (isPostgresStorageEnabled()) {
    try {
      return normalizeScheduledPostList(
        await readJsonState(SCHEDULED_POST_STATE_KEY, []),
      ).map((item) => ({
        ...item,
        imageAsset: deserializeImageAsset(item.imageAsset),
      }));
    } catch (error) {
      console.error(
        "[scheduled-post.service] loadScheduledPosts (postgres) error:",
        error.message,
      );
      return [];
    }
  }

  try {
    const filePath = ensureScheduledPostFile();
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return normalizeScheduledPostList(parsed).map((item) => ({
      ...item,
      imageAsset: deserializeImageAsset(item.imageAsset),
    }));
  } catch (error) {
    console.error(
      "[scheduled-post.service] loadScheduledPosts error:",
      error.message,
    );
    return [];
  }
}

async function saveScheduledPosts(items) {
  const normalized = normalizeScheduledPostList(items);
  const persisted = normalized.map((item) => ({
    ...item,
    imageAsset: serializeImageAsset(item.imageAsset),
  }));

  if (isPostgresStorageEnabled()) {
    await writeJsonState(SCHEDULED_POST_STATE_KEY, persisted);
    return normalized.map((item) => ({
      ...item,
      imageAsset: deserializeImageAsset(item.imageAsset),
    }));
  }

  const filePath = ensureScheduledPostFile();
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return normalized.map((item) => ({
    ...item,
    imageAsset: deserializeImageAsset(item.imageAsset),
  }));
}

async function createScheduledPost(payload) {
  const current = await loadScheduledPosts();
  const normalized = normalizeScheduledPost(
    {
      ...payload,
      id: String(payload?.id || "").trim() || createScheduledPostId(),
      createdAt: payload?.createdAt || nowIso(),
      updatedAt: nowIso(),
      status: payload?.status || "pending",
    },
    current.length,
  );

  if (!normalized) {
    throw new Error("Invalid scheduled post payload");
  }

  current.push(normalized);
  await saveScheduledPosts(current);
  return normalized;
}

async function getScheduledPostById(scheduleId) {
  const id = String(scheduleId || "").trim();
  if (!id) {
    return null;
  }

  const items = await loadScheduledPosts();
  return items.find((item) => item.id === id) || null;
}

async function updateScheduledPostById(scheduleId, patch = {}) {
  const id = String(scheduleId || "").trim();
  if (!id) {
    return null;
  }

  const items = await loadScheduledPosts();
  let nextRecord = null;
  const nextItems = items.map((item, index) => {
    if (item.id !== id) {
      return item;
    }

    nextRecord = normalizeScheduledPost(
      {
        ...item,
        ...patch,
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: patch.updatedAt || nowIso(),
      },
      index,
    );
    return nextRecord || item;
  });

  if (!nextRecord) {
    return null;
  }

  await saveScheduledPosts(nextItems);
  return nextRecord;
}

async function countScheduledPosts(status = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const items = await loadScheduledPosts();
  if (!normalizedStatus || normalizedStatus === "all") {
    return items.length;
  }
  return items.filter((item) => item.status === normalizedStatus).length;
}

async function clearAllScheduledPosts() {
  await saveScheduledPosts([]);
  return true;
}

module.exports = {
  clearAllScheduledPosts,
  countScheduledPosts,
  createScheduledPost,
  getScheduledPostById,
  loadScheduledPosts,
  resolveScheduledPostPath,
  saveScheduledPosts,
  updateScheduledPostById,
};
