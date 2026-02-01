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

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export async function addOrder({ userId, source, status = "paid", order }) {
  if (!userId) throw new Error("userId required");
  if (!source) throw new Error("source required");
  const db = openDb();
  await dbRun(
    db,
    `INSERT INTO orders (user_id, source, status, order_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      String(source),
      String(status || "paid"),
      JSON.stringify(order || {}),
      new Date().toISOString(),
    ],
  );
  db.close();
}

export async function clearOrders(userId) {
  if (!userId) throw new Error("userId required");
  const db = openDb();
  await dbRun(db, `DELETE FROM orders WHERE user_id = ?`, [userId]);
  db.close();
}

export async function listOrders(userId, limit = 50) {
  if (!userId) throw new Error("userId required");
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const db = openDb();
  const rows = await dbAll(
    db,
    `SELECT id, source, status, order_json, created_at
     FROM orders
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [userId, lim],
  );
  db.close();
  return rows.map((r) => {
    let order = {};
    try {
      order = JSON.parse(r.order_json || "{}");
    } catch {}
    return {
      id: r.id,
      at: r.created_at,
      source: r.source,
      status: r.status,
      order,
    };
  });
}
