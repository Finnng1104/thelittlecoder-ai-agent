const axios = require("axios");

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

async function postToFacebook(message, imageUrl = null) {
  try {
    const { pageId, pageToken } = getFacebookCredentials();
    const endpoint = imageUrl
      ? `https://graph.facebook.com/v20.0/${pageId}/photos`
      : `https://graph.facebook.com/v20.0/${pageId}/feed`;

    const payload = imageUrl
      ? { url: imageUrl, caption: message, access_token: pageToken }
      : { message, access_token: pageToken };

    const response = await axios.post(endpoint, payload);
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
  postToFacebook,
  deleteFacebookPost,
  publishToFacebook,
  postPhotoToFacebook,
};
