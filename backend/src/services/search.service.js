const axios = require("axios");
const { askAI } = require("./ai.service");

const DEFAULT_GLOBAL_DOMAINS = [
  "react.dev",
  "nextjs.org",
  "vercel.com",
  "web.dev",
  "developer.mozilla.org",
  "github.com",
  "stackoverflow.com",
  "medium.com",
  "dev.to",
  "reddit.com",
];

const DEFAULT_VI_DOMAINS = [
  "viblo.asia",
  "f8.com.vn",
  "fullstack.edu.vn",
  "topdev.vn",
  "cafedev.vn",
  "codelearn.io",
];

function formatResearch(results) {
  return results
    .map((result, index) => {
      const title = result.title || "Untitled";
      const content = result.content || "No summary";
      const url = result.url ? ` (${result.url})` : "";
      const sourceTag = result.source_tags?.length
        ? ` [${result.source_tags.join(", ")}]`
        : result.source_tag
          ? ` [${result.source_tag}]`
          : "";
      return `${index + 1}. ${title}${sourceTag}${url}\n${content}`;
    })
    .join("\n\n");
}

function sanitizeTopic(value) {
  return String(value || "")
    .replace(/[\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrlKey(url) {
  const raw = String(url || "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/g, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function mergeResearchResults(searchBatches, maxTotalResults) {
  const merged = new Map();
  let order = 0;

  for (const batch of searchBatches) {
    const sourceTag = String(batch?.sourceTag || "").trim();
    const rows = Array.isArray(batch?.results) ? batch.results : [];

    for (const row of rows) {
      const title = String(row?.title || "").trim();
      const content = String(row?.content || "").trim();
      const url = String(row?.url || "").trim();
      const urlKey = normalizeUrlKey(url);
      const fallbackKey = `${title}|${content.slice(0, 180)}`.toLowerCase();
      const key = urlKey || fallbackKey;
      if (!key) {
        continue;
      }

      const score = Number(row?.score || 0);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...row,
          title: title || row?.title || "Untitled",
          content: content || row?.content || "No summary",
          url,
          score,
          _order: order,
          source_tag: sourceTag,
          source_tags: sourceTag ? [sourceTag] : [],
        });
        order += 1;
        continue;
      }

      const tags = new Set([...(existing.source_tags || []), ...(sourceTag ? [sourceTag] : [])]);
      const picked = score > Number(existing.score || 0) ? row : existing;
      merged.set(key, {
        ...existing,
        ...picked,
        title: String(picked?.title || existing?.title || "Untitled").trim(),
        content: String(picked?.content || existing?.content || "No summary").trim(),
        url: String(picked?.url || existing?.url || "").trim(),
        score: Math.max(Number(existing.score || 0), score),
        source_tag: Array.from(tags).join("+"),
        source_tags: Array.from(tags),
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return Number(a._order || 0) - Number(b._order || 0);
    })
    .slice(0, Math.max(1, maxTotalResults))
    .map(({ _order, ...row }) => row);
}

async function runTavilySearch(apiKey, query, options = {}) {
  const payload = {
    api_key: apiKey,
    query,
    search_depth: options.searchDepth || "advanced",
    max_results: Number(options.maxResults || 8),
  };

  const topic = String(options.topic || "").trim().toLowerCase();
  if (topic) {
    payload.topic = topic;
  }

  const days = Number(options.days || 0);
  if (Number.isFinite(days) && days > 0) {
    payload.days = Math.floor(days);
  }

  const includeDomains = Array.isArray(options.includeDomains)
    ? options.includeDomains.filter(Boolean)
    : [];
  if (includeDomains.length > 0) {
    payload.include_domains = includeDomains;
  }

  const response = await axios.post("https://api.tavily.com/search", payload);
  return Array.isArray(response?.data?.results) ? response.data.results : [];
}

async function researchToday(query, options = {}) {
  try {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("Missing TAVILY_API_KEY");
    }

    const searchDepth = options.search_depth || "advanced";
    const maxResultsPerQuery = Number(
      options.max_results || process.env.RESEARCH_MAX_RESULTS_PER_QUERY || 8
    );
    const maxTotalResults = Number(
      options.max_total_results || process.env.RESEARCH_MAX_TOTAL_RESULTS || maxResultsPerQuery * 2
    );
    const includeDomainsEn = Array.isArray(options.include_domains_en)
      ? options.include_domains_en
      : Array.isArray(options.include_domains)
        ? options.include_domains
        : DEFAULT_GLOBAL_DOMAINS;
    const includeDomainsVi = Array.isArray(options.include_domains_vi)
      ? options.include_domains_vi
      : DEFAULT_VI_DOMAINS;
    const bilingual = options.bilingual !== false;
    const searchTopic = String(options.topic || "").trim().toLowerCase();
    const searchDays = Number(options.days || 0);

    const englishTopicRaw = await askAI(
      `Translate this tech topic to concise English search keywords only: ${query}`,
      {
        systemPrompt: "You are a search keyword translator. Return only concise English keywords.",
        temperature: 0.2,
      }
    );

    const originalQuery = sanitizeTopic(query);
    const translatedTopic = sanitizeTopic(englishTopicRaw);
    const englishQuery =
      translatedTopic && !translatedTopic.includes("🚨") ? translatedTopic : originalQuery;
    const vietnameseQuery = originalQuery;

    const searchJobs = [];
    searchJobs.push(
      runTavilySearch(apiKey, englishQuery, {
        searchDepth,
        maxResults: maxResultsPerQuery,
        includeDomains: includeDomainsEn,
        topic: searchTopic,
        days: searchDays,
      }).then((results) => ({
        sourceTag: "EN",
        results,
      }))
    );

    if (bilingual) {
      searchJobs.push(
        runTavilySearch(apiKey, vietnameseQuery, {
          searchDepth,
          maxResults: maxResultsPerQuery,
          includeDomains: includeDomainsVi,
          topic: searchTopic,
          days: searchDays,
        }).then((results) => ({
          sourceTag: "VI",
          results,
        }))
      );
    }

    const batches = await Promise.all(searchJobs);
    const mergedResults = mergeResearchResults(batches, maxTotalResults);
    const info = formatResearch(mergedResults);

    return {
      query: englishQuery,
      queries: {
        en: englishQuery,
        vi: vietnameseQuery,
      },
      originalQuery,
      translatedQuery: translatedTopic || originalQuery,
      searchDepth,
      totalResults: mergedResults.length,
      rawResults: mergedResults,
      infoText: info || "Khong tim thay thong tin moi nhat.",
    };
  } catch (error) {
    console.error("[search.service] Tavily error:", error.message);
    return {
      query,
      queries: {
        en: query,
        vi: query,
      },
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
