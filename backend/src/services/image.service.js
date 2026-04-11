const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const INLINE_FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+AP6XqVYxQAAAABJRU5ErkJggg==";
const DEFAULT_REFERENCE_IMAGE_RELATIVE_PATH = "assets/anh-mau.png";
const DEFAULT_PANEL_MAIN_TEXT = "WHAT IS REACTJS";
const FIXED_PANEL_SUBTEXT = "THE LITTLE CODER | JR FRONTEND DEV";
const FIXED_LAPTOP_LID_TEXT = "THE LITTLE CODER";
const FIXED_DESK_SIGN_TEXT = "THE LITTLE CODER";
const VI_TO_EN_TOKEN_MAP = {
  tin: "NEWS",
  tuc: "UPDATE",
  cong: "TECH",
  nghe: "TECH",
  lap: "CODE",
  trinh: "CODE",
  huong: "GUIDE",
  dan: "GUIDE",
  hoc: "LEARN",
  bai: "LESSON",
  co: "BASIC",
  ban: "BASIC",
  nang: "ADVANCED",
  cao: "ADVANCED",
  toi: "OPTIMIZE",
  uu: "OPTIMIZE",
  hieu: "UNDERSTAND",
  la: "IS",
  gi: "WHAT",
  tai: "WHY",
  sao: "WHY",
  loi: "BUG",
  bug: "BUG",
  react: "REACT",
  nextjs: "NEXTJS",
  javascript: "JAVASCRIPT",
  typescript: "TYPESCRIPT",
  frontend: "FRONTEND",
  backend: "BACKEND",
  middleware: "MIDDLEWARE",
  roadmap: "ROADMAP",
  ai: "AI",
  agent: "AGENT",
};

function sanitizeTopic(topic) {
  return String(topic || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAscii(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAsciiLower(value) {
  return normalizeAscii(value).toLowerCase();
}

function stripNoiseWords(topic) {
  return normalizeAscii(topic)
    .replace(
      /\b(post|chia se|hanh trinh|ve|viet bai|bai viet|share|story|journey)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function hasVietnameseDiacritics(text) {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
    String(text || ""),
  );
}

function looksVietnameseByKeywords(text) {
  const normalized = ` ${toAsciiLower(text)} `;
  return /( tin tuc | cong nghe | lap trinh | huong dan | bai hoc | bai viet | tam su | hanh trinh | cho anh em | cho newbie )/.test(
    normalized,
  );
}

function compactUpperTitle(tokens, maxWords = 8, maxLength = 72) {
  return tokens
    .map((token) =>
      String(token || "")
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ")
    .slice(0, maxLength)
    .trim();
}

function getAntEmotionPrompt(emotion = "default") {
  switch (String(emotion).toLowerCase()) {
    case "confused":
      return "The mini robot eye glow is unstable and flickering in cool blue.";
    case "happy":
      return "The mini robot eye glow is bright, stable, and energetic in crisp blue-white light.";
    default:
      return "The mini robot eye glow is clean, premium, and focused in blue-white.";
  }
}

function pickDeterministicPosition(topic) {
  const positions = [
    "sitting slightly angled toward the holographic panel, hands on keyboard, focused and calm",
    "sitting upright behind the laptop, typing with attentive posture and steady focus",
    "sitting comfortably at the desk, leaning in slightly while typing with creative concentration",
  ];

  const seed = String(topic || "")
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return positions[seed % positions.length];
}

function getAntSceneInstructions(topic) {
  const rawTopic = String(topic || "").toLowerCase();
  const englishTopic = buildEnglishTitleHint(topic).toLowerCase();
  const cleanTopic = stripNoiseWords(topic) || "software engineering";

  if (/(bug|loi|lỗi|fix|debug|error)/i.test(rawTopic)) {
    return {
      antAction:
        "sitting at the desk while tilting its head, one hand on keyboard, visibly puzzled by a floating error panel",
      consoleLog: `console.error("Bug found in ${englishTopic}...");`,
      emotion: "confused",
      cleanTopic,
    };
  }

  if (
    /(bai 1|bài 1|moi bat dau|mới bắt đầu|newbie|co ban|cơ bản|tutorial|learn)/i.test(
      rawTopic,
    )
  ) {
    return {
      antAction:
        "sitting comfortably and typing with focused curiosity, eyes wide and engaged",
      consoleLog: `console.log("Starting journey: ${englishTopic}...");`,
      emotion: "default",
      cleanTopic,
    };
  }

  if (
    /(nang cao|nâng cao|vuot qua|vượt qua|optimiz|performance|scale|production)/i.test(
      rawTopic,
    )
  ) {
    return {
      antAction:
        "typing rapidly with confident posture, slightly leaning forward with energetic body language",
      consoleLog: `console.log("Feature completed: ${englishTopic}!");`,
      emotion: "happy",
      cleanTopic,
    };
  }

  return {
    antAction: pickDeterministicPosition(cleanTopic),
    consoleLog: `console.log("Exploring ${englishTopic}...");`,
    emotion: "default",
    cleanTopic,
  };
}

function buildEnglishTitleHint(topic) {
  const raw = String(topic || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) {
    return DEFAULT_PANEL_MAIN_TEXT;
  }

  const asciiTokens = normalizeAscii(raw).split(/\s+/).filter(Boolean);
  const containsVietnamese =
    hasVietnameseDiacritics(raw) || looksVietnameseByKeywords(raw);

  // Nếu đã là EN thì chỉ cần normalize nhẹ.
  if (!containsVietnamese) {
    const englishLike = compactUpperTitle(asciiTokens, 10, 84);
    return englishLike || DEFAULT_PANEL_MAIN_TEXT;
  }

  // Nếu là VN, map theo từ khóa chính sang EN.
  const mappedTokens = toAsciiLower(raw)
    .split(/\s+/)
    .map((token) => VI_TO_EN_TOKEN_MAP[token] || "")
    .filter(Boolean);
  const mapped = compactUpperTitle(mappedTokens, 8, 72);
  if (mapped) {
    return mapped;
  }

  const fallbackAscii = compactUpperTitle(asciiTokens, 8, 72);
  return fallbackAscii || DEFAULT_PANEL_MAIN_TEXT;
}

function resolveImageInput(input) {
  if (typeof input === "string") {
    return {
      topic: input,
      imageShortTitle: "",
      antAction: "",
      logMessage: "",
      deskSignText: "",
    };
  }

  return {
    topic: String(input?.topic || input?.post_content || "").trim(),
    imageShortTitle: String(
      input?.image_short_title || input?.imageShortTitle || "",
    ).trim(),
    antAction: String(input?.ant_action || input?.antAction || "").trim(),
    logMessage: String(input?.log_message || input?.logMessage || "").trim(),
    deskSignText: String(
      input?.desk_sign_text || input?.deskSignText || "",
    ).trim(),
  };
}

function buildDeskSignText(input = {}) {
  const explicit = compactUpperTitle(
    normalizeAscii(input.deskSignText).split(/\s+/).filter(Boolean),
    4,
    28,
  );
  if (explicit) {
    return explicit;
  }

  const raw = toAsciiLower(
    [input.topic, input.imageShortTitle].filter(Boolean).join(" "),
  );

  if (
    /\b(back|comeback|restart|reboot|return|tro lai|quay lai|khoi dong lai)\b/i.test(
      raw,
    )
  ) {
    return "I'M BACK";
  }

  if (/\b(news|update|tin tuc|cap nhat|launch|release)\b/i.test(raw)) {
    return "NEW DROP";
  }

  if (/\b(debug|bug|fix|loi)\b/i.test(raw)) {
    return "FIX MODE";
  }

  if (/\b(guide|tutorial|huong dan|learn|study)\b/i.test(raw)) {
    return "BUILD MODE";
  }

  if (/\b(insight|share|kinh nghiem|career|deep)\b/i.test(raw)) {
    return "DEEP DIVE";
  }

  if (/\b(tip|trick|hack|meo|snippet)\b/i.test(raw)) {
    return "QUICK HACK";
  }

  if (/\b(showcase|project|demo|build)\b/i.test(raw)) {
    return "BUILT IT";
  }

  return FIXED_DESK_SIGN_TEXT;
}

function sanitizePanelMainText(value, fallback) {
  const primary = buildEnglishTitleHint(value);
  if (primary && primary !== DEFAULT_PANEL_MAIN_TEXT) {
    return primary;
  }

  const secondary = buildEnglishTitleHint(fallback);
  if (secondary) {
    return secondary;
  }

  return DEFAULT_PANEL_MAIN_TEXT;
}

function trimDisplayText(value, maxLength = 80) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function shouldShowLocalizedTitle(localizedTitle, englishTitle) {
  const localized = trimDisplayText(localizedTitle, 120);
  if (!localized) {
    return false;
  }

  const normalizedLocalized = normalizeAscii(localized).toUpperCase();
  const normalizedEnglish = normalizeAscii(englishTitle).toUpperCase();
  return (
    normalizedLocalized !== normalizedEnglish ||
    hasVietnameseDiacritics(localizedTitle)
  );
}

function buildImagePromptPackage(topicOrPayload, emotion = "default") {
  const input = resolveImageInput(topicOrPayload);
  const topic = input.topic || "web development topic";
  const hintTitle = buildEnglishTitleHint(topic);
  const imageTitleEn = sanitizePanelMainText(input.imageShortTitle, hintTitle);
  const localizedTitle = trimDisplayText(topic, 120) || imageTitleEn;
  const imageTitleDisplay = shouldShowLocalizedTitle(
    localizedTitle,
    imageTitleEn,
  )
    ? `${imageTitleEn} (${localizedTitle})`
    : imageTitleEn;

  return {
    prompt: buildImagePrompt(topicOrPayload, emotion),
    imageTitleEn,
    imageTitleLocalized: localizedTitle,
    imageTitleDisplay,
  };
}

function buildImagePrompt(topicOrPayload, emotion = "default") {
  const input = resolveImageInput(topicOrPayload);
  const topic = input.topic || "web development topic";
  const scene = getAntSceneInstructions(topic);
  const sceneEmotion = emotion === "default" ? scene.emotion : emotion;
  const rawTopic = buildEnglishTitleHint(topic) || "WEB DEVELOPMENT TOPIC";
  const hintTitle = buildEnglishTitleHint(topic);
  const panelTitle = sanitizePanelMainText(input.imageShortTitle, hintTitle);
  const robotAction = input.antAction || scene.antAction;
  const logMessage = input.logMessage || scene.consoleLog;
  const deskSignText = buildDeskSignText(input);

  return `
(Cinematic rendered image in tech-noir style), use attached reference image composition and depth if available.

The scene features an adorable sleek mini robot mascot with large glowing blue eyes, a compact rounded body, smooth glossy panels, and elegant blue light seams. The robot is wearing a tiny black tech hoodie with a prominent glowing white React logo on the chest. Dynamic action: ${robotAction}. The robot is seated at a sleek matte black desk, focused on typing on the laptop.

Foreground and branding:
- Laptop lid must show clear white uppercase text: "${FIXED_LAPTOP_LID_TEXT}".
- On the desk in the near foreground, place one miniature sign with clear, legible uppercase text: "${deskSignText}".
- Keep only one visible headphone set on the desk area, with no duplicate headphones anywhere else.

Floating holographic layer:
- In front of the laptop, create one complex free-floating cyber holographic panel with layered cinematic depth.
- Panel main text must stay clear, legible, and uppercase: "${panelTitle}".
- Panel secondary text must be fixed and clear: "${FIXED_PANEL_SUBTEXT}".
- Add subtle glowing white-blue holographic code snippets surrounding the robot.
- Keep the panel text unobstructed and easy to read.

Environment and composition:
- Color palette features crisp white glow, soft silver metallic tones, cool blue lighting, and deep gray shadows.
- The room is a minimal futuristic creator studio with clean desk surfaces, premium dual monitors, soft indirect lighting, and a blurred city night view.
- Remove the glowing wall sign entirely and avoid extra wall branding.
- Composition follows the rule of thirds, with the main subject slightly off-center and the laptop plus character as the primary focal point.
- Use a wide-angle lens, shallow depth of field, and sharp focus on the robot and text panels.
- 3D rendered in Unreal Engine 5 style, premium, clean, cinematic, no watermark, no corner logos.

Scene context:
- Topic context: ${rawTopic}
- Small debug vibe line for scene consistency: ${logMessage}
- Mood tuning: ${getAntEmotionPrompt(sceneEmotion)}
`
    .replace(/\s+/g, " ")
    .trim();
}

function getGoogleApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY || "";
}

function normalizeModelName(name) {
  return String(name || "")
    .trim()
    .replace(/^models\//i, "");
}

function getImageModelCandidates() {
  const primary = normalizeModelName(
    process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image",
  );
  const extra = String(process.env.GEMINI_IMAGE_FALLBACK_MODELS || "")
    .split(",")
    .map((item) => normalizeModelName(item))
    .filter(Boolean);

  return Array.from(
    new Set([
      primary,
      "gemini-2.5-flash-image",
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
      "gemini-2.5-flash",
      ...extra,
    ]),
  );
}

function resolveReferenceImagePath() {
  const configured = String(
    process.env.GEMINI_REFERENCE_IMAGE_PATH ||
      DEFAULT_REFERENCE_IMAGE_RELATIVE_PATH,
  ).trim();
  if (!configured) {
    return "";
  }

  if (path.isAbsolute(configured)) {
    return configured;
  }

  const backendRoot = path.resolve(__dirname, "..", "..");
  return path.resolve(backendRoot, configured);
}

function inferMimeType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

function fileToGenerativePart(filePath, mimeType) {
  const data = fs.readFileSync(filePath);
  return {
    inlineData: {
      data: Buffer.from(data).toString("base64"),
      mimeType,
    },
  };
}

function getReferenceImagePart() {
  const referencePath = resolveReferenceImagePath();
  if (!referencePath || !fs.existsSync(referencePath)) {
    return null;
  }

  const mimeType = inferMimeType(referencePath);
  return fileToGenerativePart(referencePath, mimeType);
}

function extractUrlFromText(text) {
  const matched = String(text || "").match(/https?:\/\/\S+/i);
  return matched ? matched[0] : "";
}

function extractImagePart(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.find((part) => part.inlineData || part.inline_data) || null;
}

function buildFluxFallbackUrl(prompt, seed = null) {
  const encoded = encodeURIComponent(
    String(prompt || "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const value = Number.isInteger(seed)
    ? seed
    : Math.floor(Math.random() * 100000);
  return `https://pollinations.ai/p/${encoded}?width=1280&height=720&model=flux&nologo=true&seed=${value}`;
}

function isTelegramSafePhotoMime(mimeType) {
  return /^image\/(jpeg|jpg|png)$/i.test(String(mimeType || ""));
}

function getInlineFallbackAsset(prompt, reason) {
  return {
    type: "buffer",
    buffer: Buffer.from(INLINE_FALLBACK_PNG_BASE64, "base64"),
    mimeType: "image/png",
    isFallback: true,
    fallbackReason: reason || "inline-fallback",
    prompt,
  };
}

async function callGeminiForImage(prompt, options = {}) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY (or GOOGLE_AI_KEY)");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = getImageModelCandidates();
  const includeReferenceImage = Boolean(options.includeReferenceImage);
  const referenceImagePart = includeReferenceImage
    ? getReferenceImagePart()
    : null;
  if (includeReferenceImage && !referenceImagePart) {
    console.warn(
      `[image.service] Reference image not found at "${resolveReferenceImagePath()}". Fallback to prompt-only mode.`,
    );
  }

  let lastError = null;
  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const requestPayload = referenceImagePart
        ? [referenceImagePart, { text: prompt }]
        : prompt;
      const result = await model.generateContent(requestPayload);
      const response = await result.response;
      return { response, modelName };
    } catch (error) {
      lastError = error;
      const msg = String(error.message || "").toLowerCase();
      const retryableModelError =
        msg.includes("not found") ||
        msg.includes("not supported") ||
        msg.includes("404") ||
        msg.includes("429") ||
        msg.includes("quota");
      if (retryableModelError) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No available Gemini model for generateContent");
}

async function generateImageAsset(topic, emotion = "default") {
  const prompt = buildImagePrompt(topic, emotion);
  try {
    const { response, modelName } = await callGeminiForImage(prompt, {
      includeReferenceImage: true,
    });

    const imagePart = extractImagePart(response);
    if (imagePart) {
      const inline = imagePart.inlineData || imagePart.inline_data;
      if (inline?.data) {
        const mimeType = inline.mimeType || inline.mime_type || "image/png";
        if (isTelegramSafePhotoMime(mimeType)) {
          return {
            type: "buffer",
            buffer: Buffer.from(inline.data, "base64"),
            mimeType,
            model: modelName,
            prompt,
          };
        }
      }
    }

    const text =
      response?.text?.() ||
      response?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join(" ") ||
      "";
    const url = extractUrlFromText(text);
    if (url) {
      try {
        const { buffer, mimeType } = await downloadImageBuffer(url, true);
        if (isTelegramSafePhotoMime(mimeType)) {
          return {
            type: "buffer",
            buffer,
            mimeType,
            model: modelName,
            prompt,
            sourceUrl: url,
          };
        }
        return { type: "url", url, model: modelName, prompt };
      } catch (_downloadError) {
        return { type: "url", url, model: modelName, prompt };
      }
    }

    const fluxUrl = buildFluxFallbackUrl(prompt);
    try {
      const { buffer, mimeType } = await downloadImageBuffer(fluxUrl, true);
      if (isTelegramSafePhotoMime(mimeType)) {
        return {
          type: "buffer",
          buffer,
          mimeType,
          prompt,
          isFallback: true,
          fallbackReason: "flux-url-fallback",
          sourceUrl: fluxUrl,
        };
      }
      return { type: "url", url: fluxUrl, prompt, isFallback: true };
    } catch (_fluxError) {
      return getInlineFallbackAsset(prompt, "flux-download-failed");
    }
  } catch (error) {
    console.error(
      "[image.service] Google image generation error:",
      error.message,
    );
    const fluxUrl = buildFluxFallbackUrl(prompt);
    try {
      const { buffer, mimeType } = await downloadImageBuffer(fluxUrl, true);
      if (isTelegramSafePhotoMime(mimeType)) {
        return {
          type: "buffer",
          buffer,
          mimeType,
          isFallback: true,
          fallbackReason: "google-failed-flux-success",
          error: error.message,
          prompt,
          sourceUrl: fluxUrl,
        };
      }
      return {
        type: "url",
        url: fluxUrl,
        isFallback: true,
        fallbackReason: "google-failed-flux-url",
        error: error.message,
        prompt,
      };
    } catch (_fluxError) {
      return getInlineFallbackAsset(prompt, "google-failed-inline-fallback");
    }
  }
}

async function generateImageUrl(topic, emotion = "default") {
  const asset = await generateImageAsset(topic, emotion);
  if (asset.type === "url" && asset.url) {
    return asset.url;
  }

  if (asset.type === "buffer" && asset.buffer) {
    return `data:${asset.mimeType || "image/png"};base64,${asset.buffer.toString("base64")}`;
  }

  return buildFluxFallbackUrl(buildImagePrompt(topic, emotion));
}

async function generateImageUrlFromPrompt(promptText, options = {}) {
  const prompt = String(promptText || "").trim();
  if (!prompt) {
    return buildFluxFallbackUrl("minimalist tech banner");
  }

  try {
    const { response } = await callGeminiForImage(prompt, {
      includeReferenceImage: Boolean(options.includeReferenceImage),
    });
    const imagePart = extractImagePart(response);

    if (imagePart) {
      const inline = imagePart.inlineData || imagePart.inline_data;
      if (inline?.data) {
        return `data:${inline.mimeType || "image/png"};base64,${inline.data}`;
      }
    }

    const text =
      response?.text?.() ||
      response?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join(" ") ||
      "";
    const url = extractUrlFromText(text);
    if (url) {
      return url;
    }
    return buildFluxFallbackUrl(prompt, options.seed);
  } catch (error) {
    console.error(
      "[image.service] generateImageUrlFromPrompt error:",
      error.message,
    );
    return buildFluxFallbackUrl(prompt, options.seed);
  }
}

async function downloadImageBuffer(imageUrl, withMeta = false) {
  if (String(imageUrl || "").startsWith("data:")) {
    const base64Data = String(imageUrl).split(",")[1] || "";
    const buffer = Buffer.from(base64Data, "base64");
    return withMeta ? { buffer, mimeType: "image/png" } : buffer;
  }

  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const contentType = String(response.headers?.["content-type"] || "");
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Invalid content-type for image: ${contentType || "unknown"}`,
    );
  }

  const buffer = Buffer.from(response.data);
  return withMeta ? { buffer, mimeType: contentType } : buffer;
}

module.exports = {
  buildImagePromptPackage,
  generateImageAsset,
  generateImageUrl,
  generateImageUrlFromPrompt,
  getAntEmotionPrompt,
  downloadImageBuffer,
};
