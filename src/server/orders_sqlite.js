import sqlite3 from "sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getOrderSheets } from "../coupang/api/getOrderSheets.js";

function resolveDataDir() {
  const override = String(process.env.COUPLEPHANT_DATA_DIR || "").trim();
  return override ? path.resolve(override) : path.join(process.cwd(), "data");
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "app.db");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _schemaReady = false;

async function ensureOrdersSchema(db) {
  if (_schemaReady) return;

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      external_id TEXT,
      external_sub_id TEXT,
      order_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  // ensure columns
  const cols = await dbAll(db, "PRAGMA table_info(orders)");
  const names = new Set(cols.map((c) => String(c.name)));

  // Add columns for dedupe/upsert
  if (!names.has('external_id')) {
    await dbRun(db, "ALTER TABLE orders ADD COLUMN external_id TEXT");
  }
  if (!names.has('external_sub_id')) {
    await dbRun(db, "ALTER TABLE orders ADD COLUMN external_sub_id TEXT");
  }
  if (!names.has('updated_at')) {
    await dbRun(db, "ALTER TABLE orders ADD COLUMN updated_at TEXT");
  }

  // Unique index for dedupe
  await dbRun(
    db,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique ON orders(user_id, source, external_id, external_sub_id)",
  );
  await dbRun(db, "CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(user_id, created_at)");

  _schemaReady = true;
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

export async function addOrder({ userId, source, status = "paid", order, externalId = null, externalSubId = null }) {
  if (!userId) throw new Error("userId required");
  if (!source) throw new Error("source required");

  const now = new Date().toISOString();
  const db = openDb();
  try {
    await ensureOrdersSchema(db);

    const eid = externalId == null ? null : String(externalId);
    const esid = externalSubId == null ? '' : String(externalSubId);

    await dbRun(
      db,
      `INSERT INTO orders (user_id, source, status, external_id, external_sub_id, order_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source, external_id, external_sub_id) DO UPDATE SET
         status = excluded.status,
         order_json = excluded.order_json,
         updated_at = excluded.updated_at`,
      [
        userId,
        String(source),
        String(status || "paid"),
        eid,
        esid,
        JSON.stringify(order || {}),
        now,
        now,
      ],
    );
  } finally {
    db.close();
  }
}

export async function clearOrders(userId) {
  if (!userId) throw new Error("userId required");
  const db = openDb();
  try {
    await ensureOrdersSchema(db);
    await dbRun(db, `DELETE FROM orders WHERE user_id = ?`, [userId]);
  } finally {
    db.close();
  }
}

export async function listOrders(userId, limit = 50) {
  if (!userId) throw new Error("userId required");
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const db = openDb();
  try {
    await ensureOrdersSchema(db);
    const rows = await dbAll(
      db,
      `SELECT id, source, status, order_json, created_at, external_id, external_sub_id
       FROM orders
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [userId, lim],
    );
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
        externalId: r.external_id,
        externalSubId: r.external_sub_id,
        order,
      };
    });
  } finally {
    db.close();
  }
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
    // Coupang API sometimes returns code as string ("SUCCESS") or number (200)
    const c = body?.code;
    const isOk = c === "SUCCESS" || c === 200 || c === "200";
    if (!body || !isOk) {
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

import crypto from 'node:crypto';

function stableHash(obj) {
  try {
    const s = JSON.stringify(obj);
    return crypto.createHash('sha1').update(s).digest('hex');
  } catch {
    return crypto.randomUUID();
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function buildCoupangExternalIds(sheet, item, i) {
  const externalId = pickFirst(sheet, [
    'orderId',
    'orderSheetId',
    'orderSheetNo',
    'shipmentBoxId',
    'shipmentBoxNo',
    'deliveryId',
  ]) || stableHash(sheet);

  const externalSubId = pickFirst(item, [
    'orderItemId',
    'orderItemNo',
    'vendorItemId',
    'sellerProductItemId',
  ]) || String(i);

  return { externalId: String(externalId), externalSubId: String(externalSubId) };
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

  // Accumulate + dedupe via unique keys (do NOT clear existing orders)
  let processed = 0;
  for (const sheet of r.data) {
    const orderItems = Array.isArray(sheet?.orderItems) ? sheet.orderItems : [];
    if (orderItems.length === 0) {
      const ids = buildCoupangExternalIds(sheet, {}, 0);
      await addOrder({
        userId,
        source: 'coupang',
        status: String(status || 'ACCEPT'),
        order: { sheet },
        externalId: ids.externalId,
        externalSubId: ids.externalSubId,
      });
      processed += 1;
      continue;
    }
    let idx = 0;
    for (const item of orderItems) {
      const ids = buildCoupangExternalIds(sheet, item, idx);
      await addOrder({
        userId,
        source: 'coupang',
        status: String(status || 'ACCEPT'),
        order: { sheet, item },
        externalId: ids.externalId,
        externalSubId: ids.externalSubId,
      });
      processed += 1;
      idx += 1;
    }
  }

  return {
    ok: true,
    mode: 'coupang',
    dateFrom,
    dateTo,
    status,
    scannedSheets: r.data.length,
    processed,
    at: new Date().toISOString(),
  };
}
