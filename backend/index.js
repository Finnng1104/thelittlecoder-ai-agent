require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { askAI, DEEP_RESEARCH_PROMPT } = require("./src/services/ai.service");
const { researchToday } = require("./src/services/search.service");
const {
  generateImageUrl,
  downloadImageBuffer,
} = require("./src/services/image.service");
const { postToFacebook, deleteFacebookPost } = require("./src/services/facebook.service");

const telegramToken = process.env.TELEGRAM_TOKEN;
const draftStore = new Map();
const TELEGRAM_CAPTION_MAX = 1024;

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

function toCaption(postText) {
  const fullCaption = `BAN THAO CHAT LUONG CAO:\n\n${postText}`;
  if (fullCaption.length <= TELEGRAM_CAPTION_MAX) {
    return { caption: fullCaption, truncated: false };
  }

  const suffix = "\n\n... (caption da rut gon)";
  const trimmed = fullCaption.slice(0, TELEGRAM_CAPTION_MAX - suffix.length) + suffix;
  return { caption: trimmed, truncated: true };
}

async function sendDraftPreview(ctx, imageUrl, postText) {
  const { caption, truncated } = toCaption(postText);

  try {
    await ctx.replyWithPhoto(imageUrl, {
      caption,
      ...buildDraftKeyboard(),
    });
  } catch (imgUrlError) {
    console.log("[bot] URL image failed, try upload buffer:", imgUrlError.message);

    try {
      const imageBuffer = await downloadImageBuffer(imageUrl);
      await ctx.replyWithPhoto(
        { source: imageBuffer, filename: "draft-banner.png" },
        {
          caption,
          ...buildDraftKeyboard(),
        }
      );
    } catch (uploadError) {
      console.log("[bot] Buffer upload failed, fallback text:", uploadError.message);
      await ctx.reply(
        `BAN THAO (loi hien thi anh):\n\nLink anh: ${imageUrl}\n\n${postText}`,
        buildDraftKeyboard()
      );
      return;
    }
  }

  if (truncated) {
    await ctx.reply(`Ban day du:\n\n${postText}`);
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
  if (String(ctx.chat.id) !== ownerChatId()) {
    return;
  }

  const text = ctx.message?.text || "";
  const postId = text.replace(/^\/delete(@\w+)?\s*/i, "").trim();

  if (!postId) {
    await ctx.reply("Tien chua nhap ID bai viet. Vi du: /delete 123456789");
    return;
  }

  const statusMsg = await ctx.reply(`Dang yeu cau Facebook go bai: ${postId}...`);

  try {
    await deleteFacebookPost(postId);
    await updateStatus(ctx, statusMsg, "Da xoa bai viet thanh cong khoi Fanpage.");
  } catch (error) {
    await updateStatus(ctx, statusMsg, `Xoa that bai: ${error.message}`);
  }
});

bot.on("text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userText = ctx.message.text;

  if (chatId !== ownerChatId()) {
    console.log(`[bot] Warning: stranger message from chat ID ${chatId}`);
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
        `[2/4] Da quet ${research.totalResults} nguon. Dang phan tich va viet ban nhap theo style cua Tien...`
      );

      const draft1 = await askAI(
        `Du lieu research goc:\n${research.infoText}\n\n` +
          `Chu de goc: ${topic}\n` +
          `Tu khoa tim kiem tieng Anh: ${research.query}\n\n` +
          "Hay viet ban nhap bai dang Facebook cho The Little Coder.",
        {
          systemPrompt: DEEP_RESEARCH_PROMPT,
          model: process.env.OPENROUTER_DEEP_MODEL || process.env.OPENROUTER_MODEL,
          temperature: 0.45,
          timeout: 300000,
          throwOnError: true,
        }
      );

      await updateStatus(
        ctx,
        statusMsg,
        "[3/4] Dang tu phan bien va tinh chinh de loai bo van mau AI..."
      );

      const finalPost = await askAI(
        `Day la bai ban vua viet:\n${draft1}\n\n` +
          "Hay chinh lai theo style The Little Coder: tu nhien, thuc chien, bo cac cum sao rong, giu giong ke chuyen cua mot ky su dang lam that.",
        {
          systemPrompt: DEEP_RESEARCH_PROMPT,
          model: process.env.OPENROUTER_DEEP_MODEL || process.env.OPENROUTER_MODEL,
          temperature: 0.4,
          timeout: 300000,
          throwOnError: true,
        }
      );

      await updateStatus(ctx, statusMsg, "[4/4] Dang tao banner va dong goi ban thao...");

      const finalImageUrl = generateImageUrl(topic);
      draftStore.set(chatId, {
        postText: finalPost,
        imageUrl: finalImageUrl,
        topic,
      });

      await sendDraftPreview(ctx, finalImageUrl, finalPost);
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

  await ctx.reply("Dang suy nghi...");
  const aiAnswer = await askAI(userText, {
    timeout: 300000,
  });
  await ctx.reply(aiAnswer);
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

  const newImageUrl = generateImageUrl(draft.topic);
  const updatedDraft = { ...draft, imageUrl: newImageUrl };
  draftStore.set(chatId, updatedDraft);

  await sendDraftPreview(ctx, newImageUrl, updatedDraft.postText);
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

    const fbPostId = await postToFacebook(draft.postText, draft.imageUrl || null);
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
