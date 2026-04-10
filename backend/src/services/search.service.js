const axios = require("axios");
const { askAI } = require("./ai.service");

const DEFAULT_RESEARCH_PROVIDER = "tavily";
const DEFAULT_SHOPAIKEY_BASE_URL = "https://api.shopaikey.com/v1";
const DEFAULT_SHOPAIKEY_MODEL = "grok-2";
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

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

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

function normalizeResearchProvider(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (["tavily", "grok"].includes(raw)) {
    return raw;
  }
  return "";
}

function resolveResearchProvider() {
  const configured = normalizeResearchProvider(process.env.RESEARCH_PROVIDER);
  if (configured) {
    return configured;
  }

  if (String(process.env.TAVILY_API_KEY || "").trim()) {
    return "tavily";
  }

  if (resolveShopAiResearchConfig().apiKey) {
    return "grok";
  }

  return DEFAULT_RESEARCH_PROVIDER;
}

function resolveShopAiResearchConfig() {
  return {
    apiKey: firstNonEmpty(
      process.env.SHOPAIKEY_API_KEY,
      process.env.GROK_RESEARCH_API_KEY,
      process.env.GROK_API_KEY,
    ),
    baseUrl: firstNonEmpty(
      process.env.SHOPAIKEY_BASE_URL,
      process.env.GROK_RESEARCH_BASE_URL,
      DEFAULT_SHOPAIKEY_BASE_URL,
    ).replace(/\/+$/g, ""),
    model: firstNonEmpty(
      process.env.SHOPAIKEY_MODEL,
      process.env.GROK_RESEARCH_MODEL,
      DEFAULT_SHOPAIKEY_MODEL,
    ),
  };
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

function normalizeModelContent(value) {
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          return String(part.text || part.content || "").trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (value && typeof value === "object") {
    return String(value.text || value.content || "").trim();
  }

  return String(value || "").trim();
}

function extractJsonPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    // fall through
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_error) {
      // fall through
    }
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_error) {
      // fall through
    }
  }

  return null;
}

function normalizeGrokResearchResults(results, maxTotalResults) {
  const rows = Array.isArray(results) ? results : [];
  return rows
    .map((row, index) => {
      const title = String(row?.title || row?.name || "").trim();
      const content = String(
        row?.content || row?.summary || row?.snippet || "",
      )
        .replace(/\s+/g, " ")
        .trim();
      const url = String(row?.url || row?.link || "").trim();
      const sourceTag = String(
        row?.source_tag || row?.sourceTag || row?.language || "",
      )
        .trim()
        .toUpperCase();
      const rawScore = Number(row?.score);
      const score = Number.isFinite(rawScore)
        ? rawScore
        : Math.max(0.1, 1 - index * 0.05);

      if (!title && !content) {
        return null;
      }

      return {
        title: title || "Untitled",
        content: content || "No summary",
        url,
        score,
        source_tag: sourceTag || "",
        source_tags: sourceTag ? [sourceTag] : [],
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, maxTotalResults));
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

async function runGrokResearch(query, options = {}) {
  const config = resolveShopAiResearchConfig();
  if (!config.apiKey) {
    throw new Error(
      "Missing SHOPAIKEY_API_KEY (or GROK_RESEARCH_API_KEY/GROK_API_KEY)",
    );
  }

  const maxResultsPerQuery = Number(
    options.max_results || process.env.RESEARCH_MAX_RESULTS_PER_QUERY || 8,
  );
  const maxTotalResults = Number(
    options.max_total_results ||
      process.env.RESEARCH_MAX_TOTAL_RESULTS ||
      maxResultsPerQuery * 2,
  );
  const bilingual = options.bilingual !== false;
  const searchTopic = String(options.topic || "").trim().toLowerCase();
  const searchDays = Number(options.days || 0);
  const originalQuery = sanitizeTopic(query);

  const systemPrompt =
    "You are a web research assistant for developer content. " +
    "Return JSON only. If the model has web/search capability, use it. " +
    "Never invent source URLs. If a URL is unavailable, return an empty string.";
  const userPrompt =
    `Research this developer topic and return a single JSON object.\n\n` +
    `Topic: ${originalQuery}\n` +
    `Mode: ${searchTopic || "general"}\n` +
    `Freshness: ${searchDays > 0 ? `${searchDays} day(s)` : "latest relevant context"}\n` +
    `Need bilingual coverage: ${bilingual ? "yes" : "no"}\n` +
    `Need up to ${maxTotalResults} research items.\n\n` +
    `Required JSON schema:\n` +
    `{\n` +
    `  "translated_query": "concise English search keywords",\n` +
    `  "summary": "short factual summary in Vietnamese",\n` +
    `  "results": [\n` +
    `    {\n` +
    `      "title": "source title",\n` +
    `      "content": "1-3 sentence factual summary",\n` +
    `      "url": "https://source-url",\n` +
    `      "source_tag": "EN or VI",\n` +
    `      "score": 0.0\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Prefer official docs, vendor announcements, or reputable technical sources.\n` +
    `- Do not invent URLs.\n` +
    `- Keep content concise and factual.\n` +
    `- Return JSON only, no markdown.`;

  const response = await axios.post(
    `${config.baseUrl}/chat/completions`,
    {
      model: config.model,
      temperature: 0.2,
      max_tokens: 2200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    },
  );

  const messageContent = normalizeModelContent(
    response?.data?.choices?.[0]?.message?.content,
  );
  const parsed = extractJsonPayload(messageContent);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Grok research response is not valid JSON");
  }

  const translatedQuery = sanitizeTopic(
    parsed.translated_query || parsed.translatedQuery || originalQuery,
  );
  const normalizedResults = normalizeGrokResearchResults(
    parsed.results,
    maxTotalResults,
  );
  const summary = String(parsed.summary || parsed.overview || "")
    .replace(/\s+/g, " ")
    .trim();
  const info = formatResearch(normalizedResults);

  return {
    provider: "grok",
    query: translatedQuery || originalQuery,
    queries: {
      en: translatedQuery || originalQuery,
      vi: originalQuery,
    },
    originalQuery,
    translatedQuery: translatedQuery || originalQuery,
    searchDepth: `model:${config.model}`,
    totalResults: normalizedResults.length,
    rawResults: normalizedResults,
    infoText: [summary, info].filter(Boolean).join("\n\n") || "Khong tim thay thong tin moi nhat.",
  };
}

function buildResearchFallback(query, options = {}, provider = "") {
  const originalQuery = sanitizeTopic(query);
  return {
    provider: provider || resolveResearchProvider(),
    query: originalQuery,
    queries: {
      en: originalQuery,
      vi: originalQuery,
    },
    originalQuery,
    translatedQuery: originalQuery,
    searchDepth: options.search_depth || "advanced",
    totalResults: 0,
    rawResults: [],
    infoText: "Khong tim thay thong tin moi nhat.",
  };
}

async function runTavilyResearch(query, options = {}) {
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
    provider: "tavily",
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
}

async function researchToday(query, options = {}) {
  try {
    const provider = resolveResearchProvider();
    if (provider === "grok") {
      return await runGrokResearch(query, options);
    }
    return await runTavilyResearch(query, options);
  } catch (error) {
    const provider = resolveResearchProvider();
    console.error(`[search.service] ${provider} research error:`, error.message);
    return buildResearchFallback(query, options, provider);
  }
}

module.exports = { researchToday };
