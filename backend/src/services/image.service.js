const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const THE_LITTLE_CODER_BASE_PROMPT = `
# THE LITTLE CODER - VISUAL IDENTITY & PERFECT LAYOUT

## Core Aesthetic:
- Style: Minimalist Geometric 3D Render, Low-Poly Aesthetic, Tech-Noir.
- Color Palette: Deep Black Background (#111111), Electric Cyan (#00C8C8) light accents.

## The Perfect Layout (Fixed):
- Background: A clean, deeply shadowed black room. Subtle abstract cyan geometric light lines are barely visible in the far distance, creating a thoughtful, determined atmosphere.
- Desk: A large, centered matte black desk with subtle cyan neon light edges.
- Foreground Element: Positioned centrally on the desk is a sleek matte black laptop. The laptop lid displays the centered teal code: "the little coder".
- Main Mascot: A newly designed, small, sturdy stylized minimalist 3D ant mascot, rendered in dark matte grey (#111111). The ant is standing carefully behind the desk and the laptop, looking determinedly forward. Critically, its antennae are stylized and emit a distinct, flickering electric cyan glow effect. Subtle cyan light glints off its segmented body and geometric form.
- The Neon Panel (Unobstructed): Positioned behind the desk and ant, a large, centered glowing cyan neon panel (rectangle shape, like a chalkboard) will display the content. Minimalist cyan mono font. The ant's state and position remain fixed.

## Dynamic Content Replacement (On the Neon Panel):
- Future blog posts will only replace the Vietnamese text and the console log message on the neon panel.
- All original fixed elements (icons, positions) must remain unobstructed.

High-quality 3D render, isometric tech style, cinematic lighting, sharp focus, vibrant colors, minimalist background, professional developer vibe, no watermark, no logo.
`.trim();
const INLINE_FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+AP6XqVYxQAAAABJRU5ErkJggg==";
const DEFAULT_REFERENCE_IMAGE_RELATIVE_PATH = "assets/anh-mau.jpg";

function sanitizeTopic(topic) {
  return String(topic || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripNoiseWords(topic) {
  return topic
    .replace(
      /\b(post|chia se|hanh trinh|ve|viet bai|bai viet|share|story|journey)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function getAntEmotionPrompt(emotion = "default") {
  switch (String(emotion).toLowerCase()) {
    case "confused":
      return "The ant antennae glow is dim, unstable, and flickering with uneven cyan pulses.";
    case "happy":
      return "The ant antennae glow is bright, stable, and energetic with subtle cyan sparks.";
    default:
      return "The ant antennae glow is stable, clean, and focused in cyan.";
  }
}

function pickDeterministicPosition(topic) {
  const positions = [
    "standing on the right side of the desk, facing the neon panel",
    "standing on the left side of the desk, facing the neon panel",
    "standing behind the laptop, facing the neon panel",
  ];

  const seed = String(topic || "")
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return positions[seed % positions.length];
}

function getAntSceneInstructions(topic) {
  const rawTopic = String(topic || "").toLowerCase();
  const cleanTopic = stripNoiseWords(sanitizeTopic(topic)) || "software engineering";

  if (/(bug|loi|lỗi|fix|debug|error)/i.test(rawTopic)) {
    return {
      antAction:
        "sitting on the desk, looking confused at the laptop screen, scratching its head with a tiny hand",
      consoleLog: 'console.error("Bug found: Unexpected behavior...");',
      emotion: "confused",
      cleanTopic,
    };
  }

  if (/(bai 1|bài 1|moi bat dau|mới bắt đầu|newbie|co ban|cơ bản)/i.test(rawTopic)) {
    return {
      antAction:
        "standing on a small stack of books, looking eager at the neon panel, holding a tiny pencil",
      consoleLog: `console.log("Starting journey: ${cleanTopic}...");`,
      emotion: "default",
      cleanTopic,
    };
  }

  if (/(nang cao|nâng cao|vuot qua|vượt qua|optimiz|performance|scale|production)/i.test(rawTopic)) {
    return {
      antAction: "jumping happily on the desk while celebrating with a tiny flag",
      consoleLog: `console.log("Feature completed: ${cleanTopic}!");`,
      emotion: "happy",
      cleanTopic,
    };
  }

  return {
    antAction: pickDeterministicPosition(cleanTopic),
    consoleLog: `console.log("Exploring ${cleanTopic}...");`,
    emotion: "default",
    cleanTopic,
  };
}

function buildDynamicNeonText(topic, emotion = "default") {
  const scene = getAntSceneInstructions(topic);
  const sceneEmotion = emotion === "default" ? scene.emotion : emotion;

  return (
    `${getAntEmotionPrompt(sceneEmotion)} ` +
    `On the large cyan neon panel behind the ant, only replace the Vietnamese text with: ` +
    `'Moi anh em cung "tham" ve ${scene.cleanTopic} cho anh em newbie'. ` +
    `Set the small console text to: ${scene.consoleLog} ` +
    `The ant action should be: ${scene.antAction}. ` +
    "Unobstructed view of all original elements (icons, the little coder logo, the ant)."
  );
}

function getGoogleApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY || "";
}

function buildMasterPrompt(topic, emotion = "default") {
  const dynamicPart = buildDynamicNeonText(topic, emotion);
  return `${THE_LITTLE_CODER_BASE_PROMPT}\n${dynamicPart}`
    .replace(/\s+/g, " ")
    .trim();
}

function buildStrictReferencePrompt(topic, emotion = "default") {
  const scene = getAntSceneInstructions(topic);
  const sceneEmotion = emotion === "default" ? scene.emotion : emotion;

  return `
[STRICT INSTRUCTION - REFERENCE IMAGE ATTACHED]
1. REPLICATE LAYOUT: Use the attached reference image as the absolute source of layout and visual identity.
2. KEEP BRAND FIXED:
   - Keep the same 3D ant mascot identity (low-poly body, cyan glowing antennae).
   - The matte black laptop with glowing teal text "the little coder".
   - Dark tech-noir room and centered cyan neon panel.
   - Keep cinematic lighting and the same minimalist composition language.
3. DYNAMIC UPDATE:
   - Only replace the neon panel text with: "Moi anh em cung 'tham' ve ${scene.cleanTopic} cho newbie".
   - Keep text centered, legible, cyan monospaced style.
   - Update bottom-right console text to: ${scene.consoleLog}
4. DYNAMIC ANT CHARACTER:
   - Action and position: ${scene.antAction}
   - The ant still faces the panel or laptop contextually and must remain clearly visible.
   - The neon panel text must stay unobstructed.
5. QUALITY: Professional 3D render, 16:9 ratio, high resolution.
6. GUARDRAIL: Do not redesign brand identity. Do not replace mascot species. Do not add unrelated objects.
7. ANT EMOTION: ${getAntEmotionPrompt(sceneEmotion)}
`
    .replace(/\s+/g, " ")
    .trim();
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

function isTelegramSafePhotoMime(mimeType) {
  return /^image\/(jpeg|jpg|png)$/i.test(String(mimeType || ""));
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
        msg.includes("404");
      if (retryableModelError) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No available Gemini model for generateContent");
}

async function generateImageAsset(topic, emotion = "default") {
  try {
    const prompt =
      `${buildMasterPrompt(topic, emotion)} ${buildStrictReferencePrompt(
        topic,
        emotion,
      )}`
        .replace(/\s+/g, " ")
        .trim();
    const { response, modelName } = await callGeminiForImage(prompt, {
      includeReferenceImage: true,
    });

    const imagePart = extractImagePart(response);
    if (imagePart) {
      const inline = imagePart.inlineData || imagePart.inline_data;
      if (inline?.data) {
        const mimeType = inline.mimeType || inline.mime_type || "image/png";
        if (!isTelegramSafePhotoMime(mimeType)) {
          console.warn(
            `[image.service] Unsupported inline mime for Telegram photo: ${mimeType}`,
          );
        } else {
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
        return {
          type: "url",
          url,
          model: modelName,
          prompt,
          fallbackReason: `unsafe-mime:${mimeType}`,
        };
      } catch (downloadError) {
        return { type: "url", url, model: modelName, prompt };
      }
    }

    const fluxUrl = buildFluxFallbackUrl(prompt);
    try {
      const { buffer, mimeType } = await downloadImageBuffer(fluxUrl, true);
      if (!isTelegramSafePhotoMime(mimeType)) {
        return {
          type: "url",
          url: fluxUrl,
          prompt,
          isFallback: true,
          fallbackReason: `flux-unsafe-mime:${mimeType}`,
        };
      }
      return {
        type: "buffer",
        buffer,
        mimeType,
        prompt,
        isFallback: true,
        fallbackReason: "flux-url-fallback",
        sourceUrl: fluxUrl,
      };
    } catch (fluxError) {
      return getInlineFallbackAsset(prompt, "flux-download-failed");
    }
  } catch (error) {
    console.error(
      "[image.service] Google image generation error:",
      error.message,
    );
    const prompt = buildMasterPrompt(topic, emotion);
    const fluxUrl = buildFluxFallbackUrl(prompt);
    try {
      const { buffer, mimeType } = await downloadImageBuffer(fluxUrl, true);
      if (!isTelegramSafePhotoMime(mimeType)) {
        return {
          type: "url",
          url: fluxUrl,
          isFallback: true,
          fallbackReason: `google-failed-flux-unsafe-mime:${mimeType}`,
          error: error.message,
          prompt,
        };
      }
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

  return buildFluxFallbackUrl(buildMasterPrompt(topic, emotion));
}

async function generateImageUrlFromPrompt(promptText, options = {}) {
  try {
    const prompt = String(promptText || "");
    const { response } = await callGeminiForImage(prompt);
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
    return buildFluxFallbackUrl(String(promptText || ""), options.seed);
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
  generateImageAsset,
  generateImageUrl,
  generateImageUrlFromPrompt,
  getAntEmotionPrompt,
  downloadImageBuffer,
};
