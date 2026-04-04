require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { startTelegramBot } = require("./bot");
const { initAutomationJobs } = require("./services/automation.service");

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "the-little-coder-ai-backend",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api", (_req, res) => {
  res.json({
    message: "Backend is running",
    endpoints: ["/api/health"],
  });
});

app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

startTelegramBot();
initAutomationJobs();
