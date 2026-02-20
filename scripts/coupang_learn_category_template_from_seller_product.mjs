// Learn and upsert a Coupang category template from an existing successful seller product.
// Usage:
//   node scripts/coupang_learn_category_template_from_seller_product.mjs <sellerProductId> [--unitType=PIECE] [--name="..."]
//
// Notes:
// - This script uses Coupang access keys from your app DB user settings.
// - It does NOT print secrets.
// - Some Coupang GET responses do not include unitType; you can supply --unitType.

import sqlite3 from 'sqlite3';
import path from 'node:path';
import process from 'node:process';

import { getSellerProduct } from '../src/coupang/api/getSellerProduct.js';
import { initDb, upsertCategoryTemplate } from '../src/server/storage_sqlite.js';

function parseArgs(argv) {
  const out = { sellerProductId: null, unitType: null, name: '' };
  const args = argv.slice(2);
  out.sellerProductId = args.find((a) => !a.startsWith('--')) || null;
  for (const a of args) {
    if (a.startsWith('--unitType=')) out.unitType = a.split('=')[1] || '';
    if (a.startsWith('--name=')) out.name = a.split('=')[1] || '';
  }
  return out;
}

const { sellerProductId, unitType: unitTypeArg, name } = parseArgs(process.argv);
if (!sellerProductId) {
  console.error('sellerProductId required');
  process.exit(2);
}

const DB_PATH = path.join(process.cwd(), 'data', 'app.db');
const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, row) => (e ? rej(e) : res(row))));

// Pick the first user (single-tenant use). If needed, pass an email filter later.
const userRow = await dbGet('select settings_json from users order by created_at asc limit 1');
if (!userRow) {
  console.error('no users found in DB');
  process.exit(2);
}

const settings = JSON.parse(userRow.settings_json || '{}');
const accessKey = settings.coupangAccessKey;
const secretKey = settings.coupangSecretKey;
if (!accessKey || !secretKey) {
  console.error('missing coupangAccessKey/coupangSecretKey in user settings');
  process.exit(2);
}

const res = await getSellerProduct({ sellerProductId, accessKey, secretKey });
const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
const data = body?.data || {};
const displayCategoryCode = data?.displayCategoryCode;
const firstItem = Array.isArray(data?.items) ? data.items[0] : null;

if (!displayCategoryCode) {
  console.error('displayCategoryCode not found in response');
  process.exit(2);
}

const unitCount = firstItem?.unitCount ?? 1;
const unitType = (firstItem?.unitType || unitTypeArg || 'PIECE').toString().trim();

const attrs = Array.isArray(firstItem?.attributes)
  ? firstItem.attributes
      .filter((a) => a && a.attributeTypeName && a.attributeValueName)
      .map((a) => ({ attributeTypeName: a.attributeTypeName, attributeValueName: String(a.attributeValueName) }))
  : null;

await initDb();
await upsertCategoryTemplate({
  marketplace: 'coupang',
  displayCategoryCode,
  name: name || `learned from sellerProductId ${sellerProductId}`,
  template: {
    learnedFrom: { sellerProductId: String(sellerProductId) },
    itemUnit: { unitCount: Number(unitCount) || 1, unitType },
    // Keep attributes optional; include only if present.
    itemAttributes: attrs && attrs.length ? attrs : null,
  },
});

db.close();

console.log(JSON.stringify({ ok: true, displayCategoryCode, itemUnit: { unitCount, unitType }, attrsCount: attrs ? attrs.length : 0 }, null, 2));
