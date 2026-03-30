import sqlite3 from "sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getOrderSheets } from "../coupang/api/getOrderSheets.js";
import { parseCoupangJson } from "../coupang/parseJson.js";

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

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
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

export async function getOrderById(userId, id) {
  if (!userId) throw new Error("userId required");
  const nid = Number(id);
  if (!Number.isFinite(nid) || nid <= 0) throw new Error("invalid id");
  const db = openDb();
  try {
    await ensureOrdersSchema(db);
    const row = await dbGet(
      db,
      `SELECT id, source, status, order_json, created_at, external_id, external_sub_id
       FROM orders
       WHERE user_id = ? AND id = ?
       LIMIT 1`,
      [userId, Math.floor(nid)],
    );
    if (!row) return null;
    let order = {};
    try {
      order = JSON.parse(row.order_json || "{}");
    } catch {}
    return {
      id: row.id,
      at: row.created_at,
      source: row.source,
      status: row.status,
      externalId: row.external_id,
      externalSubId: row.external_sub_id,
      order,
    };
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
      body = typeof res.body === "string" ? parseCoupangJson(res.body) : res.body;
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

function normalizeStatusList(raw, fallback = ["ACCEPT"]) {
  const src = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
  const out = src
    .map((x) => String(x || "").trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(out.length > 0 ? out : fallback));
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

function extractOrderTimestampMs(orderPayload) {
  const order = orderPayload && typeof orderPayload === "object" ? orderPayload : {};
  const sheet = order?.sheet && typeof order.sheet === "object" ? order.sheet : {};
  const candidates = [
    sheet.orderDate,
    sheet.orderedAt,
    sheet.paidAt,
    sheet.createdAt,
    sheet.deliveryStartDate,
    sheet.instructDate,
    order.orderDate,
    order.orderedAt,
    order.createdAt,
  ];
  for (const value of candidates) {
    if (value == null || String(value).trim() === "") continue;
    const ts = Date.parse(String(value));
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

async function markMissingOrdersCancelled({
  userId,
  dateFrom,
  dateTo,
  seenKeys = new Set(),
  activeStatuses = [],
}) {
  if (!userId) return { reconciled: 0 };
  const statuses = normalizeStatusList(activeStatuses, []);
  if (statuses.length === 0) return { reconciled: 0 };

  const fromTs = Date.parse(`${String(dateFrom || "").trim()}T00:00:00+09:00`);
  const toTs = Date.parse(`${String(dateTo || "").trim()}T23:59:59.999+09:00`);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return { reconciled: 0 };

  const db = openDb();
  try {
    await ensureOrdersSchema(db);
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = await dbAll(
      db,
      `SELECT id, status, external_id, external_sub_id, order_json
       FROM orders
       WHERE user_id = ?
         AND source = 'coupang'
         AND status IN (${placeholders})`,
      [userId, ...statuses],
    );

    const now = new Date().toISOString();
    let reconciled = 0;
    for (const row of rows) {
      const key = `${String(row.external_id || "")}\t${String(row.external_sub_id || "")}`;
      if (seenKeys.has(key)) continue;

      let order = {};
      try {
        order = JSON.parse(row.order_json || "{}");
      } catch {}
      const ts = extractOrderTimestampMs(order);
      if (!Number.isFinite(ts) || ts < fromTs || ts > toTs) continue;

      await dbRun(
        db,
        `UPDATE orders
         SET status = ?, updated_at = ?
         WHERE id = ?`,
        ["CANCELLED", now, row.id],
      );
      reconciled += 1;
    }

    return { reconciled };
  } finally {
    db.close();
  }
}

export async function refreshShippingStatusesFromCoupang({
  userId,
  settings = {},
  dateFrom,
  dateTo,
  status = "ACCEPT",
  statuses = [],
}) {
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
  const statusList = normalizeStatusList(statuses, normalizeStatusList(status, ["ACCEPT"]));

  let processed = 0;
  let scannedSheets = 0;
  const seenKeys = new Set();
  const warnings = [];

  for (const oneStatus of statusList) {
    const r = await fetchOrderSheetsAll({
      vendorId,
      accessKey,
      secretKey,
      createdAtFrom,
      createdAtTo,
      status: oneStatus,
    });
    if (!r.ok) {
      warnings.push({
        status: oneStatus,
        error: r.error || "status_fetch_failed",
        httpStatus: Number(r.status || 0) || null,
      });
      continue;
    }

    scannedSheets += r.data.length;
    for (const sheet of r.data) {
      const orderItems = Array.isArray(sheet?.orderItems) ? sheet.orderItems : [];
      if (orderItems.length === 0) {
        const ids = buildCoupangExternalIds(sheet, {}, 0);
        seenKeys.add(`${ids.externalId}\t${ids.externalSubId}`);
        await addOrder({
          userId,
          source: 'coupang',
          status: String(oneStatus || 'ACCEPT'),
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
        seenKeys.add(`${ids.externalId}\t${ids.externalSubId}`);
        await addOrder({
          userId,
          source: 'coupang',
          status: String(oneStatus || 'ACCEPT'),
          order: { sheet, item },
          externalId: ids.externalId,
          externalSubId: ids.externalSubId,
        });
        processed += 1;
        idx += 1;
      }
    }
  }

  const reconciled =
    warnings.length === 0
      ? await markMissingOrdersCancelled({
          userId,
          dateFrom,
          dateTo,
          seenKeys,
          activeStatuses: statusList,
        })
      : { reconciled: 0 };

  if (processed === 0 && warnings.length > 0) {
    return {
      ok: false,
      reason: "shipping_refresh_failed",
      statuses: statusList,
      warnings,
    };
  }

  return {
    ok: true,
    mode: 'coupang',
    dateFrom,
    dateTo,
    status: statusList[0] || String(status || "ACCEPT"),
    statuses: statusList,
    scannedSheets,
    processed,
    reconciled: Number(reconciled?.reconciled || 0),
    warnings,
    at: new Date().toISOString(),
  };
}

export async function upsertCoupangOrderSheet({ userId, sheet, statusOverride = "" }) {
  if (!userId) throw new Error("userId required");
  if (!sheet || typeof sheet !== "object") throw new Error("sheet required");

  const normalizedStatus = String(statusOverride || sheet?.status || "").trim() || "ACCEPT";
  const orderItems = Array.isArray(sheet?.orderItems) ? sheet.orderItems : [];

  if (orderItems.length === 0) {
    const ids = buildCoupangExternalIds(sheet, {}, 0);
    await addOrder({
      userId,
      source: "coupang",
      status: normalizedStatus,
      order: { sheet },
      externalId: ids.externalId,
      externalSubId: ids.externalSubId,
    });
    return { ok: true, upserted: 1 };
  }

  let upserted = 0;
  for (let i = 0; i < orderItems.length; i += 1) {
    const item = orderItems[i] || {};
    const ids = buildCoupangExternalIds(sheet, item, i);
    await addOrder({
      userId,
      source: "coupang",
      status: normalizedStatus,
      order: { sheet, item },
      externalId: ids.externalId,
      externalSubId: ids.externalSubId,
    });
    upserted += 1;
  }

  return { ok: true, upserted };
}
