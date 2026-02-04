import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import sqlite3 from "sqlite3";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

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

  // Upload preview history (MVP)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS preview_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      source_price REAL,
      final_price REAL,
      image_url TEXT NOT NULL DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      options_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`,
  );

  // Orders (MVP scaffold)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL,          -- domeme | domeggook
      status TEXT NOT NULL,          -- paid | drafted | uploaded | etc.
      order_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  );

  // Uploaded products (dedupe)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS uploaded_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      seller_product_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      final_price REAL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, source_url)
    )`,
  );

  // Web Push subscriptions
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      subscription_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, endpoint)
    )`,
  );

  // APNs device tokens (native app)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS apns_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, device_token)
    )`,
  );

  // Background jobs (upload/preview)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,               -- preview | upload
      status TEXT NOT NULL,             -- queued | running | success | failed
      input_url TEXT NOT NULL,
      force TEXT NOT NULL DEFAULT '0',
      result_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
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
  const user = await dbGet(
    db,
    "SELECT id, email, password_hash FROM users WHERE email = ?",
    [email],
  );
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

export async function addPreviewHistory({
  userId,
  url,
  title = "",
  sourcePrice = null,
  finalPrice = null,
  imageUrl = "",
  images = [],
  options = [],
  // Retention policy (default): keep last 7 days + max 30 rows
  retentionDays = 7,
  maxRows = 30,
}) {
  if (!userId) throw new Error("userId required");
  if (!url) throw new Error("url required");

  const db = openDb();
  const nowIso = new Date().toISOString();

  await dbRun(
    db,
    `INSERT INTO preview_history (
      user_id, url, title, source_price, final_price, image_url, images_json, options_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      String(url),
      String(title || ""),
      Number.isFinite(Number(sourcePrice)) ? Number(sourcePrice) : null,
      Number.isFinite(Number(finalPrice)) ? Number(finalPrice) : null,
      String(imageUrl || ""),
      JSON.stringify(Array.isArray(images) ? images : []),
      JSON.stringify(Array.isArray(options) ? options : []),
      nowIso,
    ],
  );

  // retention: delete old rows
  const days = Math.max(1, Math.min(365, Number(retentionDays) || 7));
  const max = Math.max(1, Math.min(500, Number(maxRows) || 30));
  try {
    await dbRun(
      db,
      `DELETE FROM preview_history
       WHERE user_id = ?
         AND datetime(created_at) < datetime('now', ?)`,
      [userId, `-${days} days`],
    );

    // retention: keep only latest N rows
    await dbRun(
      db,
      `DELETE FROM preview_history
       WHERE user_id = ?
         AND id NOT IN (
           SELECT id
           FROM preview_history
           WHERE user_id = ?
           ORDER BY id DESC
           LIMIT ?
         )`,
      [userId, userId, max],
    );
  } catch {}

  db.close();
}

export async function getUploadedProductByUrl(userId, sourceUrl) {
  if (!userId) throw new Error("userId required");
  if (!sourceUrl) throw new Error("sourceUrl required");
  const db = openDb();
  const row = await dbGet(
    db,
    "SELECT id, user_id, source_url, seller_product_id, title, final_price, created_at FROM uploaded_products WHERE user_id = ? AND source_url = ?",
    [userId, String(sourceUrl)],
  );
  db.close();
  return row || null;
}

export async function upsertUploadedProduct({
  userId,
  sourceUrl,
  sellerProductId = null,
  title = "",
  finalPrice = null,
}) {
  if (!userId) throw new Error("userId required");
  if (!sourceUrl) throw new Error("sourceUrl required");
  const db = openDb();
  const nowIso = new Date().toISOString();
  await dbRun(
    db,
    `INSERT INTO uploaded_products (user_id, source_url, seller_product_id, title, final_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, source_url) DO UPDATE SET
       seller_product_id = excluded.seller_product_id,
       title = excluded.title,
       final_price = excluded.final_price`,
    [
      userId,
      String(sourceUrl),
      sellerProductId != null ? String(sellerProductId) : null,
      String(title || ""),
      Number.isFinite(Number(finalPrice)) ? Number(finalPrice) : null,
      nowIso,
    ],
  );
  db.close();
}

export async function upsertPushSubscription({ userId, subscription }) {
  if (!userId) throw new Error("userId required");
  const sub = subscription || null;
  const endpoint = String(sub?.endpoint || "").trim();
  if (!endpoint) throw new Error("subscription.endpoint required");
  const db = openDb();
  const nowIso = new Date().toISOString();
  await dbRun(
    db,
    `INSERT INTO push_subscriptions (user_id, endpoint, subscription_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, endpoint) DO UPDATE SET
       subscription_json = excluded.subscription_json`,
    [userId, endpoint, JSON.stringify(sub), nowIso],
  );
  db.close();
}

export async function deletePushSubscription({ userId, endpoint }) {
  if (!userId) throw new Error("userId required");
  const ep = String(endpoint || "").trim();
  if (!ep) throw new Error("endpoint required");
  const db = openDb();
  await dbRun(db, "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?", [userId, ep]);
  db.close();
}

export async function upsertApnsToken({ userId, deviceToken }) {
  if (!userId) throw new Error("userId required");
  const token = String(deviceToken || "").trim();
  if (!token) throw new Error("deviceToken required");
  const db = openDb();
  const nowIso = new Date().toISOString();
  await dbRun(
    db,
    `INSERT INTO apns_tokens (user_id, device_token, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, device_token) DO UPDATE SET created_at = excluded.created_at`,
    [userId, token, nowIso],
  );
  db.close();
}

export async function deleteApnsToken({ userId, deviceToken }) {
  if (!userId) throw new Error("userId required");
  const token = String(deviceToken || "").trim();
  if (!token) throw new Error("deviceToken required");
  const db = openDb();
  await dbRun(db, "DELETE FROM apns_tokens WHERE user_id = ? AND device_token = ?", [userId, token]);
  db.close();
}

export async function createJob({ userId, kind, inputUrl, force = '0' }) {
  if (!userId) throw new Error('userId required');
  if (!kind) throw new Error('kind required');
  if (!inputUrl) throw new Error('inputUrl required');
  const db = openDb();
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await dbRun(
    db,
    `INSERT INTO jobs (id, user_id, kind, status, input_url, force, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, '{}', ?, ?)`,
    [id, userId, String(kind), String(inputUrl), String(force), nowIso, nowIso],
  );
  db.close();
  return { id, status: 'queued', kind, inputUrl, force };
}

export async function updateJob({ id, patch = {} }) {
  if (!id) throw new Error('id required');
  const db = openDb();
  const nowIso = new Date().toISOString();

  const fields = [];
  const params = [];

  const allowed = {
    status: 'status',
    resultJson: 'result_json',
    errorCode: 'error_code',
    errorMessage: 'error_message',
  };

  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] === undefined) continue;
    fields.push(`${col} = ?`);
    params.push(
      k === 'resultJson' ? JSON.stringify(patch[k] ?? {}) : (patch[k] ?? null),
    );
  }

  fields.push('updated_at = ?');
  params.push(nowIso);
  params.push(String(id));

  await dbRun(db, `UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, params);
  db.close();
}

export async function getJob(userId, id) {
  if (!userId) throw new Error('userId required');
  if (!id) throw new Error('id required');
  const db = openDb();
  const row = await dbGet(
    db,
    'SELECT id, user_id, kind, status, input_url, force, result_json, error_code, error_message, created_at, updated_at FROM jobs WHERE user_id = ? AND id = ?',
    [userId, String(id)],
  );
  db.close();
  if (!row) return null;
  let result = {};
  try { result = JSON.parse(row.result_json || '{}'); } catch {}
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    inputUrl: row.input_url,
    force: row.force,
    result,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listApnsTokens(userId) {
  if (!userId) throw new Error("userId required");
  const db = openDb();
  const rows = await dbAll(
    db,
    "SELECT device_token FROM apns_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 20",
    [userId],
  );
  db.close();
  return (rows || []).map((r) => String(r.device_token || "")).filter(Boolean);
}

export async function listPushSubscriptions(userId) {
  if (!userId) throw new Error("userId required");
  const db = openDb();
  const rows = await dbAll(
    db,
    "SELECT subscription_json FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10",
    [userId],
  );
  db.close();
  const out = [];
  for (const r of rows || []) {
    try {
      const sub = JSON.parse(r.subscription_json || "{}");
      if (sub?.endpoint) out.push(sub);
    } catch {}
  }
  return out;
}

export async function listPreviewHistory(userId, limit = 50) {
  if (!userId) throw new Error("userId required");
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  const db = openDb();
  const rows = await dbAll(
    db,
    `SELECT id, url, title, source_price, final_price, image_url, images_json, options_json, created_at
     FROM preview_history
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [userId, lim],
  );
  db.close();

  return rows.map((r) => {
    let images = [];
    let options = [];
    try {
      images = JSON.parse(r.images_json || "[]");
    } catch {}
    try {
      options = JSON.parse(r.options_json || "[]");
    } catch {}
    return {
      id: r.id,
      at: r.created_at,
      url: r.url,
      title: r.title,
      sourcePrice: r.source_price,
      finalPrice: r.final_price,
      imageUrl: r.image_url,
      images,
      options,
    };
  });
}
