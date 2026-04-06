const axios = require("axios");
const FormData = require("form-data");
const { formatForFacebook } = require("../utils/textFormatter");

function getFacebookCredentials() {
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const pageToken = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_ACCESS_TOKEN;

  if (!pageId || !pageToken) {
    throw new Error(
      "Missing FB_PAGE_ID/FB_PAGE_TOKEN (or FACEBOOK_PAGE_ID/FACEBOOK_ACCESS_TOKEN)"
    );
  }

  return { pageId, pageToken };
}

function normalizeImageInput(imageInput) {
  if (!imageInput) {
    return { mode: "none" };
  }

  if (typeof imageInput === "string") {
    return { mode: "url", url: imageInput };
  }

  if (Buffer.isBuffer(imageInput?.buffer)) {
    return {
      mode: "buffer",
      buffer: imageInput.buffer,
      mimeType: imageInput.mimeType || "image/png",
    };
  }

  if (typeof imageInput?.url === "string" && imageInput.url) {
    return { mode: "url", url: imageInput.url };
  }

  return { mode: "none" };
}

function prepareContentForFacebook(rawText) {
  return formatForFacebook(rawText);
}

async function postToFacebook(message, imageInput = null) {
  try {
    const { pageId, pageToken } = getFacebookCredentials();
    const normalized = normalizeImageInput(imageInput);
    const cleanMessage = prepareContentForFacebook(message);

    if (normalized.mode === "buffer") {
      const form = new FormData();
      form.append("source", normalized.buffer, {
        filename: "cover.png",
        contentType: normalized.mimeType,
      });
      form.append("caption", cleanMessage);
      form.append("access_token", pageToken);

      const response = await axios.post(
        `https://graph.facebook.com/v20.0/${pageId}/photos`,
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: Infinity,
        }
      );
      return response.data.post_id || response.data.id;
    }

    if (normalized.mode === "url") {
      const response = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
        url: normalized.url,
        caption: cleanMessage,
        access_token: pageToken,
      });
      return response.data.post_id || response.data.id;
    }

    const response = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
      message: cleanMessage,
      access_token: pageToken,
    });
    return response.data.post_id || response.data.id;
  } catch (error) {
    console.error("[facebook.service] FB API error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || "Loi API Facebook");
  }
}

async function deleteFacebookPost(postId) {
  try {
    const { pageToken } = getFacebookCredentials();
    await axios.delete(`https://graph.facebook.com/v20.0/${postId}`, {
      params: { access_token: pageToken },
    });
    return true;
  } catch (error) {
    console.error("[facebook.service] FB Delete API error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || "Khong xoa duoc bai");
  }
}

async function publishToFacebook(message, options = {}) {
  return postToFacebook(message, options.imageUrl || null);
}

async function postPhotoToFacebook(message, imageUrl) {
  return postToFacebook(message, imageUrl);
}

module.exports = {
  prepareContentForFacebook,
  postToFacebook,
  deleteFacebookPost,
  publishToFacebook,
  postPhotoToFacebook,
};
