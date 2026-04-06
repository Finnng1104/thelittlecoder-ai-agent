require("dotenv").config();

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
const ENDPOINT_VERSIONS = ["v1", "v1beta"];

function printModel(model) {
  const name = model?.name || "(unknown)";
  const methods = Array.isArray(model?.supportedGenerationMethods)
    ? model.supportedGenerationMethods.join(", ")
    : "none";
  console.log(`- ${name} (supported: ${methods})`);
}

async function fetchModels(version) {
  const url = `https://generativelanguage.googleapis.com/${version}/models?key=${API_KEY}`;
  const response = await fetch(url);

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    const errorMessage =
      payload?.error?.message || `Request failed with status ${response.status}`;
    throw new Error(`[${version}] ${errorMessage}`);
  }

  return payload?.models || [];
}

async function run() {
  if (!API_KEY) {
    console.error("Missing GOOGLE_API_KEY or GOOGLE_AI_KEY in backend/.env");
    process.exit(1);
  }

  for (const version of ENDPOINT_VERSIONS) {
    try {
      const models = await fetchModels(version);
      console.log(`\n=== Available models via ${version} ===`);

      if (models.length === 0) {
        console.log("(no models returned)");
        continue;
      }

      models.forEach(printModel);

      const generateContentModels = models
        .filter((model) =>
          Array.isArray(model.supportedGenerationMethods) &&
          model.supportedGenerationMethods.includes("generateContent")
        )
        .map((model) => model.name);

      console.log("\nModels that support generateContent:");
      if (generateContentModels.length === 0) {
        console.log("(none)");
      } else {
        generateContentModels.forEach((modelName) => console.log(`- ${modelName}`));
      }
    } catch (error) {
      console.error(`\nCould not list models from ${version}: ${error.message}`);
    }
  }
}

run();
