import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import sqlite3 from "sqlite3";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const UPLOADED_PRODUCTS_TABLE = "uploaded_products";

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

function normalizeRow(row) {
  if (!row) return null;
  let meta = {};
  try {
    meta = JSON.parse(row.meta_json || "{}");
  } catch {
    meta = {};
  }
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
