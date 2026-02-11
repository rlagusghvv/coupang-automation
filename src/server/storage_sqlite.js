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

async function tableInfo(db, table) {
  try {
    return await dbAll(db, `PRAGMA table_info(${table})`);
  } catch {
    return [];
  }
}

async function ensureColumn(db, table, column, colDefSql) {
  const info = await tableInfo(db, table);
  const exists = Array.isArray(info) && info.some((c) => String(c?.name || '') === column);
  if (exists) return false;
  await dbRun(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${colDefSql}`);
  return true;
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
      catalog_id TEXT,
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

  // Presets (named settings snapshots)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    )`,
  );

  // Catalog products (B-style)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS catalog_products (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      confirmed_title TEXT NOT NULL DEFAULT '',
      main_image_url TEXT NOT NULL DEFAULT '',
      detail_images_json TEXT NOT NULL DEFAULT '[]',
      preset_id TEXT,
      category_override INTEGER,
      seller_product_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      validation_json TEXT NOT NULL DEFAULT '{}',
      last_source_snapshot_json TEXT NOT NULL DEFAULT '{}',
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deployed_at TEXT,
      UNIQUE(user_id, source_url)
    )`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS recommendations (
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
      created_at TEXT NOT NULL,
      UNIQUE(user_id, source_url)
    )`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS recommendations_state (
      user_id TEXT PRIMARY KEY,
      next_keyword_idx INTEGER NOT NULL DEFAULT 0,
      last_notified_at TEXT,
      updated_at TEXT NOT NULL
    )`,
  );

  // Catalog events (sync/change log)
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS catalog_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  );

  // Migrations
  try { await ensureColumn(db, 'jobs', 'catalog_id', 'TEXT'); } catch {}
  try { await ensureColumn(db, 'catalog_products', 'last_source_snapshot_json', "TEXT NOT NULL DEFAULT '{}'" ); } catch {}
  try { await ensureColumn(db, 'catalog_products', 'last_synced_at', 'TEXT'); } catch {}
  try { await ensureColumn(db, 'recommendations_state', 'last_notified_at', 'TEXT'); } catch {}

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

export async function listUsersForSync() {
  const db = openDb();
  const rows = await dbAll(db, 'SELECT id, settings_json FROM users', []);
  db.close();
  return rows.map((r) => {
    let settings = {};
    try { settings = JSON.parse(r.settings_json || '{}'); } catch {}
    return { id: r.id, settings };
  });
}

// Users who have at least one push target (Web Push subscription or APNs token)
export async function listUsersWithPushTargets() {
  const db = openDb();
  const rows = await dbAll(
    db,
    `SELECT u.id, u.settings_json
     FROM users u
     WHERE EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)
        OR EXISTS (SELECT 1 FROM apns_tokens at WHERE at.user_id = u.id)`,
    [],
  );
  db.close();
  return rows.map((r) => {
    let settings = {};
    try { settings = JSON.parse(r.settings_json || '{}'); } catch {}
    return { id: r.id, settings };
  });
}

export async function getRecommendationsNotifyState(userId) {
  const db = openDb();
  const row = await dbGet(db, 'SELECT last_notified_at FROM recommendations_state WHERE user_id = ?', [userId]);
  db.close();
  return {
    lastNotifiedAt: row?.last_notified_at ? String(row.last_notified_at) : '',
  };
}

export async function setRecommendationsLastNotifiedAt(userId, iso) {
  const db = openDb();
  const now = new Date().toISOString();
  // Ensure row exists; keep next_keyword_idx as-is
  await dbRun(
    db,
    `INSERT INTO recommendations_state (user_id, next_keyword_idx, last_notified_at, updated_at)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_notified_at = excluded.last_notified_at, updated_at = excluded.updated_at`,
    [userId, String(iso || now), now],
  );
  db.close();
}

export async function clearRecommendationsForUser(userId) {
  const db = openDb();
  await dbRun(db, 'DELETE FROM recommendations WHERE user_id = ?', [userId]);
  // Reset cursor so keyword rotation starts from the beginning.
  await dbRun(
    db,
    `INSERT INTO recommendations_state (user_id, next_keyword_idx, updated_at)
     VALUES (?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET next_keyword_idx = 0, updated_at = excluded.updated_at`,
    [userId, new Date().toISOString()],
  );
  db.close();
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

export async function createJob({ userId, kind, inputUrl, force = '0', catalogId = null }) {
  if (!userId) throw new Error('userId required');
  if (!kind) throw new Error('kind required');
  // inputUrl is optional for some background jobs (e.g. recommendations)
  if (inputUrl == null) throw new Error('inputUrl required');
  const db = openDb();
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await dbRun(
    db,
    `INSERT INTO jobs (id, user_id, kind, status, input_url, force, catalog_id, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, '{}', ?, ?)`,
    [id, userId, String(kind), String(inputUrl), String(force), catalogId ? String(catalogId) : null, nowIso, nowIso],
  );
  db.close();
  return { id, status: 'queued', kind, inputUrl, force, catalogId: catalogId ? String(catalogId) : null };
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

export async function getActiveJobByKind(userId, kind, activeStatuses = ['queued', 'running']) {
  if (!userId) throw new Error('userId required');
  if (!kind) throw new Error('kind required');
  const db = openDb();
  const statuses = Array.isArray(activeStatuses) && activeStatuses.length > 0 ? activeStatuses : ['queued', 'running'];
  const placeholders = statuses.map(() => '?').join(', ');
  const row = await dbGet(
    db,
    `SELECT id, user_id, kind, status, input_url, force, result_json, error_code, error_message, created_at, updated_at
     FROM jobs
     WHERE user_id = ? AND kind = ? AND status IN (${placeholders})
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(userId), String(kind), ...statuses.map(String)],
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

// ---- Catalog Products (B-style) ----
function normalizeImages(arr, limit = 50) {
  const list = Array.isArray(arr) ? arr : [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const s = String(x || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export async function upsertCatalogProduct({
  userId,
  sourceUrl,
  confirmedTitle = '',
  mainImageUrl = '',
  detailImages = [],
  presetId = null,
  categoryOverride = null,
  status = 'draft',
}) {
  if (!userId) throw new Error('userId required');
  const url = String(sourceUrl || '').trim();
  if (!url) throw new Error('sourceUrl required');

  const nowIso = new Date().toISOString();
  const id = crypto.randomUUID();
  const images = normalizeImages(detailImages, 80);

  const db = openDb();
  await dbRun(
    db,
    `INSERT INTO catalog_products (
      id, user_id, source_url, confirmed_title, main_image_url, detail_images_json, preset_id, category_override, status, validation_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, source_url) DO UPDATE SET
      confirmed_title = excluded.confirmed_title,
      main_image_url = excluded.main_image_url,
      detail_images_json = excluded.detail_images_json,
      preset_id = excluded.preset_id,
      category_override = excluded.category_override,
      status = excluded.status,
      updated_at = excluded.updated_at`,
    [
      id,
      userId,
      url,
      String(confirmedTitle || ''),
      String(mainImageUrl || ''),
      JSON.stringify(images),
      presetId ? String(presetId) : null,
      categoryOverride == null || categoryOverride === '' ? null : Number(categoryOverride),
      String(status || 'draft'),
      '{}',
      nowIso,
      nowIso,
    ],
  );

  const row = await dbGet(
    db,
    'SELECT id FROM catalog_products WHERE user_id = ? AND source_url = ?',
    [userId, url],
  );
  db.close();
  return row ? await getCatalogProductById(userId, row.id) : null;
}

export async function getCatalogProductById(userId, id) {
  if (!userId) throw new Error('userId required');
  const db = openDb();
  const row = await dbGet(
    db,
    `SELECT id, user_id, source_url, confirmed_title, main_image_url, detail_images_json, preset_id, category_override, seller_product_id, status, validation_json, last_source_snapshot_json, last_synced_at, created_at, updated_at, deployed_at
     FROM catalog_products
     WHERE user_id = ? AND id = ?`,
    [userId, String(id)],
  );
  db.close();
  if (!row) return null;
  let detailImages = [];
  let validation = {};
  let lastSourceSnapshot = {};
  try { detailImages = JSON.parse(row.detail_images_json || '[]'); } catch {}
  try { validation = JSON.parse(row.validation_json || '{}'); } catch {}
  try { lastSourceSnapshot = JSON.parse(row.last_source_snapshot_json || '{}'); } catch {}
  return {
    id: row.id,
    sourceUrl: row.source_url,
    confirmedTitle: row.confirmed_title,
    mainImageUrl: row.main_image_url,
    detailImages,
    presetId: row.preset_id,
    categoryOverride: row.category_override,
    sellerProductId: row.seller_product_id,
    status: row.status,
    validation,
    lastSourceSnapshot,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deployedAt: row.deployed_at,
  };
}

export async function listCatalogProducts(userId, { limit = 50, status = "", q = "" } = {}) {
  if (!userId) throw new Error('userId required');
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const st = String(status || '').trim();
  const query = String(q || '').trim();

  const like = query ? `%${query.replaceAll('%', '').replaceAll('_', '')}%` : '';

  const db = openDb();
  const rows = await dbAll(
    db,
    `SELECT id, source_url, confirmed_title, main_image_url, preset_id, category_override, seller_product_id, status, updated_at, deployed_at
     FROM catalog_products
     WHERE user_id = ?
       AND (? = "" OR status = ?)
       AND (? = "" OR confirmed_title LIKE ? OR source_url LIKE ?)
     ORDER BY updated_at DESC
     LIMIT ?`,
    [userId, st, st, query, like, like, lim],
  );
  db.close();
  return rows.map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    confirmedTitle: r.confirmed_title,
    mainImageUrl: r.main_image_url,
    presetId: r.preset_id,
    categoryOverride: r.category_override,
    sellerProductId: r.seller_product_id,
    status: r.status,
    updatedAt: r.updated_at,
    deployedAt: r.deployed_at,
  }));
}

export async function updateCatalogProduct(userId, id, patch = {}) {
  if (!userId) throw new Error('userId required');
  if (!id) throw new Error('id required');
  const nowIso = new Date().toISOString();
  const fields = [];
  const params = [];

  const allowed = {
    sourceUrl: 'source_url',
    confirmedTitle: 'confirmed_title',
    mainImageUrl: 'main_image_url',
    presetId: 'preset_id',
    categoryOverride: 'category_override',
    sellerProductId: 'seller_product_id',
    status: 'status',
    deployedAt: 'deployed_at',
    validation: 'validation_json',
    detailImages: 'detail_images_json',
    lastSourceSnapshot: 'last_source_snapshot_json',
    lastSyncedAt: 'last_synced_at',
  };

  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] === undefined) continue;
    fields.push(`${col} = ?`);
    if (k === "detailImages") params.push(JSON.stringify(normalizeImages(patch[k], 80)));
    else if (k === "validation") params.push(JSON.stringify(patch[k] ?? {}));
    else if (k === "lastSourceSnapshot") params.push(JSON.stringify(patch[k] ?? {}));
    else if (k === "categoryOverride") params.push(patch[k] == null || patch[k] === "" ? null : Number(patch[k]));
    else if (k === "presetId") params.push(patch[k] ? String(patch[k]) : null);
    else params.push(patch[k] ?? null);
  }

  fields.push('updated_at = ?');
  params.push(nowIso);
  params.push(userId);
  params.push(String(id));

  const db = openDb();
  await dbRun(db, `UPDATE catalog_products SET ${fields.join(", ")} WHERE user_id = ? AND id = ?`, params);
  db.close();
  return await getCatalogProductById(userId, id);
}

export async function deleteCatalogProduct(userId, id) {
  if (!userId) throw new Error('userId required');
  if (!id) throw new Error('id required');
  const db = openDb();
  await dbRun(db, 'DELETE FROM catalog_products WHERE user_id = ? AND id = ?', [userId, String(id)]);
  db.close();
}

// ---- Catalog Events (sync/change log) ----
export async function addCatalogEvent({ userId, catalogId, type, severity = 'info', message = '', data = {} }) {
  if (!userId) throw new Error('userId required');
  if (!catalogId) throw new Error('catalogId required');
  const db = openDb();
  const id = crypto.randomUUID();
  await dbRun(
    db,
    'INSERT INTO catalog_events (id, user_id, catalog_id, type, severity, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, String(userId), String(catalogId), String(type), String(severity), String(message || ''), JSON.stringify(data || {}), new Date().toISOString()],
  );
  db.close();
  return { id };
}

export async function listCatalogEvents(userId, catalogId, { limit = 50 } = {}) {
  if (!userId) throw new Error('userId required');
  if (!catalogId) throw new Error('catalogId required');
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const db = openDb();
  const rows = await dbAll(
    db,
    `SELECT id, type, severity, message, data_json, created_at
     FROM catalog_events
     WHERE user_id = ? AND catalog_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [String(userId), String(catalogId), lim],
  );
  db.close();
  return rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.data_json || '{}'); } catch {}
    return {
      id: r.id,
      type: r.type,
      severity: r.severity,
      message: r.message,
      data,
      createdAt: r.created_at,
    };
  });
}
