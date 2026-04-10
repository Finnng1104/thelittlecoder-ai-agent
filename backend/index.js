const fs = require("fs");
const path = require("path");
require("dotenv").config();
const cron = require("node-cron");
const { Telegraf, Markup } = require("telegraf");
const {
  askAI,
  REFINE_CONTENT_PROMPT,
  ROADMAP_GENERATOR_PROMPT,
  SERIES_POST_PROMPT,
} = require("./src/services/ai.service");
const {
  generateImageAsset,
  downloadImageBuffer,
} = require("./src/services/image.service");
const {
  postToFacebook,
  deleteFacebookPost,
} = require("./src/services/facebook.service");
const { formatForFacebook } = require("./src/utils/textFormatter");
const {
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
} = require("./src/services/roadmap.service");
const {
  resolveDraftFilePath,
  upsertDraftRecord,
  getDraftRecordById,
  deleteDraftRecordById,
  countPersistedDraftRecords,
  clearAllDraftRecords,
} = require("./src/services/draft.service");
const {
  assertStorageConfiguration,
  clearAllPostgresData,
  isPostgresStorageEnabled,
  resolveStorageDriver,
  resolvePostgresDescriptor,
  countAppStateRows,
} = require("./src/services/db.service");
const { buildDraftFromTopic } = require("./src/services/draft-builder.service");
const { createCommandService } = require("./src/services/command.service");
const {
  buildDeletePostKeyboard,
  extractPublishContent,
  hasPublishableImage,
} = require("./src/services/publish.service");

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

const APP_ENV = String(
  process.env.APP_ENV || process.env.NODE_ENV || "development",
)
  .trim()
  .toLowerCase();
const IS_PRODUCTION_ENV = APP_ENV === "production";

function resolveTelegramToken() {
  if (IS_PRODUCTION_ENV) {
    return firstNonEmpty(
      process.env.TELEGRAM_BOT_PROD_TOKEN,
      process.env.TELEGRAM_TOKEN_PROD,
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_TOKEN,
    );
  }

  return firstNonEmpty(
    process.env.TELEGRAM_BOT_TEST_TOKEN,
    process.env.TELEGRAM_TOKEN_DEV,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_TOKEN,
  );
}

function resolveOwnerChatId() {
  if (IS_PRODUCTION_ENV) {
    return firstNonEmpty(
      process.env.MY_CHAT_ID_PROD,
      process.env.MY_CHAT_ID,
      process.env.YOUR_TELEGRAM_CHAT_ID,
    );
  }

  return firstNonEmpty(
    process.env.MY_CHAT_ID_TEST,
    process.env.MY_CHAT_ID_DEV,
    process.env.MY_CHAT_ID,
    process.env.YOUR_TELEGRAM_CHAT_ID,
  );
}

const telegramToken = resolveTelegramToken();
const draftStore = new Map();
const publishedPostStore = new Map();
const roadmapProposalStore = new Map();
const draftEditRequestStore = new Map();
const handledCommandMessages = new Set();
const processedTextMessageKeys = new Set();
const TELEGRAM_CAPTION_MAX = 1024;
const TELEGRAM_MESSAGE_SAFE_LIMIT = 3800;
let isRoadmapJobRunning = false;
let botLockFd = null;
let botLockPath = "";
const ENABLE_IMAGE_GENERATION = parseBoolean(
  process.env.ENABLE_IMAGE_GENERATION,
  false,
);

assertStorageConfiguration();

if (!telegramToken) {
  throw new Error(
    "Missing Telegram bot token. Configure TELEGRAM_BOT_TEST_TOKEN (dev) or TELEGRAM_BOT_PROD_TOKEN (prod).",
  );
}

function processExists(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function releaseBotLock() {
  try {
    if (botLockFd !== null) {
      fs.closeSync(botLockFd);
      botLockFd = null;
    }
  } catch (_error) {
    // no-op
  }

  try {
    if (botLockPath && fs.existsSync(botLockPath)) {
      fs.unlinkSync(botLockPath);
    }
  } catch (_error) {
    // no-op
  }
}

function acquireBotLock() {
  const defaultLockFile = IS_PRODUCTION_ENV
    ? ".bot.prod.lock"
    : ".bot.dev.lock";
  const configuredPath = String(
    process.env.BOT_LOCK_FILE || defaultLockFile,
  ).trim();
  const lockPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, configuredPath);
  botLockPath = lockPath;

  const createLock = () => {
    botLockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(
      botLockFd,
      JSON.stringify(
        {
          pid: process.pid,
          started_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  };

  try {
    createLock();
    return;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const existingPid = Number(parsed?.pid || 0);
    if (processExists(existingPid)) {
      throw new Error(
        `Another bot process is running (pid=${existingPid}). Stop old process or remove lock: ${lockPath}`,
      );
    }
    fs.unlinkSync(lockPath);
    createLock();
  } catch (error) {
    throw new Error(
      `Failed to acquire bot lock at ${lockPath}: ${error.message}`,
    );
  }
}

acquireBotLock();

const bot = new Telegraf(telegramToken, { handlerTimeout: 600000 });

console.log(
  `[boot] APP_ENV=${APP_ENV} (telegram mode: ${IS_PRODUCTION_ENV ? "production" : "development"})`,
);

function ownerChatId() {
  return resolveOwnerChatId();
}

function markCommandHandled(ctx) {
  const messageId = Number(ctx?.message?.message_id);
  if (!Number.isFinite(messageId)) {
    return;
  }
  handledCommandMessages.add(messageId);
  setTimeout(() => handledCommandMessages.delete(messageId), 15000);
}

function isCommandHandled(ctx) {
  const messageId = Number(ctx?.message?.message_id);
  if (!Number.isFinite(messageId)) {
    return false;
  }
  return handledCommandMessages.has(messageId);
}

function isDuplicateTextMessage(ctx) {
  const chatId = String(ctx?.chat?.id || "");
  const messageId = Number(ctx?.message?.message_id);
  if (!chatId || !Number.isFinite(messageId)) {
    return false;
  }

  const key = `${chatId}:${messageId}`;
  if (processedTextMessageKeys.has(key)) {
    return true;
  }

  processedTextMessageKeys.add(key);
  setTimeout(() => processedTextMessageKeys.delete(key), 15 * 60 * 1000);
  return false;
}

function buildDraftKeyboard() {
  return buildDraftKeyboardWithId("");
}

function buildDraftKeyboardWithId(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    const rows = [[Markup.button.callback("Duyệt & Đăng bài", "confirm_post")]];
    rows.push([Markup.button.callback("Chỉnh sửa nội dung", "edit_content")]);
    if (ENABLE_IMAGE_GENERATION) {
      rows.push([Markup.button.callback("Đổi ảnh khác", "regen_image")]);
    }
    rows.push([Markup.button.callback("Bỏ qua bản thảo", "cancel_post")]);
    return Markup.inlineKeyboard(rows);
  }

  const rows = [
    [Markup.button.callback("Duyệt & Đăng bài", `confirm_post:${id}`)],
  ];
  rows.push([
    Markup.button.callback("Chỉnh sửa nội dung", `edit_content:${id}`),
  ]);
  if (ENABLE_IMAGE_GENERATION) {
    rows.push([Markup.button.callback("Đổi ảnh khác", `regen_image:${id}`)]);
  }
  rows.push([Markup.button.callback("Bỏ qua bản thảo", `cancel_post:${id}`)]);
  return Markup.inlineKeyboard(rows);
}

function createDraftId(prefix = "draft") {
  const safePrefix =
    String(prefix || "draft")
      .replace(/[^\w-]/g, "")
      .slice(0, 12) || "draft";
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${ts}_${rnd}`;
}

async function storeDraft(chatId, payload, options = {}) {
  const id = String(
    options.draftId ||
      payload?.draftId ||
      createDraftId(payload?.source || "draft"),
  );
  const record = {
    ...payload,
    draftId: id,
    chatId: String(chatId),
    createdAt: payload?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  clearPendingDraftEditRequest(String(chatId));
  draftStore.set(String(chatId), record);
  await upsertDraftRecord(record);
  return record;
}

async function resolveDraftByAction(chatId, draftId) {
  const normalizedChatId = String(chatId || "");
  const id = String(draftId || "").trim();
  const current = draftStore.get(normalizedChatId);

  if (!id) {
    return current || null;
  }

  if (current?.draftId === id) {
    return current;
  }

  const persisted = await getDraftRecordById(id);
  if (!persisted) {
    return null;
  }

  if (String(persisted.chatId || "") !== normalizedChatId) {
    return null;
  }

  draftStore.set(normalizedChatId, persisted);
  return persisted;
}

async function clearDraft(chatId, draftId = "") {
  const normalizedChatId = String(chatId || "");
  const id = String(draftId || "").trim();
  if (id) {
    await deleteDraftRecordById(id);
  }

  const current = draftStore.get(normalizedChatId);
  if (!current) {
    return;
  }

  if (!id || current.draftId === id) {
    draftStore.delete(normalizedChatId);
    clearPendingDraftEditRequest(normalizedChatId);
  }
}

function setPendingDraftEditRequest(chatId, draftId) {
  const normalizedChatId = String(chatId || "");
  const normalizedDraftId = String(draftId || "").trim();
  if (!normalizedChatId || !normalizedDraftId) {
    return;
  }
  draftEditRequestStore.set(normalizedChatId, {
    draftId: normalizedDraftId,
    createdAt: Date.now(),
  });
}

function getPendingDraftEditRequest(chatId) {
  const normalizedChatId = String(chatId || "");
  if (!normalizedChatId) {
    return null;
  }
  return draftEditRequestStore.get(normalizedChatId) || null;
}

function clearPendingDraftEditRequest(chatId) {
  const normalizedChatId = String(chatId || "");
  if (!normalizedChatId) {
    return;
  }
  draftEditRequestStore.delete(normalizedChatId);
}

function rememberPublishedPost(chatId, postId) {
  const id = String(postId || "").trim();
  if (!id) {
    return;
  }

  const current = publishedPostStore.get(chatId) || { ids: [] };
  const ids = [id, ...(current.ids || []).filter((item) => item !== id)].slice(
    0,
    20,
  );
  publishedPostStore.set(chatId, {
    ids,
    lastPostId: ids[0],
    updatedAt: Date.now(),
  });
}

function forgetPublishedPost(chatId, postId) {
  const id = String(postId || "").trim();
  if (!id) {
    return;
  }

  const current = publishedPostStore.get(chatId);
  if (!current) {
    return;
  }

  const ids = (current.ids || []).filter((item) => item !== id);
  if (ids.length === 0) {
    publishedPostStore.delete(chatId);
    return;
  }

  publishedPostStore.set(chatId, {
    ...current,
    ids,
    lastPostId: ids[0],
    updatedAt: Date.now(),
  });
}

function getLastPublishedPostId(chatId) {
  return String(publishedPostStore.get(chatId)?.lastPostId || "").trim();
}

function extractDeleteCommandArg(text) {
  const normalizedText = String(text || "")
    .replace(/`/g, "")
    .replace(/\u200b/g, "")
    .trim();
  const matched = normalizedText.match(/^\/delete(?:@\w+)?(?:\s+(.+))?$/i);
  if (!matched) {
    return null;
  }

  const rawArg = String(matched[1] || "").trim();
  if (!rawArg) {
    return "";
  }

  return rawArg.split(/\s+/)[0].trim();
}

function extractRewriteInput(text) {
  const normalizedText = String(text || "")
    .replace(/\u200b/g, "")
    .trim();
  if (!normalizedText) {
    return null;
  }

  const commandMatch = normalizedText.match(
    /^\/rewrite(?:@\w+)?(?:\s+([\s\S]+))?$/i,
  );
  if (commandMatch) {
    return String(commandMatch[1] || "").trim();
  }

  const prefixMatch = normalizedText.match(
    /^(?:viet lai|viết lại|content)\s*:\s*([\s\S]+)$/i,
  );
  if (prefixMatch) {
    return String(prefixMatch[1] || "").trim();
  }

  return null;
}

function shouldRegenerateCurrentRoadmapDraft(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!normalized) {
    return false;
  }

  return (
    /huy.*tao\s*lai/.test(normalized) ||
    /huy.*lam\s*lai/.test(normalized) ||
    /tao\s*lai.*ban\s*thao/.test(normalized) ||
    /lam\s*lai.*ban\s*thao/.test(normalized)
  );
}

function buildTopicFromRawContent(rawContent) {
  const cleaned = String(rawContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "chia se ca nhan";
  }

  return cleaned.slice(0, 120);
}

function toCaption(postText) {
  const fullCaption = `BẢN THẢO CHẤT LƯỢNG CAO:\n\n${postText}`;
  if (fullCaption.length <= TELEGRAM_CAPTION_MAX) {
    return { caption: fullCaption, truncated: false };
  }

  const suffix = "\n\n... (caption đã rút gọn)";
  const trimmed =
    fullCaption.slice(0, TELEGRAM_CAPTION_MAX - suffix.length) + suffix;
  return { caption: trimmed, truncated: true };
}

function splitLongText(text, limit = TELEGRAM_MESSAGE_SAFE_LIMIT) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }

  if (raw.length <= limit) {
    return [raw];
  }

  const chunks = [];
  let remaining = raw;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function buildFallbackShortTitle(topic) {
  const words = String(topic || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);

  if (words.length === 0) {
    return "WEB DEV INSIGHT";
  }

  return words.join(" ");
}

function buildSeriesImageShortTitle(
  day,
  topic,
  aiShortTitle = "",
  roadmapImageHint = "",
) {
  const normalizedDay = Number.isFinite(Number(day))
    ? Math.max(1, Math.floor(Number(day)))
    : 1;
  const hintRaw = String(roadmapImageHint || "").trim();
  const raw = String(aiShortTitle || "")
    .replace(/^DAY\s*\d+\s*[:\-]?\s*/i, "")
    .trim();
  const base = hintRaw || raw || buildFallbackShortTitle(topic);
  const compact = String(base)
    .toUpperCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  return `DAY ${normalizedDay}: ${compact || "SERIES"}`.trim();
}

function ensureSeriesHeading(postText, day, topic) {
  const normalizedDay = Number.isFinite(Number(day))
    ? Math.max(1, Math.floor(Number(day)))
    : 1;
  const heading = `📘 DAY ${normalizedDay}: ${String(topic || "").trim()}`;
  const normalizedText = String(postText || "").trim();
  if (!normalizedText) {
    return heading;
  }

  if (/(^|\n)\s*📘\s*DAY\s+\d+\s*:/i.test(normalizedText)) {
    return normalizedText;
  }

  return `${heading}\n\n${normalizedText}`;
}

function extractFirstJsonObject(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch (_error) {
      // Fall through.
    }
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    // Try object slice below.
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function extractFirstJsonArray(rawText) {
  const pickArrayFromObject = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const preferredKeys = [
      "roadmap",
      "items",
      "data",
      "results",
      "result",
      "list",
      "plans",
      "plan",
    ];

    for (const key of preferredKeys) {
      if (Array.isArray(value[key])) {
        return value[key];
      }
    }

    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) {
        return nested;
      }
    }

    for (const nested of Object.values(value)) {
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        continue;
      }
      for (const deep of Object.values(nested)) {
        if (Array.isArray(deep)) {
          return deep;
        }
      }
    }

    return null;
  };

  const isRoadmapItemLike = (value) =>
    Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ("topic" in value ||
          "day" in value ||
          "image_hint" in value ||
          "type" in value),
    );

  const normalizeParsedToArray = (parsed) => {
    if (Array.isArray(parsed)) {
      return parsed;
    }

    const wrappedArray = pickArrayFromObject(parsed);
    if (Array.isArray(wrappedArray)) {
      return wrappedArray;
    }

    if (isRoadmapItemLike(parsed)) {
      return [parsed];
    }

    return null;
  };

  const extractRoadmapItemsFromObjectStream = (input) => {
    const source = String(input || "").trim();
    if (!source || !source.includes("{")) {
      return null;
    }

    const items = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaping = false;

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (ch === "\\") {
          escaping = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") {
        if (depth === 0) {
          start = i;
        }
        depth += 1;
        continue;
      }

      if (ch === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const candidate = source.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (isRoadmapItemLike(parsed)) {
              items.push(parsed);
            }
          } catch (_error) {
            // Skip invalid fragment
          }
          start = -1;
        }
      }
    }

    return items.length > 0 ? items : null;
  };

  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const fenced = String(fenceMatch?.[1] || "").trim();
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced);
      const normalized = normalizeParsedToArray(parsed);
      if (normalized) {
        return normalized;
      }
    } catch (_error) {
      const streamItems = extractRoadmapItemsFromObjectStream(fenced);
      if (streamItems) {
        return streamItems;
      }
    }
  }

  try {
    const parsed = JSON.parse(text);
    const normalized = normalizeParsedToArray(parsed);
    if (normalized) {
      return normalized;
    }
  } catch (_error) {
    const streamItems = extractRoadmapItemsFromObjectStream(text);
    if (streamItems) {
      return streamItems;
    }
  }

  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first >= 0 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    const candidate = text.slice(firstObject, lastObject + 1);
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeParsedToArray(parsed);
      if (normalized) {
        return normalized;
      }
    } catch (_error) {
      const streamItems = extractRoadmapItemsFromObjectStream(candidate);
      if (streamItems) {
        return streamItems;
      }
    }
  }

  const streamItems = extractRoadmapItemsFromObjectStream(text);
  if (streamItems) {
    return streamItems;
  }

  return null;
}

function parseStructuredAiOutput(rawText, topic) {
  const parsed = extractFirstJsonObject(rawText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI tra ve khong dung dinh dang JSON bat buoc.");
  }

  const structured = {
    post_content: String(parsed.post_content || "").trim(),
    image_short_title: String(parsed.image_short_title || "").trim(),
    ant_action: String(parsed.ant_action || "").trim(),
    log_message: String(parsed.log_message || "").trim(),
  };

  if (!structured.post_content) {
    throw new Error("JSON thieu truong post_content.");
  }

  if (!structured.image_short_title) {
    structured.image_short_title = buildFallbackShortTitle(topic);
  }

  if (!structured.ant_action) {
    structured.ant_action = "standing behind laptop";
  }

  if (!structured.log_message) {
    structured.log_message = `Learning ${buildFallbackShortTitle(topic)}...`;
  }

  return structured;
}

function buildPostDraftOptions(extra = {}) {
  return {
    ...extra,
    enableImageGeneration: ENABLE_IMAGE_GENERATION,
    parseStructuredAiOutput,
    ensureSeriesHeading,
    buildSeriesImageShortTitle,
  };
}

const commandService = createCommandService({
  updateStatus,
  storeDraft,
  sendDraftPreview,
  buildPostDraftOptions,
  rememberPublishedPost,
});

function parseRoadmapOutput(rawText, sourceTopic) {
  const parsedArray = extractFirstJsonArray(rawText);
  if (!parsedArray) {
    throw new Error("AI không trả về JSON Array cho roadmap.");
  }

  const normalized = normalizeRoadmapPlan(parsedArray, sourceTopic);
  if (normalized.length === 0) {
    throw new Error("Roadmap rỗng hoặc không hợp lệ.");
  }

  return normalized;
}

function formatRoadmapSummary(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows
    .map((item, index) => {
      const type = resolveRoadmapSeriesType(item);
      const dayLabel =
        type === "study" && Number.isFinite(Number(item?.day))
          ? `Day ${Number(item.day)}`
          : `Talk ${index + 1}`;
      return `${dayLabel}. [${type}] ${item.topic}`;
    })
    .join("\n");
}

function formatRoadmapItemLabel(item) {
  const type = resolveRoadmapSeriesType(item);
  if (type === "study" && Number.isFinite(Number(item?.day))) {
    return `Day ${Number(item.day)}`;
  }
  return `Talk (${String(item?.id || "").slice(0, 8) || "no-id"})`;
}

function formatRoadmapList(items, options = {}) {
  const rows = Array.isArray(items) ? items : [];
  const statusFilter = String(options.status || "")
    .trim()
    .toLowerCase();
  const filtered = statusFilter
    ? rows.filter(
        (item) => String(item?.status || "").toLowerCase() === statusFilter,
      )
    : rows;

  if (filtered.length === 0) {
    return "Roadmap trống hoặc không có bài khớp bộ lọc.";
  }

  const lines = filtered
    .sort((a, b) => {
      const typeA = resolveRoadmapSeriesType(a);
      const typeB = resolveRoadmapSeriesType(b);
      const groupA = typeA === "study" ? 0 : 1;
      const groupB = typeB === "study" ? 0 : 1;
      if (groupA !== groupB) {
        return groupA - groupB;
      }
      const dayA = Number(a?.day || Number.MAX_SAFE_INTEGER);
      const dayB = Number(b?.day || Number.MAX_SAFE_INTEGER);
      if (dayA !== dayB) {
        return dayA - dayB;
      }
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    })
    .map(
      (item) =>
        `${resolveRoadmapSeriesType(item) === "study" ? `Day ${item.day}` : "Talk"} | ${String(item.status || "unknown").toUpperCase()}\n` +
        `type: ${resolveRoadmapSeriesType(item)}\n` +
        `id: ${item.id}\n` +
        `topic: ${item.topic}\n` +
        `${item.image_hint ? `image_hint: ${item.image_hint}` : ""}`,
    );

  return lines.join("\n\n");
}

function parseBoolean(value, defaultValue = false) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

function parsePositiveInt(value, defaultValue = 0) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
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
  if (
    ["talk", "story", "sharing", "chia-se", "tamsu", "tam-su"].includes(raw)
  ) {
    return "talk";
  }
  if (
    ["summary", "review", "weekly-summary", "tong-ket", "tongket"].includes(raw)
  ) {
    return "summary";
  }

  return "";
}

function inferRoadmapSeriesTypeFromTopic(topic) {
  const normalized = toAsciiLower(topic);
  if (!normalized) {
    return "study";
  }

  if (/(tong ket|nhin lai|recap|weekly review|review tuan)/.test(normalized)) {
    return "summary";
  }

  if (
    /(tam su|chia se|hanh trinh|cau chuyen|cam nhan|kinh nghiem|lessons learned)/.test(
      normalized,
    )
  ) {
    return "talk";
  }

  return "study";
}

function resolveRoadmapSeriesType(item) {
  const explicit = normalizeRoadmapSeriesType(item?.series_type || item?.type);
  if (explicit) {
    return explicit;
  }
  return inferRoadmapSeriesTypeFromTopic(item?.topic || "");
}

function getWeekdayIndexInTimezone(date, timezone) {
  const tz = String(timezone || "").trim() || "Asia/Ho_Chi_Minh";
  try {
    const weekdayShort = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: tz,
    }).format(date);
    const map = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    if (Object.prototype.hasOwnProperty.call(map, weekdayShort)) {
      return map[weekdayShort];
    }
  } catch (_error) {
    // fallback below
  }
  return date.getDay();
}

function getRoadmapScheduleRuleForDate(date, timezone) {
  const weekday = getWeekdayIndexInTimezone(date, timezone);

  // Thu 2,3,5,7 -> học (Mon,Tue,Thu,Sat)
  if ([1, 2, 4, 6].includes(weekday)) {
    return {
      key: "study_days",
      label: "Thứ 2/3/5/7 (series học)",
      preferredTypes: ["study"],
    };
  }

  // Thu 4,6,CN -> tâm sự/tổng kết nhẹ nhàng
  return {
    key: "talk_days",
    label: "Thứ 4/6/CN (series tâm sự)",
    preferredTypes: ["talk", "summary"],
  };
}

function findNextRoadmapItemBySchedule(
  items,
  statuses = ["pending"],
  options = {},
) {
  const rows = Array.isArray(items) ? items : [];
  const allowedStatus = new Set(
    (Array.isArray(statuses) ? statuses : ["pending"]).map(String),
  );
  const timezone = String(
    options.timezone || process.env.ROADMAP_TIMEZONE || "Asia/Ho_Chi_Minh",
  );
  const allowCrossTypeFallback = parseBoolean(
    options.allowCrossTypeFallback ??
      process.env.ROADMAP_ALLOW_CROSS_TYPE_FALLBACK,
    false,
  );

  const rule = getRoadmapScheduleRuleForDate(new Date(), timezone);
  const preferredTypeSet = new Set(rule.preferredTypes);

  const pendingRows = rows
    .filter((item) => allowedStatus.has(String(item?.status || "pending")))
    .sort((a, b) => {
      const typeA = resolveRoadmapSeriesType(a);
      const typeB = resolveRoadmapSeriesType(b);
      const dayA = Number(a?.day || Number.MAX_SAFE_INTEGER);
      const dayB = Number(b?.day || Number.MAX_SAFE_INTEGER);
      const createdA =
        Date.parse(String(a?.created_at || a?.updated_at || "")) || 0;
      const createdB =
        Date.parse(String(b?.created_at || b?.updated_at || "")) || 0;

      // Study -> ưu tiên theo day.
      if (typeA === "study" || typeB === "study") {
        if (dayA !== dayB) {
          return dayA - dayB;
        }
      }

      // Talk/Summary -> ưu tiên theo thời điểm tạo.
      if (createdA !== createdB) {
        return createdA - createdB;
      }
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    });

  const matched = pendingRows.find((item) =>
    preferredTypeSet.has(resolveRoadmapSeriesType(item)),
  );
  if (matched) {
    return { item: matched, rule, usedFallback: false };
  }

  if (!allowCrossTypeFallback) {
    return { item: null, rule, usedFallback: false };
  }

  return { item: pendingRows[0] || null, rule, usedFallback: true };
}

function recoverInterruptedProcessingItems(
  items,
  staleMinutes = parsePositiveInt(
    process.env.ROADMAP_PROCESSING_STALE_MINUTES,
    20,
  ),
) {
  const rows = Array.isArray(items) ? items : [];
  let recoveredCount = 0;
  const now = Date.now();
  const staleMs = Math.max(1, staleMinutes) * 60 * 1000;

  const updated = rows.map((item) => {
    const status = String(item?.status || "");
    if (status !== "processing") {
      return item;
    }

    const startedAtRaw = String(
      item?.processing_started_at || item?.updated_at || item?.created_at || "",
    ).trim();
    const startedAtMs = Date.parse(startedAtRaw);
    const isStale =
      !Number.isFinite(startedAtMs) || now - startedAtMs >= staleMs;
    if (!isStale) {
      return item;
    }

    recoveredCount += 1;
    return {
      ...item,
      status: "pending",
      processing_recovered_at: new Date().toISOString(),
      last_error: "Recovered from interrupted processing run.",
      updated_at: new Date().toISOString(),
    };
  });

  return {
    items: updated,
    recoveredCount,
    staleMinutes: Math.max(1, staleMinutes),
  };
}

function isTelegramPhotoMime(mimeType) {
  return /^image\/(jpeg|jpg|png)$/i.test(String(mimeType || ""));
}

async function safeReplyLongText(ctx, text, extra) {
  const chunks = splitLongText(text);
  if (chunks.length === 0) {
    return;
  }

  await ctx.reply(chunks[0], extra);
  for (let i = 1; i < chunks.length; i += 1) {
    await ctx.reply(chunks[i]);
  }
}

async function sendDraftPreview(ctx, imageAsset, postText, draftId = "") {
  const keyboard = buildDraftKeyboardWithId(draftId);

  if (!ENABLE_IMAGE_GENERATION) {
    await safeReplyLongText(ctx, `BẢN THẢO:\n\n${postText}`, keyboard);
    return;
  }

  const { caption, truncated } = toCaption(postText);
  const imageUrl = imageAsset?.url || imageAsset?.imageUrl || "";
  const hasBuffer =
    imageAsset?.type === "buffer" && Buffer.isBuffer(imageAsset.buffer);

  const sendFromUrlWithFallback = async (url) => {
    if (!url) {
      throw new Error("Missing image URL");
    }

    try {
      await ctx.replyWithPhoto(url, {
        caption,
        ...keyboard,
      });
      return;
    } catch (imgUrlError) {
      console.log(
        "[bot] URL image failed, try upload buffer:",
        imgUrlError.message,
      );
    }

    const { buffer: imageBuffer, mimeType } = await downloadImageBuffer(
      url,
      true,
    );
    if (!isTelegramPhotoMime(mimeType)) {
      throw new Error(`Unsupported image mime for Telegram photo: ${mimeType}`);
    }
    await ctx.replyWithPhoto(
      { source: imageBuffer, filename: "draft-banner.png" },
      {
        caption,
        ...keyboard,
      },
    );
  };

  try {
    if (hasBuffer) {
      await ctx.replyWithPhoto(
        { source: imageAsset.buffer, filename: "draft-banner.png" },
        {
          caption,
          ...keyboard,
        },
      );
    } else if (imageUrl) {
      await sendFromUrlWithFallback(imageUrl);
    } else {
      throw new Error("No image data from generator");
    }
  } catch (imageError) {
    console.log(
      "[bot] Preview image failed, fallback text:",
      imageError.message,
    );
    await safeReplyLongText(
      ctx,
      `BẢN THẢO (lỗi hiển thị ảnh):\n\n${imageUrl ? `Link ảnh: ${imageUrl}\n\n` : ""}${postText}`,
      keyboard,
    );
    return;
  }

  if (truncated) {
    await safeReplyLongText(ctx, `Bản đầy đủ:\n\n${postText}`);
  }
}

async function updateStatus(ctx, statusMessage, text) {
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      text,
    );
  } catch (error) {
    console.log("[bot] Could not edit status message:", error.message);
    await ctx.reply(text);
  }
}

async function runDeletePostFlow(ctx, inputPostId = "") {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return false;
  }

  const explicitId = String(inputPostId || "").trim();
  const postId = explicitId || getLastPublishedPostId(chatId);

  if (!postId) {
    await ctx.reply(
      "Chưa có ID để xóa. Dùng: /delete <post_id> hoặc đăng bài mới rồi /delete.",
    );
    return false;
  }

  const statusMsg = await ctx.reply(
    `Đang yêu cầu Facebook gỡ bài: ${postId}...`,
  );
  try {
    await deleteFacebookPost(postId);
    forgetPublishedPost(chatId, postId);
    await updateStatus(
      ctx,
      statusMsg,
      "Đã xóa bài viết thành công khỏi Fanpage.",
    );
    return true;
  } catch (error) {
    await updateStatus(ctx, statusMsg, `Xóa thất bại: ${error.message}`);
    return false;
  }
}

async function runDraftEditFeedbackFlow(ctx, feedbackText) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return false;
  }

  const pendingRequest = getPendingDraftEditRequest(chatId);
  if (!pendingRequest?.draftId) {
    return false;
  }

  const feedback = String(feedbackText || "").trim();
  if (!feedback) {
    await ctx.reply(
      "Feedback đang trống. Gửi lại nội dung bạn muốn chỉnh sửa nhé.",
    );
    return true;
  }

  const draft = await resolveDraftByAction(chatId, pendingRequest.draftId);
  if (!draft) {
    clearPendingDraftEditRequest(chatId);
    await ctx.reply(
      "Không tìm thấy bản nháp để chỉnh sửa. Hãy tạo lại bản nháp mới.",
    );
    return true;
  }

  const statusMsg = await ctx.reply(
    "[Edit] Đang cập nhật bản thảo theo feedback của bạn...",
  );

  try {
    const isSeries = Number.isFinite(Number(draft.roadmapDay));
    const seriesDay = isSeries
      ? Math.max(1, Math.floor(Number(draft.roadmapDay)))
      : null;
    const roadmapItem = draft.roadmapItemId
      ? findRoadmapItemByTarget(
          await loadRoadmap(),
          String(draft.roadmapItemId),
        )
      : null;
    const seriesHint = String(roadmapItem?.image_hint || "").trim();

    const editPrompt =
      `Đây là bản thảo hiện tại:\n${draft.postText}\n\n` +
      `Feedback chỉnh sửa của user:\n${feedback}\n\n` +
      `${isSeries ? `Day hiện tại: ${seriesDay}\n` : ""}` +
      `${seriesHint ? `image_hint từ roadmap: ${seriesHint}\n` : ""}` +
      "Hãy chỉnh lại nội dung theo feedback, giữ đúng ý chính quan trọng và trả về JSON đúng schema.";

    const structuredRaw = await askAI(editPrompt, {
      systemPrompt: isSeries ? SERIES_POST_PROMPT : REFINE_CONTENT_PROMPT,
      model:
        process.env.AI_MODEL ||
        process.env.OPENROUTER_DEEP_MODEL ||
        process.env.OPENROUTER_MODEL,
      expectJson: true,
      temperature: 0.3,
      timeout: 300000,
      throwOnError: true,
    });

    const structured = parseStructuredAiOutput(
      structuredRaw,
      draft.topic || "draft",
    );
    let finalPost = formatForFacebook(structured.post_content);
    if (isSeries) {
      finalPost = ensureSeriesHeading(finalPost, seriesDay, draft.topic || "");
    }

    const updatedImageMeta = {
      ...(draft.imageMeta || {}),
      topic: draft.topic || draft.imageMeta?.topic || "",
      image_short_title: isSeries
        ? buildSeriesImageShortTitle(
            seriesDay,
            draft.topic || draft.imageMeta?.topic || "",
            structured.image_short_title,
            seriesHint,
          )
        : structured.image_short_title || draft.imageMeta?.image_short_title,
      ant_action: structured.ant_action || draft.imageMeta?.ant_action,
      log_message: structured.log_message || draft.imageMeta?.log_message,
    };

    const updatedDraft = await storeDraft(
      chatId,
      {
        ...draft,
        postText: finalPost,
        imageMeta: updatedImageMeta,
        lastEditFeedback: feedback,
      },
      { draftId: draft.draftId },
    );

    clearPendingDraftEditRequest(chatId);
    await sendDraftPreview(
      ctx,
      updatedDraft.imageAsset,
      updatedDraft.postText,
      updatedDraft.draftId,
    );
    await updateStatus(
      ctx,
      statusMsg,
      "[Edit] Đã cập nhật bản thảo theo feedback. Bạn duyệt lại giúp mình.",
    );
    return true;
  } catch (error) {
    await updateStatus(
      ctx,
      statusMsg,
      `[Edit] Chỉnh sửa thất bại: ${error.message}`,
    );
    await ctx.reply("Bạn có thể gửi feedback khác để mình thử chỉnh lại.");
    return true;
  }
}

async function runRewriteFlow(ctx, rawContent) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const userRaw = String(rawContent || "").trim();
  if (!userRaw) {
    await ctx.reply(
      "Bạn hãy gửi: /rewrite <nội dung thô>\nHoặc: Viết lại: <nội dung thô>",
    );
    return;
  }

  const statusMsg = await ctx.reply(
    "[1/3] Đang refactor nội dung theo phong cách The Little Coder...",
  );

  try {
    const structuredRaw = await askAI(
      `Nội dung thô của Tiến:\n${userRaw}\n\n` +
        "Hãy giữ nguyên ý chính, chỉ chỉnh sửa ngôn từ và trả về JSON đúng schema.",
      {
        systemPrompt: REFINE_CONTENT_PROMPT,
        model:
          process.env.AI_MODEL ||
          process.env.OPENROUTER_DEEP_MODEL ||
          process.env.OPENROUTER_MODEL,
        expectJson: true,
        temperature: 0.4,
        timeout: 300000,
        throwOnError: true,
      },
    );

    await updateStatus(
      ctx,
      statusMsg,
      "[2/3] Đang parse JSON và dọn đẹp nội dung để tạo bản thảo...",
    );

    const structured = parseStructuredAiOutput(
      structuredRaw,
      buildTopicFromRawContent(userRaw),
    );
    const finalPost = formatForFacebook(structured.post_content);
    const imageMeta = {
      topic: buildTopicFromRawContent(userRaw),
      image_short_title: structured.image_short_title,
      ant_action: structured.ant_action,
      log_message: structured.log_message,
    };

    await updateStatus(
      ctx,
      statusMsg,
      ENABLE_IMAGE_GENERATION
        ? "[3/3] Đang tạo banner và gửi bản thảo để duyệt..."
        : "[3/3] Đang gửi bản thảo text để duyệt (tạm tắt tạo ảnh)...",
    );

    const imageAsset = ENABLE_IMAGE_GENERATION
      ? await generateImageAsset(imageMeta, "default")
      : null;
    const draft = await storeDraft(chatId, {
      postText: finalPost,
      topic: imageMeta.topic,
      imageMeta,
      imageAsset,
      imageUrl: imageAsset?.url || null,
      source: "rewrite",
      rawContent: userRaw,
    });

    await sendDraftPreview(ctx, imageAsset, finalPost, draft.draftId);
    await updateStatus(
      ctx,
      statusMsg,
      "Đã refactor xong. Bản thảo sẵn sàng, bấm Duyệt & Đăng bài nếu ok.",
    );
  } catch (error) {
    console.error("[bot] Rewrite workflow error:", error.message);
    await updateStatus(ctx, statusMsg, "Rewrite bị gián đoạn. Đang báo lỗi...");
    await ctx.reply(`Rewrite thất bại: ${error.message}`);
  }
}

function createTelegramCtxProxy(chatId) {
  return {
    chat: { id: Number(chatId) },
    telegram: bot.telegram,
    reply: (text, extra) => bot.telegram.sendMessage(chatId, text, extra),
    replyWithPhoto: (photo, extra) =>
      bot.telegram.sendPhoto(chatId, photo, extra),
  };
}

async function runRoadmapCreateFlow(ctx, sourceTopic, options = {}) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const topic = String(sourceTopic || "").trim();
  const defaultSeriesType = normalizeRoadmapSeriesType(
    options.defaultSeriesType || "",
  );
  if (!topic) {
    await ctx.reply(
      "Dùng: /roadmap <chủ đề lớn>. Ví dụ: /roadmap ReactJS từ A-Z",
    );
    return;
  }

  const statusMsg = await ctx.reply(
    `[Roadmap] Đang tạo lộ trình cho: ${topic}...`,
  );
  let rawPlan = "";
  try {
    rawPlan = await askAI(
      `Chủ đề tổng: ${topic}\n\n` +
        "Hãy tạo roadmap với số lượng bài PHÙ HỢP độ rộng chủ đề (không cố định), " +
        "trả về đúng JSON Array theo schema yêu cầu.\n" +
        (defaultSeriesType
          ? `Toàn bộ bài trong roadmap này bắt buộc thuộc type="${defaultSeriesType}".`
          : ""),
      {
        systemPrompt: ROADMAP_GENERATOR_PROMPT,
        model:
          process.env.AI_MODEL ||
          process.env.OPENROUTER_DEEP_MODEL ||
          process.env.OPENROUTER_MODEL,
        expectJson: true,
        temperature: 0.2,
        timeout: 180000,
        throwOnError: true,
      },
    );

    const roadmapItemsRaw = parseRoadmapOutput(rawPlan, topic);
    const roadmapItems = roadmapItemsRaw.map((item) => ({
      ...item,
      series_type: defaultSeriesType || resolveRoadmapSeriesType(item),
    }));
    roadmapProposalStore.set(chatId, {
      topic,
      items: roadmapItems,
      createdAt: new Date().toISOString(),
    });
    const stats = getRoadmapStats(roadmapItems);

    await updateStatus(
      ctx,
      statusMsg,
      `[Roadmap] Đã tạo xong ${stats.total} bài (CHƯA LƯU).`,
    );
    await safeReplyLongText(
      ctx,
      `Danh sách đề xuất (${stats.total} bài):\n${formatRoadmapSummary(roadmapItems)}`,
    );
    await ctx.reply(
      `Đề xuất này đang chờ bạn duyệt.\n` +
        `- Lưu đề xuất (append): /roadmap_save\n` +
        `- Lưu đề xuất (ghi đè): /roadmap_save replace\n` +
        `- Bỏ đề xuất: /roadmap_discard\n` +
        `- Duyệt tất cả để chạy lịch: /roadmap_approve_all\n` +
        `- Duyệt từng bài: /roadmap_approve <day|id>\n` +
        `- Đổi type bài: /roadmap_type <day|id> <study|talk|summary>`,
    );
  } catch (error) {
    console.error("[bot] Roadmap create error:", error.message);
    if (rawPlan) {
      console.error(
        "[bot] Roadmap raw AI output preview:",
        String(rawPlan).slice(0, 600),
      );
    }
    await updateStatus(
      ctx,
      statusMsg,
      `[Roadmap] Tạo roadmap thất bại: ${error.message}`,
    );
  }
}

async function runRoadmapSaveFlow(ctx, rawArg = "") {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const proposal = roadmapProposalStore.get(chatId);
  if (!proposal?.items?.length) {
    await ctx.reply(
      "Chưa có đề xuất roadmap để lưu. Dùng /roadmap <chủ đề lớn> trước.",
    );
    return;
  }

  const saveMode = String(rawArg || "")
    .trim()
    .toLowerCase();
  const replaceMode = ["replace", "overwrite", "reset"].includes(saveMode);

  let nextItems = proposal.items;
  if (!replaceMode) {
    const current = await loadRoadmap();
    const maxCurrentStudyDay = current.reduce((max, item) => {
      if (resolveRoadmapSeriesType(item) !== "study") {
        return max;
      }
      const day = Number(item?.day || 0);
      return Number.isFinite(day) && day > max ? day : max;
    }, 0);

    let studyOffset = 0;
    const appended = proposal.items.slice().map((item) => {
      const itemType = resolveRoadmapSeriesType(item);
      const nextItem = {
        ...item,
        series_type: itemType,
        appended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (itemType === "study") {
        studyOffset += 1;
        nextItem.day = maxCurrentStudyDay + studyOffset;
      } else {
        delete nextItem.day;
      }

      return nextItem;
    });

    nextItems = [...current, ...appended];
  }

  await saveRoadmap(nextItems);
  roadmapProposalStore.delete(chatId);
  const stats = getRoadmapStats(nextItems);
  await ctx.reply(
    `[Roadmap] Đã ${replaceMode ? "ghi đè" : "append"} ${proposal.items.length} bài vào ${resolveRoadmapPath()}.\n` +
      `Hiện tại: total=${stats.total}, draft=${stats.draft}, pending=${stats.pending}, drafted=${stats.drafted}, posted=${stats.posted}.\n` +
      `Mặc định đang ở trạng thái DRAFT, bạn duyệt bằng /roadmap_approve hoặc /roadmap_approve_all.`,
  );
}

async function runRoadmapDiscardFlow(ctx) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  if (!roadmapProposalStore.has(chatId)) {
    await ctx.reply("Không có đề xuất roadmap nào để bỏ.");
    return;
  }

  roadmapProposalStore.delete(chatId);
  await ctx.reply("Đã bỏ đề xuất roadmap chưa lưu.");
}

async function runRoadmapListFlow(ctx, status = "") {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const roadmap = await loadRoadmap();
  const stats = getRoadmapStats(roadmap);
  const title =
    `[Roadmap] total=${stats.total}, draft=${stats.draft || 0}, pending=${stats.pending}, ` +
    `processing=${stats.processing}, drafted=${stats.drafted}, posted=${stats.posted}, failed=${stats.failed}`;
  await ctx.reply(title);
  await safeReplyLongText(ctx, formatRoadmapList(roadmap, { status }));
}

async function runRoadmapApproveFlow(ctx, target) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const key = String(target || "").trim();
  if (!key) {
    await ctx.reply("Dùng: /roadmap_approve <day|id>");
    return;
  }

  const roadmap = await loadRoadmap();
  const found = findRoadmapItemByTarget(roadmap, key);
  if (!found) {
    await ctx.reply(`Không tìm thấy bài với key: ${key}`);
    return;
  }

  const updated = updateRoadmapItemByTarget(roadmap, key, {
    status: "pending",
    approved_at: new Date().toISOString(),
  });
  await saveRoadmap(updated);
  await ctx.reply(
    `Đã duyệt ${formatRoadmapItemLabel(found)} (${found.topic}) -> PENDING.`,
  );
}

async function runRoadmapApproveAllFlow(ctx) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const roadmap = await loadRoadmap();
  if (roadmap.length === 0) {
    await ctx.reply(
      "Roadmap hiện đang rỗng (0 bài). Dùng /roadmap <chủ đề lớn> rồi /roadmap_save trước.",
    );
    return;
  }

  let changedCount = 0;
  const updated = roadmap.map((item) => {
    const status = String(item?.status || "draft");
    if (["draft", "failed", "processing"].includes(status)) {
      changedCount += 1;
      return {
        ...item,
        status: "pending",
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    return item;
  });
  await saveRoadmap(updated);
  const stats = getRoadmapStats(updated);
  await ctx.reply(
    `Đã duyệt ${changedCount} bài từ DRAFT/FAILED/PROCESSING -> PENDING.\n` +
      `Tổng bài: ${stats.total}\n` +
      `Hiện tại: pending=${stats.pending}, drafted=${stats.drafted}, posted=${stats.posted}.`,
  );
}

async function runRoadmapEditFlow(ctx, rawArg) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const text = String(rawArg || "").trim();
  const parts = text.split("|");
  const target = String(parts[0] || "").trim();
  const newTopic = String(parts.slice(1).join("|") || "").trim();

  if (!target || !newTopic) {
    await ctx.reply("Dùng: /roadmap_edit <day|id> | <topic mới>");
    return;
  }

  const roadmap = await loadRoadmap();
  const found = findRoadmapItemByTarget(roadmap, target);
  if (!found) {
    await ctx.reply(`Không tìm thấy bài với key: ${target}`);
    return;
  }

  const updated = updateRoadmapItemByTarget(roadmap, target, {
    topic: newTopic,
    // Sau khi sửa nội dung, đưa về draft để duyệt lại.
    status: "draft",
    edited_at: new Date().toISOString(),
  });
  await saveRoadmap(updated);
  await ctx.reply(
    `Đã sửa ${formatRoadmapItemLabel(found)}.\nTopic mới: ${newTopic}\nTrạng thái: DRAFT`,
  );
}

async function runRoadmapSetTypeFlow(ctx, rawArg) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const text = String(rawArg || "").trim();
  const [targetRaw, typeRaw] = text.split(/\s+/);
  const target = String(targetRaw || "").trim();
  const seriesType = normalizeRoadmapSeriesType(typeRaw || "");

  if (!target || !seriesType) {
    await ctx.reply("Dùng: /roadmap_type <day|id> <study|talk|summary>");
    return;
  }

  const roadmap = await loadRoadmap();
  const found = findRoadmapItemByTarget(roadmap, target);
  if (!found) {
    await ctx.reply(`Không tìm thấy bài với key: ${target}`);
    return;
  }

  let nextDayPatch = {};
  if (seriesType === "study") {
    const maxStudyDay = roadmap.reduce((max, item) => {
      if (resolveRoadmapSeriesType(item) !== "study") {
        return max;
      }
      const day = Number(item?.day || 0);
      return Number.isFinite(day) && day > max ? day : max;
    }, 0);
    nextDayPatch = { day: Number(found?.day) || maxStudyDay + 1 };
  } else {
    nextDayPatch = { day: undefined };
  }

  const updated = updateRoadmapItemByTarget(roadmap, target, {
    series_type: seriesType,
    ...nextDayPatch,
    type_set_at: new Date().toISOString(),
  });
  await saveRoadmap(updated);
  await ctx.reply(`Đã cập nhật ${found.id} -> type=${seriesType}.`);
}

async function runRoadmapDeleteFlow(ctx, target) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const key = String(target || "").trim();
  if (!key) {
    await ctx.reply("Dùng: /roadmap_delete <day|id>");
    return;
  }

  const roadmap = await loadRoadmap();
  const found = findRoadmapItemByTarget(roadmap, key);
  if (!found) {
    await ctx.reply(`Không tìm thấy bài với key: ${key}`);
    return;
  }

  const updated = removeRoadmapItemByTarget(roadmap, key);
  await saveRoadmap(updated);

  // Xóa luôn draft đã gửi qua Telegram nếu có.
  await deleteDraftRecordById(`rm_${found.id}`);
  const currentDraft = draftStore.get(chatId);
  if (currentDraft?.roadmapItemId === found.id) {
    await clearDraft(chatId, currentDraft.draftId);
  }

  await ctx.reply(`Đã xóa ${formatRoadmapItemLabel(found)} khỏi roadmap.`);
}

async function runRoadmapClearFlow(ctx, rawArg) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const confirm = String(rawArg || "")
    .trim()
    .toLowerCase();
  if (confirm !== "confirm") {
    await ctx.reply("Để xóa toàn bộ roadmap, dùng: /roadmap_clear confirm");
    return;
  }

  await saveRoadmap([]);
  const currentDraft = draftStore.get(chatId);
  if (currentDraft?.source === "roadmap") {
    await clearDraft(chatId, currentDraft.draftId);
  }
  await ctx.reply("Đã xóa toàn bộ roadmap.");
}

async function runStorageClearFlow(ctx, rawArg) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const confirm = String(rawArg || "")
    .trim()
    .toLowerCase();
  if (confirm !== "confirm") {
    await ctx.reply(
      "Để xóa toàn bộ dữ liệu lưu trữ, dùng: /storage_clear confirm",
    );
    return;
  }

  if (isPostgresStorageEnabled()) {
    const cleared = await clearAllPostgresData();
    if (!cleared) {
      await ctx.reply("[Storage] Xóa dữ liệu thất bại trên Postgres.");
      return;
    }
  } else {
    await saveRoadmap([]);
    await clearAllDraftRecords();
  }

  draftStore.clear();
  roadmapProposalStore.clear();
  draftEditRequestStore.clear();
  publishedPostStore.clear();

  await ctx.reply(
    `[Storage] Đã xóa toàn bộ dữ liệu (${isPostgresStorageEnabled() ? "postgres" : "file"}).`,
  );
}

async function runStorageInfoFlow(ctx) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const configuredDriver = resolveStorageDriver();
  const usingPostgres = isPostgresStorageEnabled();
  const activeBackend = usingPostgres ? "postgres" : "file";

  const roadmap = await loadRoadmap();
  const roadmapStats = getRoadmapStats(roadmap);
  const persistedDraftCount = await countPersistedDraftRecords();
  const appStateRows = usingPostgres ? await countAppStateRows() : 0;

  const fallbackAllowed = parseBoolean(
    process.env.STORAGE_ALLOW_FILE_FALLBACK,
    false,
  );
  const migrateJson = parseBoolean(process.env.STORAGE_MIGRATE_JSON, false);

  const lines = [
    "[Storage] Trạng thái hiện tại",
    `- Driver cấu hình: ${configuredDriver}`,
    `- Backend đang dùng: ${activeBackend}`,
    `- Fallback file: ${fallbackAllowed ? "ON" : "OFF"}`,
    `- Auto migrate JSON -> DB: ${migrateJson ? "ON" : "OFF"}`,
  ];

  if (usingPostgres) {
    lines.push(`- Postgres: ${resolvePostgresDescriptor()}`);
    lines.push(`- Bảng app_state: ${appStateRows} row(s)`);
  } else {
    lines.push(`- Roadmap file: ${resolveRoadmapPath()}`);
    lines.push(`- Draft file: ${resolveDraftFilePath()}`);
  }

  lines.push(
    `- Roadmap: total=${roadmapStats.total}, draft=${roadmapStats.draft}, pending=${roadmapStats.pending}, drafted=${roadmapStats.drafted}, posted=${roadmapStats.posted}, failed=${roadmapStats.failed}`,
  );
  lines.push(`- Draft records: ${persistedDraftCount}`);

  await ctx.reply(lines.join("\n"));
}

async function runRoadmapRegenerateCurrentFlow(ctx) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const roadmap = await loadRoadmap();
  const draftedItem = findNextRoadmapItem(roadmap, ["drafted"]);
  if (!draftedItem) {
    await ctx.reply("Không có bản nháp roadmap nào đang chờ duyệt để tạo lại.");
    return;
  }

  const resetRoadmap = updateRoadmapItem(roadmap, draftedItem.id, {
    status: "pending",
    draft_preview_ready: false,
    regenerated_at: new Date().toISOString(),
  });
  await saveRoadmap(resetRoadmap);

  await deleteDraftRecordById(`rm_${draftedItem.id}`);
  const currentDraft = draftStore.get(chatId);
  if (currentDraft?.roadmapItemId === draftedItem.id) {
    await clearDraft(chatId, currentDraft.draftId);
  }

  await ctx.reply(
    `[Roadmap] Đã hủy bản nháp ${formatRoadmapItemLabel(draftedItem)} và chuẩn bị tạo lại...`,
  );
  const ok = await runRoadmapNextDraftFlow("manual");
  if (!ok) {
    await ctx.reply("[Roadmap] Không tạo lại được bản nháp ở lần chạy này.");
  }
}

async function runRoadmapNextDraftFlow(trigger = "manual") {
  if (isRoadmapJobRunning) {
    return false;
  }

  const adminChatId = ownerChatId();
  if (!adminChatId) {
    console.warn(
      "[roadmap] Missing admin chat id. Configure MY_CHAT_ID_TEST (dev) or MY_CHAT_ID_PROD (prod). Skip auto draft.",
    );
    return false;
  }

  isRoadmapJobRunning = true;
  let statusMessage = null;
  let processingItemId = "";
  let processingDay = "";
  try {
    let roadmap = await loadRoadmap();
    const recovered = recoverInterruptedProcessingItems(roadmap);
    if (recovered.recoveredCount > 0) {
      roadmap = recovered.items;
      await saveRoadmap(roadmap);
      try {
        await bot.telegram.sendMessage(
          adminChatId,
          `[Roadmap] Khôi phục ${recovered.recoveredCount} bài PROCESSING bị stale ` +
            `(>${recovered.staleMinutes} phút) -> PENDING.`,
        );
      } catch (_notifyRecoveredError) {
        // no-op
      }
    }

    const requireReviewBeforeNext = parseBoolean(
      process.env.ROADMAP_REQUIRE_REVIEW_BEFORE_NEXT,
      true,
    );
    if (requireReviewBeforeNext) {
      const waitingDraft = findNextRoadmapItem(roadmap, ["drafted"]);
      if (waitingDraft) {
        if (trigger !== "cron") {
          await bot.telegram.sendMessage(
            adminChatId,
            `[Roadmap] ${formatRoadmapItemLabel(waitingDraft)} đang ở trạng thái DRAFTED, ` +
              `hãy duyệt/hủy trước khi tạo bản nháp tiếp theo.`,
          );
        }
        return false;
      }
    }

    const timezone = String(
      process.env.ROADMAP_TIMEZONE || "Asia/Ho_Chi_Minh",
    ).trim();
    const scheduledPick = findNextRoadmapItemBySchedule(roadmap, ["pending"], {
      timezone,
      // Cron chạy theo lịch type. Manual cho phép fallback để dễ test/điều hành.
      allowCrossTypeFallback: trigger !== "cron",
    });
    const next = scheduledPick.item;
    if (!next) {
      if (trigger !== "cron") {
        await bot.telegram.sendMessage(
          adminChatId,
          `[Roadmap] Không có bài PENDING khớp lịch hôm nay: ${scheduledPick.rule.label}.`,
        );
      }
      return false;
    }

    const processingRoadmap = updateRoadmapItem(roadmap, next.id, {
      status: "processing",
      processing_started_at: new Date().toISOString(),
      last_error: "",
    });
    await saveRoadmap(processingRoadmap);
    processingItemId = String(next.id || "");
    const nextLabel = formatRoadmapItemLabel(next);
    processingDay = nextLabel;

    const triggerLabel = trigger === "cron" ? "tự động" : "thủ công";
    const nextSeriesType = resolveRoadmapSeriesType(next);
    statusMessage = await bot.telegram.sendMessage(
      adminChatId,
      `[Roadmap/${triggerLabel}] Đang xử lý ${nextLabel} [${nextSeriesType}]` +
        `${scheduledPick.usedFallback ? " [fallback]" : ""}: ${next.topic}`,
    );

    const onStep = async (_index, text) => {
      try {
        await bot.telegram.editMessageText(
          adminChatId,
          statusMessage.message_id,
          undefined,
          `[Roadmap] ${nextLabel} [${nextSeriesType}]: ${text}`,
        );
      } catch (_error) {
        await bot.telegram.sendMessage(adminChatId, `[Roadmap] ${text}`);
      }
    };

    const draft = await buildDraftFromTopic(
      next.topic,
      buildPostDraftOptions({
        onStep,
        seriesInfo: {
          day: Number(next.day) || 1,
          total: roadmap.length,
          image_hint: next.image_hint || "",
        },
      }),
    );
    const draftWithRoadmap = {
      ...draft,
      source: "roadmap",
      roadmapItemId: next.id,
      roadmapDay: Number(next.day) || undefined,
      roadmapSeriesType: nextSeriesType,
    };
    const savedDraft = await storeDraft(adminChatId, draftWithRoadmap, {
      draftId: `rm_${next.id}`,
    });

    const draftedRoadmap = updateRoadmapItem(await loadRoadmap(), next.id, {
      status: "drafted",
      drafted_at: new Date().toISOString(),
      draft_preview_ready: true,
    });
    await saveRoadmap(draftedRoadmap);

    const pseudoCtx = createTelegramCtxProxy(adminChatId);
    await sendDraftPreview(
      pseudoCtx,
      savedDraft.imageAsset,
      savedDraft.postText,
      savedDraft.draftId,
    );
    await bot.telegram.sendMessage(
      adminChatId,
      `[Roadmap] ${nextLabel} [${nextSeriesType}] đã có bản thảo. ` +
        `Bấm "Duyệt & Đăng bài" để lên sóng.`,
    );
    return true;
  } catch (error) {
    console.error("[roadmap] Auto draft error:", error.message);
    try {
      const roadmap = await loadRoadmap();
      if (processingItemId) {
        const rollback = updateRoadmapItem(roadmap, processingItemId, {
          status: "pending",
          last_error: error.message,
        });
        await saveRoadmap(rollback);
      }
    } catch (syncError) {
      console.error("[roadmap] rollback error:", syncError.message);
    }

    try {
      if (adminChatId) {
        await bot.telegram.sendMessage(
          adminChatId,
          `[Roadmap] Tạo bản nháp thất bại` +
            `${processingDay ? ` (${processingDay})` : ""}: ${error.message}`,
        );
      }
    } catch (_notifyError) {
      // no-op
    }
    return false;
  } finally {
    isRoadmapJobRunning = false;
  }
}

function initRoadmapScheduler() {
  const enabled = parseBoolean(process.env.ROADMAP_AUTO_ENABLED, true);
  if (!enabled) {
    console.log("[roadmap] Scheduler disabled by ROADMAP_AUTO_ENABLED=false");
    return;
  }

  const testIntervalMinutes = parsePositiveInt(
    process.env.ROADMAP_TEST_INTERVAL_MINUTES,
    0,
  );
  const useTestInterval = testIntervalMinutes >= 1 && testIntervalMinutes <= 59;
  const timezone = String(
    process.env.ROADMAP_TIMEZONE || "Asia/Ho_Chi_Minh",
  ).trim();

  if (useTestInterval) {
    const cronExpr = `*/${testIntervalMinutes} * * * *`;
    cron.schedule(
      cronExpr,
      async () => {
        await runRoadmapNextDraftFlow("cron:test");
      },
      { timezone },
    );
    console.log(
      `[roadmap] Scheduler enabled: "${cronExpr}" (${timezone}) [test interval=${testIntervalMinutes}m]` +
        " | type-schedule: T2/T3/T5/T7=study, T4/T6/CN=talk",
    );
    return;
  }

  const scheduleSlots = [
    {
      key: "morning",
      label: "08:00",
      cronExpr: String(process.env.ROADMAP_CRON_MORNING || "0 8 * * *").trim(),
    },
    {
      key: "noon",
      label: "12:00",
      cronExpr: String(process.env.ROADMAP_CRON_NOON || "0 12 * * *").trim(),
    },
    {
      key: "night",
      label: "20:00",
      cronExpr: String(process.env.ROADMAP_CRON_NIGHT || "0 20 * * *").trim(),
    },
  ];

  for (const slot of scheduleSlots) {
    cron.schedule(
      slot.cronExpr,
      async () => {
        await runRoadmapNextDraftFlow(`cron:${slot.key}`);
      },
      { timezone },
    );
  }

  console.log(
    `[roadmap] Scheduler enabled (${timezone}): ` +
      scheduleSlots
        .map((slot) => `${slot.label}="${slot.cronExpr}"`)
        .join(", ") +
      " | type-schedule: T2/T3/T5/T7=study, T4/T6/CN=talk",
  );
}

bot.start((ctx) => {
  ctx.reply("Chào Tiến! Tôi đã sẵn sàng research, viết bài và tạo banner.");
});

bot.help((ctx) => {
  ctx.reply(
    "Lệnh hiện tại:\n\n" +
      "1) Tạo bài nhanh\n" +
      "- /post <chủ đề>: Viết bài chia sẻ/góc nhìn và tạo bản thảo để duyệt.\n" +
      "- /news <chủ đề>: Viết bản tin công nghệ và tạo bản thảo để duyệt.\n" +
      "- /publish <nội dung>: Đăng ngay lên Facebook; có thể gửi kèm ảnh bằng caption /publish ...\n" +
      "- /rewrite <nội dung thô>: Viết lại nội dung bạn đưa theo văn phong đã cấu hình.\n" +
      "- /edit_cancel: Hủy phiên chỉnh sửa bản thảo đang chờ feedback.\n" +
      "- /delete <post_id>: Xóa bài đã đăng trên Facebook.\n\n" +
      "2) Quản lý roadmap\n" +
      "- /roadmap <chủ đề lớn>: Tạo đề xuất roadmap tổng quát.\n" +
      "- /roadmap_study <chủ đề>: Tạo đề xuất chỉ gồm bài học (study).\n" +
      "- /roadmap_talk <chủ đề>: Tạo đề xuất chỉ gồm bài tâm sự (talk).\n" +
      "- /roadmap_summary <chủ đề>: Tạo đề xuất chỉ gồm bài tổng kết (summary).\n" +
      "- /roadmap_save [replace]: Lưu đề xuất (mặc định append, thêm 'replace' để ghi đè).\n" +
      "- /roadmap_discard: Bỏ đề xuất chưa lưu.\n" +
      "- /roadmap_list [status]: Xem danh sách roadmap, có thể lọc status.\n" +
      "- /roadmap_approve <day|id>: Duyệt 1 bài -> pending.\n" +
      "- /roadmap_approve_all: Duyệt toàn bộ bài draft/failed/processing -> pending.\n" +
      "- /roadmap_edit <day|id> | <topic mới>: Sửa topic 1 bài (đưa về draft).\n" +
      "- /roadmap_type <day|id> <study|talk|summary>: Đổi loại bài.\n" +
      "- /roadmap_delete <day|id>: Xóa 1 bài khỏi roadmap.\n" +
      "- /roadmap_clear confirm: Xóa toàn bộ roadmap.\n" +
      "- /roadmap_next: Chạy tạo bản nháp roadmap kế tiếp ngay.\n" +
      "- /roadmap_regen: Hủy bản nháp roadmap hiện tại và tạo lại.\n\n" +
      "3) Storage\n" +
      "- /storage_info: Xem storage đang dùng (postgres/file) + số liệu hiện tại.\n" +
      "- /storage_clear confirm: Xóa toàn bộ dữ liệu lưu trữ (roadmap + draft).",
  );
});

bot.command("delete", async (ctx) => {
  markCommandHandled(ctx);
  const postId = extractDeleteCommandArg(ctx.message?.text || "") || "";
  await runDeletePostFlow(ctx, postId);
});

bot.command("rewrite", async (ctx) => {
  markCommandHandled(ctx);
  const rawContent = extractRewriteInput(ctx.message?.text || "");
  await runRewriteFlow(ctx, rawContent || "");
});

bot.command("publish", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  await commandService.publish(ctx, { chatId: String(ctx.chat.id) });
});

bot.command("edit_cancel", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }

  const pendingRequest = getPendingDraftEditRequest(String(ctx.chat.id));
  if (!pendingRequest) {
    await ctx.reply("Hiện không có phiên chỉnh sửa nào đang chờ feedback.");
    return;
  }

  clearPendingDraftEditRequest(String(ctx.chat.id));
  await ctx.reply("Đã hủy chế độ chỉnh sửa nội dung.");
});

bot.command("roadmap", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }

  const text = String(ctx.message?.text || "").trim();
  const topic = text.replace(/^\/roadmap(?:@\w+)?\s*/i, "").trim();
  await runRoadmapCreateFlow(ctx, topic);
});

bot.command("roadmap_study", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const topic = text.replace(/^\/roadmap_study(?:@\w+)?\s*/i, "").trim();
  await runRoadmapCreateFlow(ctx, topic, { defaultSeriesType: "study" });
});

bot.command("roadmap_talk", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const topic = text.replace(/^\/roadmap_talk(?:@\w+)?\s*/i, "").trim();
  await runRoadmapCreateFlow(ctx, topic, { defaultSeriesType: "talk" });
});

bot.command("roadmap_summary", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const topic = text.replace(/^\/roadmap_summary(?:@\w+)?\s*/i, "").trim();
  await runRoadmapCreateFlow(ctx, topic, { defaultSeriesType: "summary" });
});

bot.command("roadmap_save", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const arg = text.replace(/^\/roadmap_save(?:@\w+)?\s*/i, "").trim();
  await runRoadmapSaveFlow(ctx, arg);
});

bot.command("roadmap_discard", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  await runRoadmapDiscardFlow(ctx);
});

bot.command("roadmap_next", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }

  await ctx.reply("[Roadmap] Đang chạy bản nháp kế tiếp...");
  const ok = await runRoadmapNextDraftFlow("manual");
  if (!ok) {
    await ctx.reply("[Roadmap] Không tạo được bản nháp mới ở lần chạy này.");
  }
});

bot.command("roadmap_list", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const status = text.replace(/^\/roadmap_list(?:@\w+)?\s*/i, "").trim();
  await runRoadmapListFlow(ctx, status);
});

bot.command("roadmap_approve", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const target = text.replace(/^\/roadmap_approve(?:@\w+)?\s*/i, "").trim();
  await runRoadmapApproveFlow(ctx, target);
});

bot.command("roadmap_approve_all", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  await runRoadmapApproveAllFlow(ctx);
});

bot.command("roadmap_edit", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const rawArg = text.replace(/^\/roadmap_edit(?:@\w+)?\s*/i, "").trim();
  await runRoadmapEditFlow(ctx, rawArg);
});

bot.command("roadmap_type", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const rawArg = text.replace(/^\/roadmap_type(?:@\w+)?\s*/i, "").trim();
  await runRoadmapSetTypeFlow(ctx, rawArg);
});

bot.command("roadmap_delete", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const target = text.replace(/^\/roadmap_delete(?:@\w+)?\s*/i, "").trim();
  await runRoadmapDeleteFlow(ctx, target);
});

bot.command("roadmap_clear", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const arg = text.replace(/^\/roadmap_clear(?:@\w+)?\s*/i, "").trim();
  await runRoadmapClearFlow(ctx, arg);
});

bot.command("storage_clear", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  const text = String(ctx.message?.text || "").trim();
  const arg = text.replace(/^\/storage_clear(?:@\w+)?\s*/i, "").trim();
  await runStorageClearFlow(ctx, arg);
});

bot.command("storage_info", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  await runStorageInfoFlow(ctx);
});

bot.command("roadmap_regen", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  await runRoadmapRegenerateCurrentFlow(ctx);
});

bot.on("text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userText = String(ctx.message.text || "");

  if (isDuplicateTextMessage(ctx)) {
    return;
  }

  if (isCommandHandled(ctx)) {
    return;
  }

  if (chatId !== ownerChatId()) {
    console.log(`[bot] Warning: stranger message from chat ID ${chatId}`);
    return;
  }

  // Chặn xử lý trùng cho các command đã có bot.command riêng.
  if (
    /^\/(?:start|help|delete|rewrite|publish|edit_cancel|storage_clear|storage_info|roadmap(?:_study|_talk|_summary|_next|_regen|_save|_discard|_list|_approve_all|_approve|_edit|_type|_delete|_clear)?)(?:@\w+)?\b/i.test(
      userText,
    )
  ) {
    return;
  }

  const pendingEdit = getPendingDraftEditRequest(chatId);
  if (pendingEdit && !userText.startsWith("/")) {
    await runDraftEditFeedbackFlow(ctx, userText);
    return;
  }

  const deleteArg = extractDeleteCommandArg(userText);
  if (deleteArg !== null) {
    await runDeletePostFlow(ctx, deleteArg);
    return;
  }

  const rewriteInput = extractRewriteInput(userText);
  if (rewriteInput !== null) {
    await runRewriteFlow(ctx, rewriteInput);
    return;
  }

  if (shouldRegenerateCurrentRoadmapDraft(userText)) {
    await runRoadmapRegenerateCurrentFlow(ctx);
    return;
  }

  if (userText.startsWith("/roadmap_next")) {
    await ctx.reply("[Roadmap] Đang chạy bản nháp kế tiếp...");
    const ok = await runRoadmapNextDraftFlow("manual");
    if (!ok) {
      await ctx.reply("[Roadmap] Không tạo được bản nháp mới ở lần chạy này.");
    }
    return;
  }

  if (userText.startsWith("/roadmap_save")) {
    const arg = userText.replace(/^\/roadmap_save(?:@\w+)?\s*/i, "").trim();
    await runRoadmapSaveFlow(ctx, arg);
    return;
  }

  if (userText.startsWith("/roadmap_discard")) {
    await runRoadmapDiscardFlow(ctx);
    return;
  }

  if (userText.startsWith("/roadmap_list")) {
    const status = userText.replace(/^\/roadmap_list(?:@\w+)?\s*/i, "").trim();
    await runRoadmapListFlow(ctx, status);
    return;
  }

  if (userText.startsWith("/roadmap_approve_all")) {
    await runRoadmapApproveAllFlow(ctx);
    return;
  }

  if (userText.startsWith("/roadmap_approve")) {
    const target = userText
      .replace(/^\/roadmap_approve(?:@\w+)?\s*/i, "")
      .trim();
    await runRoadmapApproveFlow(ctx, target);
    return;
  }

  if (userText.startsWith("/roadmap_edit")) {
    const rawArg = userText.replace(/^\/roadmap_edit(?:@\w+)?\s*/i, "").trim();
    await runRoadmapEditFlow(ctx, rawArg);
    return;
  }

  if (userText.startsWith("/roadmap_type")) {
    const rawArg = userText.replace(/^\/roadmap_type(?:@\w+)?\s*/i, "").trim();
    await runRoadmapSetTypeFlow(ctx, rawArg);
    return;
  }

  if (userText.startsWith("/roadmap_delete")) {
    const target = userText
      .replace(/^\/roadmap_delete(?:@\w+)?\s*/i, "")
      .trim();
    await runRoadmapDeleteFlow(ctx, target);
    return;
  }

  if (userText.startsWith("/roadmap_clear")) {
    const arg = userText.replace(/^\/roadmap_clear(?:@\w+)?\s*/i, "").trim();
    await runRoadmapClearFlow(ctx, arg);
    return;
  }

  if (userText.startsWith("/storage_clear")) {
    const arg = userText.replace(/^\/storage_clear(?:@\w+)?\s*/i, "").trim();
    await runStorageClearFlow(ctx, arg);
    return;
  }

  if (userText.startsWith("/storage_info")) {
    await runStorageInfoFlow(ctx);
    return;
  }

  if (userText.startsWith("/roadmap_study")) {
    const topic = userText.replace(/^\/roadmap_study(?:@\w+)?\s*/i, "").trim();
    await runRoadmapCreateFlow(ctx, topic, { defaultSeriesType: "study" });
    return;
  }

  if (userText.startsWith("/roadmap_talk")) {
    const topic = userText.replace(/^\/roadmap_talk(?:@\w+)?\s*/i, "").trim();
    await runRoadmapCreateFlow(ctx, topic, { defaultSeriesType: "talk" });
    return;
  }

  if (userText.startsWith("/roadmap_summary")) {
    const topic = userText
      .replace(/^\/roadmap_summary(?:@\w+)?\s*/i, "")
      .trim();
    await runRoadmapCreateFlow(ctx, topic, { defaultSeriesType: "summary" });
    return;
  }

  if (userText.startsWith("/roadmap")) {
    const topic = userText.replace(/^\/roadmap(?:@\w+)?\s*/i, "").trim();
    await runRoadmapCreateFlow(ctx, topic);
    return;
  }

  if (/^\/news(?:@\w+)?\b/i.test(userText)) {
    const topic = userText.replace(/^\/news(?:@\w+)?\s*/i, "").trim();
    await commandService.news(ctx, topic, { chatId });
    return;
  }

  if (/^\/post(?:@\w+)?\b/i.test(userText)) {
    const topic = userText.replace(/^\/post(?:@\w+)?\s*/i, "").trim();
    await commandService.post(ctx, topic, { chatId });
    return;
  }

  if (userText.startsWith("/")) {
    await ctx.reply("Lệnh không hợp lệ. Dùng /help để xem lệnh hỗ trợ.");
    return;
  }

  await ctx.reply("Đang suy nghĩ...");
  const aiAnswer = await askAI(userText, {
    timeout: 300000,
  });
  await safeReplyLongText(ctx, aiAnswer);
});

bot.on("photo", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  if (extractPublishContent(ctx.message) === null) {
    return;
  }

  await commandService.publish(ctx, { chatId });
});

bot.on("document", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  if (extractPublishContent(ctx.message) === null) {
    return;
  }

  if (!hasPublishableImage(ctx.message)) {
    await ctx.reply("`/publish` chỉ nhận ảnh hoặc text. File đính kèm này không phải ảnh.", {
      parse_mode: "Markdown",
    });
    return;
  }

  await commandService.publish(ctx, { chatId });
});

bot.catch(async (error, ctx) => {
  console.error("[bot] Unhandled middleware error:", error);
  try {
    if (ctx?.chat?.id && String(ctx.chat.id) === ownerChatId()) {
      await ctx.reply(
        "Tiến ơi, tôi gặp lỗi ngoài dự kiến. Thử lại giúp mình nhé!",
      );
    }
  } catch (notifyError) {
    console.error("[bot] Failed to notify error to user:", notifyError.message);
  }
});

async function handleRegenImageAction(ctx, draftId = "") {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = await resolveDraftByAction(chatId, draftId);
  if (!draft) {
    await ctx.answerCbQuery("Không tìm thấy bản thảo (có thể đã hết hạn).", {
      show_alert: true,
    });
    return;
  }

  if (!ENABLE_IMAGE_GENERATION) {
    await ctx.answerCbQuery("Đang tắt tạm thời tính năng tạo ảnh.", {
      show_alert: true,
    });
    return;
  }

  await ctx.answerCbQuery("Đang tạo ảnh mới...");

  const newImageAsset = await generateImageAsset(
    draft.imageMeta || draft.topic,
    "default",
  );
  const updatedDraft = await storeDraft(
    chatId,
    {
      ...draft,
      imageAsset: newImageAsset,
      imageUrl: newImageAsset?.url || null,
    },
    { draftId: draft.draftId || draftId },
  );

  await sendDraftPreview(
    ctx,
    newImageAsset,
    updatedDraft.postText,
    updatedDraft.draftId,
  );
}

async function handleEditContentAction(ctx, draftId = "") {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = await resolveDraftByAction(chatId, draftId);
  if (!draft) {
    await ctx.answerCbQuery("Không tìm thấy bản thảo để chỉnh sửa.", {
      show_alert: true,
    });
    return;
  }

  setPendingDraftEditRequest(chatId, draft.draftId || draftId);
  await ctx.answerCbQuery("Đã bật chế độ chỉnh sửa nội dung.");
  await ctx.reply(
    "Gửi feedback chỉnh sửa cho bản thảo (ví dụ: rút ngắn hơn, đổi hook, thêm ví dụ ngắn).\n" +
      "Khi không muốn chỉnh nữa, dùng /edit_cancel.",
  );
}

async function handleConfirmPostAction(ctx, draftId = "") {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = await resolveDraftByAction(chatId, draftId);
  if (!draft) {
    await ctx.answerCbQuery("Không tìm thấy bản thảo để đăng.", {
      show_alert: true,
    });
    return;
  }

  await ctx.answerCbQuery("Đang đăng bài lên Facebook...");

  try {
    const callbackMessage = ctx.callbackQuery?.message;
    if (callbackMessage?.caption) {
      await ctx.editMessageCaption("Đang đẩy bài lên Fanpage...");
    } else if (callbackMessage?.text) {
      await ctx.editMessageText("Đang đẩy bài lên Fanpage...");
    } else {
      await ctx.reply("Đang đẩy bài lên Fanpage...");
    }

    const fbPostId = await postToFacebook(
      draft.postText,
      draft.imageAsset || draft.imageUrl || null,
    );
    rememberPublishedPost(chatId, fbPostId);

    if (draft.source === "roadmap" && draft.roadmapItemId) {
      const roadmap = await loadRoadmap();
      const postedRoadmap = updateRoadmapItem(roadmap, draft.roadmapItemId, {
        status: "posted",
        posted_at: new Date().toISOString(),
        facebook_post_id: fbPostId,
        draft_preview_ready: false,
      });
      await saveRoadmap(postedRoadmap);
    }

    await clearDraft(chatId, draft.draftId || draftId);

    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (editError) {
      console.log("[bot] Could not clear inline keyboard:", editError.message);
    }

    await ctx.reply(
      `LÊN SÓNG THÀNH CÔNG!\n\n` +
        `ID bài viết: \`${fbPostId}\`\n\n` +
        `Nếu muốn xóa bài này, gõ:\n` +
        `\`/delete ${fbPostId}\``,
      {
        parse_mode: "Markdown",
        ...buildDeletePostKeyboard(fbPostId),
      },
    );
  } catch (error) {
    await ctx.reply(`Đăng bài thất bại: ${error.message}`);
  }
}

async function handleCancelPostAction(ctx, draftId = "") {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = await resolveDraftByAction(chatId, draftId);
  if (draft?.source === "roadmap" && draft.roadmapItemId) {
    const roadmap = await loadRoadmap();
    const rollback = updateRoadmapItem(roadmap, draft.roadmapItemId, {
      status: "pending",
      draft_preview_ready: false,
      cancelled_at: new Date().toISOString(),
    });
    await saveRoadmap(rollback);
  }

  await clearDraft(chatId, draft?.draftId || draftId);
  await ctx.answerCbQuery("Đã hủy bản thảo.");

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (editError) {
    console.log("[bot] Could not clear inline keyboard:", editError.message);
  }

  await ctx.reply("Đã bỏ qua bản thảo hiện tại.");
}

async function handleDeletePublishedPostAction(ctx, postId = "") {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const normalizedPostId = String(postId || "").trim();
  if (!normalizedPostId) {
    await ctx.answerCbQuery("Thiếu ID bài viết.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery("Đang xóa bài...");
  const deleted = await runDeletePostFlow(ctx, normalizedPostId);
  if (!deleted) {
    return;
  }

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (editError) {
    console.log("[bot] Could not clear delete keyboard:", editError.message);
  }
}

bot.action(/^regen_image:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleRegenImageAction(ctx, draftId);
});

bot.action(/^edit_content:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleEditContentAction(ctx, draftId);
});

bot.action(/^confirm_post:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleConfirmPostAction(ctx, draftId);
});

bot.action(/^cancel_post:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleCancelPostAction(ctx, draftId);
});

bot.action(/^delete_published:(.+)$/, async (ctx) => {
  const postId = String(ctx.match?.[1] || "").trim();
  await handleDeletePublishedPostAction(ctx, postId);
});

// Backward-compatible handlers for old messages without draftId in callback_data.
bot.action("regen_image", async (ctx) => {
  await handleRegenImageAction(ctx, "");
});

bot.action("edit_content", async (ctx) => {
  await handleEditContentAction(ctx, "");
});

bot.action("confirm_post", async (ctx) => {
  await handleConfirmPostAction(ctx, "");
});

bot.action("cancel_post", async (ctx) => {
  await handleCancelPostAction(ctx, "");
});

initRoadmapScheduler();

bot.launch().then(() => {
  console.log("[bot] Telegram bot is online and waiting for commands...");
});

process.once("SIGINT", () => {
  releaseBotLock();
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  releaseBotLock();
  bot.stop("SIGTERM");
});
process.once("exit", () => {
  releaseBotLock();
});
