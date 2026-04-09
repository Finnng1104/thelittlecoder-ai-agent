const { runManualPostFlow } = require("./post.service");
const { runManualNewsFlow } = require("./news.service");

function createCommandService(dependencies = {}) {
  const updateStatus = dependencies.updateStatus;
  const storeDraft = dependencies.storeDraft;
  const sendDraftPreview = dependencies.sendDraftPreview;
  const buildPostDraftOptions = dependencies.buildPostDraftOptions;

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
  };
}

module.exports = {
  createCommandService,
};
