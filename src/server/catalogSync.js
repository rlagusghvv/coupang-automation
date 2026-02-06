import crypto from 'node:crypto';

import { previewUploadFromUrl } from '../pipeline/previewUploadFromUrl.js';
import {
  listCatalogProducts,
  getCatalogProductById,
  updateCatalogProduct,
  addCatalogEvent,
} from './storage_sqlite.js';

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

export async function syncOneCatalogProduct({ userId, catalogId, userSettings = {} }) {
  const product = await getCatalogProductById(userId, catalogId);
  if (!product) throw new Error('not_found');

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
