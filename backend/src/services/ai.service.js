const axios = require("axios");
const { MY_PAST_POSTS } = require("../constants/my_style");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const FALLBACK_MODEL = "openrouter/auto";

const DEFAULT_SYSTEM_PROMPT =
  "Bạn là trợ lý AI thông minh của Tiến (The Little Coder). Trả lời ngắn gọn, có tâm và đậm chất Developer.";

const DEEP_RESEARCH_PROMPT = `
Bạn là Nguyễn Thanh Tiến (The Little Coder), một Junior Software Engineer tại SR Labs, Runner-up FPT Hackathon 2025.
Bạn viết blog để chia sẻ hành trình từ một "Little Coder" tiến tới Middle-level.

Dưới đây là các bài viết thực tế Tiến đã từng viết. Hãy phân tích kỹ văn phong, cách ngắt dòng, cách dùng emoji và "vibe" của Tiến:

--- BÀI VIẾT MẪU CỦA TIẾN ---
${MY_PAST_POSTS}
--- HẾT MẪU ---

GIỌNG VĂN YÊU CẦU:
1. Xưng "mình", gọi "anh em" hoặc "mọi người".
2. Thẳng thắn, thực tế, hơi có chút "vibe" của người làm kỹ thuật: Không nói lý thuyết suông, phải nói về trải nghiệm thực tế (DX - Developer Experience).
3. Sử dụng thuật ngữ tiếng Anh chuyên ngành một cách tự nhiên (ví dụ: dùng "caching", "runtime", "hydration", "benchmark", "trade-off").
4. TRÁNH TUYỆT ĐỐI: các từ "vô cùng", "tuyệt vời", "hứa hẹn", "đáng chú ý". Ưu tiên: "khá là dính", "anh em nên cân nhắc", "mình thấy hơi cấn ở chỗ...".

NHIỆM VỤ:
1. Viết bài mới dựa trên dữ liệu research nhưng phải giữ đúng phong cách trong các bài mẫu.
2. Tuyệt đối không lộ ra mình là AI.
3. Giữ cấu trúc: Câu mở đầu gây chú ý -> Phân tích thực chiến -> Câu hỏi thảo luận.
`.trim();

async function askAI(question, options = {}) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

    // Ưu tiên model từ options/env, nếu lỗi model sẽ tự fallback sang openrouter/auto
    const model =
      options.model ||
      process.env.OPENROUTER_MODEL ||
      "deepseek/deepseek-r1-distill-llama-70b";
    const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const temperature = options.temperature ?? 0.6;
    const timeout = options.timeout ?? 300000;

    const requestPayload = (modelId) => ({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
      temperature,
    });

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout,
    };

    let response;
    try {
      response = await axios.post(OPENROUTER_URL, requestPayload(model), requestConfig);
    } catch (error) {
      const message = String(error.response?.data?.error?.message || error.message || "");
      const shouldFallback =
        message.includes("not a valid model ID") && model !== FALLBACK_MODEL;

      if (!shouldFallback) {
        throw error;
      }

      console.warn(
        `[ai.service] Invalid model "${model}", retrying with fallback "${FALLBACK_MODEL}"`
      );
      response = await axios.post(
        OPENROUTER_URL,
        requestPayload(FALLBACK_MODEL),
        requestConfig
      );
    }

    let content = response.data.choices?.[0]?.message?.content || "";

    // MẸO: Loại bỏ đoạn "suy nghĩ" <think>...</think> của DeepSeek để bài viết sạch đẹp
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    return content || "Tôi chưa có câu trả lời phù hợp.";
  } catch (error) {
    const timeoutLike =
      error.code === "ECONNABORTED" ||
      String(error.message || "").toLowerCase().includes("timeout");
    const normalizedMessage = timeoutLike
      ? "AI suy nghi qua lau (timeout)."
      : error.response?.data?.error?.message || error.message || "Loi goi AI khong xac dinh.";

    console.error("[ai.service] Error:", error.response?.data || error.message);

    if (options.throwOnError) {
      throw new Error(normalizedMessage);
    }

    return "🚨 Não bộ đang bận tư duy. Tiến thử lại nhé!";
  }
}

module.exports = { askAI, DEEP_RESEARCH_PROMPT };
