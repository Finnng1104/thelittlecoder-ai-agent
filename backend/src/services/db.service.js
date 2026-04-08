let pgModule = null;
try {
  pgModule = require("pg");
} catch (_error) {
  pgModule = null;
}

const Pool = pgModule?.Pool || null;
const DEFAULT_STORAGE_DRIVER = "postgres";
let warnedUnavailable = false;
let poolInstance = null;
let schemaInitialized = false;

function nowIso() {
  return new Date().toISOString();
}

function parseBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "y", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(raw)) {
    return false;
  }
  return fallback;
}

function isFileFallbackAllowed() {
  return parseBoolean(process.env.STORAGE_ALLOW_FILE_FALLBACK, false);
}

function resolveStorageDriver() {
  return String(process.env.STORAGE_DRIVER || DEFAULT_STORAGE_DRIVER)
    .trim()
    .toLowerCase();
}

function isPostgresStorageEnabled() {
  const driver = resolveStorageDriver();
  const usePg = ["postgres", "postgresql", "pg"].includes(driver);
  if (!usePg) {
    return false;
  }

  if (!process.env.DATABASE_URL) {
    if (!isFileFallbackAllowed()) {
      return false;
    }
    if (!warnedUnavailable) {
      console.warn(
        "[db.service] STORAGE_DRIVER=postgres nhưng thiếu DATABASE_URL. Tự fallback về file JSON."
      );
      warnedUnavailable = true;
    }
    return false;
  }

  if (!Pool) {
    if (!isFileFallbackAllowed()) {
      return false;
    }
    if (!warnedUnavailable) {
      console.warn(
        "[db.service] Thiếu package \"pg\" nên không thể dùng Postgres. Tự fallback về file JSON."
      );
      warnedUnavailable = true;
    }
    return false;
  }

  return true;
}

function resolvePostgresDescriptor() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  if (!raw) {
    return "postgres:<missing DATABASE_URL>";
  }
  try {
    const url = new URL(raw);
    const host = url.hostname || "unknown-host";
    const dbName = String(url.pathname || "").replace(/^\/+/, "") || "unknown-db";
    return `postgres:${host}/${dbName}`;
  } catch (_error) {
    return "postgres:<invalid DATABASE_URL>";
  }
}

function assertStorageConfiguration() {
  const driver = resolveStorageDriver();
  const wantsPostgres = ["postgres", "postgresql", "pg"].includes(driver);
  if (!wantsPostgres) {
    return;
  }

  const allowFallback = isFileFallbackAllowed();
  if (!process.env.DATABASE_URL) {
    if (!allowFallback) {
      throw new Error(
        "STORAGE_DRIVER=postgres nhưng thiếu DATABASE_URL và STORAGE_ALLOW_FILE_FALLBACK=false."
      );
    }
    return;
  }

  if (!Pool) {
    if (!allowFallback) {
      throw new Error(
        "STORAGE_DRIVER=postgres nhưng chưa cài package pg và STORAGE_ALLOW_FILE_FALLBACK=false."
      );
    }
  }
}

function getPool() {
  if (!isPostgresStorageEnabled()) {
    return null;
  }

  if (poolInstance) {
    return poolInstance;
  }

  const ssl =
    parseBoolean(process.env.PG_REQUIRE_SSL, false) ||
    String(process.env.PGSSLMODE || "").toLowerCase() === "require"
      ? { rejectUnauthorized: false }
      : undefined;

  poolInstance = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 5),
    ssl,
  });

  poolInstance.on("error", (error) => {
    console.error("[db.service] Postgres pool error:", error.message);
  });

  return poolInstance;
}

async function initSchemaIfNeeded() {
  if (schemaInitialized) {
    return;
  }

  const pool = getPool();
  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      payload_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS draft_records (
      draft_id TEXT PRIMARY KEY,
      chat_id TEXT,
      payload_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  schemaInitialized = true;
}

async function readJsonState(stateKey, fallbackValue = null) {
  const pool = getPool();
  if (!pool) {
    return fallbackValue;
  }

  try {
    await initSchemaIfNeeded();
    const key = String(stateKey || "").trim();
    if (!key) {
      return fallbackValue;
    }

    const result = await pool.query(
      "SELECT payload_json FROM app_state WHERE state_key = $1 LIMIT 1",
      [key]
    );
    const row = result.rows?.[0];
    if (!row || row.payload_json === undefined || row.payload_json === null) {
      return fallbackValue;
    }

    if (typeof row.payload_json === "string") {
      return JSON.parse(row.payload_json);
    }
    return row.payload_json;
  } catch (error) {
    console.error("[db.service] readJsonState error:", error.message);
    return fallbackValue;
  }
}

async function writeJsonState(stateKey, value) {
  const pool = getPool();
  if (!pool) {
    return value;
  }

  const key = String(stateKey || "").trim();
  if (!key) {
    throw new Error("stateKey is required");
  }

  try {
    await initSchemaIfNeeded();
    await pool.query(
      `
      INSERT INTO app_state (state_key, payload_json, updated_at)
      VALUES ($1, $2::jsonb, $3::timestamptz)
      ON CONFLICT(state_key)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `,
      [key, JSON.stringify(value ?? null), nowIso()]
    );
    return value;
  } catch (error) {
    console.error("[db.service] writeJsonState error:", error.message);
    throw error;
  }
}

async function upsertJsonDraft(draftId, chatId, value) {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const id = String(draftId || "").trim();
  if (!id) {
    throw new Error("draftId is required");
  }

  try {
    await initSchemaIfNeeded();
    await pool.query(
      `
      INSERT INTO draft_records (draft_id, chat_id, payload_json, updated_at)
      VALUES ($1, $2, $3::jsonb, $4::timestamptz)
      ON CONFLICT(draft_id)
      DO UPDATE SET
        chat_id = excluded.chat_id,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `,
      [id, String(chatId || "").trim(), JSON.stringify(value ?? null), nowIso()]
    );
    return value;
  } catch (error) {
    console.error("[db.service] upsertJsonDraft error:", error.message);
    throw error;
  }
}

async function getJsonDraft(draftId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  const id = String(draftId || "").trim();
  if (!id) {
    return null;
  }

  try {
    await initSchemaIfNeeded();
    const result = await pool.query(
      "SELECT payload_json FROM draft_records WHERE draft_id = $1 LIMIT 1",
      [id]
    );
    const row = result.rows?.[0];
    if (!row || row.payload_json === undefined || row.payload_json === null) {
      return null;
    }
    if (typeof row.payload_json === "string") {
      return JSON.parse(row.payload_json);
    }
    return row.payload_json;
  } catch (error) {
    console.error("[db.service] getJsonDraft error:", error.message);
    return null;
  }
}

async function deleteJsonDraft(draftId) {
  const pool = getPool();
  if (!pool) {
    return false;
  }

  const id = String(draftId || "").trim();
  if (!id) {
    return false;
  }

  try {
    await initSchemaIfNeeded();
    const result = await pool.query("DELETE FROM draft_records WHERE draft_id = $1", [id]);
    return Number(result.rowCount || 0) > 0;
  } catch (error) {
    console.error("[db.service] deleteJsonDraft error:", error.message);
    return false;
  }
}

async function countDraftRows() {
  const pool = getPool();
  if (!pool) {
    return 0;
  }

  try {
    await initSchemaIfNeeded();
    const result = await pool.query("SELECT COUNT(1)::int AS total FROM draft_records");
    return Number(result.rows?.[0]?.total || 0);
  } catch (error) {
    console.error("[db.service] countDraftRows error:", error.message);
    return 0;
  }
}

async function countAppStateRows() {
  const pool = getPool();
  if (!pool) {
    return 0;
  }

  try {
    await initSchemaIfNeeded();
    const result = await pool.query("SELECT COUNT(1)::int AS total FROM app_state");
    return Number(result.rows?.[0]?.total || 0);
  } catch (error) {
    console.error("[db.service] countAppStateRows error:", error.message);
    return 0;
  }
}

async function clearAllPostgresData() {
  const pool = getPool();
  if (!pool) {
    return false;
  }

  try {
    await initSchemaIfNeeded();
    await pool.query("TRUNCATE TABLE draft_records, app_state");
    return true;
  } catch (error) {
    console.error("[db.service] clearAllPostgresData error:", error.message);
    return false;
  }
}

module.exports = {
  isPostgresStorageEnabled,
  isFileFallbackAllowed,
  resolveStorageDriver,
  resolvePostgresDescriptor,
  assertStorageConfiguration,
  readJsonState,
  writeJsonState,
  upsertJsonDraft,
  getJsonDraft,
  deleteJsonDraft,
  countDraftRows,
  countAppStateRows,
  clearAllPostgresData,
};
