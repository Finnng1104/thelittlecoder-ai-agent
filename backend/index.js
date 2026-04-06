require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const {
  askAI,
  DEEP_RESEARCH_PROMPT,
  REFINE_CONTENT_PROMPT,
} = require("./src/services/ai.service");
const { researchToday } = require("./src/services/search.service");
const {
  generateImageAsset,
  downloadImageBuffer,
} = require("./src/services/image.service");
const { postToFacebook, deleteFacebookPost } = require("./src/services/facebook.service");
const { formatForFacebook } = require("./src/utils/textFormatter");

const telegramToken = process.env.TELEGRAM_TOKEN;
const draftStore = new Map();
const publishedPostStore = new Map();
const TELEGRAM_CAPTION_MAX = 1024;
const TELEGRAM_MESSAGE_SAFE_LIMIT = 3800;

if (!telegramToken) {
  throw new Error("Missing TELEGRAM_TOKEN in backend/.env");
}

const bot = new Telegraf(telegramToken, { handlerTimeout: 600000 });

function ownerChatId() {
  return String(process.env.MY_CHAT_ID || "");
}

function buildDraftKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Duyệt & Đăng bài", "confirm_post")],
    [Markup.button.callback("Đổi ảnh khác", "regen_image")],
    [Markup.button.callback("Bỏ qua bản thảo", "cancel_post")],
  ]);
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

async function sendDraftPreview(ctx, imageAsset, postText) {
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
        ...buildDraftKeyboard(),
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
        ...buildDraftKeyboard(),
      }
    );
  };

  try {
    if (hasBuffer) {
      await ctx.replyWithPhoto(
        { source: imageAsset.buffer, filename: "draft-banner.png" },
        {
          caption,
          ...buildDraftKeyboard(),
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
      buildDraftKeyboard()
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
      "[3/3] Đang tạo banner và gửi bản thảo để duyệt..."
    );

    const imageAsset = await generateImageAsset(imageMeta, "default");
    draftStore.set(chatId, {
      postText: finalPost,
      topic: imageMeta.topic,
      imageMeta,
      imageAsset,
      imageUrl: imageAsset?.url || null,
      source: "rewrite",
      rawContent: userRaw,
    });

    await sendDraftPreview(ctx, imageAsset, finalPost);
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

bot.start((ctx) => {
  ctx.reply(
    "Chào Tiến! Tôi đã sẵn sàng research, viết bài và tạo banner."
  );
});

bot.help((ctx) => {
  ctx.reply(
    "Lệnh hiện tại: /start, /help, /post <chủ đề>, /rewrite <nội dung thô>, /delete <post_id>."
  );
});

bot.command("delete", async (ctx) => {
  const postId = extractDeleteCommandArg(ctx.message?.text || "") || "";
  await runDeletePostFlow(ctx, postId);
});

bot.command("rewrite", async (ctx) => {
  const rawContent = extractRewriteInput(ctx.message?.text || "");
  await runRewriteFlow(ctx, rawContent || "");
});

bot.on("text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userText = ctx.message.text;

  if (chatId !== ownerChatId()) {
    console.log(`[bot] Warning: stranger message from chat ID ${chatId}`);
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

  if (userText.startsWith("/post")) {
    const topic = userText.replace("/post", "").trim();
    if (!topic) {
      await ctx.reply("Vui lòng dùng đúng: /post <chủ đề>");
      return;
    }

    const statusMsg = await ctx.reply(`[1/4] Đang quét tin tức quốc tế về: ${topic}...`);

    try {
      const research = await researchToday(topic, {
        search_depth: "advanced",
        max_results: 8,
        include_domains: ["vercel.com", "medium.com", "dev.to", "reddit.com"],
      });

      await updateStatus(
        ctx,
        statusMsg,
        `[2/4] Đã quét ${research.totalResults} nguồn. Đang viết bài và tạo JSON theo hiến pháp content...`
      );

      const structuredRaw = await askAI(
          `Dữ liệu research gốc:\n${research.infoText}\n\n` +
          `Chủ đề gốc: ${topic}\n` +
          `Từ khóa tìm kiếm tiếng Anh: ${research.query}\n\n` +
          "Hãy tạo output JSON đúng schema yêu cầu. Không trả về markdown, không lời giải thích.",
        {
          systemPrompt: DEEP_RESEARCH_PROMPT,
          model:
            process.env.AI_MODEL ||
            process.env.OPENROUTER_DEEP_MODEL ||
            process.env.OPENROUTER_MODEL,
          temperature: 0.35,
          timeout: 300000,
          throwOnError: true,
        }
      );

      await updateStatus(
        ctx,
        statusMsg,
        "[3/4] Đang parse JSON và dọn đẹp nội dung Facebook..."
      );

      const structured = parseStructuredAiOutput(structuredRaw, topic);
      const finalPost = formatForFacebook(structured.post_content);
      const imageMeta = {
        topic,
        image_short_title: structured.image_short_title,
        ant_action: structured.ant_action,
        log_message: structured.log_message,
      };

      await updateStatus(
        ctx,
        statusMsg,
        "[4/4] Gemini đang tạo banner theo bố cục The Little Coder..."
      );

      const imageAsset = await generateImageAsset(imageMeta, "default");
      draftStore.set(chatId, {
        postText: finalPost,
        topic,
        imageMeta,
        imageAsset,
        imageUrl: imageAsset?.url || null,
      });

      await sendDraftPreview(ctx, imageAsset, finalPost);
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

bot.action("regen_image", async (ctx) => {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = draftStore.get(chatId);
  if (!draft) {
    await ctx.answerCbQuery("Không có bản thảo để tạo lại ảnh.");
    return;
  }

  await ctx.answerCbQuery("Đang tạo ảnh mới...");

  const newImageAsset = await generateImageAsset(draft.imageMeta || draft.topic, "default");
  const updatedDraft = {
    ...draft,
    imageAsset: newImageAsset,
    imageUrl: newImageAsset?.url || null,
  };
  draftStore.set(chatId, updatedDraft);

  await sendDraftPreview(ctx, newImageAsset, updatedDraft.postText);
});

bot.action("confirm_post", async (ctx) => {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  const draft = draftStore.get(chatId);
  if (!draft) {
    await ctx.answerCbQuery("Không có bản thảo để đăng.");
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
    draftStore.delete(chatId);

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
});

bot.action("cancel_post", async (ctx) => {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Bạn không có quyền này.", { show_alert: true });
    return;
  }

  draftStore.delete(chatId);
  await ctx.answerCbQuery("Đã hủy bản thảo.");

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (editError) {
    console.log("[bot] Could not clear inline keyboard:", editError.message);
  }

  await ctx.reply("Đã bỏ qua bản thảo hiện tại.");
});

bot.launch().then(() => {
  console.log("[bot] Telegram bot is online and waiting for commands...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
