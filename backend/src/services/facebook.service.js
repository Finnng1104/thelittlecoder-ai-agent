const axios = require("axios");

async function publishToFacebook(message, options = {}) {
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!accessToken || !pageId) {
    throw new Error("FACEBOOK_ACCESS_TOKEN or FACEBOOK_PAGE_ID is missing");
  }

  const response = await axios.post(
    `https://graph.facebook.com/${pageId}/feed`,
    null,
    {
      params: {
        message,
        access_token: accessToken,
        ...(options.link ? { link: options.link } : {}),
      },
    }
  );

  return response.data;
}

module.exports = { publishToFacebook };
