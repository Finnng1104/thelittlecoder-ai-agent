const axios = require("axios");

function sanitizeTopic(topic) {
  return String(topic || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toCleanPrompt(input) {
  const cleanTopic = sanitizeTopic(input) || "technology";
  return `modern tech logo for ${cleanTopic} 3d render high resolution`
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateImageUrlFromPrompt(promptText) {
  const prompt = toCleanPrompt(promptText);
  const seed = Math.floor(Math.random() * 1000);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}`;
}

function generateImageUrl(topic) {
  return generateImageUrlFromPrompt(topic);
}

async function downloadImageBuffer(imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return Buffer.from(response.data);
}

module.exports = { generateImageUrl, generateImageUrlFromPrompt, downloadImageBuffer };
