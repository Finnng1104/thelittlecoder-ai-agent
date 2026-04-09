const { runManualDraftFlow } = require("./draft-builder.service");

async function runManualNewsFlow(ctx, topic, options = {}) {
  return runManualDraftFlow(ctx, topic, {
    ...options,
    commandName: "news",
    source: "manual_news",
    postIntent: "news",
  });
}

module.exports = {
  runManualNewsFlow,
};
