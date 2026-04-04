const axios = require("axios");
const { askAI } = require("./ai.service");

function formatResearch(results) {
  return results
    .map((result, index) => {
      const title = result.title || "Untitled";
      const content = result.content || "No summary";
      const url = result.url ? ` (${result.url})` : "";
      return `${index + 1}. ${title}${url}\n${content}`;
    })
    .join("\n\n");
}

async function researchToday(query, options = {}) {
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("Missing TAVILY_API_KEY");
    }

    const defaultDomains = ["vercel.com", "medium.com", "dev.to", "reddit.com"];
    const searchDepth = options.search_depth || "advanced";
    const maxResults = Number(options.max_results || 8);
    const includeDomains = options.include_domains || defaultDomains;

    const englishTopicRaw = await askAI(
      `Translate this tech topic to concise English search keywords only: ${query}`,
      {
        systemPrompt: "You are a search keyword translator. Return only concise English keywords.",
        temperature: 0.2,
      }
    );

    const englishTopic = String(englishTopicRaw || "")
      .replace(/[\r\n"]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const searchQuery = englishTopic && !englishTopic.includes("🚨") ? englishTopic : query;

    const response = await axios.post("https://api.tavily.com/search", {
      api_key: apiKey,
      query: searchQuery,
      search_depth: searchDepth,
      max_results: maxResults,
      include_domains: includeDomains,
    });

    const results = response.data.results || [];
    const info = formatResearch(results);

    return {
      query: searchQuery,
      originalQuery: query,
      translatedQuery: englishTopic,
      searchDepth,
      totalResults: results.length,
      rawResults: results,
      infoText: info || "Khong tim thay thong tin moi nhat.",
    };
  } catch (error) {
    console.error("[search.service] Tavily error:", error.message);
    return {
      query,
      originalQuery: query,
      translatedQuery: query,
      searchDepth: options.search_depth || "advanced",
      totalResults: 0,
      rawResults: [],
      infoText: "Khong tim thay thong tin moi nhat.",
    };
  }
}

module.exports = { researchToday };
