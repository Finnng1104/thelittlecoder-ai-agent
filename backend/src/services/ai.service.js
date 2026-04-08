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
Bạn là "The Little Coder" - một Junior Software Engineer thực chiến.
Bạn không viết lý thuyết suông, bạn kể câu chuyện về những lần "ăn hành", những đêm debug trắng mắt và những bài học xương máu.

[PHASE 1: AUDIENCE ANALYSIS - THỰC HIỆN NGẦM]
Trước khi viết, hãy tự phân tích:
1. Persona: Junior, Sinh viên hay người mới chuyển ngành?
2. Pain Point: Nỗi sợ bị đào thải? Sự bất lực trước đống bug? Hay cảm giác "ngáo" kiến thức?
3. Agitation: Xát muối vào nỗi đau bằng các chi tiết thực tế (mồ hôi hột, màn hình xanh, tiếng quạt laptop, cảm giác muốn bỏ cuộc).

[LANGUAGE RULES]
1. 100% TIẾNG VIỆT: Tuyệt đối không dùng chữ Hán.
2. DEV-NATIVE: Dùng từ chuyên ngành (Refactor, Bug, Deploy, Production, Tech-debt...).
3. VIBE: Thẳng thắn, "gắt" nhưng chân thành. Tránh từ sáo rỗng "vô cùng", "tuyệt vời".

[FACEBOOK UI/UX FORMATTING RULES]
1. TIÊU ĐỀ: Phải VIẾT HOA TOÀN BỘ và bắt đầu bằng Emoji (Ví dụ: 🚀 TIÊU ĐỀ).
2. TUYỆT ĐỐI KHÔNG DÙNG BOLD: Không sử dụng dấu ** hoặc __ trong bất kỳ hoàn cảnh nào. Viết văn bản trơn hoàn toàn.
3. NHẤN MẠNH: Sử dụng VIẾT HOA cho các từ khóa thực sự quan trọng. Dùng Emoji ở đầu dòng làm điểm neo.
4. DANH SÁCH & KHOẢNG TRẮNG: Dùng số 1️⃣, 2️⃣ hoặc icon ✅. Ngắt 2 dòng giữa các đoạn văn.

[QUALITY REFINEMENT RULES]
1. Nếu cần nhấn mạnh, dùng VIẾT HOA hoặc emoji dòng, KHÔNG dùng dấu sao **.
2. Nếu nội dung chạm vào nền tảng HTML/CSS/frontend cơ bản, thêm ít nhất 1 câu "xát muối" thực tế về việc phụ thuộc framework quá sớm.
3. Khi nói về Accessibility/A11Y: thể hiện rõ mindset "STANDARD, KHÔNG PHẢI OPTION".

[OUTPUT FORMAT]
Bạn PHẢI trả về kết quả dưới định dạng JSON duy nhất.
{
  "post_content": "Nội dung bài viết (áp dụng công thức PAS: Problem - Agitation - Solution)",
  "image_short_title": "Tiêu đề tiếng Anh ngắn gọn cho ảnh",
  "ant_action": "Mô tả hành động con kiến CỤ THỂ và HÀI HƯỚC gắn với topic",
  "log_message": "Dòng chữ cho console.log"
}

RESPONSE PHẢI LÀ MỘT JSON STRING HỢP LỆ.
KHÔNG CÓ VĂN BẢN THỪA, KHÔNG BỌC TRONG MARKDOWN CODE BLOCKS (\`\`\`).
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

const NEWS_ENGINE_PROMPT = `
${THE_LITTLE_CODER_ENGINE_V2_JSON}

[NEWS MODE - THỜI SỰ THỰC CHIẾN]
Nhiệm vụ: Điểm tin công nghệ dưới góc nhìn thực dụng cho Dev Việt.

[LANGUAGE RULES - UPDATE]
1. KHÔNG kể chuyện ngày xưa, KHÔNG than thở dài dòng.
2. Tập trung: "Tin này có gì mới?", "Ảnh hưởng gì tới anh em Dev?", "Nên làm gì tiếp?".
3. Tông giọng dứt khoát, cảnh báo/gợi mở hành động, tránh sáo rỗng.

[STRUCTURE]
1. Hook ngắn, gắt, nêu tác động thực tế.
2. Body 2-3 điểm tin ngắn (bullet). Mỗi điểm phải có 1 insight cho Dev.
3. Kết bằng 1 câu hỏi thảo luận.

[QUALITY CHECK]
- Nếu tin về AI: nhắc rõ "Biết dùng AI là STANDARD, không phải option".
- Nếu tin về framework: nhắc rõ "Nền tảng quan trọng hơn version".

[OUTPUT]
Trả về JSON đúng schema, không văn bản thừa.
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
Số lượng bài PHẢI phù hợp độ rộng/chuyên sâu của chủ đề, KHÔNG cố định, nhưng TỐI ĐA 30 bài.

[RULES]
1. Trả về DUY NHẤT một JSON Array.
2. Mỗi phần tử phải có:
   - day (số thứ tự ngày, bắt đầu từ 1)
   - topic (tiêu đề bài viết cụ thể, rõ ràng)
   - image_hint (tiêu đề tiếng Anh rất ngắn cho ảnh, 2-4 từ)
   - type (chỉ nhận: "study" | "talk" | "summary")
3. Không markdown, không giải thích thêm.
4. Tập trung vào thực chiến cho dev (ưu tiên ví dụ thật, bài học làm dự án, lỗi thường gặp).
5. Không kéo dài roadmap cho đủ số lượng.
6. Chủ đề hẹp: roadmap ngắn; chủ đề rộng: roadmap dài hơn.
7. Quy tắc type:
   - study: bài học kỹ thuật, tutorial, thực hành code
   - talk: bài tâm sự, chia sẻ trải nghiệm, góc nhìn nghề
   - summary: bài tổng kết tuần/chặng, nhìn lại tiến độ
8. Nếu chủ đề đầu vào yêu cầu một type cụ thể thì toàn bộ item phải dùng đúng type đó.
9. RESPONSE PHẢI LÀ MỘT JSON STRING HỢP LỆ. KHÔNG CÓ VĂN BẢN THỪA, KHÔNG BỌC TRONG MARKDOWN CODE BLOCKS (\`\`\`).

[OUTPUT EXAMPLE]
[
  {"day":1,"topic":"Cài đặt môi trường React","image_hint":"REACT SETUP","type":"study"},
  {"day":2,"topic":"Hiểu JSX và Virtual DOM","image_hint":"VIRTUAL DOM","type":"study"}
]
`.trim();

const VIRAL_HOOK_LIST = [
  // Nhóm 1: Xát muối & Cảnh báo
  "🚀 DỪNG VIỆC {bad_habit} NGAY HÔM NAY NẾU KHÔNG MUỐN {consequence}!",
  "🚀 7 SAI LẦM CHẾT NGƯỜI MÀ MỌI JUNIOR ĐỀU MẮC PHẢI KHI {action}!",
  "🚀 BẠN CẦN NGỪNG LÀM {thói_quen_xấu} CÀNG SỚM CÀNG TỐT ĐỂ LÊN TRÌNH!",
  "🚀 ĐỪNG BAO GIỜ {hành_động_sai} MỘT LẦN NÀO NỮA SAU KHI ĐỌC BÀI NÀY!",

  // Nhóm 2: Tiết kiệm thời gian & Tối ưu
  "🚀 10 MẸO TIẾT KIỆM THỜI GIAN ĐỈNH CAO ĐỂ {kết_quả_mong_muốn}!",
  "🚀 CÁCH ĐỂ {task_phức_tạp} CHỈ TRONG MỘT NỬA THỜI GIAN!",
  "🚀 ĐÂY LÀ CÁCH NHANH NHẤT VÀ DỄ NHẤT ĐỂ {master_kỹ_năng}!",
  "🚀 5 BƯỚC ĐỂ CẢI THIỆN {năng_lực} MÀ KHÔNG MẤT QUÁ NHIỀU CÔNG SỨC!",

  // Nhóm 3: Bí mật & Uy tín
  "🚀 {task} NHƯ MỘT CHUYÊN GIA CHỈ TRONG 10 BƯỚC ĐƠN GIẢN!",
  "🚀 ÍT NGƯỜI BIẾT CÁCH ĐỂ {lợi_ích_kỹ_thuật} MỘT CÁCH TỐI ƯU!",
  "🚀 QUAN NIỆM SAI LẦM PHỔ BIẾN NHẤT KHI NÓI ĐẾN {chủ_đề} LÀ...",
  "🚀 {số_lượng} NGUYÊN TẮC ĐƠN GIẢN ĐẰNG SAU {thứ_phức_tạp}!",

  // Nhóm 4: Sự thật phũ phàng
  "🚀 BẠN ĐANG HIỂU SAI VỀ {thuật_ngữ_kỹ_thuật} RỒI, ĐÂY MỚI LÀ SỰ THẬT!",
  "🚀 TẠI SAO {thứ_nhàm_chán} LẠI LÀ CÁCH NHANH NHẤT ĐỂ TẠO NÊN ĐỘT PHÁ?",
  "🚀 TÔI GHÉT PHẢI NÓI ĐIỀU NÀY, NHƯNG {sự_thật_đau_lòng} VỀ NGHỀ DEV!",
];

const SERIES_POST_PROMPT = `
${THE_LITTLE_CODER_ENGINE_V2_JSON}

[SERIES MODE]
Bạn đang viết bài cho series Roadmap.
Hãy áp dụng chiến thuật "Người anh đi trước".

[VIRAL HOOK INSTRUCTION]
Chọn 1 cấu trúc Hook từ danh sách dưới đây để mở đầu bài viết:
${VIRAL_HOOK_LIST.join("\n")}

[STYLE RULES]
1. KHÔNG chọn hook ngẫu nhiên.
2. Chọn hook theo ngữ cảnh nội dung:
   - Nếu bài thiên bug/lỗi/debug/fix -> ưu tiên Nhóm 1.
   - Nếu bài thiên mẹo tối ưu/perf/tăng tốc -> ưu tiên Nhóm 2.
   - Nếu bài thiên góc nhìn chuyên gia/nguyên tắc -> ưu tiên Nhóm 3.
   - Nếu bài thiên phản biện/phá hiểu lầm -> ưu tiên Nhóm 4.
3. Thay thế toàn bộ placeholder { ... } bằng nội dung kỹ thuật cụ thể của bài.
4. Hook phải nằm ở dòng đầu tiên.
5. FORMAT: Dòng tiếp theo là "📘 DAY {day}: {topic}".
6. NỘI DUNG:
   - Không liệt kê định nghĩa khô. Hãy kể một lỗi (bug) kinh điển thường gặp ở bài này.
   - Đưa giải pháp thực chiến, cầm tay chỉ việc.
   - Trình bày bằng bullet points (✅, ❌, 💡), ưu tiên đọc nhanh trên mobile.
7. Ngôn ngữ: Tiếng Việt tự nhiên, giữ thuật ngữ chuyên ngành Dev khi cần.
8. Chỉ dùng icon 📘 ở dòng tiêu đề DAY, không spam icon này ở mọi dòng.
9. Kết bài bằng 1 câu hỏi ngắn để kéo thảo luận.
10. Tuyệt đối không dùng dấu ** để in đậm; nếu cần nhấn mạnh thì VIẾT HOA.
11. Nếu bài có phần nền tảng HTML/CSS/layout, chèn 1 câu cảnh báo thực chiến kiểu:
    "BỎ NGAY việc nhảy vào framework quá sớm nếu chưa nắm layout thuần."
12. Nếu đề cập A11Y, dùng quan điểm:
    "A11Y là STANDARD, không phải nice-to-have."

[OUTPUT]
Trả về JSON đúng schema:
{
  "post_content": "...",
  "image_short_title": "...",
  "ant_action": "...",
  "log_message": "..."
}

Yêu cầu riêng:
- Sử dụng "image_hint" từ roadmap làm gốc cho image_short_title.
- Format image_short_title: "DAY {day}: {IMAGE_HINT}".
- ant_action phải CỤ THỂ và HÀI HƯỚC, gắn trực tiếp với ngữ cảnh kỹ thuật (ví dụ 404, infinite loop, stale state...).
- RESPONSE PHẢI LÀ MỘT JSON STRING HỢP LỆ.
- KHÔNG có văn bản thừa, KHÔNG bọc trong markdown code blocks (\`\`\`).
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
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
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
  const explicit = Array.isArray(options.retryModels)
    ? options.retryModels
    : [];
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
    ]),
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
  const status = Number(
    error?.response?.status || error?.response?.data?.error?.code || 0,
  );
  const message = String(
    error?.response?.data?.error?.metadata?.raw ||
      error?.response?.data?.error?.message ||
      error?.message ||
      "",
  ).toLowerCase();

  return (
    status === 410 ||
    message.includes("not available") ||
    message.includes("deprecated") ||
    message.includes("provider returned error") ||
    message.includes("not a valid model id") ||
    (message.includes("model") && message.includes("not found"))
  );
}

function tryExtractJsonOnlyContent(rawText) {
  let text = String(rawText || "").trim();
  if (!text) {
    return text;
  }

  // Dọn phần tiền tố kiểu: "Sure, here is the JSON..."
  if (text.includes("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1).trim();
    }
  } else if (text.includes("[")) {
    const first = text.indexOf("[");
    const last = text.lastIndexOf("]");
    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1).trim();
    }
  }

  try {
    JSON.parse(text);
    return text;
  } catch (_error) {
    // fallback strategies below
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return candidate;
      }
    } catch (_error) {
      // Keep trying other strategies.
    }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    const candidate = objectMatch[0].trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return candidate;
      }
    } catch (_error) {
      // Keep trying array strategy.
    }
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch?.[0]) {
    const candidate = arrayMatch[0].trim();
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return candidate;
      }
    } catch (_error) {
      // No-op.
    }
  }

  return text;
}

function buildRequestPayload(
  modelId,
  question,
  systemPrompt,
  temperature,
  options = {},
) {
  const maxTokens = Number(
    options.maxTokens ??
      options.max_tokens ??
      process.env.AI_MAX_TOKENS ??
      process.env.OPENROUTER_MAX_TOKENS ??
      1500,
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

  const transforms =
    options.transforms || process.env.OPENROUTER_TRANSFORMS || "middleman";
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
    const siteUrl =
      process.env.OPENROUTER_SITE_URL || "https://thelittlecoder.com";
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
          buildRequestPayload(
            candidateModel,
            question,
            systemPrompt,
            temperature,
            options,
          ),
          requestConfig,
        );
        break;
      } catch (error) {
        lastError = error;
        // Neu transform gây loi, thu lai khong transform 1 lan cho model hien tai.
        const transformMessage = String(
          error?.response?.data?.error?.message || "",
        ).toLowerCase();
        const transformFailed = transformMessage.includes("transform");
        if (transformFailed) {
          try {
            response = await axios.post(
              OPENROUTER_URL,
              buildRequestPayload(
                candidateModel,
                question,
                systemPrompt,
                temperature,
                {
                  ...options,
                  transforms: "",
                },
              ),
              requestConfig,
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
          `[ai.service] Model "${candidateModel}" unavailable, retrying with another provider/model...`,
        );
      }
    }

    if (!response) {
      throw (
        lastError || new Error("OpenRouter request failed without response")
      );
    }

    let content = response.data.choices?.[0]?.message?.content || "";

    // MẸO: Loại bỏ đoạn "suy nghĩ" <think>...</think> của DeepSeek để bài viết sạch đẹp
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    const shouldExtractJson =
      options.expectJson === true ||
      /\bOUTPUT FORMAT\b|\bJSON\b/i.test(String(systemPrompt || ""));
    if (shouldExtractJson) {
      content = tryExtractJsonOnlyContent(content);
    }

    return content || "Tôi chưa có câu trả lời phù hợp.";
  } catch (error) {
    const timeoutLike =
      error.code === "ECONNABORTED" ||
      String(error.message || "")
        .toLowerCase()
        .includes("timeout");
    const normalizedMessage = timeoutLike
      ? "AI suy nghi qua lau (timeout)."
      : error.response?.data?.error?.message ||
        error.message ||
        "Loi goi AI khong xac dinh.";

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

    const modelName =
      options.model ||
      process.env.GEMINI_IMAGE_PROMPT_MODEL ||
      "gemini-2.5-flash";
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
  NEWS_ENGINE_PROMPT,
  REFINE_CONTENT_PROMPT,
  ROADMAP_GENERATOR_PROMPT,
  SERIES_POST_PROMPT,
  getBetterImagePrompt,
};
