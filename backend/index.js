require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { askAI, DEEP_RESEARCH_PROMPT } = require("./src/services/ai.service");
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
    [Markup.button.callback("Duyet & Dang bai", "confirm_post")],
    [Markup.button.callback("Doi anh khac", "regen_image")],
    [Markup.button.callback("Bo qua ban thao", "cancel_post")],
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

function toCaption(postText) {
  const fullCaption = `BAN THAO CHAT LUONG CAO:\n\n${postText}`;
  if (fullCaption.length <= TELEGRAM_CAPTION_MAX) {
    return { caption: fullCaption, truncated: false };
  }

  const suffix = "\n\n... (caption da rut gon)";
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
      `BAN THAO (loi hien thi anh):\n\n${imageUrl ? `Link anh: ${imageUrl}\n\n` : ""}${postText}`,
      buildDraftKeyboard()
    );
    return;
  }

  if (truncated) {
    await safeReplyLongText(ctx, `Ban day du:\n\n${postText}`);
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
      "Chua co ID de xoa. Dung: /delete <post_id> hoac dang bai moi roi /delete."
    );
    return;
  }

  const statusMsg = await ctx.reply(`Dang yeu cau Facebook go bai: ${postId}...`);
  try {
    await deleteFacebookPost(postId);
    forgetPublishedPost(chatId, postId);
    await updateStatus(ctx, statusMsg, "Da xoa bai viet thanh cong khoi Fanpage.");
  } catch (error) {
    await updateStatus(ctx, statusMsg, `Xoa that bai: ${error.message}`);
  }
}

bot.start((ctx) => {
  ctx.reply(
    "Chao Tien! Toi da san sang research, viet bai va tao banner."
  );
});

bot.help((ctx) => {
  ctx.reply(
    "Lenh hien tai: /start, /help, /post <chu de>, /delete <post_id>."
  );
});

bot.command("delete", async (ctx) => {
  const postId = extractDeleteCommandArg(ctx.message?.text || "") || "";
  await runDeletePostFlow(ctx, postId);
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

  if (userText.startsWith("/post")) {
    const topic = userText.replace("/post", "").trim();
    if (!topic) {
      await ctx.reply("Vui long dung dung: /post <chu de>");
      return;
    }

    const statusMsg = await ctx.reply(`[1/4] Dang quet tin tuc quoc te ve: ${topic}...`);

    try {
      const research = await researchToday(topic, {
        search_depth: "advanced",
        max_results: 8,
        include_domains: ["vercel.com", "medium.com", "dev.to", "reddit.com"],
      });

      await updateStatus(
        ctx,
        statusMsg,
        `[2/4] Da quet ${research.totalResults} nguon. Dang viet bai va tạo JSON theo hiep phap content...`
      );

      const structuredRaw = await askAI(
        `Du lieu research goc:\n${research.infoText}\n\n` +
          `Chu de goc: ${topic}\n` +
          `Tu khoa tim kiem tieng Anh: ${research.query}\n\n` +
          "Hay tao output JSON dung schema yeu cau. Khong tra ve markdown, khong loi giai thich.",
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
        "[3/4] Dang parse JSON va don dep noi dung Facebook..."
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
        "[4/4] Gemini dang tao banner theo bo cuc The Little Coder..."
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
        "Hoan tat quy trinh Deep Research. Ban thao da san sang de duyet."
      );
    } catch (error) {
      console.error("[bot] Post workflow error:", error.message);
      const lower = String(error.message || "").toLowerCase();
      const friendlyMessage = lower.includes("timeout")
        ? "AI suy nghi qua lau (timeout). Tien thu ra lenh /post lai nhe!"
        : error.message;

      await updateStatus(ctx, statusMsg, "Quy trinh bi gian doan. Dang bao loi cho Tien...");
      await ctx.reply(
        `Tien oi, toi dang bi ket trong dong suy nghi.\n\nLoi: ${friendlyMessage}`
      );
    }

    return;
  }

  if (userText.startsWith("/")) {
    await ctx.reply("Lenh khong hop le. Dung /help de xem lenh ho tro.");
    return;
  }

  await ctx.reply("Dang suy nghi...");
  const aiAnswer = await askAI(userText, {
    timeout: 300000,
  });
  await safeReplyLongText(ctx, aiAnswer);
});

bot.catch(async (error, ctx) => {
  console.error("[bot] Unhandled middleware error:", error);
  try {
    if (ctx?.chat?.id && String(ctx.chat.id) === ownerChatId()) {
      await ctx.reply("Tien oi, toi gap loi ngoai du kien. Thu lai giup minh nhe!");
    }
  } catch (notifyError) {
    console.error("[bot] Failed to notify error to user:", notifyError.message);
  }
});

bot.action("regen_image", async (ctx) => {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Ban khong co quyen nay.", { show_alert: true });
    return;
  }

  const draft = draftStore.get(chatId);
  if (!draft) {
    await ctx.answerCbQuery("Khong co ban thao de tao lai anh.");
    return;
  }

  await ctx.answerCbQuery("Dang tao anh moi...");

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
    await ctx.answerCbQuery("Ban khong co quyen nay.", { show_alert: true });
    return;
  }

  const draft = draftStore.get(chatId);
  if (!draft) {
    await ctx.answerCbQuery("Khong co ban thao de dang.");
    return;
  }

  await ctx.answerCbQuery("Dang dang bai len Facebook...");

  try {
    const callbackMessage = ctx.callbackQuery?.message;
    if (callbackMessage?.caption) {
      await ctx.editMessageCaption("Dang day bai len Fanpage...");
    } else if (callbackMessage?.text) {
      await ctx.editMessageText("Dang day bai len Fanpage...");
    } else {
      await ctx.reply("Dang day bai len Fanpage...");
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
      `LEN SONG THANH CONG!\n\n` +
        `ID bai viet: \`${fbPostId}\`\n\n` +
        `Neu muon xoa bai nay, go:\n` +
        `\`/delete ${fbPostId}\``,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    await ctx.reply(`Dang bai that bai: ${error.message}`);
  }
});

bot.action("cancel_post", async (ctx) => {
  const chatId = String(ctx.chat?.id || "");

  if (chatId !== ownerChatId()) {
    await ctx.answerCbQuery("Ban khong co quyen nay.", { show_alert: true });
    return;
  }

  draftStore.delete(chatId);
  await ctx.answerCbQuery("Da huy ban thao.");

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (editError) {
    console.log("[bot] Could not clear inline keyboard:", editError.message);
  }

  await ctx.reply("Da bo qua ban thao hien tai.");
});

bot.launch().then(() => {
  console.log("[bot] Telegram bot is online and waiting for commands...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
