import sqlite3 from "sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getOrderSheets } from "../coupang/api/getOrderSheets.js";

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

async function fetchOrderSheetsAll({ vendorId, accessKey, secretKey, createdAtFrom, createdAtTo, status }) {
  const all = [];
  let nextToken = "";
  let guard = 0;
  do {
    guard += 1;
    const res = await getOrderSheets({
      vendorId,
      accessKey,
      secretKey,
      createdAtFrom,
      createdAtTo,
      status,
      nextToken,
      maxPerPage: 50,
    });
    if (res.status !== 200) {
      return { ok: false, error: "coupang_api_error", status: res.status, body: res.body };
    }
    let body;
    try {
      body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    } catch {
      return { ok: false, error: "invalid_json", body: res.body };
    }
    if (!body || body.code !== "SUCCESS") {
      return { ok: false, error: "api_failed", body };
    }
    const data = body.data || [];
    if (Array.isArray(data)) all.push(...data);
    nextToken = body.nextToken || "";
  } while (nextToken && guard < 200);

  return { ok: true, data: all };
}

function formatDateKST(dateStr) {
  return `${dateStr}+09:00`;
}

export async function refreshShippingStatusesFromCoupang({ userId, settings = {}, dateFrom, dateTo, status = "ACCEPT" }) {
  if (!userId) throw new Error('userId required');
  const accessKey = String(settings.coupangAccessKey || "").trim();
  const secretKey = String(settings.coupangSecretKey || "").trim();
  const vendorId = String(settings.coupangVendorId || "").trim();

  const missing = [];
  if (!accessKey) missing.push('쿠팡 Access Key');
  if (!secretKey) missing.push('쿠팡 Secret Key');
  if (!vendorId) missing.push('쿠팡 Vendor ID');
  if (missing.length) {
    return { ok: false, reason: 'missing_keys', missing };
  }
  if (!dateFrom || !dateTo) {
    return { ok: false, reason: 'missing_dates' };
  }

  const createdAtFrom = formatDateKST(dateFrom);
  const createdAtTo = formatDateKST(dateTo);

  const r = await fetchOrderSheetsAll({ vendorId, accessKey, secretKey, createdAtFrom, createdAtTo, status });
  if (!r.ok) return r;

  // MVP: store latest snapshot into our orders table (replace user's existing orders)
  await clearOrders(userId);

  let inserted = 0;
  for (const sheet of r.data) {
    const orderItems = Array.isArray(sheet?.orderItems) ? sheet.orderItems : [];
    if (orderItems.length === 0) {
      await addOrder({ userId, source: 'coupang', status: String(status || 'ACCEPT'), order: sheet });
      inserted += 1;
      continue;
    }
    for (const item of orderItems) {
      await addOrder({
        userId,
        source: 'coupang',
        status: String(status || 'ACCEPT'),
        order: { sheet, item },
      });
      inserted += 1;
    }
  }

  return {
    ok: true,
    mode: 'coupang',
    dateFrom,
    dateTo,
    status,
    scannedSheets: r.data.length,
    inserted,
    at: new Date().toISOString(),
  };
}
