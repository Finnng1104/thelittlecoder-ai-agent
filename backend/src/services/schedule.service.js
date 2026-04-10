const { Markup } = require("telegraf");
const { postToFacebook } = require("./facebook.service");
const {
  buildDeletePostKeyboard,
  hasPublishableImage,
  resolveTelegramImageInput,
} = require("./publish.service");
const {
  createScheduledPost,
  getScheduledPostById,
  loadScheduledPosts,
  updateScheduledPostById,
} = require("./scheduled-post.service");

const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Ho_Chi_Minh";
const DEFAULT_SCHEDULE_UTC_OFFSET = "+07:00";

function nowIso() {
  return new Date().toISOString();
}

function normalizeRawMessage(message) {
  return String(message?.text || message?.caption || "")
    .replace(/\u200b/g, "")
    .trim();
}

function resolveScheduleTimezone() {
  return String(
    process.env.SCHEDULE_TIMEZONE ||
      process.env.ROADMAP_TIMEZONE ||
      DEFAULT_SCHEDULE_TIMEZONE,
  ).trim();
}

function resolveScheduleUtcOffset() {
  return String(
    process.env.SCHEDULE_UTC_OFFSET || DEFAULT_SCHEDULE_UTC_OFFSET,
  ).trim();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isValidCalendarDate(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function formatScheduledAtLabel(dateIso) {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const formatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: resolveScheduleTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return formatter.format(date).replace(",", "");
}

function parseScheduleDateTime(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return null;
  }

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let matched =
    raw.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/,
    ) ||
    raw.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/,
    );

  if (!matched) {
    return null;
  }

  if (raw.includes("-")) {
    year = Number(matched[1]);
    month = Number(matched[2]);
    day = Number(matched[3]);
    hour = Number(matched[4]);
    minute = Number(matched[5]);
  } else {
    day = Number(matched[1]);
    month = Number(matched[2]);
    year = Number(matched[3]);
    hour = Number(matched[4]);
    minute = Number(matched[5]);
  }

  if (
    !isValidCalendarDate(year, month, day) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const isoLike =
    `${year}-${pad2(month)}-${pad2(day)}` +
    `T${pad2(hour)}:${pad2(minute)}:00${resolveScheduleUtcOffset()}`;
  const date = new Date(isoLike);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return {
    scheduledAtIso: date.toISOString(),
    scheduledLabel: `${pad2(day)}/${pad2(month)}/${year} ${pad2(hour)}:${pad2(
      minute,
    )}`,
  };
}

function buildScheduleUsageText() {
  return (
    "Dùng: /schedule <dd/mm/yyyy hh:mm | nội dung>\n" +
    "Ví dụ: /schedule 12/04/2026 20:30 | Bài viết tối nay\n" +
    "Hoặc: /schedule 2026-04-12 20:30 | Bài viết tối nay"
  );
}

function extractScheduleRequest(message) {
  const raw = normalizeRawMessage(message);
  const matched = raw.match(/^\/schedule(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!matched) {
    return null;
  }

  const body = String(matched[1] || "").trim();
  if (!body) {
    return {
      error: buildScheduleUsageText(),
    };
  }

  const dividerIndex = body.indexOf("|");
  if (dividerIndex < 0) {
    return {
      error:
        "Thiếu dấu `|` để ngăn ngày giờ và nội dung.\n\n" +
        buildScheduleUsageText(),
    };
  }

  const dateTimeRaw = body.slice(0, dividerIndex).trim();
  const content = body.slice(dividerIndex + 1).trim();
  if (!content) {
    return {
      error: "Nội dung đang trống.\n\n" + buildScheduleUsageText(),
    };
  }

  const parsedDateTime = parseScheduleDateTime(dateTimeRaw);
  if (!parsedDateTime) {
    return {
      error:
        "Không đọc được ngày giờ. Hỗ trợ `dd/mm/yyyy hh:mm` hoặc `yyyy-mm-dd hh:mm`.\n\n" +
        buildScheduleUsageText(),
    };
  }

  return {
    content,
    scheduledAtIso: parsedDateTime.scheduledAtIso,
    scheduledLabel: parsedDateTime.scheduledLabel,
  };
}

function previewText(text, maxLength = 72) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildCancelScheduledPostKeyboard(scheduleId) {
  const normalizedId = String(scheduleId || "").trim();
  if (!normalizedId) {
    return {};
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("Hủy lịch", `cancel_scheduled:${normalizedId}`)],
  ]);
}

async function runSchedulePostFlow(ctx, options = {}) {
  const request = extractScheduleRequest(ctx?.message);
  if (request === null) {
    return false;
  }

  if (request.error) {
    await ctx.reply(request.error, { parse_mode: "Markdown" });
    return true;
  }

  const message = ctx?.message || {};
  if (message.document && !hasPublishableImage(message)) {
    await ctx.reply(
      "`/schedule` chỉ nhận ảnh hoặc text. File đính kèm này không phải ảnh.",
      { parse_mode: "Markdown" },
    );
    return true;
  }

  const scheduledTime = new Date(request.scheduledAtIso);
  if (scheduledTime.getTime() <= Date.now()) {
    await ctx.reply("Thời gian đặt lịch phải lớn hơn thời điểm hiện tại.");
    return true;
  }

  try {
    const imageAsset = hasPublishableImage(message)
      ? await resolveTelegramImageInput(ctx)
      : null;
    const scheduledPost = await createScheduledPost({
      chatId: String(options.chatId || ctx?.chat?.id || ""),
      content: request.content,
      imageAsset,
      scheduledAt: request.scheduledAtIso,
      scheduledLabel: request.scheduledLabel,
      status: "pending",
      source: "telegram",
    });

    await ctx.reply(
      `ĐÃ LÊN LỊCH!\n\n` +
        `ID lịch: \`${scheduledPost.id}\`\n` +
        `Thời gian: ${formatScheduledAtLabel(scheduledPost.scheduledAt)}\n\n` +
        `Nếu muốn hủy lịch này, gõ:\n` +
        `\`/schedule_delete ${scheduledPost.id}\``,
      {
        parse_mode: "Markdown",
        ...buildCancelScheduledPostKeyboard(scheduledPost.id),
      },
    );
    return true;
  } catch (error) {
    await ctx.reply(`[Schedule] Tạo lịch thất bại: ${error.message}`);
    return true;
  }
}

async function runScheduleListFlow(ctx, rawStatus = "") {
  const inputStatus = String(rawStatus || "").trim().toLowerCase() || "pending";
  const allowed = new Set(["pending", "posted", "failed", "cancelled", "all"]);
  const status = allowed.has(inputStatus) ? inputStatus : "pending";
  const allItems = await loadScheduledPosts();
  const filtered = allItems
    .filter((item) => status === "all" || item.status === status)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  if (!filtered.length) {
    await ctx.reply(
      status === "all"
        ? "Chưa có lịch đăng nào."
        : `Chưa có lịch đăng nào ở trạng thái ${status}.`,
    );
    return true;
  }

  const lines = [`LỊCH ĐĂNG (${status}):`];
  for (const item of filtered.slice(0, 20)) {
    lines.push(
      `- ${item.id} | ${item.status} | ${formatScheduledAtLabel(
        item.scheduledAt,
      )}`,
    );
    lines.push(`  ${previewText(item.content)}`);
  }

  if (filtered.length > 20) {
    lines.push(`\nCòn ${filtered.length - 20} lịch nữa chưa hiển thị.`);
  }

  await ctx.reply(lines.join("\n"));
  return true;
}

async function runScheduleDeleteFlow(ctx, scheduleId, options = {}) {
  const id = String(scheduleId || "").trim();
  if (!id) {
    await ctx.reply("Dùng: /schedule_delete <schedule_id>");
    return false;
  }

  const found = await getScheduledPostById(id);
  if (!found) {
    await ctx.reply(`Không tìm thấy lịch đăng: ${id}`);
    return false;
  }

  if (found.status === "posted") {
    await ctx.reply(
      `Lịch ${id} đã lên sóng lúc ${formatScheduledAtLabel(
        found.postedAt || found.scheduledAt,
      )}, không thể hủy nữa.`,
    );
    return false;
  }

  if (found.status === "cancelled") {
    if (!options.silentIfCancelled) {
      await ctx.reply(`Lịch ${id} đã được hủy trước đó.`);
    }
    return true;
  }

  await updateScheduledPostById(id, {
    status: "cancelled",
    cancelledAt: nowIso(),
    errorMessage: "",
  });

  if (!options.silentSuccess) {
    await ctx.reply(
      `Đã hủy lịch ${id} (${formatScheduledAtLabel(found.scheduledAt)}).`,
    );
  }
  return true;
}

async function runDueScheduledPostFlow(options = {}) {
  const sendMessage = options.sendMessage;
  const rememberPublishedPost = options.rememberPublishedPost;
  if (
    typeof sendMessage !== "function" ||
    typeof rememberPublishedPost !== "function"
  ) {
    throw new Error("Missing scheduled publish dependencies.");
  }

  const now = Date.now();
  const dueItems = (await loadScheduledPosts())
    .filter(
      (item) =>
        item.status === "pending" &&
        new Date(item.scheduledAt).getTime() <= now,
    )
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  if (!dueItems.length) {
    return 0;
  }

  let processedCount = 0;
  for (const item of dueItems) {
    try {
      const fbPostId = await postToFacebook(item.content, item.imageAsset || null);
      rememberPublishedPost(item.chatId, fbPostId);
      await updateScheduledPostById(item.id, {
        status: "posted",
        postedAt: nowIso(),
        facebookPostId: fbPostId,
        errorMessage: "",
      });
      await sendMessage(
        item.chatId,
        `LỊCH ĐĂNG ĐÃ LÊN SÓNG!\n\n` +
          `ID lịch: \`${item.id}\`\n` +
          `ID bài viết: \`${fbPostId}\`\n\n` +
          `Nếu muốn xóa bài này, gõ:\n` +
          `\`/delete ${fbPostId}\``,
        {
          parse_mode: "Markdown",
          ...buildDeletePostKeyboard(fbPostId),
        },
      );
      processedCount += 1;
    } catch (error) {
      await updateScheduledPostById(item.id, {
        status: "failed",
        failedAt: nowIso(),
        errorMessage: error.message,
      });
      await sendMessage(
        item.chatId,
        `[Schedule] Đăng lịch thất bại.\n\n` +
          `ID lịch: \`${item.id}\`\n` +
          `Thời gian: ${formatScheduledAtLabel(item.scheduledAt)}\n` +
          `Lỗi: ${error.message}\n\n` +
          `Bạn có thể hủy bằng:\n` +
          `\`/schedule_delete ${item.id}\``,
        {
          parse_mode: "Markdown",
          ...buildCancelScheduledPostKeyboard(item.id),
        },
      );
    }
  }

  return processedCount;
}

module.exports = {
  buildCancelScheduledPostKeyboard,
  extractScheduleRequest,
  formatScheduledAtLabel,
  runDueScheduledPostFlow,
  runScheduleDeleteFlow,
  runScheduleListFlow,
  runSchedulePostFlow,
};
