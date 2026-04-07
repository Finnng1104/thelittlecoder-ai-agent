require("dotenv").config();
const cron = require("node-cron");
const { Telegraf, Markup } = require("telegraf");
const {
  askAI,
  DEEP_RESEARCH_PROMPT,
  REFINE_CONTENT_PROMPT,
  ROADMAP_GENERATOR_PROMPT,
  SERIES_POST_PROMPT,
} = require("./src/services/ai.service");
const { researchToday } = require("./src/services/search.service");
const {
  generateImageAsset,
  downloadImageBuffer,
} = require("./src/services/image.service");
const { postToFacebook, deleteFacebookPost } = require("./src/services/facebook.service");
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
  upsertDraftRecord,
  getDraftRecordById,
  deleteDraftRecordById,
} = require("./src/services/draft.service");

const telegramToken = process.env.TELEGRAM_TOKEN;
const draftStore = new Map();
const publishedPostStore = new Map();
const roadmapProposalStore = new Map();
const handledCommandMessages = new Set();
const TELEGRAM_CAPTION_MAX = 1024;
const TELEGRAM_MESSAGE_SAFE_LIMIT = 3800;
let isRoadmapJobRunning = false;
const ENABLE_IMAGE_GENERATION = parseBoolean(
  process.env.ENABLE_IMAGE_GENERATION,
  false
);

if (!telegramToken) {
  throw new Error("Missing TELEGRAM_TOKEN in backend/.env");
}

const bot = new Telegraf(telegramToken, { handlerTimeout: 600000 });

function ownerChatId() {
  return String(process.env.MY_CHAT_ID || "");
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

function buildDraftKeyboard() {
  return buildDraftKeyboardWithId("");
}

function buildDraftKeyboardWithId(draftId) {
  const id = String(draftId || "").trim();
  if (!id) {
    const rows = [[Markup.button.callback("Duyệt & Đăng bài", "confirm_post")]];
    if (ENABLE_IMAGE_GENERATION) {
      rows.push([Markup.button.callback("Đổi ảnh khác", "regen_image")]);
    }
    rows.push([Markup.button.callback("Bỏ qua bản thảo", "cancel_post")]);
    return Markup.inlineKeyboard(rows);
  }

  const rows = [[Markup.button.callback("Duyệt & Đăng bài", `confirm_post:${id}`)]];
  if (ENABLE_IMAGE_GENERATION) {
    rows.push([Markup.button.callback("Đổi ảnh khác", `regen_image:${id}`)]);
  }
  rows.push([Markup.button.callback("Bỏ qua bản thảo", `cancel_post:${id}`)]);
  return Markup.inlineKeyboard(rows);
}

function createDraftId(prefix = "draft") {
  const safePrefix = String(prefix || "draft")
    .replace(/[^\w-]/g, "")
    .slice(0, 12) || "draft";
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${ts}_${rnd}`;
}

function storeDraft(chatId, payload, options = {}) {
  const id = String(options.draftId || payload?.draftId || createDraftId(payload?.source || "draft"));
  const record = {
    ...payload,
    draftId: id,
    chatId: String(chatId),
    createdAt: payload?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  draftStore.set(String(chatId), record);
  upsertDraftRecord(record);
  return record;
}

function resolveDraftByAction(chatId, draftId) {
  const normalizedChatId = String(chatId || "");
  const id = String(draftId || "").trim();
  const current = draftStore.get(normalizedChatId);

  if (!id) {
    return current || null;
  }

  if (current?.draftId === id) {
    return current;
  }

  const persisted = getDraftRecordById(id);
  if (!persisted) {
    return null;
  }

  if (String(persisted.chatId || "") !== normalizedChatId) {
    return null;
  }

  draftStore.set(normalizedChatId, persisted);
  return persisted;
}

function clearDraft(chatId, draftId = "") {
  const normalizedChatId = String(chatId || "");
  const id = String(draftId || "").trim();
  if (id) {
    deleteDraftRecordById(id);
  }

  const current = draftStore.get(normalizedChatId);
  if (!current) {
    return;
  }

  if (!id || current.draftId === id) {
    draftStore.delete(normalizedChatId);
  }
}

function rememberPublishedPost(chatId, postId) {
  const id = String(postId || "").trim();
  if (!id) {
    return;
  }

  const current = publishedPostStore.get(chatId) || { ids: [] };
  const ids = [id, ...(current.ids || []).filter((item) => item !== id)].slice(0, 20);
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

  const commandMatch = normalizedText.match(/^\/rewrite(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (commandMatch) {
    return String(commandMatch[1] || "").trim();
  }

  const prefixMatch = normalizedText.match(/^(?:viet lai|viết lại|content)\s*:\s*([\s\S]+)$/i);
  if (prefixMatch) {
    return String(prefixMatch[1] || "").trim();
  }

  return null;
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
  const trimmed = fullCaption.slice(0, TELEGRAM_CAPTION_MAX - suffix.length) + suffix;
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

function buildSeriesImageShortTitle(day, topic, aiShortTitle = "") {
  const normalizedDay = Number.isFinite(Number(day)) ? Math.max(1, Math.floor(Number(day))) : 1;
  const raw = String(aiShortTitle || "")
    .replace(/^DAY\s*\d+\s*[:\-]?\s*/i, "")
    .trim();
  const base = raw || buildFallbackShortTitle(topic);
  const compact = String(base)
    .toUpperCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  return `DAY ${normalizedDay} ${compact || "SERIES"}`.trim();
}

function ensureSeriesHeading(postText, day, topic) {
  const normalizedDay = Number.isFinite(Number(day)) ? Math.max(1, Math.floor(Number(day))) : 1;
  const heading = `📘 DAY ${normalizedDay}: ${String(topic || "").trim()}`;
  const normalizedText = String(postText || "").trim();
  if (!normalizedText) {
    return heading;
  }

  const firstLine = normalizedText.split("\n").find((line) => String(line || "").trim()) || "";
  if (/^\s*📘\s*DAY\s+\d+\s*:/i.test(firstLine) || /\bDAY\s+\d+\b/i.test(firstLine)) {
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
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const fenced = String(fenceMatch?.[1] || "").trim();
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {
      // Fall through.
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // Try bracket slice below.
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
    .map((item) => `${item.day}. ${item.topic}`)
    .join("\n");
}

function formatRoadmapList(items, options = {}) {
  const rows = Array.isArray(items) ? items : [];
  const statusFilter = String(options.status || "").trim().toLowerCase();
  const filtered = statusFilter
    ? rows.filter((item) => String(item?.status || "").toLowerCase() === statusFilter)
    : rows;

  if (filtered.length === 0) {
    return "Roadmap trống hoặc không có bài khớp bộ lọc.";
  }

  const lines = filtered
    .sort((a, b) => Number(a.day || 0) - Number(b.day || 0))
    .map(
      (item) =>
        `Day ${item.day} | ${String(item.status || "unknown").toUpperCase()}\n` +
        `id: ${item.id}\n` +
        `topic: ${item.topic}\n` +
        `${item.image_hint ? `image_hint: ${item.image_hint}` : ""}`
    );

  return lines.join("\n\n");
}

function parseBoolean(value, defaultValue = false) {
  const raw = String(value ?? "").trim().toLowerCase();
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

function recoverInterruptedProcessingItems(
  items,
  staleMinutes = parsePositiveInt(process.env.ROADMAP_PROCESSING_STALE_MINUTES, 20)
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
      item?.processing_started_at || item?.updated_at || item?.created_at || ""
    ).trim();
    const startedAtMs = Date.parse(startedAtRaw);
    const isStale = !Number.isFinite(startedAtMs) || now - startedAtMs >= staleMs;
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
  const hasBuffer = imageAsset?.type === "buffer" && Buffer.isBuffer(imageAsset.buffer);

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
      console.log("[bot] URL image failed, try upload buffer:", imgUrlError.message);
    }

    const { buffer: imageBuffer, mimeType } = await downloadImageBuffer(url, true);
    if (!isTelegramPhotoMime(mimeType)) {
      throw new Error(`Unsupported image mime for Telegram photo: ${mimeType}`);
    }
    await ctx.replyWithPhoto(
      { source: imageBuffer, filename: "draft-banner.png" },
      {
        caption,
        ...keyboard,
      }
    );
  };

  try {
    if (hasBuffer) {
      await ctx.replyWithPhoto(
        { source: imageAsset.buffer, filename: "draft-banner.png" },
        {
          caption,
          ...keyboard,
        }
      );
    } else if (imageUrl) {
      await sendFromUrlWithFallback(imageUrl);
    } else {
      throw new Error("No image data from generator");
    }
  } catch (imageError) {
    console.log("[bot] Preview image failed, fallback text:", imageError.message);
    await safeReplyLongText(
      ctx,
      `BẢN THẢO (lỗi hiển thị ảnh):\n\n${imageUrl ? `Link ảnh: ${imageUrl}\n\n` : ""}${postText}`,
      keyboard
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
      text
    );
  } catch (error) {
    console.log("[bot] Could not edit status message:", error.message);
    await ctx.reply(text);
  }
}

async function runDeletePostFlow(ctx, inputPostId = "") {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const explicitId = String(inputPostId || "").trim();
  const postId = explicitId || getLastPublishedPostId(chatId);

  if (!postId) {
    await ctx.reply(
      "Chưa có ID để xóa. Dùng: /delete <post_id> hoặc đăng bài mới rồi /delete."
    );
    return;
  }

  const statusMsg = await ctx.reply(`Đang yêu cầu Facebook gỡ bài: ${postId}...`);
  try {
    await deleteFacebookPost(postId);
    forgetPublishedPost(chatId, postId);
    await updateStatus(ctx, statusMsg, "Đã xóa bài viết thành công khỏi Fanpage.");
  } catch (error) {
    await updateStatus(ctx, statusMsg, `Xóa thất bại: ${error.message}`);
  }
}

async function buildDraftFromTopic(topic, options = {}) {
  const onStep = typeof options.onStep === "function" ? options.onStep : async () => {};
  const seriesInfo = options.seriesInfo && typeof options.seriesInfo === "object" ? options.seriesInfo : null;
  const isSeries = Number.isFinite(Number(seriesInfo?.day));
  const seriesDay = isSeries ? Math.max(1, Math.floor(Number(seriesInfo.day))) : null;
  const seriesTotal = Number.isFinite(Number(seriesInfo?.total))
    ? Math.max(1, Math.floor(Number(seriesInfo.total)))
    : null;

  await onStep(1, `[1/4] Đang quét tin tức quốc tế về: ${topic}...`);
  const research = await researchToday(topic, {
    search_depth: "advanced",
    max_results: isSeries ? 5 : 8,
    include_domains: ["vercel.com", "medium.com", "dev.to", "reddit.com"],
  });

  await onStep(
    2,
    `[2/4] Đã quét ${research.totalResults} nguồn. Đang viết bài và tạo JSON theo hiến pháp content...`
  );

  const structuredRaw = await askAI(
    (isSeries
      ? `Đây là bài thuộc series roadmap.\n` +
        `Day hiện tại: ${seriesDay}\n` +
        `${seriesTotal ? `Tổng số day trong series: ${seriesTotal}\n` : ""}` +
        `Chủ đề Day ${seriesDay}: ${topic}\n` +
        `Dữ liệu research:\n${research.infoText}\n\n` +
        `Từ khóa tìm kiếm tiếng Anh: ${research.query}\n\n` +
        "Hãy viết ngắn gọn, dễ hiểu, đúng format series và trả về JSON schema."
      : `Dữ liệu research gốc:\n${research.infoText}\n\n` +
        `Chủ đề gốc: ${topic}\n` +
        `Từ khóa tìm kiếm tiếng Anh: ${research.query}\n\n` +
        "Hãy tạo output JSON đúng schema yêu cầu. Không trả về markdown, không lời giải thích."),
    {
      systemPrompt: isSeries ? SERIES_POST_PROMPT : DEEP_RESEARCH_PROMPT,
      model:
        process.env.AI_MODEL ||
        process.env.OPENROUTER_DEEP_MODEL ||
        process.env.OPENROUTER_MODEL,
      temperature: isSeries ? 0.25 : 0.35,
      timeout: 300000,
      throwOnError: true,
    }
  );

  await onStep(3, "[3/4] Đang parse JSON và dọn đẹp nội dung Facebook...");
  const structured = parseStructuredAiOutput(structuredRaw, topic);
  let finalPost = formatForFacebook(structured.post_content);
  if (isSeries) {
    finalPost = ensureSeriesHeading(finalPost, seriesDay, topic);
  }
  const imageMeta = {
    topic,
    image_short_title: isSeries
      ? buildSeriesImageShortTitle(seriesDay, topic, structured.image_short_title)
      : structured.image_short_title,
    ant_action: structured.ant_action,
    log_message: structured.log_message,
  };

  let imageAsset = null;
  if (ENABLE_IMAGE_GENERATION) {
    await onStep(4, "[4/4] Gemini đang tạo banner theo bố cục The Little Coder...");
    imageAsset = await generateImageAsset(imageMeta, "default");
  } else {
    await onStep(4, "[4/4] Đang tắt tạm thời tính năng tạo ảnh, gửi bản nháp text để duyệt...");
  }

  return {
    topic,
    postText: finalPost,
    imageMeta,
    imageAsset,
    imageUrl: imageAsset?.url || null,
    research,
  };
}

async function runRewriteFlow(ctx, rawContent) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const userRaw = String(rawContent || "").trim();
  if (!userRaw) {
    await ctx.reply(
      "Bạn hãy gửi: /rewrite <nội dung thô>\nHoặc: Viết lại: <nội dung thô>"
    );
    return;
  }

  const statusMsg = await ctx.reply("[1/3] Đang refactor nội dung theo phong cách The Little Coder...");

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
        temperature: 0.4,
        timeout: 300000,
        throwOnError: true,
      }
    );

    await updateStatus(
      ctx,
      statusMsg,
      "[2/3] Đang parse JSON và dọn đẹp nội dung để tạo bản thảo..."
    );

    const structured = parseStructuredAiOutput(structuredRaw, buildTopicFromRawContent(userRaw));
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
        : "[3/3] Đang gửi bản thảo text để duyệt (tạm tắt tạo ảnh)..."
    );

    const imageAsset = ENABLE_IMAGE_GENERATION
      ? await generateImageAsset(imageMeta, "default")
      : null;
    const draft = storeDraft(chatId, {
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
      "Đã refactor xong. Bản thảo sẵn sàng, bấm Duyệt & Đăng bài nếu ok."
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
    replyWithPhoto: (photo, extra) => bot.telegram.sendPhoto(chatId, photo, extra),
  };
}

async function runRoadmapCreateFlow(ctx, sourceTopic) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const topic = String(sourceTopic || "").trim();
  if (!topic) {
    await ctx.reply("Dùng: /roadmap <chủ đề lớn>. Ví dụ: /roadmap ReactJS từ A-Z");
    return;
  }

  const statusMsg = await ctx.reply(`[Roadmap] Đang tạo lộ trình cho: ${topic}...`);
  try {
    const rawPlan = await askAI(
      `Chủ đề tổng: ${topic}\n\n` +
        "Hãy tạo roadmap với số lượng bài PHÙ HỢP độ rộng chủ đề (không cố định), " +
        "trả về đúng JSON Array theo schema yêu cầu.",
      {
        systemPrompt: ROADMAP_GENERATOR_PROMPT,
        model:
          process.env.AI_MODEL ||
          process.env.OPENROUTER_DEEP_MODEL ||
          process.env.OPENROUTER_MODEL,
        temperature: 0.2,
        timeout: 180000,
        throwOnError: true,
      }
    );

    const roadmapItems = parseRoadmapOutput(rawPlan, topic);
    roadmapProposalStore.set(chatId, {
      topic,
      items: roadmapItems,
      createdAt: new Date().toISOString(),
    });
    const stats = getRoadmapStats(roadmapItems);

    await updateStatus(
      ctx,
      statusMsg,
      `[Roadmap] Đã tạo xong ${stats.total} bài (CHƯA LƯU).`
    );
    await safeReplyLongText(
      ctx,
      `Danh sách đề xuất (${stats.total} bài):\n${formatRoadmapSummary(roadmapItems)}`
    );
    await ctx.reply(
      `Đề xuất này đang chờ bạn duyệt.\n` +
        `- Lưu đề xuất: /roadmap_save\n` +
        `- Bỏ đề xuất: /roadmap_discard\n` +
        `- Duyệt tất cả để chạy lịch: /roadmap_approve_all\n` +
        `- Duyệt từng bài: /roadmap_approve <day|id>`
    );
  } catch (error) {
    console.error("[bot] Roadmap create error:", error.message);
    await updateStatus(ctx, statusMsg, `[Roadmap] Tạo roadmap thất bại: ${error.message}`);
  }
}

async function runRoadmapSaveFlow(ctx) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const proposal = roadmapProposalStore.get(chatId);
  if (!proposal?.items?.length) {
    await ctx.reply("Chưa có đề xuất roadmap để lưu. Dùng /roadmap <chủ đề lớn> trước.");
    return;
  }

  saveRoadmap(proposal.items);
  roadmapProposalStore.delete(chatId);
  await ctx.reply(
    `[Roadmap] Đã lưu ${proposal.items.length} bài vào ${resolveRoadmapPath()}.\n` +
      `Mặc định đang ở trạng thái DRAFT, bạn duyệt bằng /roadmap_approve hoặc /roadmap_approve_all.`
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

  const roadmap = loadRoadmap();
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

  const roadmap = loadRoadmap();
  const found = findRoadmapItemByTarget(roadmap, key);
  if (!found) {
    await ctx.reply(`Không tìm thấy bài với key: ${key}`);
    return;
  }

  const updated = updateRoadmapItemByTarget(roadmap, key, {
    status: "pending",
    approved_at: new Date().toISOString(),
  });
  saveRoadmap(updated);
  await ctx.reply(`Đã duyệt Day ${found.day} (${found.topic}) -> PENDING.`);
}

async function runRoadmapApproveAllFlow(ctx) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const roadmap = loadRoadmap();
  if (roadmap.length === 0) {
    await ctx.reply(
      "Roadmap hiện đang rỗng (0 bài). Dùng /roadmap <chủ đề lớn> rồi /roadmap_save trước."
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
  saveRoadmap(updated);
  const stats = getRoadmapStats(updated);
  await ctx.reply(
    `Đã duyệt ${changedCount} bài từ DRAFT/FAILED/PROCESSING -> PENDING.\n` +
      `Tổng bài: ${stats.total}\n` +
      `Hiện tại: pending=${stats.pending}, drafted=${stats.drafted}, posted=${stats.posted}.`
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

  const roadmap = loadRoadmap();
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
  saveRoadmap(updated);
  await ctx.reply(`Đã sửa Day ${found.day}.\nTopic mới: ${newTopic}\nTrạng thái: DRAFT`);
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

  const roadmap = loadRoadmap();
  const found = findRoadmapItemByTarget(roadmap, key);
  if (!found) {
    await ctx.reply(`Không tìm thấy bài với key: ${key}`);
    return;
  }

  const updated = removeRoadmapItemByTarget(roadmap, key);
  saveRoadmap(updated);

  // Xóa luôn draft đã gửi qua Telegram nếu có.
  deleteDraftRecordById(`rm_${found.id}`);
  const currentDraft = draftStore.get(chatId);
  if (currentDraft?.roadmapItemId === found.id) {
    clearDraft(chatId, currentDraft.draftId);
  }

  await ctx.reply(`Đã xóa Day ${found.day} khỏi roadmap.`);
}

async function runRoadmapClearFlow(ctx, rawArg) {
  const chatId = String(ctx.chat.id);
  if (chatId !== ownerChatId()) {
    return;
  }

  const confirm = String(rawArg || "").trim().toLowerCase();
  if (confirm !== "confirm") {
    await ctx.reply(
      "Để xóa toàn bộ roadmap, dùng: /roadmap_clear confirm"
    );
    return;
  }

  saveRoadmap([]);
  const currentDraft = draftStore.get(chatId);
  if (currentDraft?.source === "roadmap") {
    clearDraft(chatId, currentDraft.draftId);
  }
  await ctx.reply("Đã xóa toàn bộ roadmap.");
}

async function runRoadmapNextDraftFlow(trigger = "manual") {
  if (isRoadmapJobRunning) {
    return false;
  }

  const adminChatId = ownerChatId();
  if (!adminChatId) {
    console.warn("[roadmap] MY_CHAT_ID is missing. Skip auto draft.");
    return false;
  }

  isRoadmapJobRunning = true;
  let statusMessage = null;
  let processingItemId = "";
  let processingDay = "";
  try {
    let roadmap = loadRoadmap();
    const recovered = recoverInterruptedProcessingItems(roadmap);
    if (recovered.recoveredCount > 0) {
      roadmap = recovered.items;
      saveRoadmap(roadmap);
      try {
        await bot.telegram.sendMessage(
          adminChatId,
          `[Roadmap] Khôi phục ${recovered.recoveredCount} bài PROCESSING bị stale ` +
            `(>${recovered.staleMinutes} phút) -> PENDING.`
        );
      } catch (_notifyRecoveredError) {
        // no-op
      }
    }

    const requireReviewBeforeNext = parseBoolean(
      process.env.ROADMAP_REQUIRE_REVIEW_BEFORE_NEXT,
      true
    );
    if (requireReviewBeforeNext) {
      const waitingDraft = findNextRoadmapItem(roadmap, ["drafted"]);
      if (waitingDraft) {
        if (trigger !== "cron") {
          await bot.telegram.sendMessage(
            adminChatId,
            `[Roadmap] Day ${waitingDraft.day} đang ở trạng thái DRAFTED, ` +
              `hãy duyệt/hủy trước khi tạo bản nháp tiếp theo.`
          );
        }
        return false;
      }
    }

    const next = findNextRoadmapItem(roadmap, ["pending"]);
    if (!next) {
      if (trigger !== "cron") {
        await bot.telegram.sendMessage(adminChatId, "[Roadmap] Không còn bài pending.");
      }
      return false;
    }

    const processingRoadmap = updateRoadmapItem(roadmap, next.id, {
      status: "processing",
      processing_started_at: new Date().toISOString(),
      last_error: "",
    });
    saveRoadmap(processingRoadmap);
    processingItemId = String(next.id || "");
    processingDay = String(next.day || "");

    const triggerLabel = trigger === "cron" ? "tự động" : "thủ công";
    statusMessage = await bot.telegram.sendMessage(
      adminChatId,
      `[Roadmap/${triggerLabel}] Đang xử lý Day ${next.day}: ${next.topic}`
    );

    const onStep = async (_index, text) => {
      try {
        await bot.telegram.editMessageText(
          adminChatId,
          statusMessage.message_id,
          undefined,
          `[Roadmap] Day ${next.day}: ${text}`
        );
      } catch (_error) {
        await bot.telegram.sendMessage(adminChatId, `[Roadmap] ${text}`);
      }
    };

    const draft = await buildDraftFromTopic(next.topic, {
      onStep,
      seriesInfo: {
        day: next.day,
        total: roadmap.length,
      },
    });
    const draftWithRoadmap = {
      ...draft,
      source: "roadmap",
      roadmapItemId: next.id,
      roadmapDay: next.day,
    };
    const savedDraft = storeDraft(adminChatId, draftWithRoadmap, {
      draftId: `rm_${next.id}`,
    });

    const draftedRoadmap = updateRoadmapItem(loadRoadmap(), next.id, {
      status: "drafted",
      drafted_at: new Date().toISOString(),
      draft_preview_ready: true,
    });
    saveRoadmap(draftedRoadmap);

    const pseudoCtx = createTelegramCtxProxy(adminChatId);
    await sendDraftPreview(
      pseudoCtx,
      savedDraft.imageAsset,
      savedDraft.postText,
      savedDraft.draftId
    );
    await bot.telegram.sendMessage(
      adminChatId,
      `[Roadmap] Day ${next.day} đã có bản thảo. Bấm "Duyệt & Đăng bài" để lên sóng.`
    );
    return true;
  } catch (error) {
    console.error("[roadmap] Auto draft error:", error.message);
    try {
      const roadmap = loadRoadmap();
      if (processingItemId) {
        const rollback = updateRoadmapItem(roadmap, processingItemId, {
          status: "pending",
          last_error: error.message,
        });
        saveRoadmap(rollback);
      }
    } catch (syncError) {
      console.error("[roadmap] rollback error:", syncError.message);
    }

    try {
      if (adminChatId) {
        await bot.telegram.sendMessage(
          adminChatId,
          `[Roadmap] Tạo bản nháp thất bại` +
            `${processingDay ? ` (Day ${processingDay})` : ""}: ${error.message}`
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

  const testIntervalMinutes = parsePositiveInt(process.env.ROADMAP_TEST_INTERVAL_MINUTES, 0);
  const useTestInterval = testIntervalMinutes >= 1 && testIntervalMinutes <= 59;
  const cronExpr = useTestInterval
    ? `*/${testIntervalMinutes} * * * *`
    : String(process.env.ROADMAP_CRON || "0 8 * * *").trim();
  const timezone = String(process.env.ROADMAP_TIMEZONE || "Asia/Ho_Chi_Minh").trim();

  cron.schedule(
    cronExpr,
    async () => {
      await runRoadmapNextDraftFlow("cron");
    },
    { timezone }
  );

  console.log(
    `[roadmap] Scheduler enabled: "${cronExpr}" (${timezone})` +
      (useTestInterval ? ` [test interval=${testIntervalMinutes}m]` : "")
  );
}

bot.start((ctx) => {
  ctx.reply(
    "Chào Tiến! Tôi đã sẵn sàng research, viết bài và tạo banner."
  );
});

bot.help((ctx) => {
  ctx.reply(
    "Lệnh hiện tại:\n" +
      "/start, /help\n" +
      "/post <chủ đề>\n" +
      "/rewrite <nội dung thô>\n" +
      "/roadmap <chủ đề lớn>\n" +
      "/roadmap_save\n" +
      "/roadmap_discard\n" +
      "/roadmap_list [status]\n" +
      "/roadmap_approve <day|id>\n" +
      "/roadmap_approve_all\n" +
      "/roadmap_edit <day|id> | <topic mới>\n" +
      "/roadmap_delete <day|id>\n" +
      "/roadmap_clear confirm\n" +
      "/roadmap_next\n" +
      "/delete <post_id>"
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

bot.command("roadmap", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }

  const text = String(ctx.message?.text || "").trim();
  const topic = text.replace(/^\/roadmap(?:@\w+)?\s*/i, "").trim();
  await runRoadmapCreateFlow(ctx, topic);
});

bot.command("roadmap_save", async (ctx) => {
  markCommandHandled(ctx);
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }
  await runRoadmapSaveFlow(ctx);
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

bot.on("text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userText = String(ctx.message.text || "");

  if (isCommandHandled(ctx)) {
    return;
  }

  if (chatId !== ownerChatId()) {
    console.log(`[bot] Warning: stranger message from chat ID ${chatId}`);
    return;
  }

  // Chặn xử lý trùng cho các command đã có bot.command riêng.
  if (/^\/(?:start|help|delete|rewrite|roadmap(?:_next|_save|_discard|_list|_approve_all|_approve|_edit|_delete|_clear)?)(?:@\w+)?\b/i.test(userText)) {
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

  if (userText.startsWith("/roadmap_next")) {
    await ctx.reply("[Roadmap] Đang chạy bản nháp kế tiếp...");
    const ok = await runRoadmapNextDraftFlow("manual");
    if (!ok) {
      await ctx.reply("[Roadmap] Không tạo được bản nháp mới ở lần chạy này.");
    }
    return;
  }

  if (userText.startsWith("/roadmap_save")) {
    await runRoadmapSaveFlow(ctx);
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
    const target = userText.replace(/^\/roadmap_approve(?:@\w+)?\s*/i, "").trim();
    await runRoadmapApproveFlow(ctx, target);
    return;
  }

  if (userText.startsWith("/roadmap_edit")) {
    const rawArg = userText.replace(/^\/roadmap_edit(?:@\w+)?\s*/i, "").trim();
    await runRoadmapEditFlow(ctx, rawArg);
    return;
  }

  if (userText.startsWith("/roadmap_delete")) {
    const target = userText.replace(/^\/roadmap_delete(?:@\w+)?\s*/i, "").trim();
    await runRoadmapDeleteFlow(ctx, target);
    return;
  }

  if (userText.startsWith("/roadmap_clear")) {
    const arg = userText.replace(/^\/roadmap_clear(?:@\w+)?\s*/i, "").trim();
    await runRoadmapClearFlow(ctx, arg);
    return;
  }

  if (userText.startsWith("/roadmap")) {
    const topic = userText.replace(/^\/roadmap(?:@\w+)?\s*/i, "").trim();
    await runRoadmapCreateFlow(ctx, topic);
    return;
  }

  if (userText.startsWith("/post")) {
    const topic = userText.replace("/post", "").trim();
    if (!topic) {
      await ctx.reply("Vui lòng dùng đúng: /post <chủ đề>");
      return;
    }

    const statusMsg = await ctx.reply(`[1/4] Đang quét tin tức quốc tế về: ${topic}...`);

    try {
      const draft = await buildDraftFromTopic(topic, {
        onStep: async (_step, text) => {
          await updateStatus(ctx, statusMsg, text);
        },
      });
      const savedDraft = storeDraft(chatId, {
        ...draft,
        source: "manual_post",
      });

      await sendDraftPreview(ctx, savedDraft.imageAsset, savedDraft.postText, savedDraft.draftId);
      await updateStatus(
        ctx,
        statusMsg,
        "Hoàn tất quy trình Deep Research. Bản thảo đã sẵn sàng để duyệt."
      );
    } catch (error) {
      console.error("[bot] Post workflow error:", error.message);
      const lower = String(error.message || "").toLowerCase();
      const friendlyMessage = lower.includes("timeout")
        ? "AI suy nghĩ quá lâu (timeout). Tiến thử ra lệnh /post lại nhé!"
        : error.message;

      await updateStatus(ctx, statusMsg, "Quy trình bị gián đoạn. Đang báo lỗi cho Tiến...");
      await ctx.reply(
        `Tiến ơi, tôi đang bị kẹt trong dòng suy nghĩ.\n\nLỗi: ${friendlyMessage}`
      );
    }

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

bot.catch(async (error, ctx) => {
  console.error("[bot] Unhandled middleware error:", error);
  try {
    if (ctx?.chat?.id && String(ctx.chat.id) === ownerChatId()) {
      await ctx.reply("Tiến ơi, tôi gặp lỗi ngoài dự kiến. Thử lại giúp mình nhé!");
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

  const draft = resolveDraftByAction(chatId, draftId);
  if (!draft) {
    await ctx.answerCbQuery("Không tìm thấy bản thảo (có thể đã hết hạn).", {
      show_alert: true,
    });
    return;
  }

  if (!ENABLE_IMAGE_GENERATION) {
    await ctx.answerCbQuery("Đang tắt tạm thời tính năng tạo ảnh.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery("Đang tạo ảnh mới...");

  const newImageAsset = await generateImageAsset(draft.imageMeta || draft.topic, "default");
  const updatedDraft = storeDraft(
    chatId,
    {
    ...draft,
    imageAsset: newImageAsset,
    imageUrl: newImageAsset?.url || null,
    },
    { draftId: draft.draftId || draftId }
  );

  await sendDraftPreview(ctx, newImageAsset, updatedDraft.postText, updatedDraft.draftId);
}

async function handleConfirmPostAction(ctx, draftId = "") {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = resolveDraftByAction(chatId, draftId);
  if (!draft) {
    await ctx.answerCbQuery("Không tìm thấy bản thảo để đăng.", { show_alert: true });
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
      draft.imageAsset || draft.imageUrl || null
    );
    rememberPublishedPost(chatId, fbPostId);

    if (draft.source === "roadmap" && draft.roadmapItemId) {
      const roadmap = loadRoadmap();
      const postedRoadmap = updateRoadmapItem(roadmap, draft.roadmapItemId, {
        status: "posted",
        posted_at: new Date().toISOString(),
        facebook_post_id: fbPostId,
        draft_preview_ready: false,
      });
      saveRoadmap(postedRoadmap);
    }

    clearDraft(chatId, draft.draftId || draftId);

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
      { parse_mode: "Markdown" }
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

  const draft = resolveDraftByAction(chatId, draftId);
  if (draft?.source === "roadmap" && draft.roadmapItemId) {
    const roadmap = loadRoadmap();
    const rollback = updateRoadmapItem(roadmap, draft.roadmapItemId, {
      status: "pending",
      draft_preview_ready: false,
      cancelled_at: new Date().toISOString(),
    });
    saveRoadmap(rollback);
  }

  clearDraft(chatId, draft?.draftId || draftId);
  await ctx.answerCbQuery("Đã hủy bản thảo.");

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (editError) {
    console.log("[bot] Could not clear inline keyboard:", editError.message);
  }

  await ctx.reply("Đã bỏ qua bản thảo hiện tại.");
}

bot.action(/^regen_image:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleRegenImageAction(ctx, draftId);
});

bot.action(/^confirm_post:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleConfirmPostAction(ctx, draftId);
});

bot.action(/^cancel_post:(.+)$/, async (ctx) => {
  const draftId = String(ctx.match?.[1] || "").trim();
  await handleCancelPostAction(ctx, draftId);
});

// Backward-compatible handlers for old messages without draftId in callback_data.
bot.action("regen_image", async (ctx) => {
  await handleRegenImageAction(ctx, "");
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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
