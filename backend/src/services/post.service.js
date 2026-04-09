const { runManualDraftFlow } = require("./draft-builder.service");

async function runManualPostFlow(ctx, topic, options = {}) {
  return runManualDraftFlow(ctx, topic, {
    ...options,
    commandName: "post",
    source: "manual_post",
    postIntent: "insight",
  });
}

module.exports = {
  runManualPostFlow,
};
