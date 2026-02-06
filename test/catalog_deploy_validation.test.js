import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initDb,
  upsertCatalogProduct,
  getCatalogProductById,
  updateCatalogProduct,
} from '../src/server/storage_sqlite.js';

import { runUploadFromUrl, getSellerProduct } from '../src/server/externalAdapters.js';

// These tests validate the core logic assumptions for post-upload validation.
// They do NOT hit real Coupang/DoMae APIs.

test('mock adapters: runUploadFromUrl returns sellerProductId', async () => {
  process.env.CE_MOCK_EXTERNAL = '1';
  const r = await runUploadFromUrl('https://example.com/p/1', { any: 'setting' });
  assert.equal(r.ok, true);
  assert.equal(String(r.create?.sellerProductId), '9999999999');
});

test('mock adapters: getSellerProduct ok returns non-empty detail', async () => {
  process.env.CE_MOCK_EXTERNAL = '1';
  process.env.CE_MOCK_SELLER_PRODUCT = 'ok';
  const r = await getSellerProduct({ sellerProductId: '999', accessKey: 'x', secretKey: 'y' });
  const body = JSON.parse(r.body);
  assert.ok(String(body?.data?.items?.[0]?.content || '').length > 20);
});

test('mock adapters: getSellerProduct detail_empty returns empty detail', async () => {
  process.env.CE_MOCK_EXTERNAL = '1';
  process.env.CE_MOCK_SELLER_PRODUCT = 'detail_empty';
  const r = await getSellerProduct({ sellerProductId: '999', accessKey: 'x', secretKey: 'y' });
  const body = JSON.parse(r.body);
  assert.equal(String(body?.data?.items?.[0]?.content || ''), '');
});

test('storage: catalog upsert/get/update basic', async () => {
  await initDb();
  const userId = 'test-user';
  const product = await upsertCatalogProduct({
    userId,
    sourceUrl: 'https://example.com/p/abc',
    confirmedTitle: '테스트',
    mainImageUrl: 'https://img/1.jpg',
    detailImages: ['https://img/1.jpg', 'https://img/2.jpg'],
    presetId: null,
    categoryOverride: 12345,
    status: 'confirmed',
  });

  const loaded = await getCatalogProductById(userId, product.id);
  assert.equal(loaded.confirmedTitle, '테스트');
  assert.equal(loaded.categoryOverride, 12345);
  assert.equal(Array.isArray(loaded.detailImages), true);

  const updated = await updateCatalogProduct(userId, product.id, { status: 'deployed_invalid', validation: { ok: false } });
  assert.equal(updated.status, 'deployed_invalid');
});
