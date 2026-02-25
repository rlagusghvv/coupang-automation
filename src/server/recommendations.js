import crypto from 'node:crypto';

import { previewUploadFromUrl } from '../pipeline/previewUploadFromUrl.js';
import { evaluateQcGate } from '../pipeline/qcGate.js';
import { dbAll, dbRun, openDb } from './storage_sqlite_internal.js';

const DEFAULT_RECOMMENDATION_COOLDOWN_DAYS = 7;
const RECOMMENDATIONS_SAVED_TABLE = 'recommendations_saved';

function dbGetOne(db, sql, params = []) {
  return dbAll(db, sql, params).then((rows) => (rows && rows[0]) || null);
}


// NOTE: storage_sqlite.js doesn't currently export low-level db helpers.
// We keep this module standalone by using the internal helper shim.

function nowIso() {
  return new Date().toISOString();
}

function withTimeout(promise, ms, label = 'timeout') {
  const t = new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms));
  return Promise.race([promise, t]);
}

export const DEFAULT_BAN_KEYWORDS = [
  // regulated (food etc)
  '식품', '먹거리', '음료', '건기식', '건강기능', '홍삼', '비타민', '영양',
  '올리브유', '카놀라', '카놀라유', '식용유', '오일', '식초', '발사믹', '꿀', '차', '커피', '과자', '간식', '스틱',
  '한우', '소고기', '돼지고기', '닭고기', '축산', '수산', '김치', '라면',
  '의약', '의료', '치료', '진단',
  '화장품', '미백', '주름', '탈모',
  // batteries/electric
  '배터리', '충전기', '전동', '전기', '220v', '110v',
  // kids safety / certifications
  'KC', '인증', '전파', '어린이', '유아', '안전인증',
  // high risk
  '액체', '향수', '스프레이',
];

export function defaultKeywordSet() {
  // v0: focus on pet + car/desk convenience items (higher perceived value, lower brand lock-in)
  return [
    // car
    '차량 수납', '차량 정리', '차량 거치대', '차량 핸드폰 거치대', '차량 송풍구 거치대',
    '차량 틈새 수납', '차량 시트 훅', '차량 케이블 정리', '차량 컵홀더',
    // desk/office
    '책상 정리', '케이블 정리', '멀티탭 정리', '노트북 거치대', '모니터 받침대',
    '서랍 정리', '정리 트레이',
    // pet (avoid food/medicine)
    '강아지 장난감', '고양이 장난감', '고양이 낚시대', '노즈워크',
    '배변 봉투', '배변패드', '펫 브러쉬', '고양이 빗',
    '강아지 목줄', '리드줄', '하네스', '가슴줄',
    '급수기', '물병', '물그릇',
    '스크래쳐', '캣닢 장난감',
    // general organizing (still useful)
    '수납', '정리', '후크', '클립', '라벨 스티커',
  ];
}

export async function fetchDomeggookUrlsByKeyword({ keyword, limit = 40, storageStatePath = '', maxPages = 2 }) {
  const q = String(keyword || '').trim();
  if (!q) return [];

  const baseUrl = `https://domeggook.com/main/item/itemList.php?sw=${encodeURIComponent(q)}&sf=ttl`;

  const extractFromHtml = (html) => {
    const out = [];
    const seen = new Set();
    const pushNo = (no) => {
      const n = String(no || '').trim();
      if (!/^\d{6,}$/.test(n)) return;
      if (seen.has(n)) return;
      seen.add(n);
      out.push(`https://domeggook.com/${n}`);
    };

    const reNo = /[?&]no=(\d{6,})/g;
    let m;
    while ((m = reNo.exec(html))) {
      pushNo(m[1]);
      if (out.length >= limit) break;
    }
    if (out.length < limit) {
      const reShort = /https?:\/\/domeggook\.com\/(\d{6,})/g;
      while ((m = reShort.exec(html))) {
        pushNo(m[1]);
        if (out.length >= limit) break;
      }
    }

    // Pattern: relative links like /63410895?advcnt=...
    if (out.length < limit) {
      const reRel = /\/(\d{6,})\?advcnt=/g;
      while ((m = reRel.exec(html))) {
        pushNo(m[1]);
        if (out.length >= limit) break;
      }
    }

    // Pattern: bare relative links like /63410895 or /63410895?...
    if (out.length < limit) {
      const reBare = /\/(\d{6,})(?:\?|\"|\')/g;
      while ((m = reBare.exec(html))) {
        pushNo(m[1]);
        if (out.length >= limit) break;
      }
    }

    return out.slice(0, limit);
  };

  const want = Math.max(1, Math.min(4, Number(maxPages) || 1));

  // 1) Try plain fetch across pages (best-effort; may be limited by bot mitigation)
  try {
    const all = [];
    for (let pageNo = 1; pageNo <= want && all.length < limit; pageNo += 1) {
      const listUrl = pageNo === 1 ? baseUrl : `${baseUrl}&page=${pageNo}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8_000);
      const r = await fetch(listUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://domeggook.com/' },
      });
      clearTimeout(t);
      if (r.status === 429) throw new Error('domeggook_rate_limited');
      if (!r.ok) break;
      const html = await r.text();
      await new Promise((r) => setTimeout(r, 220));
      const out = extractFromHtml(html);
      for (const u of out) {
        if (!all.includes(u)) all.push(u);
        if (all.length >= limit) break;
      }
    }
    if (all.length >= Math.min(10, limit)) return all.slice(0, limit);
  } catch {}

  // 2) Fallback to Playwright with logged-in storageState (more reliable)
  try {
    const { chromium } = await import('playwright');
    const fs = await import('node:fs');

    const hasState = storageStatePath && fs.existsSync(storageStatePath);
    const browser = await chromium.launch();
    const context = hasState ? await browser.newContext({ storageState: storageStatePath }) : await browser.newContext();
    const page = await context.newPage();

    const all = [];
    for (let pageNo = 1; pageNo <= want && all.length < limit; pageNo += 1) {
      const listUrl = pageNo === 1 ? baseUrl : `${baseUrl}&page=${pageNo}`;
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(650);
      const html = await page.content();
      const out = extractFromHtml(html);
      for (const u of out) {
        if (!all.includes(u)) all.push(u);
        if (all.length >= limit) break;
      }
    }

    await browser.close();
    return all.slice(0, limit);
  } catch {
    return [];
  }
}

function containsBanKeyword(text, banList) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (banList || []).some((k) => t.includes(String(k || '').toLowerCase()));
}

function roundToKrw900(p) {
  const x = Number(p);
  if (!Number.isFinite(x)) return null;
  // Round UP to prices ending with 900 (e.g. 9,900 / 12,900 / 19,900)
  const k = Math.ceil((x + 100) / 1000);
  return Math.max(900, k * 1000 - 100);
}

export function scoreRecommendation({ preview, minProfit = 3000, minMarginRate = 0.30, banKeywords = DEFAULT_BAN_KEYWORDS }) {
  const draft = preview?.draft || {};
  const computed = preview?.computed || {};

  const title = String(draft.title || '');
  if (!title) return { ok: false, reason: 'no_title' };
  if (containsBanKeyword(title, banKeywords)) return { ok: false, reason: 'banned_keyword' };

  const sourcePrice = Number(draft.price);
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) {
    return { ok: false, reason: 'bad_price' };
  }

  // Choose a recommended selling price that satisfies BOTH:
  // - profit >= minProfit
  // - marginRate >= minMarginRate
  const needByProfit = sourcePrice + Number(minProfit || 0);
  const needByMargin = sourcePrice / (1 - Number(minMarginRate || 0));
  const need = Math.max(needByProfit, needByMargin);
  const finalPrice = roundToKrw900(need);
  if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
    return { ok: false, reason: 'bad_price' };
  }

  // Profit heuristic: treat shipping as pass-through.
  const profit = finalPrice - sourcePrice;
  const marginRate = profit / finalPrice;

  if (!Number.isFinite(profit) || profit < minProfit) return { ok: false, reason: 'profit_too_low', profit, marginRate };
  if (!Number.isFinite(marginRate) || marginRate < minMarginRate) return { ok: false, reason: 'margin_too_low', profit, marginRate };

  const contentImageCount = Number(computed.contentImageCount) || 0;
  // v0: allow 1+ detail images (some listings have short descriptions).
  if (contentImageCount < 1) return { ok: false, reason: 'detail_images_too_few', contentImageCount };

  // Simple score: favor higher profit and sufficient detail images.
  const score = profit + Math.min(2000, contentImageCount * 200);
  const reason = `recommend≈${Math.round(finalPrice)} / profit≈${Math.round(profit)} / margin≈${Math.round(marginRate * 100)}% / detailImages=${contentImageCount}`;

  return {
    ok: true,
    title,
    mainImageUrl: String(draft.imageUrl || ''),
    sourcePrice,
    shippingFee: Number(draft.shippingFee) || 0,
    finalPrice,
    profit,
    marginRate,
    score,
    reason,
  };
}

export async function replaceRecommendationsForUser({ userId, items }) {
  const db = openDb();
  const now = nowIso();

  await dbRun(db, 'DELETE FROM recommendations WHERE user_id = ?', [userId]);

  for (const it of items) {
    const id = crypto.randomUUID();
    await dbRun(
      db,
      `INSERT INTO recommendations (
        id, user_id, source_url, keyword, title, main_image_url,
        source_price, shipping_fee, final_price, profit, margin_rate, score,
        reason, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        it.sourceUrl,
        it.keyword || '',
        it.title || '',
        it.mainImageUrl || '',
        it.sourcePrice ?? null,
        it.shippingFee ?? null,
        it.finalPrice ?? null,
        it.profit ?? null,
        it.marginRate ?? null,
        it.score ?? null,
        it.reason || '',
        JSON.stringify(it.payload || {}),
        now,
      ],
    );
  }

  db.close();
  return { ok: true, count: items.length };
}

export async function upsertRecommendationsForUser({ userId, items, maxKeep = 60 }) {
  const db = openDb();
  const now = nowIso();

  let inserted = 0;
  for (const it of items) {
    const id = crypto.randomUUID();
    const r = await dbRun(
      db,
      `INSERT OR IGNORE INTO recommendations (
        id, user_id, source_url, keyword, title, main_image_url,
        source_price, shipping_fee, final_price, profit, margin_rate, score,
        reason, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        it.sourceUrl,
        it.keyword || '',
        it.title || '',
        it.mainImageUrl || '',
        it.sourcePrice ?? null,
        it.shippingFee ?? null,
        it.finalPrice ?? null,
        it.profit ?? null,
        it.marginRate ?? null,
        it.score ?? null,
        it.reason || '',
        JSON.stringify(it.payload || {}),
        now,
      ],
    );
    if (r && r.changes) inserted += 1;
  }

  // prune to maxKeep by score desc
  const keep = Math.max(10, Math.min(200, Number(maxKeep) || 60));
  await dbRun(
    db,
    `DELETE FROM recommendations
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM recommendations WHERE user_id = ?
         ORDER BY score DESC
         LIMIT ?
       )`,
    [userId, userId, keep],
  );

  const row = await dbGetOne(db, 'SELECT COUNT(*) AS c FROM recommendations WHERE user_id = ?', [userId]);
  db.close();
  return { ok: true, inserted, count: Number(row?.c) || 0 };
}

async function getRecommendationsState(db, userId) {
  const r = await dbGetOne(db, 'SELECT next_keyword_idx FROM recommendations_state WHERE user_id = ?', [userId]);
  if (r) return { nextKeywordIdx: Number(r.next_keyword_idx) || 0 };
  await dbRun(db, 'INSERT INTO recommendations_state (user_id, next_keyword_idx, updated_at) VALUES (?, ?, ?)', [userId, 0, nowIso()]);
  return { nextKeywordIdx: 0 };
}

async function setRecommendationsState(db, userId, nextKeywordIdx) {
  await dbRun(
    db,
    'INSERT INTO recommendations_state (user_id, next_keyword_idx, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET next_keyword_idx=excluded.next_keyword_idx, updated_at=excluded.updated_at',
    [userId, Number(nextKeywordIdx) || 0, nowIso()],
  );
}

function normalizeCooldownDays(value, fallback = DEFAULT_RECOMMENDATION_COOLDOWN_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return Math.max(1, Math.min(60, Number(fallback) || DEFAULT_RECOMMENDATION_COOLDOWN_DAYS));
  }
  return Math.max(1, Math.min(60, Math.floor(n)));
}

function cutoffIsoFromDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(0, Number(days) || 0));
  return d.toISOString();
}

async function markCurrentRecommendationsAsSeen(db, userId, sourceUrls = []) {
  const now = nowIso();
  let marked = 0;
  for (const rawUrl of sourceUrls) {
    const sourceUrl = String(rawUrl || '').trim();
    if (!sourceUrl) continue;
    await dbRun(
      db,
      'INSERT INTO recommendations_seen (user_id, source_url, last_seen_at, created_at) ' +
        'VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, source_url) DO UPDATE SET last_seen_at=excluded.last_seen_at',
      [userId, sourceUrl, now, now],
    );
    marked += 1;
  }
  return marked;
}

async function listRecentSeenUrls(db, userId, cooldownDays) {
  const cutoff = cutoffIsoFromDays(cooldownDays);
  const rows = await dbAll(
    db,
    'SELECT source_url FROM recommendations_seen WHERE user_id = ? AND last_seen_at >= ?',
    [userId, cutoff],
  );
  return rows.map((r) => String(r?.source_url || '').trim()).filter(Boolean);
}

async function listUploadedSourceUrls(db, userId, limit = 5000) {
  const rows = await dbAll(
    db,
    'SELECT source_url FROM uploaded_products WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, Math.max(1, Math.min(10000, Number(limit) || 5000))],
  );
  return rows.map((r) => String(r?.source_url || '').trim()).filter(Boolean);
}

export async function listRecommendations(userId, { limit = 50 } = {}) {
  const db = openDb();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const queryLimit = Math.max(lim, Math.min(800, lim * 4));
  const rows = await dbAll(
    db,
    `SELECT id, source_url, keyword, title, main_image_url, source_price, shipping_fee, final_price, profit, margin_rate, score, reason, payload_json, created_at
     FROM recommendations
     WHERE user_id = ?
     ORDER BY score DESC
     LIMIT ?`,
    [userId, queryLimit],
  );
  const savedRows = await dbAll(
    db,
    `SELECT source_url
     FROM ${RECOMMENDATIONS_SAVED_TABLE}
     WHERE user_id = ?`,
    [userId],
  ).catch(() => []);
  db.close();
  const savedSet = new Set(
    savedRows.map((r) => String(r?.source_url || '').trim()).filter(Boolean),
  );
  const mapped = rows.map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload_json || '{}'); } catch {}

    const qc = payload?.qc || null;
    const prev = payload?.preview || null;
    const previewImagesRaw = Array.isArray(prev?.computed?.images)
      ? prev.computed.images
      : (Array.isArray(prev?.contentImagesFiltered) ? prev.contentImagesFiltered : []);
    const previewImages = previewImagesRaw
        .map((u) => String(u || '').trim())
        .filter(Boolean)
        .slice(0, 30);
    const detailImageCount = Number(
      qc?.detailImageCount ??
      prev?.computed?.contentImageCount ??
      prev?.imageCountFiltered ??
      previewImages.length ??
      0
    ) || 0;
    const tier = String(qc?.tier || (detailImageCount >= 3 ? 'A' : (detailImageCount >= 1 ? 'B' : 'C')));
    const eligibleUpload = Boolean(qc?.eligibleUpload === true || qc?.ok === true);
    const sourcePrice = Number.isFinite(Number(r.source_price))
      ? Number(r.source_price)
      : (Number.isFinite(Number(prev?.draft?.price)) ? Number(prev?.draft?.price) : null);
    const shippingFee = Number.isFinite(Number(r.shipping_fee))
      ? Number(r.shipping_fee)
      : (Number.isFinite(Number(prev?.draft?.shippingFee)) ? Number(prev?.draft?.shippingFee) : null);

    return {
      id: r.id,
      sourceUrl: r.source_url,
      keyword: r.keyword,
      title: r.title,
      mainImageUrl: r.main_image_url,
      sourcePrice,
      shippingFee,
      finalPrice: r.final_price,
      profit: r.profit,
      marginRate: r.margin_rate,
      score: r.score,
      reason: r.reason,
      contentImageCount: detailImageCount,
      previewImages,
      qc: { tier, eligibleUpload, detailImageCount },
      createdAt: r.created_at,
      saved: savedSet.has(String(r.source_url || '').trim()),
    };
  });
  return mapped.filter((item) => Boolean(item?.qc?.eligibleUpload)).slice(0, lim);
}

function normalizeRecommendationItemInput(item = {}) {
  const it = item && typeof item === 'object' ? item : {};
  const sourceUrl = String(it.sourceUrl || '').trim();
  const payload = it.payload && typeof it.payload === 'object' ? it.payload : {};
  const qc = it.qc && typeof it.qc === 'object' ? it.qc : {};
  const previewImages = Array.isArray(it.previewImages)
    ? it.previewImages.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const contentImageCount = Number(it.contentImageCount ?? qc?.detailImageCount ?? 0) || 0;
  const mergedPayload = {
    ...(payload || {}),
    ...(Object.keys(qc).length ? { qc } : {}),
  };
  if (
    (!mergedPayload.preview || typeof mergedPayload.preview !== 'object') &&
    (previewImages.length > 0 || contentImageCount > 0)
  ) {
    mergedPayload.preview = {
      draft: {
        price: Number.isFinite(Number(it.sourcePrice)) ? Number(it.sourcePrice) : null,
        shippingFee: Number.isFinite(Number(it.shippingFee)) ? Number(it.shippingFee) : null,
      },
      computed: {
        images: previewImages,
        contentImageCount,
      },
    };
  }
  const payloadJson = JSON.stringify({
    ...mergedPayload,
  });
  return {
    sourceUrl,
    keyword: String(it.keyword || '').trim(),
    title: String(it.title || '').trim(),
    mainImageUrl: String(it.mainImageUrl || '').trim(),
    sourcePrice: Number.isFinite(Number(it.sourcePrice)) ? Number(it.sourcePrice) : null,
    shippingFee: Number.isFinite(Number(it.shippingFee)) ? Number(it.shippingFee) : null,
    finalPrice: Number.isFinite(Number(it.finalPrice)) ? Number(it.finalPrice) : null,
    profit: Number.isFinite(Number(it.profit)) ? Number(it.profit) : null,
    marginRate: Number.isFinite(Number(it.marginRate)) ? Number(it.marginRate) : null,
    score: Number.isFinite(Number(it.score)) ? Number(it.score) : null,
    reason: String(it.reason || '').trim(),
    payloadJson,
  };
}

function mapSavedRowToItem(r) {
  let payload = {};
  try { payload = JSON.parse(r.payload_json || '{}'); } catch {}
  const qc = payload?.qc || {};
  const prev = payload?.preview || {};
  const previewImagesRaw = Array.isArray(prev?.computed?.images)
    ? prev.computed.images
    : (Array.isArray(prev?.contentImagesFiltered) ? prev.contentImagesFiltered : []);
  const previewImages = previewImagesRaw
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 30);
  const detailImageCount = Number(
    qc?.detailImageCount ??
    prev?.computed?.contentImageCount ??
    prev?.imageCountFiltered ??
    previewImages.length ??
    0
  ) || 0;
  const sourcePrice = Number.isFinite(Number(r.source_price))
    ? Number(r.source_price)
    : (Number.isFinite(Number(prev?.draft?.price)) ? Number(prev?.draft?.price) : null);
  const shippingFee = Number.isFinite(Number(r.shipping_fee))
    ? Number(r.shipping_fee)
    : (Number.isFinite(Number(prev?.draft?.shippingFee)) ? Number(prev?.draft?.shippingFee) : null);
  return {
    id: r.id,
    sourceUrl: r.source_url,
    keyword: r.keyword,
    title: r.title,
    mainImageUrl: r.main_image_url,
    sourcePrice,
    shippingFee,
    finalPrice: r.final_price,
    profit: r.profit,
    marginRate: r.margin_rate,
    score: r.score,
    reason: r.reason,
    contentImageCount: detailImageCount,
    previewImages,
    qc: {
      tier: String(qc?.tier || '-'),
      eligibleUpload: Boolean(qc?.eligibleUpload),
      detailImageCount,
    },
    saved: true,
    savedAt: r.saved_at,
  };
}

export async function listSavedRecommendations(userId, { limit = 200 } = {}) {
  const db = openDb();
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const rows = await dbAll(
    db,
    `SELECT id, source_url, keyword, title, main_image_url, source_price, shipping_fee, final_price, profit, margin_rate, score, reason, payload_json, saved_at
     FROM ${RECOMMENDATIONS_SAVED_TABLE}
     WHERE user_id = ?
     ORDER BY saved_at DESC
     LIMIT ?`,
    [userId, lim],
  ).catch(() => []);
  db.close();
  return rows.map(mapSavedRowToItem);
}

export async function saveRecommendationForUser({ userId, item = {} } = {}) {
  const now = nowIso();
  const db = openDb();
  try {
    const normalized = normalizeRecommendationItemInput(item);
    const sourceUrl = normalized.sourceUrl;
    if (!sourceUrl) return { ok: false, error: 'missing_source_url' };

    let source = normalized;
    if (!source.title) {
      const fromReco = await dbGetOne(
        db,
        `SELECT source_url, keyword, title, main_image_url, source_price, shipping_fee, final_price, profit, margin_rate, score, reason, payload_json
         FROM recommendations
         WHERE user_id = ? AND source_url = ?
         LIMIT 1`,
        [userId, sourceUrl],
      );
      if (fromReco) {
        source = {
          sourceUrl: String(fromReco.source_url || '').trim(),
          keyword: String(fromReco.keyword || '').trim(),
          title: String(fromReco.title || '').trim(),
          mainImageUrl: String(fromReco.main_image_url || '').trim(),
          sourcePrice: fromReco.source_price,
          shippingFee: fromReco.shipping_fee,
          finalPrice: fromReco.final_price,
          profit: fromReco.profit,
          marginRate: fromReco.margin_rate,
          score: fromReco.score,
          reason: String(fromReco.reason || '').trim(),
          payloadJson: fromReco.payload_json || '{}',
        };
      }
    }

    const id = crypto.randomUUID();
    await dbRun(
      db,
      `INSERT INTO ${RECOMMENDATIONS_SAVED_TABLE} (
        id, user_id, source_url, keyword, title, main_image_url,
        source_price, shipping_fee, final_price, profit, margin_rate, score,
        reason, payload_json, saved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, source_url) DO UPDATE SET
        keyword=excluded.keyword,
        title=excluded.title,
        main_image_url=excluded.main_image_url,
        source_price=excluded.source_price,
        shipping_fee=excluded.shipping_fee,
        final_price=excluded.final_price,
        profit=excluded.profit,
        margin_rate=excluded.margin_rate,
        score=excluded.score,
        reason=excluded.reason,
        payload_json=excluded.payload_json,
        saved_at=excluded.saved_at`,
      [
        id,
        userId,
        source.sourceUrl,
        source.keyword || '',
        source.title || '',
        source.mainImageUrl || '',
        source.sourcePrice ?? null,
        source.shippingFee ?? null,
        source.finalPrice ?? null,
        source.profit ?? null,
        source.marginRate ?? null,
        source.score ?? null,
        source.reason || '',
        source.payloadJson || '{}',
        now,
      ],
    );
    return { ok: true, sourceUrl: source.sourceUrl };
  } finally {
    db.close();
  }
}

export async function removeSavedRecommendationForUser({ userId, sourceUrl } = {}) {
  const db = openDb();
  try {
    const target = String(sourceUrl || '').trim();
    if (!target) return { ok: false, error: 'missing_source_url' };
    await dbRun(
      db,
      `DELETE FROM ${RECOMMENDATIONS_SAVED_TABLE}
       WHERE user_id = ? AND source_url = ?`,
      [userId, target],
    );
    return { ok: true, sourceUrl: target };
  } finally {
    db.close();
  }
}

function parseWon(text) {
  const s = String(text || '');
  const m = s.match(/(\d[\d,]{2,})\s*원/);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeErrorMessage(error) {
  const parts = [];
  const msg = String(error?.message || error || '').trim();
  const causeCode = String(error?.cause?.code || '').trim();
  const causeMsg = String(error?.cause?.message || '').trim();
  if (causeCode) parts.push(causeCode);
  if (causeMsg && !parts.includes(causeMsg)) parts.push(causeMsg);
  if (msg && !parts.includes(msg)) parts.push(msg);
  return parts.filter(Boolean).join(' | ') || 'unknown_error';
}

function detectRecommendationHint(keywordDiagnostics = []) {
  const rows = Array.isArray(keywordDiagnostics) ? keywordDiagnostics : [];
  const flatErrors = rows
    .flatMap((r) => Array.isArray(r?.errors) ? r.errors : [])
    .map((e) => String(e || '').toLowerCase());

  if (flatErrors.some((e) => e.includes('rate_limited') || e.includes('429'))) {
    return '도매꾹 요청 제한(429) 가능성이 있습니다. 잠시 후 다시 시도하세요.';
  }
  if (flatErrors.some((e) => e.includes('enotfound') || e.includes('eai_again') || e.includes('getaddrinfo'))) {
    return '도매꾹 DNS/네트워크 연결 문제로 후보 수집에 실패했습니다.';
  }
  if (flatErrors.some((e) => e.includes('fetch failed') || e.includes('etimedout') || e.includes('econnreset'))) {
    return '도매꾹 네트워크 연결 또는 차단 이슈로 후보 수집에 실패했습니다.';
  }
  if (rows.length > 0 && rows.every((r) => Number(r?.collected || 0) === 0)) {
    return '키워드 결과가 없거나 수집이 차단되어 추천 후보를 만들지 못했습니다.';
  }
  return '';
}

function normalizeCandidateImageUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return `https://domeggook.com${s}`;
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  return '';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function resolveRecommendationPolicy(settings = {}) {
  return {
    // User request default: only QC-passed items should be recommended.
    requireQcPass: parseBoolean(settings?.recommendationRequireQcPass, true),
    // User request default: avoid repeating the same items by keeping recent-seen exclusion strict.
    allowRelaxedExclusion: parseBoolean(settings?.recommendationAllowRelaxedExclusion, false),
    // Keep this off by default; quick fallback often brings low-quality items.
    allowQuickFallback: parseBoolean(settings?.recommendationAllowQuickFallback, false),
  };
}

function resolveRecommendationThresholds(settings = {}) {
  const minProfit = Math.floor(
    clampNumber(
      settings?.recommendationMinProfit ?? settings?.minProfit,
      1000,
      20000,
      2500,
    ),
  );
  const minMarginRate = clampNumber(
    settings?.recommendationMinMarginRate ?? settings?.minMarginRate,
    0.12,
    0.9,
    0.25,
  );
  return { minProfit, minMarginRate };
}

async function fetchFastCandidatesFromList({ keyword, limit = 80, storageStatePath = '' }) {
  // v2: Prefer Domeggook OpenAPI if available.
  // Fallback: Playwright list scraping (legacy).
  const q = String(keyword || '').trim();
  if (!q) return { items: [], diagnostics: { keyword: '', strategy: 'none', collected: 0, errors: ['empty_keyword'] } };
  const diagnostics = { keyword: q, strategy: 'none', collected: 0, errors: [] };

  // 0) Try OpenAPI (best-effort). If docs/endpoint mismatch, it will throw.
  try {
    const { domeggookOpenApiGetItemList } = await import('../utils/domeggook_openapi.js');
    const r = await domeggookOpenApiGetItemList({
      keyword: q,
      market: 'dome',
      page: 1,
      pageSize: Math.max(10, Math.min(80, Number(limit) || 40)),
      sort: q ? 'se' : 'rd',
      ver: '4.1',
      om: 'json',
    });

    const raw = r?.raw || null;
    const items = raw?.domeggook?.list?.item || raw?.list?.item;
    const list = Array.isArray(items) ? items : (items ? [items] : []);

    if (list.length) {
      const out = [];
      for (const it of list) {
        const title = String(it?.title || '').trim();
        const price = Number(it?.price);
        const url = String(it?.url || '').trim() || '';
        const no = String(it?.no || '').trim();
        const imageUrl = normalizeCandidateImageUrl(
          it?.img ||
          it?.image ||
          it?.imageUrl ||
          it?.img_url ||
          it?.thumbnail ||
          it?.thumb ||
          it?.main_image ||
          it?.main_image_url ||
          it?.image_url ||
          it?.list_img ||
          it?.photo,
        );
        const finalUrl = url || (no ? `https://domeggook.com/${no}` : '');
        if (!finalUrl || !title || !Number.isFinite(price)) continue;
        out.push({
          url: finalUrl.replace(/^http:\/\//, 'https://'),
          title: title.slice(0, 80),
          price,
          imageUrl,
        });
        if (out.length >= limit) break;
      }
      if (out.length) {
        diagnostics.strategy = 'openapi';
        diagnostics.collected = out.length;
        return { items: out, diagnostics };
      }
    }
  } catch (e) {
    diagnostics.errors.push(`openapi: ${normalizeErrorMessage(e)}`);
  }

  // 1) Playwright list-page extraction (legacy)
  try {
    const { chromium } = await import('playwright');
    const fs = await import('node:fs');

    const hasState = storageStatePath && fs.existsSync(storageStatePath);
    const browser = await chromium.launch();
    try {
      const context = hasState ? await browser.newContext({ storageState: storageStatePath }) : await browser.newContext();
      const page = await context.newPage();

      const listUrl = `https://domeggook.com/main/item/itemList.php?sw=${encodeURIComponent(q)}&sf=ttl`;
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      await page.waitForTimeout(700);

      const rows = await page.evaluate(({ keyword }) => {
        const kwRaw = String(keyword || '').trim().toLowerCase();
        const kw = kwRaw.replace(/\s+/g, '');

        const parseWon = (s) => {
          const m = String(s || '').match(/(\d[\d,]{2,})\s*원/);
          if (!m) return null;
          const n = Number(String(m[1]).replace(/,/g, ''));
          return Number.isFinite(n) ? n : null;
        };

        const out = [];
        const seen = new Set();
        const anchors = [...document.querySelectorAll('a[href^="/"]')];

        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/^\/(\d{6,})(?:\?|$)/);
          if (!m) continue;
          const id = m[1];
          if (seen.has(id)) continue;

          const card = a.closest('li, article, div, td') || a.parentElement;
          const text = (card?.innerText || a.innerText || '').replace(/\s+/g, ' ').trim();
          const price = parseWon(text);
          if (!price) continue;

          const title = text.replace(/\d[\d,]{2,}\s*원/g, '').trim();
          if (!title) continue;

          const hay = (title + ' ' + text).toLowerCase();
          const hayNorm = hay.replace(/\s+/g, '');
          if (kw && !hayNorm.includes(kw)) continue;

          seen.add(id);
          const imgEl = card?.querySelector?.('img');
          const imageUrlRaw =
            imgEl?.getAttribute?.('data-src') ||
            imgEl?.getAttribute?.('src') ||
            '';
          let imageUrl = String(imageUrlRaw || '').trim();
          if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
          else if (imageUrl.startsWith('/')) imageUrl = `${location.origin}${imageUrl}`;
          imageUrl = imageUrl.replace(/^http:\/\//i, 'https://');
          out.push({
            url: `https://domeggook.com/${id}`,
            title: title.slice(0, 80),
            price,
            imageUrl,
          });
          if (out.length >= 120) break;
        }

        return out;
      }, { keyword: q });

      if (rows && rows.length) {
        const items = rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 80)));
        diagnostics.strategy = 'playwright';
        diagnostics.collected = items.length;
        return { items, diagnostics };
      }
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    diagnostics.errors.push(`playwright: ${normalizeErrorMessage(e)}`);
  }

  // 2) Fallback: get URLs then fetch each item HTML (may hit 429)
  const urls = await fetchDomeggookUrlsByKeyword({ keyword: q, limit: Math.min(limit, 12), storageStatePath }).catch((e) => {
    diagnostics.errors.push(`url_seed: ${normalizeErrorMessage(e)}`);
    return [];
  });
  const out = [];
  const maxFallbackFetch = Math.max(1, Math.min(4, Number(limit) || 4));

  for (const u of urls) {
    if (out.length >= maxFallbackFetch) break;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3_000);
      const r = await fetch(u, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://domeggook.com/' },
      });
      clearTimeout(t);
      if (r.status === 429) throw new Error('domeggook_rate_limited');
      if (!r.ok) continue;
      const html = await r.text();
      await new Promise((r) => setTimeout(r, 200));

      const title = (() => {
        const m = html.match(/<meta property=["']og:title["'] content=["']([^"']+)["']/i);
        if (m && m[1]) return m[1].trim();
        const t2 = html.match(/<title>([\s\S]*?)<\/title>/i);
        return t2 && t2[1] ? t2[1].replace(/\s+/g, ' ').trim() : '';
      })();

      const price = (() => {
        const m1 = html.match(/(\d[\d,]{2,})\s*원/);
        if (!m1) return null;
        const n = Number(String(m1[1]).replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
      })();

      const imageUrl = (() => {
        const m = html.match(/<meta property=["']og:image["'] content=["']([^"']+)["']/i);
        if (m && m[1]) return normalizeCandidateImageUrl(m[1]);
        const m2 = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m2 && m2[1]) return normalizeCandidateImageUrl(m2[1]);
        return '';
      })();

      if (!title || !price) continue;
      const hay = String(title).toLowerCase().replace(/\s+/g, '');
      const needle = String(q).trim().toLowerCase().replace(/\s+/g, '');
      if (needle && !hay.includes(needle)) continue;
      out.push({ url: u, title, price, imageUrl });
      if (out.length >= limit) break;
    } catch (e) {
      if (String(e?.message || e).includes('rate_limited')) throw e;
      if (diagnostics.errors.length < 8) diagnostics.errors.push(`item_fetch: ${normalizeErrorMessage(e)}`);
    }

    await new Promise((r) => setTimeout(r, 80));
  }

  diagnostics.strategy = out.length ? 'url_fallback' : diagnostics.strategy;
  diagnostics.collected = out.length;
  return { items: out, diagnostics };
}

function strictValidatePreview(preview, banKeywords = DEFAULT_BAN_KEYWORDS) {
  if (!preview?.ok) return { ok: false, reason: 'preview_failed' };
  const draft = preview?.draft && typeof preview.draft === 'object' ? preview.draft : {};
  const qcPreview = preview?.preview && typeof preview.preview === 'object' ? preview.preview : {};
  const title = String(draft?.title || '');
  if (!title) return { ok: false, reason: 'no_title' };
  if (containsBanKeyword(title, banKeywords)) return { ok: false, reason: 'banned_keyword' };

  const previewImages = Array.isArray(qcPreview?.contentImagesFiltered)
    ? qcPreview.contentImagesFiltered.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  const contentImageCount = Number(qcPreview?.imageCountFiltered ?? previewImages.length ?? 0) || 0;
  const hasMain = Boolean(draft?.imageUrl);
  const hasAnyImage = previewImages.length > 0 || hasMain;

  if (!hasAnyImage) return { ok: false, reason: 'no_images', contentImageCount };
  return {
    ok: true,
    contentImageCount,
    previewImages: previewImages.slice(0, 30),
    qcPreview,
    mainImageUrl: String(draft?.imageUrl || '').trim(),
    title: String(draft?.title || '').trim(),
    sourcePrice: Number(draft?.price),
    shippingFee: draft?.shippingFee,
  };
}

async function generateRecommendationsBatch({
  settings,
  keywords,
  topN = 20,
  excludeUrls = new Set(),
  onProgress = null,
  maxRuntimeMs = 110_000,
  previewTimeoutMs = 12_000,
} = {}) {
  const seed = Array.isArray(keywords) && keywords.length > 0 ? keywords : defaultKeywordSet();
  const startedAt = Date.now();
  const keywordDiagnostics = [];
  const normalizedSettings = settings || {};
  const thresholds = resolveRecommendationThresholds(normalizedSettings);
  const policy = resolveRecommendationPolicy(normalizedSettings);
  const keywordScanLimit = Math.max(
    1,
    Math.min(
      seed.length,
      policy.requireQcPass ? 16 : 8,
      Math.max(8, Math.ceil(Number(topN || 20) * 1.5)),
    ),
  );

  const candidates = [];
  for (const kw of seed.slice(0, keywordScanLimit)) {
    if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.45)) break;
    let list = [];
    try {
      const result = await fetchFastCandidatesFromList({
        keyword: kw,
        limit: policy.requireQcPass ? 60 : 40,
        storageStatePath: String(normalizedSettings?.domeggookStorageStatePath || ''),
      });
      list = Array.isArray(result?.items) ? result.items : [];
      if (result?.diagnostics) keywordDiagnostics.push(result.diagnostics);
    } catch (e) {
      if (String(e?.message || e).includes('rate_limited')) {
        if (typeof onProgress === 'function') {
          try { onProgress({ stage: 'rate_limited', keyword: kw, candidates: candidates.length }); } catch {}
        }
        throw e;
      }
      keywordDiagnostics.push({
        keyword: kw,
        strategy: 'error',
        collected: 0,
        errors: [normalizeErrorMessage(e)],
      });
      list = [];
    }

    for (const it of list) {
      if (excludeUrls.has(it.url)) continue;
      candidates.push({ keyword: kw, ...it });
      if (candidates.length >= 1200) break;
    }
    if (typeof onProgress === 'function') {
      try { onProgress({ stage: 'collect', keyword: kw, candidates: candidates.length }); } catch {}
    }
    if (candidates.length >= 1200) break;
  }

  const uniq = [];
  const seen = new Set();
  for (const c of candidates) {
    if (excludeUrls.has(c.url)) continue;
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    uniq.push(c);
  }

  const scoredPool = [];
  for (const c of uniq) {
    if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.65)) break;
    if (containsBanKeyword(c.title, DEFAULT_BAN_KEYWORDS)) continue;

    const fakePreview = {
      ok: true,
      url: c.url,
      draft: { title: c.title, price: c.price, shippingFee: null, imageUrl: '' },
      computed: { contentImageCount: 1 },
    };

    const s = scoreRecommendation({
      preview: fakePreview,
      minProfit: thresholds.minProfit,
      minMarginRate: thresholds.minMarginRate,
      banKeywords: DEFAULT_BAN_KEYWORDS,
    });
    if (!s.ok) continue;

    scoredPool.push({
      sourceUrl: c.url,
      keyword: c.keyword,
      ...s,
      mainImageUrl: normalizeCandidateImageUrl(c.imageUrl || s.mainImageUrl),
      payload: { fast: true },
    });

    if (scoredPool.length >= 500) break;
  }

  // If strict thresholds produce too small a pool, relax once to avoid empty lists.
  if (scoredPool.length < Math.max(8, Math.floor(topN * 1.2))) {
    const relaxedMinProfit = Math.max(1000, Math.floor(thresholds.minProfit * 0.6));
    const relaxedMinMarginRate = Math.max(0.12, Number((thresholds.minMarginRate * 0.7).toFixed(3)));
    const existing = new Set(scoredPool.map((x) => String(x?.sourceUrl || '').trim()));
    for (const c of uniq) {
      if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.75)) break;
      const u = String(c?.url || '').trim();
      if (!u || existing.has(u)) continue;
      if (containsBanKeyword(c.title, DEFAULT_BAN_KEYWORDS)) continue;

      const fakePreview = {
        ok: true,
        url: c.url,
        draft: { title: c.title, price: c.price, shippingFee: null, imageUrl: '' },
        computed: { contentImageCount: 1 },
      };
      const s = scoreRecommendation({
        preview: fakePreview,
        minProfit: relaxedMinProfit,
        minMarginRate: relaxedMinMarginRate,
        banKeywords: DEFAULT_BAN_KEYWORDS,
      });
      if (!s.ok) continue;

      existing.add(u);
      scoredPool.push({
        sourceUrl: c.url,
        keyword: c.keyword,
        ...s,
        mainImageUrl: normalizeCandidateImageUrl(c.imageUrl || s.mainImageUrl),
        payload: {
          fast: true,
          relaxedThreshold: true,
          thresholds: {
            minProfit: relaxedMinProfit,
            minMarginRate: relaxedMinMarginRate,
          },
        },
      });
      if (scoredPool.length >= 500) break;
    }
  }

  scoredPool.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  const final = [];
  let validated = 0;
  let qcRejected = 0;
  let maxValidate = Math.max(topN * (policy.requireQcPass ? 12 : 2), 24);
  maxValidate = Math.min(maxValidate, policy.requireQcPass ? 220 : 80);
  for (const cand of scoredPool) {
    if (final.length >= topN) break;
    if (validated >= maxValidate) break;
    if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.92)) break;
    if (excludeUrls.has(cand.sourceUrl)) continue;

    const prev = await withTimeout(
      previewUploadFromUrl(cand.sourceUrl, {
        ...normalizedSettings,
        maxContentImages: 30,
      }),
      previewTimeoutMs,
      'preview_timeout',
    ).catch(() => null);

    validated += 1;

    const v = strictValidatePreview(prev, DEFAULT_BAN_KEYWORDS);
    if (!v.ok) {
      if (typeof onProgress === 'function' && validated % 3 === 0) {
        try { onProgress({ stage: 'validate', validated, kept: final.length, qcRejected, target: topN }); } catch {}
      }
      continue;
    }

    const qcGate = evaluateQcGate(v.qcPreview || {}, normalizedSettings);
    if (policy.requireQcPass && !qcGate.ok) {
      qcRejected += 1;
      if (typeof onProgress === 'function' && validated % 3 === 0) {
        try { onProgress({ stage: 'validate', validated, kept: final.length, qcRejected, target: topN }); } catch {}
      }
      continue;
    }

    const detailCount = Number(v.contentImageCount || 0) || 0;
    const tier = detailCount >= 3 ? 'A' : (detailCount >= 1 ? 'B' : 'C');
    const eligibleUpload = Boolean(qcGate.ok);

    // Prefer fields from the real preview (more accurate than list-scraped/fake preview).
    const prevTitle = String(v.title || '').trim();
    const prevMainImageUrl = String(v.mainImageUrl || '').trim();
    const prevPrice = Number(v.sourcePrice);
    const prevShip = v.shippingFee;

    final.push({
      ...cand,
      title: prevTitle || cand.title,
      mainImageUrl: prevMainImageUrl || cand.mainImageUrl,
      sourcePrice: Number.isFinite(prevPrice) ? prevPrice : cand.sourcePrice,
      shippingFee: (prevShip == null ? cand.shippingFee : prevShip),
      payload: {
        ...cand.payload,
        preview: {
          url: prev?.url || cand.sourceUrl,
          draft: prev?.draft || null,
          computed: {
            images: v.previewImages || [],
            contentImageCount: detailCount,
            imageCountRaw: Number(v.qcPreview?.imageCountRaw || 0) || 0,
            imageCountFiltered: Number(v.qcPreview?.imageCountFiltered || detailCount) || detailCount,
            imageCountRejected: Number(v.qcPreview?.imageCountRejected || 0) || 0,
          },
        },
        qc: {
          ok: Boolean(qcGate.ok),
          reasons: Array.isArray(qcGate.reasons) ? qcGate.reasons : [],
          metrics: qcGate.metrics && typeof qcGate.metrics === 'object' ? qcGate.metrics : {},
          detailImageCount: detailCount,
          tier,
          eligibleUpload,
        },
      },
    });
    if (typeof onProgress === 'function' && validated % 3 === 0) {
      try { onProgress({ stage: 'validate', validated, kept: final.length, qcRejected, target: topN }); } catch {}
    }
  }

  // Keep UX stable: if strict preview validation yielded too few items,
  // backfill with scored candidates so the list is not almost empty.
  let fallbackFilledCount = 0;
  if (policy.allowQuickFallback && final.length < topN) {
    const chosen = new Set(final.map((x) => String(x?.sourceUrl || '')));
    for (const cand of scoredPool) {
      if (final.length >= topN) break;
      if (excludeUrls.has(cand.sourceUrl)) continue;
      if (chosen.has(cand.sourceUrl)) continue;
      chosen.add(cand.sourceUrl);

      final.push({
        ...cand,
        payload: {
          ...cand.payload,
          qc: {
            ok: false,
            reasons: ['quick_fallback'],
            metrics: {},
            detailImageCount: 0,
            tier: 'C',
            eligibleUpload: false,
          },
          quickFallback: true,
        },
      });
      fallbackFilledCount += 1;
    }
  }

  const diagnostics = {
    keywordsTried: keywordScanLimit,
    collectedCandidates: candidates.length,
    uniqueCandidates: uniq.length,
    scoredCandidates: scoredPool.length,
    thresholds,
    policy,
    validated,
    kept: final.length,
    qcRejected,
    fallbackFilledCount,
    keywordDiagnostics: keywordDiagnostics.slice(0, keywordScanLimit).map((d) => ({
      keyword: d.keyword,
      strategy: d.strategy || 'none',
      collected: Number(d.collected || 0),
      errors: (Array.isArray(d.errors) ? d.errors : []).slice(0, 2),
    })),
    openApiKeyMissing: keywordDiagnostics.some((d) =>
      (Array.isArray(d?.errors) ? d.errors : []).some((e) =>
        String(e || '').includes('domeggook_openapi_key_missing')
      )
    ),
    hasDomeggookSessionPath: Boolean(String(normalizedSettings?.domeggookStorageStatePath || '').trim()),
    hint: '',
  };
  if (final.length === 0) {
    if (qcRejected > 0) {
      diagnostics.hint = `QC 통과 상품을 찾지 못했습니다. 검증 ${validated}건 중 QC 탈락 ${qcRejected}건입니다.`;
    } else if (diagnostics.openApiKeyMissing && !diagnostics.hasDomeggookSessionPath) {
      diagnostics.hint = '도매꾹 OpenAPI 키가 없고 세션 파일 경로도 비어 있어 후보 수집을 시작하지 못했습니다.';
    } else {
      diagnostics.hint = detectRecommendationHint(keywordDiagnostics);
    }
  }

  return { ok: true, items: final, validated, diagnostics };
}

export async function generateRecommendationsForUser({ userId, settings, keywords, topN = 20, onProgress = null }) {
  const batch = await generateRecommendationsBatch({ settings, keywords, topN, excludeUrls: new Set(), onProgress });
  await replaceRecommendationsForUser({ userId, items: batch.items });
  return { ok: true, count: batch.items.length, diagnostics: batch.diagnostics };
}

export async function fillRecommendationsForUser({ userId, settings, keywords, targetCount = 20, maxAddPerRun = 6, onProgress = null }) {
  const db = openDb();
  const seed = Array.isArray(keywords) && keywords.length > 0 ? keywords : defaultKeywordSet();

  const existingRows = await dbAll(db, 'SELECT source_url FROM recommendations WHERE user_id = ?', [userId]);
  const exclude = new Set(existingRows.map((r) => r.source_url));

  const state = await getRecommendationsState(db, userId);
  const idx = state.nextKeywordIdx % Math.max(1, seed.length);
  const kw = seed[idx];
  await setRecommendationsState(db, userId, idx + 1);

  db.close();

  if (typeof onProgress === 'function') {
    try { onProgress({ stage: 'fill_start', keyword: kw, candidates: exclude.size }); } catch {}
  }

  const need = Math.max(0, Number(targetCount) - exclude.size);
  if (need <= 0) {
    return {
      ok: true,
      inserted: 0,
      count: exclude.size,
      keyword: kw,
      diagnostics: {
        keywordsTried: 1,
        collectedCandidates: 0,
        uniqueCandidates: 0,
        scoredCandidates: 0,
        validated: 0,
        kept: exclude.size,
        keywordDiagnostics: [],
        hint: '',
      },
    };
  }

  const batch = await generateRecommendationsBatch({
    settings,
    keywords: [kw],
    topN: Math.min(Math.max(1, need), Math.max(2, Number(maxAddPerRun) || 6)),
    excludeUrls: exclude,
    onProgress,
  });

  const up = await upsertRecommendationsForUser({ userId, items: batch.items, maxKeep: Math.max(60, Number(targetCount) || 20) });
  return { ok: true, ...up, keyword: kw, diagnostics: batch.diagnostics };
}


export async function refreshRecommendationsForUser({
  userId,
  settings,
  keywords,
  targetCount = 20,
  cooldownDays,
  onProgress = null,
} = {}) {
  const policy = resolveRecommendationPolicy(settings || {});
  const seed = Array.isArray(keywords) && keywords.length > 0 ? keywords : defaultKeywordSet();
  const target = Math.max(5, Math.min(100, Number(targetCount) || 20));
  const cooldown = normalizeCooldownDays(
    cooldownDays ?? settings?.recommendationCooldownDays,
    DEFAULT_RECOMMENDATION_COOLDOWN_DAYS,
  );

  const db = openDb();
  const existingRows = await dbAll(
    db,
    'SELECT source_url FROM recommendations WHERE user_id = ?',
    [userId],
  );
  const existingUrls = existingRows
    .map((r) => String(r?.source_url || '').trim())
    .filter(Boolean);

  const markedCount = await markCurrentRecommendationsAsSeen(db, userId, existingUrls);
  const recentSeenUrls = await listRecentSeenUrls(db, userId, cooldown);
  const uploadedUrls = await listUploadedSourceUrls(db, userId, 8000);
  const excludeUrls = new Set([...recentSeenUrls, ...uploadedUrls]);

  await dbRun(db, 'DELETE FROM recommendations WHERE user_id = ?', [userId]);

  const state = await getRecommendationsState(db, userId);
  await setRecommendationsState(db, userId, state.nextKeywordIdx + 1);
  db.close();

  if (typeof onProgress === 'function') {
    try {
      onProgress({
        stage: 'refresh_start',
        removed: existingUrls.length,
        cooldownDays: cooldown,
        excluded: excludeUrls.size,
      });
    } catch {}
  }

  const initialExcludedCount = excludeUrls.size;
  let finalExcludedCount = excludeUrls.size;
  let usedRelaxedExclusion = false;

  let batch = await generateRecommendationsBatch({
    settings,
    keywords: seed,
    topN: target,
    excludeUrls,
    onProgress,
  });

  // If too few items are found, retry without "recent seen" restriction.
  // Keep uploaded products excluded to avoid duplicate uploads.
  const tooFew = batch.items.length < Math.max(2, Math.floor(target * 0.5));
  if (policy.allowRelaxedExclusion && tooFew && recentSeenUrls.length > 0) {
    const uploadedOnlyExclude = new Set(uploadedUrls);
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          stage: 'relax_exclude',
          beforeExcluded: excludeUrls.size,
          afterExcluded: uploadedOnlyExclude.size,
        });
      } catch {}
    }
    const retryBatch = await generateRecommendationsBatch({
      settings,
      keywords: seed,
      topN: target,
      excludeUrls: uploadedOnlyExclude,
      onProgress,
    });
    if (retryBatch.items.length > batch.items.length) {
      batch = retryBatch;
      usedRelaxedExclusion = true;
      finalExcludedCount = uploadedOnlyExclude.size;
    }
  }

  await replaceRecommendationsForUser({ userId, items: batch.items });

  const diagnostics = {
    ...batch.diagnostics,
    initialExcludedCount,
    finalExcludedCount,
    relaxedExclusionAllowed: Boolean(policy.allowRelaxedExclusion),
    relaxedExclusionApplied: usedRelaxedExclusion,
  };

  return {
    ok: true,
    count: batch.items.length,
    removedCount: existingUrls.length,
    markedCount,
    cooldownDays: cooldown,
    excludedCount: finalExcludedCount,
    diagnostics,
  };
}

export function startRecommendationLoop({ getUsers, hour = 9, minute = 0, intervalMs = 60_000 }) {
  let lastRunKey = '';

  const tick = async () => {
    try {
      const now = new Date();
      const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (key === lastRunKey) return;

      if (now.getHours() !== hour || now.getMinutes() !== minute) return;

      const users = await getUsers();
      for (const u of users) {
        try {
          await generateRecommendationsForUser({ userId: u.id, settings: u.settings || {}, keywords: defaultKeywordSet(), topN: 20 });
        } catch {}
      }
      lastRunKey = key;
    } catch {}
  };

  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}
