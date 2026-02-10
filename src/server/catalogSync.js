import crypto from 'node:crypto';

import { previewUploadFromUrl } from '../pipeline/previewUploadFromUrl.js';
import {
  listCatalogProducts,
  getCatalogProductById,
  updateCatalogProduct,
  addCatalogEvent,
} from './storage_sqlite.js';

import { getSellerProduct } from '../coupang/api/getSellerProduct.js';

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function summarizeSource(preview) {
  const draft = preview?.draft || {};
  const computed = preview?.computed || {};
  const options = Array.isArray(preview?.options) ? preview.options : [];

  const totalStock = options.reduce((sum, o) => sum + (Number(o?.stock) || 0), 0);

  return {
    at: new Date().toISOString(),
    title: String(draft.title || ''),
    price: safeNum(draft.price),
    finalPrice: safeNum(computed.finalPrice),
    shippingFee: safeNum(draft.shippingFee),
    mainImageUrl: String(draft.imageUrl || ''),
    contentImageCount: safeNum(computed.contentImageCount),
    optionsCount: safeNum(computed.optionsCount),
    totalStock,
    options: options.slice(0, 200).map((o) => ({
      name: String(o?.name || ''),
      stock: Number(o?.stock) || 0,
      priceDelta: safeNum(o?.priceDelta) ?? 0,
      values: Array.isArray(o?.values) ? o.values.slice(0, 10) : [],
    })),
  };
}

function diffSnapshots(prev, next) {
  const diff = { changed: false, changes: [] };

  const prevFinal = safeNum(prev?.finalPrice);
  const nextFinal = safeNum(next?.finalPrice);
  if (prevFinal != null && nextFinal != null && prevFinal !== nextFinal) {
    diff.changed = true;
    diff.changes.push({ field: 'finalPrice', prev: prevFinal, next: nextFinal });
  }

  const prevStock = safeNum(prev?.totalStock);
  const nextStock = safeNum(next?.totalStock);
  if (prevStock != null && nextStock != null && prevStock !== nextStock) {
    diff.changed = true;
    diff.changes.push({ field: 'totalStock', prev: prevStock, next: nextStock });
  }

  const prevCount = safeNum(prev?.optionsCount);
  const nextCount = safeNum(next?.optionsCount);
  if (prevCount != null && nextCount != null && prevCount !== nextCount) {
    diff.changed = true;
    diff.changes.push({ field: 'optionsCount', prev: prevCount, next: nextCount });
  }

  return diff;
}

function extractCoupangDetailHtml(item0) {
  if (!item0) return '';
  if (item0.content || item0.contentText || item0.contentHtml) {
    return String(item0.content || item0.contentText || item0.contentHtml || '');
  }
  if (Array.isArray(item0.contents)) {
    return item0.contents
      .flatMap((c) => (Array.isArray(c?.contentDetails) ? c.contentDetails : []))
      .map((d) => d?.content || '')
      .join('\n');
  }
  return '';
}

async function revalidateIfNeeded({ userId, product, userSettings }) {
  const status = String(product?.status || '');
  const spid = String(product?.sellerProductId || '').trim();
  if (!spid) return null;

  // Only attempt revalidation when previously marked invalid.
  if (status !== 'deployed_invalid') return null;

  const accessKey = String(userSettings?.coupangAccessKey || '').trim();
  const secretKey = String(userSettings?.coupangSecretKey || '').trim();
  if (!accessKey || !secretKey) return null;

  const r = await getSellerProduct({ sellerProductId: spid, accessKey, secretKey });
  if (r?.status !== 200) return null;

  let obj = null;
  try {
    obj = typeof r?.body === 'string' ? JSON.parse(r.body) : r?.body;
  } catch {
    obj = null;
  }
  const data = obj?.data || obj || null;
  const items = Array.isArray(data?.items) ? data.items : [];
  const item0 = items?.[0] || null;
  const html = extractCoupangDetailHtml(item0);

  const validation = {
    ok: true,
    checkedAt: new Date().toISOString(),
    errors: [],
  };
  if (!html || String(html).trim().length < 20) {
    validation.ok = false;
    validation.errors.push('detail_empty');
  }

  await updateCatalogProduct(userId, product.id, {
    validation,
    status: validation.ok ? 'deployed' : 'deployed_invalid',
  });

  await addCatalogEvent({
    userId,
    catalogId: product.id,
    type: 'REVALIDATED',
    severity: validation.ok ? 'info' : 'warn',
    message: validation.ok ? '검증 OK로 갱신됨' : `검증 실패 유지: ${validation.errors.join(',')}`,
    data: { sellerProductId: spid, validation },
  });

  return validation;
}

export async function syncOneCatalogProduct({ userId, catalogId, userSettings = {} }) {
  const product = await getCatalogProductById(userId, catalogId);
  if (!product) throw new Error('not_found');

  // If this product was marked invalid, revalidate against Coupang first.
  await revalidateIfNeeded({ userId, product, userSettings });

  const preview = await previewUploadFromUrl(product.sourceUrl, {
    ...(userSettings || {}),
    // keep compatibility with previewUploadFromUrl expectations
    categoryOverrideCode: product.categoryOverride ?? undefined,
  });

  if (!preview?.ok) {
    await addCatalogEvent({
      userId,
      catalogId: product.id,
      type: 'SYNC_FAILED',
      severity: 'warn',
      message: String(preview?.reason || 'preview_failed'),
      data: { preview },
    });

    await updateCatalogProduct(userId, product.id, {
      lastSyncedAt: new Date().toISOString(),
      lastSourceSnapshot: { ok: false, preview },
    });

    return { ok: false, reason: preview?.reason || 'preview_failed' };
  }

  const nextSnap = summarizeSource(preview);
  const prevSnap = product.lastSourceSnapshot || null;
  const d = diffSnapshots(prevSnap, nextSnap);

  await updateCatalogProduct(userId, product.id, {
    lastSyncedAt: new Date().toISOString(),
    lastSourceSnapshot: nextSnap,
  });

  if (d.changed) {
    await addCatalogEvent({
      userId,
      catalogId: product.id,
      type: 'SOURCE_CHANGED',
      severity: 'info',
      message: `원본 변경 감지: ${d.changes.map((c) => c.field).join(', ')}`,
      data: { diff: d, prev: prevSnap, next: nextSnap },
    });
  }

  return { ok: true, changed: d.changed, diff: d, snapshot: nextSnap };
}

export async function syncAllCatalogProducts({ userId, userSettings = {}, limit = 50 }) {
  const products = await listCatalogProducts(userId, { limit, status: '' });
  const targets = products.filter((p) => p.status === 'deployed' || p.status === 'deployed_invalid');

  const results = [];
  for (const p of targets) {
    try {
      const r = await syncOneCatalogProduct({ userId, catalogId: p.id, userSettings });
      results.push({ id: p.id, ok: true, ...r });
    } catch (e) {
      results.push({ id: p.id, ok: false, error: String(e?.message || e) });
    }
  }

  return { ok: true, count: targets.length, results };
}

export function startCatalogSyncLoop({ getUsers, intervalMs = 15 * 60 * 1000 }) {
  const t = setInterval(async () => {
    try {
      const users = await getUsers();
      for (const u of users) {
        try {
          await syncAllCatalogProducts({ userId: u.id, userSettings: u.settings || {}, limit: 200 });
        } catch {}
      }
    } catch {}
  }, intervalMs);

  t.unref?.();
  return t;
}
