const axios = require("axios");

const TAVILY_BASE_URL = "https://api.tavily.com";

async function searchWeb(query, options = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is missing");
  }

  const response = await axios.post(`${TAVILY_BASE_URL}/search`, {
    api_key: apiKey,
    query,
    max_results: options.maxResults || 5,
    include_answer: options.includeAnswer ?? true,
  });

  return response.data;
}

module.exports = { searchWeb };
