import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import sqlite3 from "sqlite3";

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "app.db");
const UPLOADED_PRODUCTS_TABLE = "uploaded_products";
const RECOMMENDATIONS_TABLE = "recommendations";
const RECOMMENDATIONS_STATE_TABLE = "recommendations_state";
const RECOMMENDATIONS_SEEN_TABLE = "recommendations_seen";
const RECOMMENDATIONS_SAVED_TABLE = "recommendations_saved";
const MARKETING_LINKS_TABLE = "marketing_links";
const MARKETING_CLICKS_TABLE = "marketing_clicks";

function resolveDataDir() {
  const override = String(process.env.COUPLEPHANT_DATA_DIR || "").trim();
  return override ? path.resolve(override) : path.join(process.cwd(), "data");
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function openDb() {
  ensureDir();
  const db = new sqlite3.Database(DB_PATH);
  return db;
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function ensureColumn(db, tableName, columnName, sqlSpec) {
  const cols = await dbAll(db, `PRAGMA table_info(${tableName})`);
  const exists = cols.some((c) => String(c?.name || "") === columnName);
  if (exists) return;
  await dbRun(db, `ALTER TABLE ${tableName} ADD COLUMN ${sqlSpec}`);
}

export async function initDb() {
  const db = openDb();
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  );
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${UPLOADED_PRODUCTS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      normalized_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      image_fingerprint TEXT,
      seller_product_id TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  );

  // Legacy schema compatibility.
  await ensureColumn(db, UPLOADED_PRODUCTS_TABLE, "normalized_url", "normalized_url TEXT NOT NULL DEFAULT ''");
  await ensureColumn(
    db,
    UPLOADED_PRODUCTS_TABLE,
    "normalized_title",
    "normalized_title TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(db, UPLOADED_PRODUCTS_TABLE, "image_url", "image_url TEXT");
  await ensureColumn(db, UPLOADED_PRODUCTS_TABLE, "image_fingerprint", "image_fingerprint TEXT");
  await ensureColumn(db, UPLOADED_PRODUCTS_TABLE, "seller_product_id", "seller_product_id TEXT");
  await ensureColumn(db, UPLOADED_PRODUCTS_TABLE, "status", "status TEXT NOT NULL DEFAULT 'uploaded'");
  await ensureColumn(db, UPLOADED_PRODUCTS_TABLE, "meta_json", "meta_json TEXT NOT NULL DEFAULT '{}'");

  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_uploaded_products_user_url
      ON ${UPLOADED_PRODUCTS_TABLE} (user_id, normalized_url)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_uploaded_products_user_title
      ON ${UPLOADED_PRODUCTS_TABLE} (user_id, normalized_title)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_uploaded_products_user_fingerprint
      ON ${UPLOADED_PRODUCTS_TABLE} (user_id, image_fingerprint)`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${RECOMMENDATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      keyword TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      main_image_url TEXT NOT NULL DEFAULT '',
      source_price REAL,
      shipping_fee REAL,
      final_price REAL,
      profit REAL,
      margin_rate REAL,
      score REAL,
      reason TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  );
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "keyword", "keyword TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "title", "title TEXT NOT NULL DEFAULT ''");
  await ensureColumn(
    db,
    RECOMMENDATIONS_TABLE,
    "main_image_url",
    "main_image_url TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "source_price", "source_price REAL");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "shipping_fee", "shipping_fee REAL");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "final_price", "final_price REAL");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "profit", "profit REAL");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "margin_rate", "margin_rate REAL");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "score", "score REAL");
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "reason", "reason TEXT NOT NULL DEFAULT ''");
  await ensureColumn(
    db,
    RECOMMENDATIONS_TABLE,
    "payload_json",
    "payload_json TEXT NOT NULL DEFAULT '{}'",
  );
  await ensureColumn(db, RECOMMENDATIONS_TABLE, "created_at", "created_at TEXT NOT NULL DEFAULT ''");
  await dbRun(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_user_source
      ON ${RECOMMENDATIONS_TABLE} (user_id, source_url)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_recommendations_user_score
      ON ${RECOMMENDATIONS_TABLE} (user_id, score DESC)`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${RECOMMENDATIONS_STATE_TABLE} (
      user_id TEXT PRIMARY KEY,
      next_keyword_idx INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
  );
  await ensureColumn(
    db,
    RECOMMENDATIONS_STATE_TABLE,
    "next_keyword_idx",
    "next_keyword_idx INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(db, RECOMMENDATIONS_STATE_TABLE, "updated_at", "updated_at TEXT NOT NULL DEFAULT ''");

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${RECOMMENDATIONS_SEEN_TABLE} (
      user_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_url)
    )`,
  );
  await ensureColumn(db, RECOMMENDATIONS_SEEN_TABLE, "last_seen_at", "last_seen_at TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, RECOMMENDATIONS_SEEN_TABLE, "created_at", "created_at TEXT NOT NULL DEFAULT ''");
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_recommendations_seen_user_last_seen
      ON ${RECOMMENDATIONS_SEEN_TABLE} (user_id, last_seen_at DESC)`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${RECOMMENDATIONS_SAVED_TABLE} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      keyword TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      main_image_url TEXT NOT NULL DEFAULT '',
      source_price REAL,
      shipping_fee REAL,
      final_price REAL,
      profit REAL,
      margin_rate REAL,
      score REAL,
      reason TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      saved_at TEXT NOT NULL
    )`,
  );
  await dbRun(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_saved_user_source
      ON ${RECOMMENDATIONS_SAVED_TABLE} (user_id, source_url)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_recommendations_saved_user_saved_at
      ON ${RECOMMENDATIONS_SAVED_TABLE} (user_id, saved_at DESC)`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${MARKETING_LINKS_TABLE} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      target_url TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      campaign TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      term TEXT NOT NULL DEFAULT '',
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_marketing_links_user_created_at
      ON ${MARKETING_LINKS_TABLE} (user_id, created_at DESC)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_marketing_links_user_platform
      ON ${MARKETING_LINKS_TABLE} (user_id, platform, created_at DESC)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_marketing_links_user_campaign
      ON ${MARKETING_LINKS_TABLE} (user_id, campaign, created_at DESC)`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS ${MARKETING_CLICKS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      user_id TEXT NOT NULL,
      clicked_at TEXT NOT NULL,
      referer TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '',
      utm_content TEXT NOT NULL DEFAULT '',
      utm_term TEXT NOT NULL DEFAULT '',
      query_json TEXT NOT NULL DEFAULT '{}'
    )`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_marketing_clicks_user_clicked_at
      ON ${MARKETING_CLICKS_TABLE} (user_id, clicked_at DESC)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_marketing_clicks_slug_clicked_at
      ON ${MARKETING_CLICKS_TABLE} (slug, clicked_at DESC)`,
  );

  db.close();
}

export async function createUser({ email, password }) {
  const db = openDb();
  const existing = await dbGet(db, "SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    db.close();
    throw new Error("email already exists");
  }
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  await dbRun(
    db,
    "INSERT INTO users (id, email, password_hash, settings_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, email, passwordHash, "{}", new Date().toISOString()],
  );
  db.close();
  return { id, email };
}

export async function verifyUser({ email, password }) {
  const db = openDb();
  const user = await dbGet(db, "SELECT id, email, password_hash FROM users WHERE email = ?", [email]);
  db.close();
  if (!user) return null;
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email };
}

export async function listUsersWithSettings({ limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const db = openDb();
  try {
    const rows = await dbAll(
      db,
      "SELECT id, email, settings_json FROM users ORDER BY created_at ASC LIMIT ?",
      [safeLimit],
    );
    return rows.map((row) => {
      let settings = {};
      try {
        settings = JSON.parse(row?.settings_json || "{}");
      } catch {
        settings = {};
      }
      return {
        id: row?.id,
        email: row?.email,
        settings,
      };
    });
  } finally {
    db.close();
  }
}

export async function createSession(userId) {
  if (!userId) throw new Error("userId required");
  const db = openDb();
  const token = crypto.randomBytes(24).toString("hex");
  await dbRun(db, "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", [
    token,
    userId,
    Date.now(),
  ]);
  db.close();
  return token;
}

export async function destroySession(token) {
  const db = openDb();
  await dbRun(db, "DELETE FROM sessions WHERE token = ?", [token]);
  db.close();
}

export async function getUserBySession(token) {
  const db = openDb();
  const row = await dbGet(
    db,
    "SELECT u.id, u.email, u.settings_json FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?",
    [token],
  );
  db.close();
  if (!row) return null;
  let settings = {};
  try {
    settings = JSON.parse(row.settings_json || "{}");
  } catch {
    settings = {};
  }
  return { id: row.id, email: row.email, settings };
}

export async function updateSettings(userId, nextSettings) {
  const db = openDb();
  const row = await dbGet(db, "SELECT settings_json FROM users WHERE id = ?", [userId]);
  if (!row) {
    db.close();
    throw new Error("user not found");
  }
  let current = {};
  try {
    current = JSON.parse(row.settings_json || "{}");
  } catch {
    current = {};
  }
  const merged = { ...current, ...nextSettings };
  await dbRun(db, "UPDATE users SET settings_json = ? WHERE id = ?", [
    JSON.stringify(merged),
    userId,
  ]);
  db.close();
  return merged;
}

export function normalizeSourceUrlForDedupe(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    u.hash = "";

    for (const key of [...u.searchParams.keys()]) {
      if (
        key.startsWith("utm_") ||
        key === "from" ||
        key === "advcnt" ||
        key === "traceId" ||
        key === "searchId" ||
        key === "rank" ||
        key === "sourceType"
      ) {
        u.searchParams.delete(key);
      }
    }

    const sortedEntries = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of sortedEntries) {
      u.searchParams.append(k, v);
    }

    return u.toString();
  } catch {
    return String(rawUrl || "").trim();
  }
}

export function normalizeTitleForDedupe(rawTitle) {
  return String(rawTitle || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCoupangProductUrl(productIdRaw) {
  const productId = String(productIdRaw || "").trim();
  if (!productId) return "";
  return `https://www.coupang.com/vp/products/${productId}`;
}

function normalizeRow(row) {
  if (!row) return null;
  let meta = {};
  try {
    meta = JSON.parse(row.meta_json || "{}");
  } catch {
    meta = {};
  }
  const followUp = meta?.followUp && typeof meta.followUp === "object" ? meta.followUp : {};
  const productId = String(meta?.productId || followUp?.productId || "").trim();
  const productUrl = String(
    meta?.productUrl || followUp?.productUrl || buildCoupangProductUrl(productId),
  ).trim();
  return {
    id: row.id,
    userId: row.user_id,
    sourceUrl: row.source_url,
    normalizedUrl: row.normalized_url,
    title: row.title,
    normalizedTitle: row.normalized_title,
    imageUrl: row.image_url,
    imageFingerprint: row.image_fingerprint,
    sellerProductId: row.seller_product_id,
    productId: productId || null,
    productUrl: productUrl || null,
    status: row.status,
    meta,
    createdAt: row.created_at,
  };
}

export async function findDuplicateUpload({ userId, sourceUrl, title, imageFingerprint }) {
  const uid = String(userId || "global").trim() || "global";
  const normalizedUrl = normalizeSourceUrlForDedupe(sourceUrl);
  const normalizedTitle = normalizeTitleForDedupe(title);
  const fp = String(imageFingerprint || "").trim();

  const db = openDb();
  try {
    if (normalizedUrl) {
      const byUrl = await dbGet(
        db,
        `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE}
         WHERE user_id = ?
           AND normalized_url = ?
           AND seller_product_id IS NOT NULL
           AND TRIM(seller_product_id) <> ''
         ORDER BY id DESC LIMIT 1`,
        [uid, normalizedUrl],
      );
      if (byUrl) return { duplicate: true, reason: "duplicate_url", row: normalizeRow(byUrl) };
    }

    if (normalizedTitle) {
      const byTitle = await dbGet(
        db,
        `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE}
         WHERE user_id = ?
           AND normalized_title = ?
           AND seller_product_id IS NOT NULL
           AND TRIM(seller_product_id) <> ''
         ORDER BY id DESC LIMIT 1`,
        [uid, normalizedTitle],
      );
      if (byTitle) return { duplicate: true, reason: "duplicate_title", row: normalizeRow(byTitle) };
    }

    if (fp) {
      const byFingerprint = await dbGet(
        db,
        `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE}
         WHERE user_id = ?
           AND image_fingerprint = ?
           AND seller_product_id IS NOT NULL
           AND TRIM(seller_product_id) <> ''
         ORDER BY id DESC LIMIT 1`,
        [uid, fp],
      );
      if (byFingerprint) {
        return {
          duplicate: true,
          reason: "duplicate_fingerprint",
          row: normalizeRow(byFingerprint),
        };
      }
    }

    return { duplicate: false };
  } finally {
    db.close();
  }
}

export async function recordUploadedProduct({
  userId,
  sourceUrl,
  title,
  imageUrl,
  imageFingerprint,
  sellerProductId,
  status = "uploaded",
  meta = {},
}) {
  const uid = String(userId || "global").trim() || "global";
  const rawSourceUrl = String(sourceUrl || "");
  const normalizedUrl = normalizeSourceUrlForDedupe(sourceUrl);
  const normalizedTitle = normalizeTitleForDedupe(title);
  const payload = [
    normalizedUrl,
    String(title || ""),
    normalizedTitle,
    String(imageUrl || ""),
    String(imageFingerprint || ""),
    sellerProductId != null ? String(sellerProductId) : null,
    String(status || "uploaded"),
    JSON.stringify(meta || {}),
    new Date().toISOString(),
    uid,
    rawSourceUrl,
  ];

  const db = openDb();
  try {
    const updated = await dbRun(
      db,
      `UPDATE ${UPLOADED_PRODUCTS_TABLE}
       SET normalized_url = ?,
           title = ?,
           normalized_title = ?,
           image_url = ?,
           image_fingerprint = ?,
           seller_product_id = ?,
           status = ?,
           meta_json = ?,
           created_at = ?
       WHERE user_id = ? AND source_url = ?`,
      payload,
    );
    if (updated.changes > 0) return;

    await dbRun(
      db,
      `INSERT INTO ${UPLOADED_PRODUCTS_TABLE}
      (user_id, source_url, normalized_url, title, normalized_title, image_url, image_fingerprint, seller_product_id, status, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
        rawSourceUrl,
        normalizedUrl,
        String(title || ""),
        normalizedTitle,
        String(imageUrl || ""),
        String(imageFingerprint || ""),
        sellerProductId != null ? String(sellerProductId) : null,
        String(status || "uploaded"),
        JSON.stringify(meta || {}),
        new Date().toISOString(),
      ],
    );
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    const sourceUrlConflict =
      msg.includes("sqlite_constraint") &&
      msg.includes(`${UPLOADED_PRODUCTS_TABLE}.user_id`) &&
      msg.includes(`${UPLOADED_PRODUCTS_TABLE}.source_url`);
    if (!sourceUrlConflict) throw err;

    await dbRun(
      db,
      `UPDATE ${UPLOADED_PRODUCTS_TABLE}
       SET normalized_url = ?,
           title = ?,
           normalized_title = ?,
           image_url = ?,
           image_fingerprint = ?,
           seller_product_id = ?,
           status = ?,
           meta_json = ?,
           created_at = ?
       WHERE user_id = ? AND source_url = ?`,
      payload,
    );
  } finally {
    db.close();
  }
}

export async function listUploadedProducts({ userId, q = "", status = "", limit = 200, offset = 0 } = {}) {
  const uid = String(userId || "global").trim() || "global";
  const where = ["user_id = ?"];
  const params = [uid];

  const statusText = String(status || "").trim();
  if (statusText) {
    where.push("status = ?");
    params.push(statusText);
  }

  const keyword = String(q || "").trim();
  if (keyword) {
    const like = `%${keyword}%`;
    where.push("(title LIKE ? OR source_url LIKE ? OR seller_product_id LIKE ?)");
    params.push(like, like, like);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const db = openDb();
  try {
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await dbAll(
      db,
      `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE} ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, safeLimit, safeOffset],
    );
    const cntRow = await dbGet(db, `SELECT COUNT(1) AS cnt FROM ${UPLOADED_PRODUCTS_TABLE} ${whereSql}`, params);
    return {
      items: rows.map(normalizeRow),
      total: Number(cntRow?.cnt || 0),
      limit: safeLimit,
      offset: safeOffset,
    };
  } finally {
    db.close();
  }
}

export async function getUploadedProductById(userId, id) {
  const uid = String(userId || "global").trim() || "global";
  const nid = Number(id);
  if (!Number.isFinite(nid) || nid <= 0) return null;
  const db = openDb();
  try {
    const row = await dbGet(
      db,
      `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE} WHERE user_id = ? AND id = ? LIMIT 1`,
      [uid, Math.floor(nid)],
    );
    return normalizeRow(row);
  } finally {
    db.close();
  }
}

export async function getUploadedProductBySourceUrl(userId, sourceUrl) {
  const uid = String(userId || "global").trim() || "global";
  const raw = String(sourceUrl || "").trim();
  if (!raw) return null;
  const db = openDb();
  try {
    const row = await dbGet(
      db,
      `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE} WHERE user_id = ? AND source_url = ? ORDER BY id DESC LIMIT 1`,
      [uid, raw],
    );
    return normalizeRow(row);
  } finally {
    db.close();
  }
}

export async function getUploadedProductBySellerProductId(userId, sellerProductId) {
  const uid = String(userId || "global").trim() || "global";
  const spid = String(sellerProductId || "").trim();
  if (!spid) return null;
  const db = openDb();
  try {
    const row = await dbGet(
      db,
      `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE}
       WHERE user_id = ? AND seller_product_id = ?
       ORDER BY id DESC LIMIT 1`,
      [uid, spid],
    );
    return normalizeRow(row);
  } finally {
    db.close();
  }
}

export async function updateUploadedProductById({ userId, id, patch = {} } = {}) {
  const uid = String(userId || "global").trim() || "global";
  const nid = Number(id);
  if (!Number.isFinite(nid) || nid <= 0) throw new Error("invalid id");

  const db = openDb();
  try {
    const row = await dbGet(
      db,
      `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE} WHERE user_id = ? AND id = ? LIMIT 1`,
      [uid, Math.floor(nid)],
    );
    if (!row) return null;

    const current = normalizeRow(row) || {};
    const title = patch.title != null ? String(patch.title || "") : String(current.title || "");
    const sourceUrl = patch.sourceUrl != null ? String(patch.sourceUrl || "") : String(current.sourceUrl || "");
    const imageUrl = patch.imageUrl != null ? String(patch.imageUrl || "") : String(current.imageUrl || "");
    const imageFingerprint =
      patch.imageFingerprint != null
        ? String(patch.imageFingerprint || "")
        : String(current.imageFingerprint || "");
    const sellerProductId =
      patch.sellerProductId == null ? current.sellerProductId ?? null : String(patch.sellerProductId || "") || null;
    const status = patch.status != null ? String(patch.status || "uploaded") : String(current.status || "uploaded");

    const mergedMeta =
      patch.metaReplace && typeof patch.metaReplace === "object"
        ? { ...patch.metaReplace }
        : {
            ...(current.meta && typeof current.meta === "object" ? current.meta : {}),
            ...(patch.metaMerge && typeof patch.metaMerge === "object" ? patch.metaMerge : {}),
          };

    await dbRun(
      db,
      `UPDATE ${UPLOADED_PRODUCTS_TABLE}
       SET source_url = ?,
           normalized_url = ?,
           title = ?,
           normalized_title = ?,
           image_url = ?,
           image_fingerprint = ?,
           seller_product_id = ?,
           status = ?,
           meta_json = ?,
           created_at = ?
       WHERE user_id = ? AND id = ?`,
      [
        sourceUrl,
        normalizeSourceUrlForDedupe(sourceUrl),
        title,
        normalizeTitleForDedupe(title),
        imageUrl,
        imageFingerprint,
        sellerProductId,
        status,
        JSON.stringify(mergedMeta || {}),
        new Date().toISOString(),
        uid,
        Math.floor(nid),
      ],
    );

    const updated = await dbGet(
      db,
      `SELECT * FROM ${UPLOADED_PRODUCTS_TABLE} WHERE user_id = ? AND id = ? LIMIT 1`,
      [uid, Math.floor(nid)],
    );
    return normalizeRow(updated);
  } finally {
    db.close();
  }
}

function normalizeMarketingSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

function randomMarketingSlug(length = 8) {
  return crypto
    .randomBytes(Math.max(4, Math.ceil(length)))
    .toString("base64url")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase()
    .slice(0, Math.max(6, Math.min(32, Number(length) || 8)));
}

function isHttpUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeMarketingLinkRow(row) {
  if (!row) return null;
  let extra = {};
  try {
    extra = JSON.parse(row.extra_json || "{}");
  } catch {
    extra = {};
  }
  return {
    id: String(row.id || "").trim(),
    userId: String(row.user_id || "").trim(),
    slug: String(row.slug || "").trim(),
    targetUrl: String(row.target_url || "").trim(),
    sourceUrl: String(row.source_url || "").trim(),
    title: String(row.title || "").trim(),
    platform: String(row.platform || "").trim(),
    campaign: String(row.campaign || "").trim(),
    content: String(row.content || "").trim(),
    term: String(row.term || "").trim(),
    extra,
    createdAt: String(row.created_at || "").trim(),
    clickCount: Number(row.click_count || 0) || 0,
    lastClickedAt: String(row.last_clicked_at || "").trim() || null,
  };
}

function normalizeMarketingClickRow(row) {
  if (!row) return null;
  let query = {};
  try {
    query = JSON.parse(row.query_json || "{}");
  } catch {
    query = {};
  }
  return {
    id: Number(row.id || 0) || 0,
    slug: String(row.slug || "").trim(),
    userId: String(row.user_id || "").trim(),
    clickedAt: String(row.clicked_at || "").trim(),
    referer: String(row.referer || "").trim(),
    userAgent: String(row.user_agent || "").trim(),
    ip: String(row.ip || "").trim(),
    utmSource: String(row.utm_source || "").trim(),
    utmMedium: String(row.utm_medium || "").trim(),
    utmCampaign: String(row.utm_campaign || "").trim(),
    utmContent: String(row.utm_content || "").trim(),
    utmTerm: String(row.utm_term || "").trim(),
    query,
  };
}

export async function createMarketingLink({
  userId,
  slug = "",
  targetUrl,
  sourceUrl = "",
  title = "",
  platform = "",
  campaign = "",
  content = "",
  term = "",
  extra = {},
} = {}) {
  const uid = String(userId || "global").trim() || "global";
  const target = String(targetUrl || "").trim();
  if (!isHttpUrl(target)) throw new Error("invalid_target_url");

  const source = String(sourceUrl || "").trim();
  const sourceSafe = isHttpUrl(source) ? source : "";
  const titleSafe = String(title || "").trim().slice(0, 200);
  const platformSafe = String(platform || "").trim().toLowerCase().slice(0, 50);
  const campaignSafe = String(campaign || "").trim().slice(0, 120);
  const contentSafe = String(content || "").trim().slice(0, 120);
  const termSafe = String(term || "").trim().slice(0, 120);
  const extraSafe =
    extra && typeof extra === "object"
      ? Object.fromEntries(
          Object.entries(extra)
            .slice(0, 20)
            .map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 240)]),
        )
      : {};

  const db = openDb();
  try {
    let finalSlug = normalizeMarketingSlug(slug);
    if (finalSlug) {
      const exists = await dbGet(
        db,
        `SELECT slug FROM ${MARKETING_LINKS_TABLE} WHERE slug = ? LIMIT 1`,
        [finalSlug],
      );
      if (exists) throw new Error("slug_already_exists");
    }

    if (!finalSlug) {
      for (let i = 0; i < 8; i += 1) {
        const candidate = randomMarketingSlug(9);
        const exists = await dbGet(
          db,
          `SELECT slug FROM ${MARKETING_LINKS_TABLE} WHERE slug = ? LIMIT 1`,
          [candidate],
        );
        if (!exists) {
          finalSlug = candidate;
          break;
        }
      }
      if (!finalSlug) throw new Error("slug_generation_failed");
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await dbRun(
      db,
      `INSERT INTO ${MARKETING_LINKS_TABLE}
      (id, user_id, slug, target_url, source_url, title, platform, campaign, content, term, extra_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        uid,
        finalSlug,
        target,
        sourceSafe,
        titleSafe,
        platformSafe,
        campaignSafe,
        contentSafe,
        termSafe,
        JSON.stringify(extraSafe),
        createdAt,
      ],
    );

    const row = await dbGet(
      db,
      `SELECT * FROM ${MARKETING_LINKS_TABLE} WHERE id = ? LIMIT 1`,
      [id],
    );
    return normalizeMarketingLinkRow(row);
  } finally {
    db.close();
  }
}

export async function getMarketingLinkBySlug(slug) {
  const safeSlug = normalizeMarketingSlug(slug);
  if (!safeSlug) return null;
  const db = openDb();
  try {
    const row = await dbGet(
      db,
      `SELECT * FROM ${MARKETING_LINKS_TABLE} WHERE slug = ? LIMIT 1`,
      [safeSlug],
    );
    return normalizeMarketingLinkRow(row);
  } finally {
    db.close();
  }
}

export async function listMarketingLinks({
  userId,
  q = "",
  platform = "",
  campaign = "",
  limit = 100,
  offset = 0,
} = {}) {
  const uid = String(userId || "global").trim() || "global";
  const where = ["l.user_id = ?"];
  const params = [uid];

  const keyword = String(q || "").trim();
  if (keyword) {
    const like = `%${keyword}%`;
    where.push("(l.title LIKE ? OR l.target_url LIKE ? OR l.source_url LIKE ? OR l.slug LIKE ?)");
    params.push(like, like, like, like);
  }
  const platformText = String(platform || "").trim().toLowerCase();
  if (platformText) {
    where.push("l.platform = ?");
    params.push(platformText);
  }
  const campaignText = String(campaign || "").trim();
  if (campaignText) {
    where.push("l.campaign = ?");
    params.push(campaignText);
  }

  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const db = openDb();
  try {
    const rows = await dbAll(
      db,
      `SELECT
         l.*,
         COUNT(c.id) AS click_count,
         MAX(c.clicked_at) AS last_clicked_at
       FROM ${MARKETING_LINKS_TABLE} l
       LEFT JOIN ${MARKETING_CLICKS_TABLE} c
         ON c.slug = l.slug AND c.user_id = l.user_id
       ${whereSql}
       GROUP BY l.id
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, safeOffset],
    );
    const cnt = await dbGet(
      db,
      `SELECT COUNT(1) AS cnt
       FROM ${MARKETING_LINKS_TABLE} l
       ${whereSql}`,
      params,
    );
    return {
      items: rows.map(normalizeMarketingLinkRow),
      total: Number(cnt?.cnt || 0) || 0,
      limit: safeLimit,
      offset: safeOffset,
    };
  } finally {
    db.close();
  }
}

export async function listMarketingClicksBySlug({
  userId,
  slug,
  limit = 200,
  offset = 0,
} = {}) {
  const uid = String(userId || "global").trim() || "global";
  const safeSlug = normalizeMarketingSlug(slug);
  if (!safeSlug) return { items: [], total: 0, limit: 0, offset: 0 };
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const db = openDb();
  try {
    const rows = await dbAll(
      db,
      `SELECT *
       FROM ${MARKETING_CLICKS_TABLE}
       WHERE user_id = ? AND slug = ?
       ORDER BY clicked_at DESC
       LIMIT ? OFFSET ?`,
      [uid, safeSlug, safeLimit, safeOffset],
    );
    const cnt = await dbGet(
      db,
      `SELECT COUNT(1) AS cnt
       FROM ${MARKETING_CLICKS_TABLE}
       WHERE user_id = ? AND slug = ?`,
      [uid, safeSlug],
    );
    return {
      items: rows.map(normalizeMarketingClickRow),
      total: Number(cnt?.cnt || 0) || 0,
      limit: safeLimit,
      offset: safeOffset,
    };
  } finally {
    db.close();
  }
}

export async function recordMarketingClick({
  slug,
  referer = "",
  userAgent = "",
  ip = "",
  query = {},
} = {}) {
  const safeSlug = normalizeMarketingSlug(slug);
  if (!safeSlug) return null;

  const db = openDb();
  try {
    const link = await dbGet(
      db,
      `SELECT user_id, slug FROM ${MARKETING_LINKS_TABLE} WHERE slug = ? LIMIT 1`,
      [safeSlug],
    );
    if (!link?.user_id) return null;

    const queryObj = query && typeof query === "object" ? query : {};
    const clickedAt = new Date().toISOString();
    const utmSource = String(queryObj.utm_source || "").trim().slice(0, 80);
    const utmMedium = String(queryObj.utm_medium || "").trim().slice(0, 80);
    const utmCampaign = String(queryObj.utm_campaign || "").trim().slice(0, 120);
    const utmContent = String(queryObj.utm_content || "").trim().slice(0, 120);
    const utmTerm = String(queryObj.utm_term || "").trim().slice(0, 120);

    await dbRun(
      db,
      `INSERT INTO ${MARKETING_CLICKS_TABLE}
      (slug, user_id, clicked_at, referer, user_agent, ip, utm_source, utm_medium, utm_campaign, utm_content, utm_term, query_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safeSlug,
        String(link.user_id),
        clickedAt,
        String(referer || "").trim().slice(0, 400),
        String(userAgent || "").trim().slice(0, 500),
        String(ip || "").trim().slice(0, 120),
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(queryObj)
              .slice(0, 30)
              .map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 240)]),
          ),
        ),
      ],
    );

    return { slug: safeSlug, userId: String(link.user_id), clickedAt };
  } finally {
    db.close();
  }
}
