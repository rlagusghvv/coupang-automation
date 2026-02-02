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
