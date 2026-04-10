const {
  askAI,
  DEEP_RESEARCH_PROMPT,
  NEWS_ENGINE_PROMPT,
  SERIES_POST_PROMPT,
} = require("./ai.service");
const { researchToday } = require("./search.service");
const { buildImagePromptPackage, generateImageAsset } = require("./image.service");
const { formatForFacebook } = require("../utils/textFormatter");

async function noop() {}

function resolveTextModel() {
  return (
    process.env.AI_MODEL ||
    process.env.OPENROUTER_DEEP_MODEL ||
    process.env.OPENROUTER_MODEL
  );
}

function normalizePostIntent(value, fallback = "insight") {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (["series", "news", "tutorial", "insight"].includes(raw)) {
    return raw;
  }
  return fallback;
}

async function buildDraftFromTopic(topic, options = {}) {
  const onStep = typeof options.onStep === "function" ? options.onStep : noop;
  const seriesInfo =
    options.seriesInfo && typeof options.seriesInfo === "object"
      ? options.seriesInfo
      : null;
  const parseStructuredAiOutput =
    typeof options.parseStructuredAiOutput === "function"
      ? options.parseStructuredAiOutput
      : null;
  const ensureSeriesHeading =
    typeof options.ensureSeriesHeading === "function"
      ? options.ensureSeriesHeading
      : null;
  const buildSeriesImageShortTitle =
    typeof options.buildSeriesImageShortTitle === "function"
      ? options.buildSeriesImageShortTitle
      : null;

  if (!parseStructuredAiOutput) {
    throw new Error("Missing parseStructuredAiOutput dependency.");
  }

  const isSeries = Number.isFinite(Number(seriesInfo?.day));
  const seriesDay = isSeries
    ? Math.max(1, Math.floor(Number(seriesInfo.day)))
    : null;
  const seriesTotal = Number.isFinite(Number(seriesInfo?.total))
    ? Math.max(1, Math.floor(Number(seriesInfo.total)))
    : null;
  const seriesImageHint = isSeries
    ? String(seriesInfo?.image_hint || "").trim()
    : "";
  const postIntent = isSeries
    ? "series"
    : normalizePostIntent(options.postIntent, "insight");
  const timezone = String(
    options.timezone || process.env.ROADMAP_TIMEZONE || "Asia/Ho_Chi_Minh",
  ).trim();
  const currentDate = new Date().toLocaleDateString("vi-VN", {
    timeZone: timezone || "Asia/Ho_Chi_Minh",
  });
  const textModel = options.model || resolveTextModel();

  await onStep(1, `[1/5] Đang research thông tin mới nhất về: ${topic}...`);
  const research = await researchToday(topic, {
    search_depth: "advanced",
    max_results: isSeries ? 6 : postIntent === "news" ? 5 : 10,
    max_total_results: isSeries ? 10 : postIntent === "news" ? 10 : 16,
    bilingual: true,
    topic: postIntent === "news" ? "news" : undefined,
    days: postIntent === "news" ? 1 : undefined,
  });

  await onStep(
    2,
    `[2/5] Đã research ${research.totalResults} nguồn (EN + VI). Đang viết bản thảo v1...`,
  );

  const draft1Raw = await askAI(
    isSeries
      ? `Đây là bài thuộc series roadmap.\n` +
          `Day hiện tại: ${seriesDay}\n` +
          `${seriesTotal ? `Tổng số day trong series: ${seriesTotal}\n` : ""}` +
          `Chủ đề Day ${seriesDay}: ${topic}\n` +
          `${seriesImageHint ? `image_hint từ roadmap: ${seriesImageHint}\n` : ""}` +
          `Dữ liệu research:\n${research.infoText}\n\n` +
          `Từ khóa research EN: ${research.queries?.en || research.query}\n` +
          `Từ khóa research VI: ${research.queries?.vi || research.originalQuery}\n\n` +
          "Hãy viết ngắn gọn, dễ hiểu, đúng format series và trả về JSON schema."
      : `Dữ liệu research gốc:\n${research.infoText}\n\n` +
          `Chủ đề gốc: ${topic}\n` +
          `Ngày hiện tại: ${currentDate}\n` +
          `Từ khóa research EN: ${research.queries?.en || research.query}\n` +
          `Từ khóa research VI: ${research.queries?.vi || research.originalQuery}\n\n` +
          (postIntent === "news"
            ? "Đây là bài BẢN TIN CÔNG NGHỆ.\n" +
              "Tập trung vào: cái gì mới, ảnh hưởng gì tới dev, và hành động tiếp theo.\n" +
              "KHÔNG kể chuyện quá khứ dài dòng, KHÔNG than thở.\n"
            : postIntent === "tutorial"
              ? "Đây là bài hướng dẫn kỹ thuật. Viết rõ ràng, thực chiến, có checklist ngắn nếu cần.\n"
              : "Đây là bài chia sẻ góc nhìn/thực chiến, không viết checklist tutorial dài.\n") +
          "Hãy tạo output JSON đúng schema yêu cầu. Không trả về markdown, không lời giải thích.",
    {
      systemPrompt: isSeries
        ? SERIES_POST_PROMPT
        : postIntent === "news"
          ? NEWS_ENGINE_PROMPT
          : DEEP_RESEARCH_PROMPT,
      model: textModel,
      expectJson: true,
      temperature: isSeries ? 0.25 : 0.35,
      timeout: 300000,
      throwOnError: true,
    },
  );

  await onStep(
    3,
    "[3/5] Đang tự phản biện và tinh chỉnh để loại bỏ văn mẫu AI...",
  );

  const refinedRaw = await askAI(
    `Đây là bản thảo JSON bạn vừa viết:\n${draft1Raw}\n\n` +
      "Hãy tự review và chỉnh lại theo style The Little Coder: tự nhiên, thực chiến, bỏ cụm sáo rỗng, giữ ý chính.\n" +
      "Trả về JSON đúng schema cũ, không giải thích thêm.",
    {
      systemPrompt: isSeries
        ? SERIES_POST_PROMPT
        : postIntent === "news"
          ? NEWS_ENGINE_PROMPT
          : DEEP_RESEARCH_PROMPT,
      model: textModel,
      expectJson: true,
      temperature: isSeries ? 0.2 : 0.3,
      timeout: 300000,
      throwOnError: true,
    },
  );

  await onStep(4, "[4/5] Đang parse JSON và dọn đẹp nội dung Facebook...");
  const structured = parseStructuredAiOutput(refinedRaw, topic);
  let finalPost = formatForFacebook(structured.post_content);
  if (isSeries) {
    if (!ensureSeriesHeading || !buildSeriesImageShortTitle) {
      throw new Error("Missing series formatting dependencies.");
    }
    finalPost = ensureSeriesHeading(finalPost, seriesDay, topic);
  }

  const baseImageMeta = {
    topic,
    image_short_title: isSeries
      ? buildSeriesImageShortTitle(
          seriesDay,
          topic,
          structured.image_short_title,
          seriesImageHint,
        )
      : structured.image_short_title,
    ant_action: structured.ant_action,
    log_message: structured.log_message,
  };
  const imagePromptPackage = buildImagePromptPackage(baseImageMeta, "default");
  const imageMeta = {
    ...baseImageMeta,
    image_prompt: imagePromptPackage.prompt,
    image_title_en: imagePromptPackage.imageTitleEn,
    image_title_display: imagePromptPackage.imageTitleDisplay,
  };

  let imageAsset = null;
  if (options.enableImageGeneration) {
    await onStep(
      5,
      "[5/5] Gemini đang tạo banner theo bố cục The Little Coder...",
    );
    imageAsset = await generateImageAsset(imageMeta, "default");
  } else {
    await onStep(
      5,
      "[5/5] Đang tắt tạm thời tính năng tạo ảnh, gửi bản nháp text để duyệt...",
    );
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

async function runManualDraftFlow(ctx, topic, options = {}) {
  const normalizedTopic = String(topic || "").trim();
  const commandName = String(options.commandName || "post").trim() || "post";
  const source = String(options.source || `manual_${commandName}`).trim();
  const postIntent = normalizePostIntent(options.postIntent, "insight");
  if (!normalizedTopic) {
    await ctx.reply(`Vui lòng dùng đúng: /${commandName} <chủ đề>`);
    return false;
  }

  const updateStatus = options.updateStatus;
  const storeDraft = options.storeDraft;
  const sendDraftPreview = options.sendDraftPreview;

  if (
    typeof updateStatus !== "function" ||
    typeof storeDraft !== "function" ||
    typeof sendDraftPreview !== "function"
  ) {
    throw new Error("Missing manual post flow dependencies.");
  }

  const chatId = String(options.chatId || ctx?.chat?.id || "");
  const statusMsg = await ctx.reply("[1/5] Đang khởi động quy trình...");

  try {
    const draft = await buildDraftFromTopic(normalizedTopic, {
      ...(options.buildDraftOptions || {}),
      postIntent,
      onStep: async (_step, text) => {
        await updateStatus(ctx, statusMsg, text);
      },
    });

    const savedDraft = await storeDraft(chatId, {
      ...draft,
      source,
    });

    await sendDraftPreview(
      ctx,
      savedDraft.imageAsset,
      savedDraft.postText,
      savedDraft.draftId,
      { imageMeta: savedDraft.imageMeta },
    );
    await updateStatus(
      ctx,
      statusMsg,
      "Hoàn tất quy trình Deep Research. Bản thảo đã sẵn sàng để duyệt.",
    );
    return true;
  } catch (error) {
    console.error("[bot] Post workflow error:", error.message);
    const lower = String(error.message || "").toLowerCase();
    const friendlyMessage = lower.includes("timeout")
      ? `AI suy nghĩ quá lâu (timeout). Tiến thử ra lệnh /${commandName} lại nhé!`
      : error.message;

    await updateStatus(
      ctx,
      statusMsg,
      "Quy trình bị gián đoạn. Đang báo lỗi cho Tiến...",
    );
    await ctx.reply(
      `Tiến ơi, tôi đang bị kẹt trong dòng suy nghĩ.\n\nLỗi: ${friendlyMessage}`,
    );
    return false;
  }
}

module.exports = {
  buildDraftFromTopic,
  runManualDraftFlow,
};
