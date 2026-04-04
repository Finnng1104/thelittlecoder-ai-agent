const axios = require("axios");

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

async function generateWithGroq(messages, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is missing");
  }

  const model = options.model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const response = await axios.post(
    `${GROQ_BASE_URL}/chat/completions`,
    {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

module.exports = { generateWithGroq };
