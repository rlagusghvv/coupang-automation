import fs from 'node:fs/promises';
import path from 'node:path';

import { runUploadFromUrl as realRunUploadFromUrl } from '../pipeline/runUploadFromUrl.js';
import { getSellerProduct as realGetSellerProduct } from '../coupang/api/getSellerProduct.js';

function isMockEnabled() {
  return String(process.env.CE_MOCK_EXTERNAL || '').trim() === '1';
}

async function readFixtureJson(relPath) {
  const p = path.join(process.cwd(), relPath);
  const s = await fs.readFile(p, 'utf8');
  return JSON.parse(s);
}

/**
 * External adapter wrapper.
 * In mock mode, returns deterministic fixture responses so we can run end-to-end logic
 * (catalog confirm/deploy/validation/status transitions) without real credentials.
 */
export async function runUploadFromUrl(url, settings) {
  if (!isMockEnabled()) return realRunUploadFromUrl(url, settings);

  // Very simple: always return a successful create with a fixed sellerProductId.
  const fixture = await readFixtureJson('src/server/fixtures/mock_runUploadFromUrl_ok.json');
  return {
    ...fixture,
    input: { url, settings: { ...(settings || {}) } },
  };
}

export async function getSellerProduct({ sellerProductId, accessKey, secretKey }) {
  if (!isMockEnabled()) return realGetSellerProduct({ sellerProductId, accessKey, secretKey });

  // Allow choosing between ok/invalid detail via env.
  const which = String(process.env.CE_MOCK_SELLER_PRODUCT || 'ok').trim();
  const rel = which === 'detail_empty'
    ? 'src/server/fixtures/mock_getSellerProduct_detail_empty.json'
    : 'src/server/fixtures/mock_getSellerProduct_ok.json';

  const bodyObj = await readFixtureJson(rel);
  return { ok: true, status: 200, body: JSON.stringify(bodyObj) };
}
