const cron = require("node-cron");

function initAutomationJobs() {
  cron.schedule("0 9 * * *", () => {
    console.log("[cron] Daily automation job triggered");
  });

  console.log("[cron] Automation jobs initialized");
}

module.exports = { initAutomationJobs };
