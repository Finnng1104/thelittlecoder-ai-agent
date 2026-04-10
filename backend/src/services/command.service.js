const { runManualPostFlow } = require("./post.service");
const { runManualNewsFlow } = require("./news.service");
const { runDirectPublishFlow } = require("./publish.service");
const {
  runScheduleDeleteFlow,
  runScheduleListFlow,
  runSchedulePostFlow,
} = require("./schedule.service");

function createCommandService(dependencies = {}) {
  const updateStatus = dependencies.updateStatus;
  const storeDraft = dependencies.storeDraft;
  const sendDraftPreview = dependencies.sendDraftPreview;
  const buildPostDraftOptions = dependencies.buildPostDraftOptions;
  const rememberPublishedPost = dependencies.rememberPublishedPost;

  return {
    async post(ctx, topic, options = {}) {
      const draftOptions =
        typeof buildPostDraftOptions === "function"
          ? buildPostDraftOptions(options.buildDraftOptions || {})
          : options.buildDraftOptions || {};

      return runManualPostFlow(ctx, topic, {
        chatId: String(options.chatId || ctx?.chat?.id || ""),
        updateStatus,
        storeDraft,
        sendDraftPreview,
        buildDraftOptions: draftOptions,
      });
    },

    async news(ctx, topic, options = {}) {
      const draftOptions =
        typeof buildPostDraftOptions === "function"
          ? buildPostDraftOptions(options.buildDraftOptions || {})
          : options.buildDraftOptions || {};

      return runManualNewsFlow(ctx, topic, {
        chatId: String(options.chatId || ctx?.chat?.id || ""),
        updateStatus,
        storeDraft,
        sendDraftPreview,
        buildDraftOptions: draftOptions,
      });
    },

    async publish(ctx, options = {}) {
      return runDirectPublishFlow(ctx, {
        chatId: String(options.chatId || ctx?.chat?.id || ""),
        updateStatus,
        rememberPublishedPost,
      });
    },

    async schedule(ctx, options = {}) {
      return runSchedulePostFlow(ctx, {
        chatId: String(options.chatId || ctx?.chat?.id || ""),
      });
    },

    async scheduleList(ctx, status = "") {
      return runScheduleListFlow(ctx, status);
    },

    async scheduleDelete(ctx, scheduleId, options = {}) {
      return runScheduleDeleteFlow(ctx, scheduleId, options);
    },
  };
}

module.exports = {
  createCommandService,
};
