const axios = require("axios");
const { Markup } = require("telegraf");
const { postToFacebook } = require("./facebook.service");

function extractPublishContent(message) {
  const raw = String(message?.text || message?.caption || "")
    .replace(/\u200b/g, "")
    .trim();
  const matched = raw.match(/^\/publish(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!matched) {
    return null;
  }
  return String(matched[1] || "").trim();
}

function isImageDocument(message) {
  const mimeType = String(message?.document?.mime_type || "").trim();
  return mimeType.startsWith("image/");
}

function hasPublishableImage(message) {
  return (
    (Array.isArray(message?.photo) && message.photo.length > 0) ||
    isImageDocument(message)
  );
}

function toFileUrl(fileLink) {
  if (typeof fileLink === "string") {
    return fileLink;
  }
  return String(fileLink?.href || fileLink || "").trim();
}

function normalizeMimeType(value) {
  return String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

async function downloadTelegramImageBuffer(fileUrl, fallbackMimeType) {
  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const contentType = normalizeMimeType(response.headers?.["content-type"]);
  const mimeType = contentType.startsWith("image/")
    ? contentType
    : normalizeMimeType(fallbackMimeType);

  if (!mimeType.startsWith("image/")) {
    throw new Error(
      `Invalid content-type for image: ${contentType || "unknown"}`,
    );
  }

  return {
    buffer: Buffer.from(response.data),
    mimeType,
  };
}

async function resolveTelegramImageInput(ctx) {
  const message = ctx?.message || {};

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const bestPhoto = message.photo[message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const { buffer, mimeType } = await downloadTelegramImageBuffer(
      toFileUrl(fileLink),
      "image/jpeg",
    );
    return {
      buffer,
      mimeType: mimeType || "image/jpeg",
    };
  }

  if (isImageDocument(message) && message.document?.file_id) {
    const fileLink = await ctx.telegram.getFileLink(message.document.file_id);
    const { buffer, mimeType } = await downloadTelegramImageBuffer(
      toFileUrl(fileLink),
      String(message.document.mime_type || "image/png"),
    );
    return {
      buffer,
      mimeType: mimeType || String(message.document.mime_type || "image/png"),
    };
  }

  return null;
}

function buildDeletePostKeyboard(postId) {
  const normalizedPostId = String(postId || "").trim();
  if (!normalizedPostId) {
    return {};
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("Xóa bài", `delete_published:${normalizedPostId}`)],
  ]);
}

async function runDirectPublishFlow(ctx, options = {}) {
  const content = extractPublishContent(ctx?.message);
  if (content === null) {
    return false;
  }

  if (!content) {
    await ctx.reply(
      "Dùng: /publish <nội dung>\nHoặc gửi ảnh kèm caption: /publish <nội dung>",
    );
    return true;
  }

  const updateStatus = options.updateStatus;
  const rememberPublishedPost = options.rememberPublishedPost;
  if (
    typeof updateStatus !== "function" ||
    typeof rememberPublishedPost !== "function"
  ) {
    throw new Error("Missing publish flow dependencies.");
  }

  const chatId = String(options.chatId || ctx?.chat?.id || "");
  const statusMsg = await ctx.reply("[Publish] Đang đẩy bài lên Fanpage...");

  try {
    const imageInput = hasPublishableImage(ctx?.message)
      ? await resolveTelegramImageInput(ctx)
      : null;
    const fbPostId = await postToFacebook(content, imageInput);
    rememberPublishedPost(chatId, fbPostId);

    await updateStatus(
      ctx,
      statusMsg,
      "Đăng trực tiếp thành công. Đang trả ID bài viết...",
    );
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
    return true;
  } catch (error) {
    await updateStatus(
      ctx,
      statusMsg,
      `[Publish] Đăng trực tiếp thất bại: ${error.message}`,
    );
    return true;
  }
}

module.exports = {
  buildDeletePostKeyboard,
  extractPublishContent,
  hasPublishableImage,
  resolveTelegramImageInput,
  runDirectPublishFlow,
};
