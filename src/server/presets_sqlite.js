import crypto from "node:crypto";
import sqlite3 from "sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function openDb() {
  ensureDir();
  return new sqlite3.Database(DB_PATH);
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

function safeJsonParse(raw, fallback = {}) {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function listPresets(userId, limit = 100) {
  if (!userId) throw new Error("userId required");
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const db = openDb();
  const rows = await dbAll(
    db,
    `SELECT id, name, settings_json, created_at, updated_at
     FROM presets
     WHERE user_id = ?
     ORDER BY updated_at DESC
     LIMIT ?`,
    [String(userId), lim],
  );
  db.close();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    settings: safeJsonParse(r.settings_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getPreset(userId, id) {
  if (!userId) throw new Error("userId required");
  if (!id) throw new Error("id required");
  const db = openDb();
  const row = await dbGet(
    db,
    `SELECT id, name, settings_json, created_at, updated_at
     FROM presets
     WHERE user_id = ? AND id = ?`,
    [String(userId), String(id)],
  );
  db.close();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    settings: safeJsonParse(row.settings_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertPreset({ userId, id = null, name, settings = {} }) {
  if (!userId) throw new Error("userId required");
  const presetName = String(name || "").trim();
  if (!presetName) throw new Error("name required");
  const db = openDb();
  const nowIso = new Date().toISOString();

  const presetId = id ? String(id) : crypto.randomUUID();

  await dbRun(
    db,
    `INSERT INTO presets (id, user_id, name, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET
       settings_json = excluded.settings_json,
       updated_at = excluded.updated_at`,
    [
      presetId,
      String(userId),
      presetName,
      JSON.stringify(settings || {}),
      nowIso,
      nowIso,
    ],
  );

  db.close();
  return { id: presetId, name: presetName, settings, updatedAt: nowIso };
}

export async function deletePreset(userId, id) {
  if (!userId) throw new Error("userId required");
  if (!id) throw new Error("id required");
  const db = openDb();
  await dbRun(db, `DELETE FROM presets WHERE user_id = ? AND id = ?`, [String(userId), String(id)]);
  db.close();
}
