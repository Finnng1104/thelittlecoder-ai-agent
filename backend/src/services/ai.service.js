const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { MY_PAST_POSTS } = require("../constants/my_style");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const FALLBACK_MODEL = "openrouter/auto";
const OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-r1";
const OPENROUTER_RETRY_MODELS = [
  "deepseek/deepseek-r1",
  "deepseek/deepseek-chat",
  "meta-llama/llama-3.1-70b-instruct",
  "openrouter/auto",
];
const OPENROUTER_FREE_RETRY_MODELS = [
  "deepseek/deepseek-r1:free",
  "deepseek/deepseek-chat:free",
];

const DEFAULT_SYSTEM_PROMPT =
  'Bạn là "The Little Coder" - trợ lý kỹ thuật của Tiến. Trả lời ngắn gọn, rõ ràng, thực dụng.';

const THE_LITTLE_CODER_ENGINE_V2_JSON = `
[ROLE]
Bạn là "The Little Coder" - một Junior Frontend Developer tại Việt Nam. Giọng văn thân thiện, "anh em", khiêm tốn nhưng chuyên nghiệp.

[LANGUAGE RULES - CRITICAL]
1. 100% TIẾNG VIỆT THUẦN TÚY: Tuyệt đối không sử dụng chữ Hán (探讨, 真的, 依赖).
2. THUẬT NGỮ CHUYÊN NGÀNH: Giữ nguyên tiếng Anh (Middleware, Props, State...).

[FACEBOOK UI/UX FORMATTING RULES]
1. TIÊU ĐỀ: Phải VIẾT HOA TOÀN BỘ và bắt đầu bằng Emoji (Ví dụ: 🚀 TIÊU ĐỀ).
2. TUYỆT ĐỐI KHÔNG DÙNG BOLD: Không sử dụng dấu ** hoặc __ trong bất kỳ hoàn cảnh nào. Viết văn bản trơn hoàn toàn.
3. NHẤN MẠNH: Sử dụng VIẾT HOA cho các từ khóa thực sự quan trọng. Dùng Emoji ở đầu dòng làm điểm neo.
4. DANH SÁCH & KHOẢNG TRẮNG: Dùng số 1️⃣, 2️⃣ hoặc icon ✅. Ngắt 2 dòng giữa các đoạn văn.

[OUTPUT FORMAT - REQUIRED JSON]
Bạn PHẢI trả về kết quả dưới định dạng JSON duy nhất, không có văn bản thừa bên ngoài:
{
  "post_content": "Nội dung bài viết Facebook (văn bản trơn, VIẾT HOA từ khóa cần nhấn mạnh, không có dấu **)",
  "image_short_title": "Tiêu đề tiếng Anh ngắn gọn cho ảnh (Ví dụ: REACT PROPS)",
  "ant_action": "Mô tả hành động con kiến (Ví dụ: sitting confusedly, celebrating)",
  "log_message": "Dòng chữ cho console.log trên ảnh (Ví dụ: Learning React...)"
}

LƯU Ý: Tuyệt đối không hiển thị phần mô tả "Image Prompt" hay bất kỳ dòng giải thích nào khác ngoài JSON.
`.trim();

const DEEP_RESEARCH_PROMPT = `
${THE_LITTLE_CODER_ENGINE_V2_JSON}

[PERSONAL CONTEXT]
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
4. Tuân thủ chặt output JSON ở trên.
`.trim();

const REFINE_CONTENT_PROMPT = `
${THE_LITTLE_CODER_ENGINE_V2_JSON}

[REFINE MODE]
Nhiem vu cua ban:
- Chuyen doi noi dung tho cua Tien thanh bai dang Facebook theo phong cach "The Little Coder".

Yeu cau bat buoc:
1. GIU NGUYEN y nghia, moc thoi gian, nguyen nhan, cam xuc cot loi trong noi dung goc.
2. Chi nang cap cach dien dat: gon hon, ro hon, co vibe Dev Viet thuc chien.
3. Co the dung tu vung ky thuat mot cach tu nhien (fix bug cuoc doi, refactor lo trinh, reboot ban than...) nhung KHONG duoc lam sai thong tin.
4. Ap dung quy tac format Facebook da cho (emoji diem neo, ngat doan hop ly, nhan manh bang VIET HOA).
5. Tuyet doi KHONG chen markdown (** __ code-fence), KHONG viet loi giai thich ben ngoai.
6. Bat buoc tra ve JSON dung schema:
{
  "post_content": "...",
  "image_short_title": "...",
  "ant_action": "...",
  "log_message": "..."
}
`.trim();

const ROADMAP_GENERATOR_PROMPT = `
[TASK]
Phân rã chủ đề học tập thành một lộ trình nội dung theo thứ tự dễ -> khó.
Số lượng bài PHẢI phù hợp độ rộng/chuyên sâu của chủ đề, KHÔNG cố định.

[RULES]
1. Trả về DUY NHẤT một JSON Array.
2. Mỗi phần tử phải có:
   - day (số thứ tự ngày, bắt đầu từ 1)
   - topic (tiêu đề bài viết cụ thể, rõ ràng)
   - image_hint (tiêu đề tiếng Anh rất ngắn cho ảnh, 2-4 từ)
3. Không markdown, không giải thích thêm.
4. Tập trung vào thực chiến cho dev (ưu tiên ví dụ thật, bài học làm dự án, lỗi thường gặp).
5. Không kéo dài roadmap cho đủ số lượng.
6. Chủ đề hẹp: roadmap ngắn; chủ đề rộng: roadmap dài hơn.

[OUTPUT EXAMPLE]
[
  {"day":1,"topic":"Cài đặt môi trường React","image_hint":"REACT SETUP"},
  {"day":2,"topic":"Hiểu JSX và Virtual DOM","image_hint":"VIRTUAL DOM"}
]
`.trim();

const SERIES_POST_PROMPT = `
${THE_LITTLE_CODER_ENGINE_V2_JSON}

[SERIES MODE]
Bạn đang viết bài thuộc series roadmap theo ngày.
Mục tiêu: ngắn gọn, dễ hiểu, vào thẳng trọng tâm, hạn chế màu mè.

[STYLE RULES]
1. Mở đầu bắt buộc theo format: "📘 DAY {day}: {tiêu đề bài}".
2. Nội dung NGẮN GỌN, DỄ HIỂU, tránh dài dòng.
3. Ưu tiên dạng "đọc nhanh là làm được": định nghĩa ngắn, 2-4 ý chính, 1 ví dụ cực ngắn.
4. Không viết lan man kiểu blog dài.
5. Dùng tiếng Việt tự nhiên, giữ thuật ngữ kỹ thuật tiếng Anh khi cần.
6. Kết bài bằng 1 câu hỏi ngắn để mời thảo luận.

[OUTPUT]
Trả về JSON đúng schema:
{
  "post_content": "...",
  "image_short_title": "...",
  "ant_action": "...",
  "log_message": "..."
}

Yêu cầu riêng:
- image_short_title phải ngắn, dễ đọc trên ảnh, dạng series: "DAY {day} {SHORT TITLE}".
- Không markdown, không giải thích ngoài JSON.
`.trim();

const IMAGE_PROMPT_SYSTEM = `
You are a senior prompt engineer for The Little Coder visual identity.
Return only one final English image prompt for Flux/Imagen.
Requirements:
- Keep fixed layout: dark room, black desk, cyan neon panel, ant mascot behind laptop, laptop text "the little coder".
- Panel text must be English only, very short uppercase title (2-4 words), no Vietnamese on panel.
- Match ant pose with topic mood (bug => confused, tutorial/success => celebrating).
- No markdown, no explanation, no numbered list.
`.trim();

const FALLBACK_IMAGE_PROMPT =
  "Minimalist 3D tech-noir room, matte black desk, black laptop with text 'the little coder', " +
  "small stylized ant mascot behind laptop with cyan glowing antennae, unobstructed cyan neon panel, " +
  "cinematic lighting, sharp focus, isometric tech style, no extra text outside panel.";

function normalizeOpenRouterModel(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) {
    return OPENROUTER_DEFAULT_MODEL;
  }

  // Tu dong map model cu da deprecated sang alias ben.
  if (/deepseek-r1-distill-llama-70b/i.test(raw)) {
    return OPENROUTER_DEFAULT_MODEL;
  }

  return raw;
}

function isFreeModel(modelId) {
  return /:free(?:$|[\s/])/i.test(String(modelId || "").trim());
}

function parseBooleanEnv(value, defaultValue = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

function allowPaidFallback(primaryModel, options = {}) {
  if (typeof options.allowPaidFallback === "boolean") {
    return options.allowPaidFallback;
  }

  if (isFreeModel(primaryModel)) {
    return parseBooleanEnv(process.env.OPENROUTER_ALLOW_PAID_FALLBACK, false);
  }

  return true;
}

function buildModelQueue(primaryModel, options = {}) {
  const explicit = Array.isArray(options.retryModels) ? options.retryModels : [];
  const envExtra = String(process.env.OPENROUTER_RETRY_MODELS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const normalizedPrimary = normalizeOpenRouterModel(primaryModel);
  const paidFallbackEnabled = allowPaidFallback(normalizedPrimary, options);
  const defaultRetryModels = paidFallbackEnabled
    ? OPENROUTER_RETRY_MODELS
    : OPENROUTER_FREE_RETRY_MODELS;

  const queue = Array.from(
    new Set([
      normalizedPrimary,
      ...explicit.map((m) => normalizeOpenRouterModel(m)),
      ...envExtra.map((m) => normalizeOpenRouterModel(m)),
      ...defaultRetryModels,
      ...(paidFallbackEnabled ? [FALLBACK_MODEL] : []),
    ])
  );

  if (paidFallbackEnabled) {
    return queue;
  }

  if (!isFreeModel(normalizedPrimary)) {
    return [normalizedPrimary];
  }

  const freeOnlyQueue = queue.filter((modelId) => isFreeModel(modelId));
  if (freeOnlyQueue.length > 0) {
    return freeOnlyQueue;
  }

  return [normalizedPrimary];
}

function shouldRetryWithAnotherModel(error) {
  const status = Number(error?.response?.status || error?.response?.data?.error?.code || 0);
  const message = String(
    error?.response?.data?.error?.metadata?.raw ||
      error?.response?.data?.error?.message ||
      error?.message ||
      ""
  ).toLowerCase();

  return (
    status === 410 ||
    message.includes("not available") ||
    message.includes("deprecated") ||
    message.includes("provider returned error") ||
    message.includes("not a valid model id") ||
    message.includes("model") && message.includes("not found")
  );
}

function buildRequestPayload(modelId, question, systemPrompt, temperature, options = {}) {
  const maxTokens = Number(
    options.maxTokens ??
      options.max_tokens ??
      process.env.AI_MAX_TOKENS ??
      process.env.OPENROUTER_MAX_TOKENS ??
      1500
  );

  const payload = {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature,
  };

  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = Math.floor(maxTokens);
  }

  const transforms = options.transforms || process.env.OPENROUTER_TRANSFORMS || "middleman";
  const transformList = String(transforms)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (transformList.length > 0) {
    payload.transforms = transformList;
  }

  return payload;
}

async function askAI(question, options = {}) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

    const configuredModel =
      process.env.AI_MODEL ||
      process.env.OPENROUTER_MODEL ||
      OPENROUTER_DEFAULT_MODEL;
    const model = normalizeOpenRouterModel(options.model || configuredModel);
    const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const temperature = options.temperature ?? 0.6;
    const timeout = options.timeout ?? 300000;
    const modelQueue = buildModelQueue(model, options);
    const siteUrl = process.env.OPENROUTER_SITE_URL || "https://thelittlecoder.com";
    const appName = process.env.OPENROUTER_APP_NAME || "The Little Coder Bot";

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl,
        "X-Title": appName,
      },
      timeout,
    };

    let response = null;
    let lastError = null;

    for (const candidateModel of modelQueue) {
      try {
        response = await axios.post(
          OPENROUTER_URL,
          buildRequestPayload(candidateModel, question, systemPrompt, temperature, options),
          requestConfig
        );
        break;
      } catch (error) {
        lastError = error;
        // Neu transform gây loi, thu lai khong transform 1 lan cho model hien tai.
        const transformMessage = String(error?.response?.data?.error?.message || "").toLowerCase();
        const transformFailed = transformMessage.includes("transform");
        if (transformFailed) {
          try {
            response = await axios.post(
              OPENROUTER_URL,
              buildRequestPayload(candidateModel, question, systemPrompt, temperature, {
                ...options,
                transforms: "",
              }),
              requestConfig
            );
            break;
          } catch (retryError) {
            lastError = retryError;
          }
        }

        if (!shouldRetryWithAnotherModel(error)) {
          throw error;
        }

        console.warn(
          `[ai.service] Model "${candidateModel}" unavailable, retrying with another provider/model...`
        );
      }
    }

    if (!response) {
      throw lastError || new Error("OpenRouter request failed without response");
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

async function getBetterImagePrompt(topic, options = {}) {
  try {
    const googleKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
    if (!googleKey) {
      throw new Error("Missing GOOGLE_API_KEY (or GOOGLE_AI_KEY)");
    }

    const modelName = options.model || process.env.GEMINI_IMAGE_PROMPT_MODEL || "gemini-2.5-flash";
    const genAI = new GoogleGenerativeAI(googleKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const postExcerpt = String(options.postText || "")
      .replace(/\s+/g, " ")
      .slice(0, 800)
      .trim();

    const promptInput = [
      IMAGE_PROMPT_SYSTEM,
      `Topic: ${topic}`,
      postExcerpt ? `Post excerpt: ${postExcerpt}` : "",
      "Create one highly-detailed Flux prompt preserving The Little Coder layout and replacing panel content by this topic.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await model.generateContent(promptInput);
    const text = result.response.text().replace(/\s+/g, " ").trim();
    return text || `${FALLBACK_IMAGE_PROMPT} Topic: ${topic}`;
  } catch (error) {
    console.error("[ai.service] Gemini image prompt error:", error.message);
    return `${FALLBACK_IMAGE_PROMPT} Topic: ${topic}`;
  }
}

module.exports = {
  askAI,
  DEEP_RESEARCH_PROMPT,
  REFINE_CONTENT_PROMPT,
  ROADMAP_GENERATOR_PROMPT,
  SERIES_POST_PROMPT,
  getBetterImagePrompt,
};
