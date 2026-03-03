import crypto from 'node:crypto';

import { analyzeSameProductImages, previewUploadFromUrl } from '../pipeline/previewUploadFromUrl.js';
import { evaluateQcGate } from '../pipeline/qcGate.js';
import { extractImageUrls } from '../utils/contentImages.js';
import { stripDomeggookPromoBlocks } from '../utils/domeggookDetailHtml.js';
import { buildProxyUrl } from '../utils/imageProxy.js';
import { resolveDisplayCategoryCode } from '../utils/categoryMap.js';
import { buildCoupangSeoTitle } from '../utils/titleSuggest.js';
import { recommendCategory } from '../coupang/api/recommendCategory.js';
import { dbAll, dbRun, openDb } from './storage_sqlite_internal.js';

const DEFAULT_RECOMMENDATION_COOLDOWN_DAYS = 7;
const RECOMMENDATIONS_SAVED_TABLE = 'recommendations_saved';
const RECOMMENDATION_IMAGE_PROXY_BASE = '/api/image-proxy?url={url}';

function dbGetOne(db, sql, params = []) {
  return dbAll(db, sql, params).then((rows) => (rows && rows[0]) || null);
}


// NOTE: storage_sqlite.js doesn't currently export low-level db helpers.
// We keep this module standalone by using the internal helper shim.

function nowIso() {
  return new Date().toISOString();
}

function toRecommendationImageUrl(rawUrl, referer = '') {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  if (/^data:/i.test(u)) return u;
  if (u.startsWith('/api/image-proxy?')) return u;
  if (/^https?:\/\//i.test(u)) {
    return buildProxyUrl(u, RECOMMENDATION_IMAGE_PROXY_BASE, referer);
  }
  return u;
}

function withTimeout(promise, ms, label = 'timeout') {
  const t = new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms));
  return Promise.race([promise, t]);
}

function normalizeCharsetLabel(raw = '') {
  const text = String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/_/g, '-');
  if (!text) return '';
  if (text === 'utf8') return 'utf-8';
  if (
    text === 'cp949' ||
    text === 'ms949' ||
    text === 'euckr' ||
    text === 'x-euc-kr' ||
    text === 'windows-949' ||
    text === 'x-windows-949' ||
    text === 'ks-c-5601-1987' ||
    text === 'ks-c-5601-1989' ||
    text === 'ksc5601'
  ) {
    return 'euc-kr';
  }
  return text;
}

function extractCharsetFromContentType(contentType = '') {
  const m = String(contentType || '').match(/charset\s*=\s*["']?\s*([^;"'\s]+)/i);
  return m && m[1] ? normalizeCharsetLabel(m[1]) : '';
}

function extractCharsetFromHtmlHead(headHtml = '') {
  const text = String(headHtml || '');
  const direct = text.match(/<meta[^>]+charset=["']?\s*([a-z0-9._-]+)/i);
  if (direct && direct[1]) return normalizeCharsetLabel(direct[1]);

  const viaContentA = text.match(/<meta[^>]+content=["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i);
  if (viaContentA && viaContentA[1]) return normalizeCharsetLabel(viaContentA[1]);

  const viaContentB = text.match(/<meta[^>]+charset\s*=\s*([a-z0-9._-]+)[^>]*content=["']/i);
  if (viaContentB && viaContentB[1]) return normalizeCharsetLabel(viaContentB[1]);

  return '';
}

function countReplacementChars(text = '') {
  const m = String(text || '').match(/\uFFFD/g);
  return m ? m.length : 0;
}

function decodeHtmlBuffer(buffer, charset = 'utf-8') {
  const encoding = normalizeCharsetLabel(charset) || 'utf-8';
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return Buffer.from(buffer).toString('utf8');
  }
}

async function readHtmlWithCharset(response) {
  const arr = await response.arrayBuffer();
  const bytes = Buffer.from(arr);

  let charset = extractCharsetFromContentType(response?.headers?.get('content-type') || '');
  if (!charset) {
    const sniffHead = bytes.subarray(0, 8192).toString('latin1');
    charset = extractCharsetFromHtmlHead(sniffHead);
  }

  let html = decodeHtmlBuffer(bytes, charset || 'utf-8');

  const utfLike = !charset || String(charset).startsWith('utf');
  if (utfLike) {
    const brokenUtf = countReplacementChars(html);
    if (brokenUtf >= 8 && !/[가-힣]/.test(html)) {
      const eucHtml = decodeHtmlBuffer(bytes, 'euc-kr');
      const brokenEuc = countReplacementChars(eucHtml);
      if (brokenEuc < brokenUtf || /[가-힣]/.test(eucHtml)) {
        html = eucHtml;
      }
    }
  }

  return html;
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

// Recommendation scoring relaxation: these are often over-broad for
// discovery candidates and can eliminate almost everything.
const RELAXABLE_RECO_BAN_KEYWORDS = new Set([
  '충전기',
  '전동',
  '전기',
  '220v',
  '110v',
  'kc',
  '인증',
  '전파',
  '스틱',
]);

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
  let bestFromFetch = [];

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
      const html = await readHtmlWithCharset(r);
      await new Promise((r) => setTimeout(r, 220));
      const out = extractFromHtml(html);
      for (const u of out) {
        if (!all.includes(u)) all.push(u);
        if (all.length >= limit) break;
      }
    }
    if (all.length > 0) {
      bestFromFetch = all.slice(0, limit);
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
    return (all.length > 0 ? all : bestFromFetch).slice(0, limit);
  } catch {
    return bestFromFetch.slice(0, limit);
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

    const sourceUrl = String(r.source_url || '').trim();
    const qc = payload?.qc || null;
    const prev = payload?.preview || null;
    const previewImagesRaw = Array.isArray(prev?.computed?.images)
      ? prev.computed.images
      : (Array.isArray(prev?.contentImagesFiltered) ? prev.contentImagesFiltered : []);
    const previewImages = previewImagesRaw
        .map((u) => String(u || '').trim())
        .filter(Boolean)
        .map((u) => toRecommendationImageUrl(u, sourceUrl))
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
    const seoTitleRaw = String(payload?.seo?.title || r.title || '').trim();
    const seoTitle = seoTitleRaw || String(r.title || '').trim();
    const originalTitleRaw = String(payload?.seo?.originalTitle || r.title || '').trim();
    const categoryCode = toPositiveInt(payload?.category?.code);
    const categorySourceRaw = String(payload?.category?.source || '').trim();
    const categorySource = categorySourceRaw || (categoryCode ? 'payload' : null);

    return {
      id: r.id,
      sourceUrl,
      keyword: r.keyword,
      title: seoTitle || r.title,
      seoTitle: seoTitle || r.title,
      originalTitle: originalTitleRaw || seoTitle || r.title,
      categoryCode,
      categorySource,
      mainImageUrl: toRecommendationImageUrl(r.main_image_url, sourceUrl),
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
  const seoTitleInput = String(it.seoTitle || '').trim();
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
    title: String(it.title || seoTitleInput || '').trim(),
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
  const sourceUrl = String(r.source_url || '').trim();
  const qc = payload?.qc || {};
  const prev = payload?.preview || {};
  const previewImagesRaw = Array.isArray(prev?.computed?.images)
    ? prev.computed.images
    : (Array.isArray(prev?.contentImagesFiltered) ? prev.contentImagesFiltered : []);
  const previewImages = previewImagesRaw
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .map((u) => toRecommendationImageUrl(u, sourceUrl))
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
  const seoTitleRaw = String(payload?.seo?.title || r.title || '').trim();
  const seoTitle = seoTitleRaw || String(r.title || '').trim();
  const originalTitleRaw = String(payload?.seo?.originalTitle || r.title || '').trim();
  const categoryCode = toPositiveInt(payload?.category?.code);
  const categorySourceRaw = String(payload?.category?.source || '').trim();
  const categorySource = categorySourceRaw || (categoryCode ? 'payload' : null);
  return {
    id: r.id,
    sourceUrl,
    keyword: r.keyword,
    title: seoTitle || r.title,
    seoTitle: seoTitle || r.title,
    originalTitle: originalTitleRaw || seoTitle || r.title,
    categoryCode,
    categorySource,
    mainImageUrl: toRecommendationImageUrl(r.main_image_url, sourceUrl),
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
  const hasOpenApiError = flatErrors.some((e) => e.includes('openapi:'));
  const hasPlaywrightError = flatErrors.some((e) => e.includes('playwright:'));

  if (flatErrors.some((e) => e.includes('rate_limited') || e.includes('429'))) {
    return '도매꾹 요청 제한(429) 가능성이 있습니다. 잠시 후 다시 시도하세요.';
  }
  if (flatErrors.some((e) => e.includes('enotfound') || e.includes('eai_again') || e.includes('getaddrinfo'))) {
    return '도매꾹 DNS/네트워크 연결 문제로 후보 수집에 실패했습니다.';
  }
  if (flatErrors.some((e) => e.includes('fetch failed') || e.includes('etimedout') || e.includes('econnreset'))) {
    return '도매꾹 네트워크 연결 또는 차단 이슈로 후보 수집에 실패했습니다.';
  }
  if (hasOpenApiError && hasPlaywrightError) {
    return '도매꾹 OpenAPI 실패 후 Playwright 파싱도 실패했습니다. 서버 Playwright 실행 환경을 확인하세요.';
  }
  if (hasOpenApiError) {
    return '도매꾹 OpenAPI 응답 오류로 후보 수집에 실패했습니다. Playwright 폴백을 확인하세요.';
  }
  if (hasPlaywrightError) {
    return 'Playwright 파싱 실패로 후보 수집에 실패했습니다. 브라우저 실행 환경을 확인하세요.';
  }
  if (rows.length > 0 && rows.every((r) => Number(r?.collected || 0) === 0)) {
    return '키워드 결과가 없거나 수집이 차단되어 추천 후보를 만들지 못했습니다.';
  }
  return '';
}

function sumCountValues(map = {}) {
  if (!map || typeof map !== 'object') return 0;
  return Object.values(map).reduce((acc, value) => {
    const n = Number(value || 0);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
}

function humanizeStrictRejectReason(reason = '') {
  const key = String(reason || '').trim().toLowerCase();
  if (!key) return '알 수 없는 검증 실패';
  if (key === 'preview_playwright_budget_exhausted') return 'Playwright 재시도 예산 소진';
  if (key === 'preview_timeout') return '미리보기 타임아웃';
  if (key === 'preview_failed') return '미리보기 실패';
  if (key === 'no_title') return '제목 누락';
  if (key === 'no_images') return '이미지 없음';
  if (key.startsWith('preview_')) return `미리보기 실패 (${key.replace(/^preview_/, '')})`;
  return key;
}

function toSortedCountEntries(map = {}, limit = 5) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .map(([reason, count]) => [String(reason || ''), Number(count || 0)])
    .filter(([reason, count]) => Boolean(reason) && Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Number(limit) || 5));
}

function normalizeCandidateImageUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return `https://domeggook.com${s}`;
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  return '';
}

function isDomeggookSourceUrl(rawUrl = '') {
  const s = String(rawUrl || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    const host = String(u.hostname || '').toLowerCase();
    return host === 'domeggook.com' || host.endsWith('.domeggook.com');
  } catch {
    return /domeggook\.com/i.test(s);
  }
}

function isRelaxableQcReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return false;
  return [
    '상세 이미지가 너무 적습니다',
    '대표-상세 이미지 토큰 일치율이 낮아',
    '상세 이미지 차단 비율이 높습니다',
    '공통/배너/SNS 경로 이미지 비율이 높습니다',
    '아이콘/배너성 이미지 비율이 높습니다',
    '대표 이미지와 동일 호스트 비율이 낮습니다',
    '상품 상세 자산 경로 비율이 낮습니다',
  ].some((token) => text.includes(token));
}

function shouldAttemptRelaxedRecommendationQc(reasons = []) {
  const normalized = Array.isArray(reasons)
    ? reasons.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  if (normalized.length === 0) return false;
  return normalized.every((r) => isRelaxableQcReason(r));
}

function parseCandidatePrice(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const normalized = text.replace(/[^\d.]/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function buildQcMetricSnapshot(metrics = {}) {
  const m = metrics && typeof metrics === 'object' ? metrics : {};
  const pick = (k, fallback = 0) => {
    const n = Number(m[k]);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    imageCountRaw: pick('imageCountRaw'),
    imageCountFiltered: pick('imageCountFiltered'),
    imageCountRejected: pick('imageCountRejected'),
    tokenMatchRate: pick('tokenMatchRate'),
    rejectedRate: pick('rejectedRate'),
    exactHostMatchRate: pick('exactHostMatchRate'),
    pathAllowRateRaw: pick('pathAllowRateRaw'),
    pathBlockedRateRaw: pick('pathBlockedRateRaw'),
    suspiciousPathRateRaw: pick('suspiciousPathRateRaw'),
    mainImageTokenCount: pick('mainImageTokenCount'),
  };
}

function normalizeImageUrlWithBase(rawUrl, baseUrl = '') {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (s.startsWith('data:')) return '';
  if (s.startsWith('//')) return `https:${s}`;
  try {
    if (baseUrl) {
      const abs = new URL(s, baseUrl).toString();
      if (/^https?:\/\//i.test(abs)) return abs.replace(/^http:\/\//i, 'https://');
    }
  } catch {}
  return normalizeCandidateImageUrl(s);
}

function extractMetaContent(html, key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (m && m[1]) return String(m[1] || '').trim();
  }
  return '';
}

function extractTitleFromHtml(html = '') {
  const og = extractMetaContent(html, 'og:title');
  if (og) return og;
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return '';
  return String(m[1]).replace(/\s+/g, ' ').trim();
}

function extractPriceFromHtml(html = '') {
  const m = String(html || '').match(/(\d[\d,]{2,})\s*원/i);
  if (!m || !m[1]) return null;
  return parseCandidatePrice(m[1]);
}

function normalizePathForDetailMatch(urlObj) {
  if (!urlObj) return '';
  try {
    return decodeURIComponent(String(urlObj.pathname || '')).toLowerCase();
  } catch {
    return String(urlObj.pathname || '').toLowerCase();
  }
}

function isLikelyDetailAssetUrl(rawUrl = '') {
  const s = String(rawUrl || '').trim();
  if (!s) return false;
  let u = null;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  const host = String(u.hostname || '').toLowerCase();
  const path = normalizePathForDetailMatch(u);
  const query = String(u.search || '').toLowerCase();
  const target = `${path}${query}`;

  const isThumb =
    /(?:^|[\/_-])stt_\d+\./i.test(target) ||
    /(?:^|[\/_-])thumb(?:nail)?([\/_\-.]|$)/i.test(target);
  const blocked =
    isThumb ||
    /\/image\/common\//i.test(path) ||
    /\/image\/item\//i.test(path) ||
    /\/image\/event\//i.test(path) ||
    /\/(?:sns|social)\//i.test(path) ||
    /\/icons?\//i.test(path) ||
    /\/banners?\//i.test(path) ||
    /\/logos?\//i.test(path) ||
    /\/(?:button|btn)\//i.test(path) ||
    /\/share\//i.test(path) ||
    /logo|icon|banner|sns|facebook|twitter|kakao|naver|share|sprite/i.test(target);

  const allowedByPath =
    /\/upload\/item\//i.test(path) ||
    /\/upload\/editor\//i.test(path) ||
    /\/editor\//i.test(path) ||
    /\/contents?\//i.test(path) ||
    /\/attach(?:ment)?\//i.test(path);

  const allowedByHost = /(?:^|\.)esmplus\.com$/i.test(host) && !isThumb;
  return (allowedByPath || allowedByHost) && !blocked;
}

function isPreviewTimeoutReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('preview_timeout') ||
    text.includes('timed out') ||
    text.includes('timeout')
  );
}

async function buildHtmlPreviewFallback({
  sourceUrl,
  seedTitle = '',
  seedPrice = null,
  seedImageUrl = '',
  strictImageMatch = false,
  timeoutMs = 12_000,
} = {}) {
  const url = String(sourceUrl || '').trim();
  if (!url) return { ok: false, reason: 'fallback_missing_url' };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 12_000));
  let html = '';
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://domeggook.com/',
      },
    });
    if (!r.ok) return { ok: false, reason: `fallback_http_${r.status}` };
    html = await readHtmlWithCharset(r);
  } catch (error) {
    return { ok: false, reason: normalizeErrorMessage(error) };
  } finally {
    clearTimeout(t);
  }

  const title = extractTitleFromHtml(html) || String(seedTitle || '').trim();
  const mainImageUrl = normalizeImageUrlWithBase(
    extractMetaContent(html, 'og:image') || '',
    url,
  ) || normalizeImageUrlWithBase(seedImageUrl, url);

  const detailHtmlBlocks = [];
  const contentsBufferMatch = String(html).match(
    /<textarea[^>]*id=["']contentsBuffer["'][^>]*>([\s\S]*?)<\/textarea>/i,
  );
  if (contentsBufferMatch && contentsBufferMatch[1]) {
    detailHtmlBlocks.push(String(contentsBufferMatch[1]));
  }

  const detailIframeMatch = String(html).match(
    /<(?:iframe|a)[^>]+(?:src|href)=["']([^"']*ai\.esmplus\.com[^"']*)["']/i,
  );
  if (detailIframeMatch && detailIframeMatch[1]) {
    const detailUrl = normalizeImageUrlWithBase(detailIframeMatch[1], url);
    if (detailUrl) {
      const detailController = new AbortController();
      const detailTimeout = setTimeout(
        () => detailController.abort(),
        Math.max(3000, Math.min(7000, Math.floor((Number(timeoutMs) || 12000) * 0.7))),
      );
      try {
        const detailRes = await fetch(detailUrl, {
          signal: detailController.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: url,
          },
        });
        if (detailRes.ok) {
          const detailHtml = await readHtmlWithCharset(detailRes);
          if (detailHtml) detailHtmlBlocks.push(detailHtml);
        }
      } catch {} finally {
        clearTimeout(detailTimeout);
      }
    }
  }

  const rawImages = [];
  const pushImages = (rawHtml, cap = 120) => {
    if (!rawHtml) return;
    const cleanedHtml = stripDomeggookPromoBlocks(String(rawHtml || ''));
    const list = extractImageUrls(cleanedHtml).slice(0, cap);
    for (const item of list) rawImages.push(item);
  };

  for (const block of detailHtmlBlocks) {
    pushImages(block, 200);
    if (rawImages.length >= 200) break;
  }
  if (rawImages.length < 8) {
    pushImages(html, 200);
  }

  const normalizedAll = Array.from(
    new Set(
      rawImages
        .map((raw) => normalizeImageUrlWithBase(raw, url))
        .filter(Boolean),
    ),
  );

  const preferredImages = normalizedAll.filter((u) => isLikelyDetailAssetUrl(u));
  const uploadItemImages = normalizedAll.filter((u) => /\/upload\/item\//i.test(u));
  let imageCandidates =
    preferredImages.length >= 2
      ? preferredImages
      : (uploadItemImages.length >= 2 ? uploadItemImages : normalizedAll);
  imageCandidates = imageCandidates.slice(0, 120);
  if (imageCandidates.length === 0 && mainImageUrl) {
    imageCandidates = [mainImageUrl];
  }

  const analyzed = analyzeSameProductImages({
    sourceUrl: url,
    mainImageUrl: mainImageUrl || imageCandidates[0] || '',
    contentImageUrls: imageCandidates,
    strict: Boolean(strictImageMatch),
  });

  const price = parseCandidatePrice(extractPriceFromHtml(html)) ?? parseCandidatePrice(seedPrice);
  const draft = {
    sourceUrl: url,
    title,
    price,
    shippingFee: null,
    imageUrl: mainImageUrl || '',
    contentText: '',
    categoryText: '',
    options: [],
  };

  return {
    ok: Boolean(title && draft.imageUrl),
    skipped: false,
    url,
    reason: title && draft.imageUrl ? '' : 'fallback_missing_title_or_image',
    draft,
    preview: {
      sourceUrl: url,
      title,
      mainImageUrl: draft.imageUrl,
      contentImagesRaw: imageCandidates,
      contentImagesFiltered: analyzed?.filteredImageUrls || [],
      contentImagesRejected: analyzed?.rejectedImages || [],
      ...((analyzed && analyzed.metrics) || {}),
    },
  };
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

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function parsePredictCategoryBody(rawBody) {
  if (!rawBody) return {};
  if (typeof rawBody === 'object') return rawBody;
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function pickPredictedCategoryCode(rawBody) {
  const body = parsePredictCategoryBody(rawBody);
  return (
    toPositiveInt(body?.data?.predictedCategoryId) ||
    toPositiveInt(body?.predictedCategoryId) ||
    toPositiveInt(body?.data?.displayCategoryCode) ||
    toPositiveInt(body?.displayCategoryCode) ||
    null
  );
}

function resolveRecommendationUploadSettings(settings = {}) {
  return {
    seoEnabled: parseBoolean(settings?.recommendationAutoSeoTitle ?? settings?.autoSeoTitle, true),
    seoMaxLen: Math.floor(
      clampNumber(
        settings?.recommendationSeoTitleMaxLen,
        20,
        80,
        45,
      ),
    ),
    categoryOverrideCode: toPositiveInt(settings?.categoryOverrideCode),
    categoryDefaultCode: toPositiveInt(settings?.defaultDisplayCategoryCode),
    categoryPredictEnabled: parseBoolean(
      settings?.recommendationAutoCategoryPredict ?? settings?.autoCategoryRecommend,
      true,
    ),
    categoryPredictLimit: Math.floor(
      clampNumber(
        settings?.recommendationCategoryPredictLimit,
        0,
        30,
        8,
      ),
    ),
    categoryPredictTimeoutMs: Math.floor(
      clampNumber(
        settings?.recommendationCategoryPredictTimeoutMs,
        1200,
        9000,
        2800,
      ),
    ),
  };
}

async function predictRecommendationCategoryCode({
  title,
  description = '',
  imageUrl = '',
  accessKey = '',
  secretKey = '',
  timeoutMs = 2800,
} = {}) {
  const productName = String(title || '').trim();
  if (!productName) return { code: null, status: null, error: 'empty_title' };
  const ak = String(accessKey || '').trim();
  const sk = String(secretKey || '').trim();
  if (!ak || !sk) return { code: null, status: null, error: 'missing_keys' };

  try {
    const rec = await withTimeout(
      recommendCategory({
        productName,
        productDescription: String(description || '').slice(0, 2000),
        productImageUrl: String(imageUrl || '').trim(),
        accessKey: ak,
        secretKey: sk,
      }),
      Math.max(1200, Math.min(9000, Number(timeoutMs) || 2800)),
      'recommend_category_timeout',
    );
    const code = pickPredictedCategoryCode(rec?.body);
    return {
      code: toPositiveInt(code),
      status: Number(rec?.status) || null,
      error: null,
    };
  } catch (e) {
    return {
      code: null,
      status: null,
      error: normalizeErrorMessage(e),
    };
  }
}

function extractRecommendationPreviewDraft(item = {}) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const preview = payload?.preview && typeof payload.preview === 'object' ? payload.preview : {};
  const draft = preview?.draft && typeof preview.draft === 'object' ? preview.draft : {};
  return {
    categoryText: String(draft?.categoryText || payload?.categoryText || '').trim(),
    contentText: String(draft?.contentText || '').trim(),
    imageUrl: String(item?.mainImageUrl || draft?.imageUrl || '').trim(),
  };
}

async function enrichRecommendationsForUpload({ items = [], settings = {} } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return {
      items: [],
      diagnostics: {
        total: 0,
        seoApplied: 0,
        categoryResolved: 0,
        categoryPredicted: 0,
        categoryPredictFailed: 0,
      },
    };
  }

  const uploadSettings = resolveRecommendationUploadSettings(settings);
  const accessKey = String(settings?.coupangAccessKey || process.env.COUPANG_ACCESS_KEY || '').trim();
  const secretKey = String(settings?.coupangSecretKey || process.env.COUPANG_SECRET_KEY || '').trim();
  const canPredict =
    !uploadSettings.categoryOverrideCode &&
    uploadSettings.categoryPredictEnabled &&
    uploadSettings.categoryPredictLimit > 0 &&
    Boolean(accessKey && secretKey);

  const out = [];
  let seoApplied = 0;
  let categoryResolved = 0;
  let categoryPredicted = 0;
  let categoryPredictFailed = 0;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const currentTitle = String(item?.title || '').trim();
    const draftMeta = extractRecommendationPreviewDraft(item);

    const seoTitle = uploadSettings.seoEnabled
      ? buildCoupangSeoTitle(currentTitle, { maxLen: uploadSettings.seoMaxLen })
      : '';
    const resolvedTitle = String(seoTitle || currentTitle).trim();
    if (resolvedTitle && currentTitle && resolvedTitle !== currentTitle) {
      seoApplied += 1;
    }

    let categoryCode = null;
    let categorySource = 'unresolved';
    if (uploadSettings.categoryOverrideCode) {
      categoryCode = uploadSettings.categoryOverrideCode;
      categorySource = 'override';
    } else {
      const ruleCode = toPositiveInt(
        resolveDisplayCategoryCode({
          title: resolvedTitle || currentTitle,
          categoryText: draftMeta.categoryText,
          fallback: uploadSettings.categoryDefaultCode || 0,
        }),
      );
      if (ruleCode) {
        categoryCode = ruleCode;
        categorySource = 'rule';
      } else if (uploadSettings.categoryDefaultCode) {
        categoryCode = uploadSettings.categoryDefaultCode;
        categorySource = 'fallback';
      }
    }

    let predictedCode = null;
    if (canPredict && i < uploadSettings.categoryPredictLimit) {
      const predicted = await predictRecommendationCategoryCode({
        title: resolvedTitle || currentTitle,
        description: draftMeta.contentText,
        imageUrl: draftMeta.imageUrl,
        accessKey,
        secretKey,
        timeoutMs: uploadSettings.categoryPredictTimeoutMs,
      });
      predictedCode = toPositiveInt(predicted?.code);
      if (predictedCode) {
        categoryCode = predictedCode;
        categorySource = 'predict';
        categoryPredicted += 1;
      } else if (predicted?.error && predicted.error !== 'missing_keys') {
        categoryPredictFailed += 1;
      }
    }

    if (categoryCode) categoryResolved += 1;

    const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
    const nextPayload = {
      ...payload,
      seo: {
        ...(payload?.seo && typeof payload.seo === 'object' ? payload.seo : {}),
        title: resolvedTitle || currentTitle,
        originalTitle: currentTitle || '',
        applied: Boolean(resolvedTitle && currentTitle && resolvedTitle !== currentTitle),
        source: uploadSettings.seoEnabled ? 'rule' : 'original',
        maxLen: uploadSettings.seoMaxLen,
      },
      category: {
        ...(payload?.category && typeof payload.category === 'object' ? payload.category : {}),
        code: categoryCode || null,
        source: categorySource,
        predictedCode: predictedCode || null,
        fallbackCode: uploadSettings.categoryDefaultCode || null,
        categoryText: draftMeta.categoryText || '',
      },
    };

    out.push({
      ...item,
      title: resolvedTitle || currentTitle,
      seoTitle: resolvedTitle || currentTitle,
      originalTitle: currentTitle || '',
      categoryCode: categoryCode || null,
      categorySource,
      payload: nextPayload,
    });
  }

  return {
    items: out,
    diagnostics: {
      total: list.length,
      seoApplied,
      categoryResolved,
      categoryPredicted,
      categoryPredictFailed,
    },
  };
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

function resolveRecommendationPreviewSettings(settings = {}) {
  return {
    // Recommendation cards should show more detail images for operator review.
    strictImageMatch: parseBoolean(
      settings?.recommendationStrictImageMatch ?? settings?.recommendationPreviewStrictImageMatch,
      parseBoolean(settings?.strictImageMatch, false),
    ),
    maxContentImages: Math.floor(
      clampNumber(
        settings?.recommendationPreviewMaxContentImages ?? settings?.maxContentImages,
        10,
        120,
        60,
      ),
    ),
  };
}

function resolveRecommendationQcSettings(settings = {}) {
  const relaxEnabled = parseBoolean(settings?.recommendationQcRelaxEnabled, true);
  const relaxStage2Enabled = parseBoolean(settings?.recommendationQcRelaxStage2Enabled, true);
  return {
    // Quality-first default: at least 2 usable detail images.
    qcMinFilteredImages: Math.floor(
      clampNumber(
        settings?.recommendationQcMinFilteredImages ?? settings?.qcMinFilteredImages,
        2,
        6,
        2,
      ),
    ),
    relaxEnabled,
    relaxStage2Enabled,
    relaxStage1: {
      qcMinTokenMatchRate: clampNumber(
        settings?.recommendationQcRelaxStage1MinTokenMatchRate,
        0,
        1,
        0.12,
      ),
      qcMaxRejectedRate: clampNumber(
        settings?.recommendationQcRelaxStage1MaxRejectedRate,
        0.1,
        1,
        0.94,
      ),
      qcMinPathAllowRate: clampNumber(
        settings?.recommendationQcRelaxStage1MinPathAllowRate,
        0,
        1,
        0.03,
      ),
      qcMaxPathBlockedRate: clampNumber(
        settings?.recommendationQcRelaxStage1MaxPathBlockedRate,
        0,
        1,
        0.94,
      ),
      qcMaxSuspiciousPathRate: clampNumber(
        settings?.recommendationQcRelaxStage1MaxSuspiciousPathRate,
        0,
        1,
        0.9,
      ),
      qcMinExactHostRate: clampNumber(
        settings?.recommendationQcRelaxStage1MinExactHostRate,
        0,
        1,
        0.02,
      ),
    },
    relaxStage2: {
      qcMinTokenMatchRate: clampNumber(
        settings?.recommendationQcRelaxStage2MinTokenMatchRate,
        0,
        1,
        0,
      ),
      qcMaxRejectedRate: clampNumber(
        settings?.recommendationQcRelaxStage2MaxRejectedRate,
        0.1,
        1,
        0.985,
      ),
      qcMinPathAllowRate: clampNumber(
        settings?.recommendationQcRelaxStage2MinPathAllowRate,
        0,
        1,
        0,
      ),
      qcMaxPathBlockedRate: clampNumber(
        settings?.recommendationQcRelaxStage2MaxPathBlockedRate,
        0,
        1,
        0.985,
      ),
      qcMaxSuspiciousPathRate: clampNumber(
        settings?.recommendationQcRelaxStage2MaxSuspiciousPathRate,
        0,
        1,
        0.985,
      ),
      qcMinExactHostRate: clampNumber(
        settings?.recommendationQcRelaxStage2MinExactHostRate,
        0,
        1,
        0.01,
      ),
    },
  };
}

async function fetchFastCandidatesFromList({
  keyword,
  limit = 80,
  storageStatePath = '',
  sourceMode = 'auto',
}) {
  // Collection policy:
  // 1) OpenAPI first
  // 2) Playwright fallback only
  const q = String(keyword || '').trim();
  if (!q) return { items: [], diagnostics: { keyword: '', strategy: 'none', collected: 0, errors: ['empty_keyword'] } };
  const modeRaw = String(sourceMode || 'auto').trim().toLowerCase();
  const mode = modeRaw === 'openapi' || modeRaw === 'playwright' ? modeRaw : 'auto';
  const diagnostics = {
    keyword: q,
    strategy: 'none',
    collected: 0,
    errors: [],
    sourceMode: mode,
    openapi: { tried: false, attempts: 0, collected: 0, ok: false },
    playwright: { tried: false, attempts: 0, collected: 0, ok: false },
  };

  const normalizeOpenApiItems = (raw) => {
    const items = raw?.domeggook?.list?.item || raw?.list?.item;
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    if (!list.length) return [];
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
    return out;
  };

  if (mode !== 'playwright') {
    diagnostics.openapi.tried = true;
    const { domeggookOpenApiGetItemList } = await import('../utils/domeggook_openapi.js');
    const versions = ['4.1', '4.0'];
    for (const ver of versions) {
      diagnostics.openapi.attempts += 1;
      try {
        const r = await domeggookOpenApiGetItemList({
          keyword: q,
          market: 'dome',
          page: 1,
          pageSize: Math.max(10, Math.min(80, Number(limit) || 40)),
          sort: q ? 'se' : 'rd',
          ver,
          om: 'json',
        });
        const out = normalizeOpenApiItems(r?.raw || null);
        if (out.length > 0) {
          diagnostics.strategy = 'openapi';
          diagnostics.collected = out.length;
          diagnostics.openapi.collected = out.length;
          diagnostics.openapi.ok = true;
          return { items: out, diagnostics };
        }
      } catch (e) {
        if (diagnostics.errors.length < 8) diagnostics.errors.push(`openapi: ${normalizeErrorMessage(e)}`);
      }
    }
    if (mode === 'openapi') {
      return { items: [], diagnostics };
    }
  }

  diagnostics.playwright.tried = true;
  try {
    const { chromium } = await import('playwright');
    const fs = await import('node:fs');
    const hasState = storageStatePath && fs.existsSync(storageStatePath);

    const launchPlans = [{ channel: null }, { channel: 'chrome' }];
    let browser = null;
    for (const plan of launchPlans) {
      diagnostics.playwright.attempts += 1;
      try {
        const launchOpts = plan.channel ? { headless: true, channel: plan.channel } : { headless: true };
        browser = await chromium.launch(launchOpts);
        break;
      } catch (e) {
        if (diagnostics.errors.length < 8) diagnostics.errors.push(`playwright: ${normalizeErrorMessage(e)}`);
      }
    }
    if (!browser) return { items: [], diagnostics };

    try {
      const context = hasState
        ? await browser.newContext({ storageState: storageStatePath })
        : await browser.newContext();
      const page = await context.newPage();
      const listUrl = `https://domeggook.com/main/item/itemList.php?sw=${encodeURIComponent(q)}&sf=ttl`;
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 18_000 });
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(900);

      const rows = await page.evaluate(({ keyword }) => {
        const kwRaw = String(keyword || '').trim().toLowerCase();
        const kw = kwRaw.replace(/\s+/g, '');
        const parseWon = (s) => {
          const m = String(s || '').match(/(\d[\d,]{2,})\s*원/);
          if (!m) return null;
          const n = Number(String(m[1]).replace(/,/g, ''));
          return Number.isFinite(n) ? n : null;
        };
        const normalizeTitle = (s) =>
          String(s || '')
            .replace(/\d[\d,]{2,}\s*원/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        const out = [];
        const seen = new Set();
        const anchors = Array.from(document.querySelectorAll('a[href^="/"]'));
        for (const a of anchors) {
          const href = String(a.getAttribute('href') || '').trim();
          const m = href.match(/^\/(\d{6,})(?:\?|$)/);
          if (!m) continue;
          const id = m[1];
          if (seen.has(id)) continue;

          const card = a.closest('li, article, div, td') || a.parentElement;
          const text = String(card?.innerText || a.innerText || '')
            .replace(/\s+/g, ' ')
            .trim();
          const price = parseWon(text);
          if (!price) continue;

          const title = normalizeTitle(text);
          if (!title) continue;

          const hay = `${title} ${text}`.toLowerCase().replace(/\s+/g, '');
          if (kw && !hay.includes(kw)) continue;

          const imgEl = card?.querySelector?.('img');
          const imageUrlRaw =
            imgEl?.getAttribute?.('data-src') ||
            imgEl?.getAttribute?.('src') ||
            '';
          let imageUrl = String(imageUrlRaw || '').trim();
          if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
          else if (imageUrl.startsWith('/')) imageUrl = `${location.origin}${imageUrl}`;
          imageUrl = imageUrl.replace(/^http:\/\//i, 'https://');

          seen.add(id);
          out.push({
            url: `https://domeggook.com/${id}`,
            title: title.slice(0, 80),
            price,
            imageUrl,
          });
          if (out.length >= 200) break;
        }
        return out;
      }, { keyword: q });

      const items = Array.isArray(rows)
        ? rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 80)))
        : [];
      if (items.length > 0) {
        diagnostics.strategy = 'playwright';
        diagnostics.collected = items.length;
        diagnostics.playwright.collected = items.length;
        diagnostics.playwright.ok = true;
      }
      return { items, diagnostics };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    if (diagnostics.errors.length < 8) diagnostics.errors.push(`playwright: ${normalizeErrorMessage(e)}`);
    return { items: [], diagnostics };
  }
}

function strictValidatePreview(preview, banKeywords = DEFAULT_BAN_KEYWORDS) {
  if (!preview?.ok) {
    const reason = String(preview?.reason || preview?.error || 'preview_failed').trim();
    return { ok: false, reason: reason || 'preview_failed' };
  }
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
  previewTimeoutMs = 9_000,
  candidateSourceMode = 'auto',
} = {}) {
  const seed = Array.isArray(keywords) && keywords.length > 0 ? keywords : defaultKeywordSet();
  const startedAt = Date.now();
  const keywordDiagnostics = [];
  const normalizedSettings = settings || {};
  const recommendationQcSettings = resolveRecommendationQcSettings(normalizedSettings);
  const recommendationPreviewSettings = resolveRecommendationPreviewSettings(normalizedSettings);
  const qcSettings = { ...normalizedSettings, ...recommendationQcSettings };
  const thresholds = resolveRecommendationThresholds(normalizedSettings);
  const policy = resolveRecommendationPolicy(normalizedSettings);
  const keywordScanLimit = Math.max(
    1,
    Math.min(
      seed.length,
      policy.requireQcPass ? 18 : 10,
      Math.max(
        policy.requireQcPass ? 10 : 8,
        Math.ceil(Number(topN || 20) * (policy.requireQcPass ? 2 : 1.5)),
      ),
      18,
    ),
  );

  const candidates = [];
  let openApiFailureStreak = 0;
  let openApiCircuitBreakApplied = false;
  for (const kw of seed.slice(0, keywordScanLimit)) {
    if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.45)) break;
    const effectiveSourceMode =
      candidateSourceMode === 'auto' && openApiCircuitBreakApplied
        ? 'playwright'
        : candidateSourceMode;
    let list = [];
    try {
      const result = await fetchFastCandidatesFromList({
        keyword: kw,
        limit: policy.requireQcPass ? 80 : 40,
        storageStatePath: String(normalizedSettings?.domeggookStorageStatePath || ''),
        sourceMode: effectiveSourceMode,
      });
      list = Array.isArray(result?.items) ? result.items : [];
      if (result?.diagnostics) {
        keywordDiagnostics.push({
          ...result.diagnostics,
          sourceModeUsed: effectiveSourceMode,
        });
        if (candidateSourceMode === 'auto' && effectiveSourceMode === 'auto') {
          const errs = Array.isArray(result?.diagnostics?.errors) ? result.diagnostics.errors : [];
          const openApiFailed = errs.some((e) => String(e || '').toLowerCase().includes('openapi:'));
          const openApiCollected = Number(result?.diagnostics?.openapi?.collected || 0);
          if (openApiFailed && openApiCollected === 0) {
            openApiFailureStreak += 1;
            if (openApiFailureStreak >= 2) {
              openApiCircuitBreakApplied = true;
              if (typeof onProgress === 'function') {
                try {
                  onProgress({
                    stage: 'source_switch_playwright',
                    reason: 'openapi_failed_consecutively',
                    failureStreak: openApiFailureStreak,
                  });
                } catch {}
              }
            }
          } else {
            openApiFailureStreak = 0;
          }
        }
      }
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
        sourceModeUsed: effectiveSourceMode,
        errors: [normalizeErrorMessage(e)],
      });
      list = [];
    }

    for (const it of list) {
      if (excludeUrls.has(it.url)) continue;
      candidates.push({ keyword: kw, ...it });
      if (candidates.length >= 1800) break;
    }
    if (typeof onProgress === 'function') {
      try { onProgress({ stage: 'collect', keyword: kw, candidates: candidates.length }); } catch {}
    }
    if (candidates.length >= 1800) break;
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
  const scoreRejectCounts = {};
  const strictRejectCounts = {};
  const scoringPasses = [];
  for (const c of uniq) {
    if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.65)) break;
    if (containsBanKeyword(c.title, DEFAULT_BAN_KEYWORDS)) continue;
    const candidatePrice = parseCandidatePrice(c.price);
    if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) {
      scoreRejectCounts.bad_price = Number(scoreRejectCounts.bad_price || 0) + 1;
      continue;
    }

    const fakePreview = {
      ok: true,
      url: c.url,
      draft: { title: c.title, price: candidatePrice, shippingFee: null, imageUrl: '' },
      computed: { contentImageCount: 1 },
    };

    const s = scoreRecommendation({
      preview: fakePreview,
      minProfit: thresholds.minProfit,
      minMarginRate: thresholds.minMarginRate,
      banKeywords: DEFAULT_BAN_KEYWORDS,
    });
    if (!s.ok) {
      const reason = String(s.reason || 'unknown');
      scoreRejectCounts[reason] = Number(scoreRejectCounts[reason] || 0) + 1;
      continue;
    }

    scoredPool.push({
      sourceUrl: c.url,
      keyword: c.keyword,
      ...s,
      mainImageUrl: normalizeCandidateImageUrl(c.imageUrl || s.mainImageUrl),
      payload: { fast: true },
    });

    if (scoredPool.length >= 500) break;
  }
  scoringPasses.push({
    name: 'default',
    minProfit: thresholds.minProfit,
    minMarginRate: thresholds.minMarginRate,
    added: scoredPool.length,
  });

  // If strict thresholds produce too small a pool, relax once to avoid empty lists.
  if (scoredPool.length < Math.max(8, Math.floor(topN * 1.2))) {
    const beforeRelaxed = scoredPool.length;
    const relaxedMinProfit = Math.max(1000, Math.floor(thresholds.minProfit * 0.6));
    const relaxedMinMarginRate = Math.max(0.12, Number((thresholds.minMarginRate * 0.7).toFixed(3)));
    const shouldRelaxBanKeywords = scoredPool.length < Math.max(4, Math.ceil(Number(topN || 20) * 0.6));
    const relaxedBanKeywords = shouldRelaxBanKeywords
      ? DEFAULT_BAN_KEYWORDS.filter((kw) => !RELAXABLE_RECO_BAN_KEYWORDS.has(String(kw || '').toLowerCase()))
      : DEFAULT_BAN_KEYWORDS;
    const existing = new Set(scoredPool.map((x) => String(x?.sourceUrl || '').trim()));
    for (const c of uniq) {
      if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.75)) break;
      const u = String(c?.url || '').trim();
      if (!u || existing.has(u)) continue;
      const candidatePrice = parseCandidatePrice(c.price);
      if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) {
        scoreRejectCounts.bad_price = Number(scoreRejectCounts.bad_price || 0) + 1;
        continue;
      }

      const fakePreview = {
        ok: true,
        url: c.url,
        draft: { title: c.title, price: candidatePrice, shippingFee: null, imageUrl: '' },
        computed: { contentImageCount: 1 },
      };
      const s = scoreRecommendation({
        preview: fakePreview,
        minProfit: relaxedMinProfit,
        minMarginRate: relaxedMinMarginRate,
        banKeywords: relaxedBanKeywords,
      });
      if (!s.ok) {
        const reason = String(s.reason || 'unknown');
        scoreRejectCounts[reason] = Number(scoreRejectCounts[reason] || 0) + 1;
        continue;
      }

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
    scoringPasses.push({
      name: 'relaxed',
      minProfit: relaxedMinProfit,
      minMarginRate: relaxedMinMarginRate,
      added: Math.max(0, scoredPool.length - beforeRelaxed),
      banRelaxed: shouldRelaxBanKeywords,
    });
  }

  // Rescue pass: recommendation list quality remains guarded by QC,
  // so we can relax score thresholds once more to avoid underfilling.
  if (scoredPool.length < Math.max(12, topN * 2)) {
    const beforeRescue = scoredPool.length;
    const rescueMinProfit = Math.max(500, Math.floor(thresholds.minProfit * 0.3));
    const rescueMinMarginRate = Math.max(0.09, Number((thresholds.minMarginRate * 0.45).toFixed(3)));
    const rescueBanKeywords = DEFAULT_BAN_KEYWORDS.filter((kw) =>
      !RELAXABLE_RECO_BAN_KEYWORDS.has(String(kw || '').toLowerCase()),
    );
    const existing = new Set(scoredPool.map((x) => String(x?.sourceUrl || '').trim()));
    for (const c of uniq) {
      if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.83)) break;
      const u = String(c?.url || '').trim();
      if (!u || existing.has(u)) continue;
      const candidatePrice = parseCandidatePrice(c.price);
      if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) {
        scoreRejectCounts.bad_price = Number(scoreRejectCounts.bad_price || 0) + 1;
        continue;
      }

      const fakePreview = {
        ok: true,
        url: c.url,
        draft: { title: c.title, price: candidatePrice, shippingFee: null, imageUrl: '' },
        computed: { contentImageCount: 1 },
      };
      const s = scoreRecommendation({
        preview: fakePreview,
        minProfit: rescueMinProfit,
        minMarginRate: rescueMinMarginRate,
        banKeywords: rescueBanKeywords,
      });
      if (!s.ok) {
        const reason = String(s.reason || 'unknown');
        scoreRejectCounts[reason] = Number(scoreRejectCounts[reason] || 0) + 1;
        continue;
      }

      existing.add(u);
      scoredPool.push({
        sourceUrl: c.url,
        keyword: c.keyword,
        ...s,
        mainImageUrl: normalizeCandidateImageUrl(c.imageUrl || s.mainImageUrl),
        payload: {
          fast: true,
          rescueThreshold: true,
          thresholds: {
            minProfit: rescueMinProfit,
            minMarginRate: rescueMinMarginRate,
          },
        },
      });
      if (scoredPool.length >= 700) break;
    }
    scoringPasses.push({
      name: 'rescue',
      minProfit: rescueMinProfit,
      minMarginRate: rescueMinMarginRate,
      added: Math.max(0, scoredPool.length - beforeRescue),
      banRelaxed: true,
    });
  }

  scoredPool.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  const final = [];
  let validated = 0;
  let qcRejected = 0;
  let previewRetryRecovered = 0;
  let previewRetryFailed = 0;
  let previewPlaywrightRecovered = 0;
  let previewPlaywrightFailed = 0;
  let previewPlaywrightAttempts = 0;
  let previewOpenApiAttempts = 0;
  let previewOpenApiSucceeded = 0;
  let previewOpenApiFailed = 0;
  let previewOpenApiTimeout = 0;
  let previewOpenApiNonTimeoutFailed = 0;
  let previewPlaywrightFallbackNeeded = 0;
  let previewFallbackRecovered = 0;
  let previewFallbackFailed = 0;
  let previewTimeoutFallbackUsed = 0;
  let qcRelaxAttemptStage1 = 0;
  let qcRelaxPassStage1 = 0;
  let qcRelaxAttemptStage2 = 0;
  let qcRelaxPassStage2 = 0;
  const qcReasonCounts = {};
  const qcRejectedSamples = [];
  const maxQcRejectedSamples = 3;
  const previewOpenApiTimeoutMs = Math.max(
    1800,
    Math.min(9000, Number(normalizedSettings?.recommendationPreviewOpenApiTimeoutMs) || Math.floor(previewTimeoutMs * 0.62)),
  );
  const previewPlaywrightTimeoutMs = Math.max(
    previewTimeoutMs + 3000,
    Math.min(
      30_000,
      Math.max(12_000, Number(normalizedSettings?.recommendationPreviewPlaywrightTimeoutMs) || 14_000),
    ),
  );
  const configuredPreviewPlaywrightRetryBudget = Math.max(
    0,
    Math.min(12, Number(normalizedSettings?.recommendationPreviewPlaywrightRetryBudget) || 6),
  );
  const previewPlaywrightRetryBudgetDisabled = parseBoolean(
    normalizedSettings?.recommendationDisablePreviewPlaywrightRetryBudget ??
      normalizedSettings?.recommendationDisablePreviewPlaywrightBudget,
    true,
  );
  const previewPlaywrightRetryBudget = previewPlaywrightRetryBudgetDisabled
    ? Number.POSITIVE_INFINITY
    : configuredPreviewPlaywrightRetryBudget;
  const previewPlaywrightRetryBudgetText = previewPlaywrightRetryBudgetDisabled
    ? '무제한(테스트)'
    : `${configuredPreviewPlaywrightRetryBudget}건`;
  const previewTimeoutDisabled = parseBoolean(
    normalizedSettings?.recommendationDisablePreviewTimeout,
    true,
  );
  let maxValidate = Math.max(topN * (policy.requireQcPass ? 12 : 2), 24);
  maxValidate = Math.min(maxValidate, policy.requireQcPass ? 220 : 80);
  for (const cand of scoredPool) {
    if (final.length >= topN) break;
    if (validated >= maxValidate) break;
    if (Date.now() - startedAt > Math.floor(maxRuntimeMs * 0.92)) break;
    if (excludeUrls.has(cand.sourceUrl)) continue;

    const requestPreview = async (timeoutMs, previewSourceMode = 'auto') =>
      (
        previewTimeoutDisabled
          ? previewUploadFromUrl(cand.sourceUrl, {
              ...normalizedSettings,
              maxContentImages: recommendationPreviewSettings.maxContentImages,
              strictImageMatch: recommendationPreviewSettings.strictImageMatch ? '1' : '0',
              previewSourceMode,
              previewOpenApiTimeoutMs,
              seedTitle: cand.title,
              seedPrice: cand.sourcePrice,
              seedImageUrl: cand.mainImageUrl,
            })
          : withTimeout(
              previewUploadFromUrl(cand.sourceUrl, {
                ...normalizedSettings,
                maxContentImages: recommendationPreviewSettings.maxContentImages,
                strictImageMatch: recommendationPreviewSettings.strictImageMatch ? '1' : '0',
                previewSourceMode,
                previewOpenApiTimeoutMs,
                seedTitle: cand.title,
                seedPrice: cand.sourcePrice,
                seedImageUrl: cand.mainImageUrl,
              }),
              timeoutMs,
              'preview_timeout',
            )
      ).catch((error) => ({
        ok: false,
        reason: normalizeErrorMessage(error),
      }));

    previewOpenApiAttempts += 1;
    let prev = await requestPreview(previewTimeoutMs, 'openapi');
    let attemptedPlaywrightPreview = false;
    let usedHtmlPreviewFallback = false;
    const firstPreviewTimedOut = isPreviewTimeoutReason(prev?.reason || prev?.error);
    if (prev?.ok) {
      previewOpenApiSucceeded += 1;
    } else {
      previewOpenApiFailed += 1;
      previewPlaywrightFallbackNeeded += 1;
      if (firstPreviewTimedOut) previewOpenApiTimeout += 1;
      else previewOpenApiNonTimeoutFailed += 1;
    }

    // Primary flow: OpenAPI preview first.
    // If it fails (non-timeout), retry once with Playwright parser.
    if (!prev?.ok && !firstPreviewTimedOut) {
      if (previewPlaywrightAttempts < previewPlaywrightRetryBudget) {
        attemptedPlaywrightPreview = true;
        previewPlaywrightAttempts += 1;
        const retry = await requestPreview(previewPlaywrightTimeoutMs, 'playwright');
        if (retry?.ok) {
          prev = retry;
          previewRetryRecovered += 1;
        } else {
          prev = retry || prev;
          previewRetryFailed += 1;
        }
      } else {
        prev = {
          ok: false,
          reason: 'preview_playwright_budget_exhausted',
        };
      }
    }

    if (!prev?.ok && isPreviewTimeoutReason(prev?.reason || prev?.error)) {
      previewTimeoutFallbackUsed += 1;
      if (!attemptedPlaywrightPreview) {
        if (previewPlaywrightAttempts < previewPlaywrightRetryBudget) {
          previewPlaywrightAttempts += 1;
          const playwrightFallback = await requestPreview(previewPlaywrightTimeoutMs, 'playwright');
          if (playwrightFallback?.ok) {
            prev = playwrightFallback;
            previewPlaywrightRecovered += 1;
          } else {
            previewPlaywrightFailed += 1;
            prev = playwrightFallback || prev;
            if (policy.allowQuickFallback) {
              const fallback = await buildHtmlPreviewFallback({
                sourceUrl: cand.sourceUrl,
                seedTitle: cand.title,
                seedPrice: cand.sourcePrice,
                seedImageUrl: cand.mainImageUrl,
                strictImageMatch: recommendationPreviewSettings.strictImageMatch,
                timeoutMs: Math.max(6000, Math.floor(previewTimeoutMs * 0.9)),
              });
              if (fallback?.ok) {
                prev = fallback;
                previewFallbackRecovered += 1;
                usedHtmlPreviewFallback = true;
              } else {
                previewFallbackFailed += 1;
                prev = fallback || prev;
              }
            }
          }
        } else {
          prev = {
            ok: false,
            reason: 'preview_playwright_budget_exhausted',
          };
        }
      }
    }

    validated += 1;

    const v = strictValidatePreview(prev, DEFAULT_BAN_KEYWORDS);
    if (!v.ok) {
      const reason = String(v.reason || 'strict_validate_failed');
      strictRejectCounts[reason] = Number(strictRejectCounts[reason] || 0) + 1;
      if (typeof onProgress === 'function' && validated % 3 === 0) {
        try { onProgress({ stage: 'validate', validated, kept: final.length, qcRejected, target: topN }); } catch {}
      }
      continue;
    }

    const strictQcGate = evaluateQcGate(v.qcPreview || {}, qcSettings);
    let qcGate = strictQcGate;
    let qcDecisionStage = 'strict';

    const canTryRelaxedQc =
      policy.requireQcPass &&
      !strictQcGate.ok &&
      recommendationQcSettings.relaxEnabled &&
      isDomeggookSourceUrl(cand.sourceUrl) &&
      shouldAttemptRelaxedRecommendationQc(strictQcGate.reasons);

    if (canTryRelaxedQc) {
      qcRelaxAttemptStage1 += 1;
      const stage1Settings = { ...qcSettings, ...recommendationQcSettings.relaxStage1 };
      const stage1Gate = evaluateQcGate(v.qcPreview || {}, stage1Settings);
      if (stage1Gate.ok) {
        qcGate = stage1Gate;
        qcDecisionStage = 'relaxed_stage1';
        qcRelaxPassStage1 += 1;
      } else {
        qcGate = stage1Gate;
        qcDecisionStage = 'relaxed_stage1_failed';
        const canTryStage2 =
          recommendationQcSettings.relaxStage2Enabled &&
          (usedHtmlPreviewFallback || Number(v.contentImageCount || 0) <= 1);
        if (canTryStage2) {
          qcRelaxAttemptStage2 += 1;
          const stage2Settings = {
            ...stage1Settings,
            ...recommendationQcSettings.relaxStage2,
          };
          const stage2Gate = evaluateQcGate(v.qcPreview || {}, stage2Settings);
          qcGate = stage2Gate;
          qcDecisionStage = stage2Gate.ok ? 'relaxed_stage2' : 'relaxed_stage2_failed';
          if (stage2Gate.ok) qcRelaxPassStage2 += 1;
        }
      }
    }

    if (policy.requireQcPass && !qcGate.ok) {
      qcRejected += 1;
      const reasons = Array.isArray(qcGate?.reasons)
        ? qcGate.reasons.map((r) => String(r || '').trim()).filter(Boolean)
        : [];
      if (reasons.length === 0) reasons.push('unknown_qc_reject');
      for (const r of reasons) {
        qcReasonCounts[r] = Number(qcReasonCounts[r] || 0) + 1;
      }
      if (qcRejectedSamples.length < maxQcRejectedSamples) {
        qcRejectedSamples.push({
          sourceUrl: cand.sourceUrl,
          title: String(v.title || cand.title || '').trim(),
          reasons: reasons.slice(0, 4),
          stage: qcDecisionStage,
          metrics: buildQcMetricSnapshot(qcGate?.metrics || {}),
        });
      }
      if (typeof onProgress === 'function' && validated % 3 === 0) {
        try { onProgress({ stage: 'validate', validated, kept: final.length, qcRejected, target: topN }); } catch {}
      }
      continue;
    }

    const detailCount = Number(v.contentImageCount || 0) || 0;
    const previewCount = Array.isArray(v.previewImages) ? v.previewImages.length : 0;
    const detailDisplayCount = previewCount > 0 ? previewCount : detailCount;
    const tier = detailCount >= 3 ? 'A' : (detailCount >= 1 ? 'B' : 'C');
    const eligibleUpload = Boolean(qcGate.ok);

    // Prefer fields from the real preview (more accurate than list-scraped/fake preview).
    const prevTitle = String(v.title || '').trim();
    const prevMainImageUrl = String(v.mainImageUrl || '').trim();
    const prevPrice = Number(v.sourcePrice);
    const prevShip = v.shippingFee;
    const finalPriceNum = Number(cand.finalPrice);
    const profitNum = Number(cand.profit);
    const marginNum = Number(cand.marginRate);
    const resolvedReason =
      Number.isFinite(finalPriceNum) &&
      Number.isFinite(profitNum) &&
      Number.isFinite(marginNum)
        ? `recommend≈${Math.round(finalPriceNum)} / profit≈${Math.round(profitNum)} / margin≈${Math.round(marginNum * 100)}% / detailImages=${detailDisplayCount}`
        : String(cand.reason || '').trim();

    final.push({
      ...cand,
      title: prevTitle || cand.title,
      mainImageUrl: prevMainImageUrl || cand.mainImageUrl,
      sourcePrice: Number.isFinite(prevPrice) ? prevPrice : cand.sourcePrice,
      shippingFee: (prevShip == null ? cand.shippingFee : prevShip),
      reason: resolvedReason,
      payload: {
        ...cand.payload,
        preview: {
          url: prev?.url || cand.sourceUrl,
          draft: prev?.draft || null,
          computed: {
            images: v.previewImages || [],
            contentImageCount: detailDisplayCount,
            imageCountRaw: Number(v.qcPreview?.imageCountRaw || 0) || 0,
            imageCountFiltered: Number(v.qcPreview?.imageCountFiltered || detailDisplayCount) || detailDisplayCount,
            imageCountRejected: Number(v.qcPreview?.imageCountRejected || 0) || 0,
          },
        },
        qc: {
          ok: Boolean(qcGate.ok),
          reasons: Array.isArray(qcGate.reasons) ? qcGate.reasons : [],
          metrics: qcGate.metrics && typeof qcGate.metrics === 'object' ? qcGate.metrics : {},
          stage: qcDecisionStage,
          detailImageCount: detailDisplayCount,
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

  const uploadMeta = await enrichRecommendationsForUpload({
    items: final,
    settings: normalizedSettings,
  });
  const finalItems = Array.isArray(uploadMeta?.items) ? uploadMeta.items : final;

  const strictRejectedTotal = sumCountValues(strictRejectCounts);
  const strictRejectTop = toSortedCountEntries(strictRejectCounts, 5).map(([reason, count]) => ({
    reason,
    reasonLabel: humanizeStrictRejectReason(reason),
    count,
  }));
  const qcReasonTop = toSortedCountEntries(qcReasonCounts, 5).map(([reason, count]) => ({
    reason,
    count,
  }));

  const diagnostics = {
    candidateSourceMode,
    openApiCircuitBreakApplied,
    openApiFailureStreakFinal: openApiFailureStreak,
    keywordsTried: keywordScanLimit,
    collectedCandidates: candidates.length,
    uniqueCandidates: uniq.length,
    scoredCandidates: scoredPool.length,
    scoreRejectCounts,
    strictRejectCounts,
    scoringPasses,
    thresholds,
    policy,
    qcSettings: recommendationQcSettings,
    validated,
    kept: finalItems.length,
    qcRejected,
    qcReasonCounts,
    qcRejectedSamples,
    previewRetryRecovered,
    previewRetryFailed,
    previewOpenApiAttempts,
    previewOpenApiSucceeded,
    previewOpenApiFailed,
    previewOpenApiTimeout,
    previewOpenApiNonTimeoutFailed,
    previewTimeoutDisabled,
    previewPlaywrightFallbackNeeded,
    previewPlaywrightRecovered,
    previewPlaywrightFailed,
    previewPlaywrightAttempts,
    previewPlaywrightRetryBudget: previewPlaywrightRetryBudgetDisabled ? null : configuredPreviewPlaywrightRetryBudget,
    previewPlaywrightRetryBudgetConfigured: configuredPreviewPlaywrightRetryBudget,
    previewPlaywrightRetryBudgetDisabled,
    previewPlaywrightBudgetExhausted: Number(strictRejectCounts.preview_playwright_budget_exhausted || 0),
    previewFallbackRecovered,
    previewFallbackFailed,
    previewTimeoutFallbackUsed,
    qcRelaxAttemptStage1,
    qcRelaxPassStage1,
    qcRelaxAttemptStage2,
    qcRelaxPassStage2,
    fallbackFilledCount,
    uploadMeta: uploadMeta?.diagnostics || {},
    keywordDiagnostics: keywordDiagnostics.slice(0, keywordScanLimit).map((d) => ({
      keyword: d.keyword,
      strategy: d.strategy || 'none',
      sourceModeUsed: d.sourceModeUsed || candidateSourceMode,
      collected: Number(d.collected || 0),
      openapi: d.openapi && typeof d.openapi === 'object'
        ? {
            tried: Boolean(d.openapi.tried),
            attempts: Number(d.openapi.attempts || 0),
            collected: Number(d.openapi.collected || 0),
            ok: Boolean(d.openapi.ok),
          }
        : undefined,
      playwright: d.playwright && typeof d.playwright === 'object'
        ? {
            tried: Boolean(d.playwright.tried),
            attempts: Number(d.playwright.attempts || 0),
            collected: Number(d.playwright.collected || 0),
            ok: Boolean(d.playwright.ok),
          }
        : undefined,
      errors: (Array.isArray(d.errors) ? d.errors : []).slice(0, 2),
    })),
    openApiKeyMissing: keywordDiagnostics.some((d) =>
      (Array.isArray(d?.errors) ? d.errors : []).some((e) =>
        String(e || '').includes('domeggook_openapi_key_missing')
      )
    ),
    hasDomeggookSessionPath: Boolean(String(normalizedSettings?.domeggookStorageStatePath || '').trim()),
    stageBreakdown: {
      collect: {
        keywordsTried: keywordScanLimit,
        collectedCandidates: candidates.length,
        uniqueCandidates: uniq.length,
        scoredCandidates: scoredPool.length,
      },
      preview: {
        attempted: validated,
        passedStrictValidation: Math.max(0, validated - strictRejectedTotal),
        strictRejected: strictRejectedTotal,
        openApiAttempts: previewOpenApiAttempts,
        openApiSucceeded: previewOpenApiSucceeded,
        openApiFailed: previewOpenApiFailed,
        openApiTimeout: previewOpenApiTimeout,
        openApiNonTimeoutFailed: previewOpenApiNonTimeoutFailed,
        timeoutDisabled: previewTimeoutDisabled,
        playwrightFallbackNeeded: previewPlaywrightFallbackNeeded,
        playwrightAttempts: previewPlaywrightAttempts,
        playwrightRetryBudget: previewPlaywrightRetryBudgetDisabled ? null : configuredPreviewPlaywrightRetryBudget,
        playwrightRetryBudgetConfigured: configuredPreviewPlaywrightRetryBudget,
        playwrightRetryBudgetDisabled: previewPlaywrightRetryBudgetDisabled,
        playwrightBudgetExhausted: Number(strictRejectCounts.preview_playwright_budget_exhausted || 0),
        topRejects: strictRejectTop,
      },
      qc: {
        rejected: qcRejected,
        kept: finalItems.length,
        relaxAttemptStage1: qcRelaxAttemptStage1,
        relaxPassStage1: qcRelaxPassStage1,
        relaxAttemptStage2: qcRelaxAttemptStage2,
        relaxPassStage2: qcRelaxPassStage2,
        topReasons: qcReasonTop,
      },
    },
    strictRejectTop,
    hint: '',
  };
  if (finalItems.length === 0) {
    if (qcRejected > 0) {
      const topQcReason = Object.entries(qcReasonCounts)
        .sort((a, b) => Number(b?.[1] || 0) - Number(a?.[1] || 0))[0];
      const topReasonText = topQcReason && Number(topQcReason[1] || 0) > 0
        ? ` (주요 사유: ${topQcReason[0]} ${topQcReason[1]}건)`
        : '';
      diagnostics.hint = `QC 통과 상품을 찾지 못했습니다. 검증 ${validated}건 중 QC 탈락 ${qcRejected}건입니다.${topReasonText}`;
    } else if (validated > 0) {
      const topStrictReject = Object.entries(strictRejectCounts)
        .sort((a, b) => Number(b?.[1] || 0) - Number(a?.[1] || 0))[0];
      if (topStrictReject && Number(topStrictReject[1] || 0) > 0) {
        const reasonRaw = String(topStrictReject[0] || '').trim();
        const reason = reasonRaw.toLowerCase();
        const reasonLabel = humanizeStrictRejectReason(reasonRaw);
        if (reason.includes('preview')) {
          const budgetExhausted = Number(strictRejectCounts.preview_playwright_budget_exhausted || 0);
          const timeoutRejected = Number(strictRejectCounts.preview_timeout || 0);
          if (budgetExhausted > 0) {
            diagnostics.hint = `미리보기 단계에서 제외되었습니다 (${reasonLabel} ${topStrictReject[1]}건). OpenAPI 후보 수집은 되었지만 Playwright 폴백 예산 ${previewPlaywrightRetryBudgetText}을 모두 사용해 추가 재시도를 하지 못했습니다 (예산소진 ${budgetExhausted}건, timeout ${timeoutRejected}건).`;
          } else {
            diagnostics.hint = `미리보기 단계에서 제외되었습니다 (${reasonLabel} ${topStrictReject[1]}건). OpenAPI 미리보기 시도 ${previewOpenApiAttempts}건 중 성공 ${previewOpenApiSucceeded}건, 실패 ${previewOpenApiFailed}건입니다.`;
          }
        } else {
          diagnostics.hint = `품질 검증 단계에서 제외되었습니다 (${reasonLabel} ${topStrictReject[1]}건).`;
        }
      }
    } else if (Number(diagnostics.scoredCandidates || 0) === 0) {
      const topReject = Object.entries(scoreRejectCounts)
        .sort((a, b) => Number(b?.[1] || 0) - Number(a?.[1] || 0))[0];
      if (topReject && Number(topReject[1] || 0) > 0) {
        diagnostics.hint = `추천 점수 필터에서 모두 제외되었습니다 (${topReject[0]} ${topReject[1]}건).`;
      } else {
        diagnostics.hint = detectRecommendationHint(keywordDiagnostics);
      }
    } else if (diagnostics.openApiKeyMissing && !diagnostics.hasDomeggookSessionPath) {
      diagnostics.hint = '도매꾹 OpenAPI 키가 없고 세션 파일 경로도 비어 있어 후보 수집을 시작하지 못했습니다.';
    } else {
      diagnostics.hint = detectRecommendationHint(keywordDiagnostics);
    }
    if (!diagnostics.hint) {
      diagnostics.hint = '후보 수집 단계에서 유효한 상품을 찾지 못했습니다. 잠시 후 다시 시도하세요.';
    }
  }

  return { ok: true, items: finalItems, validated, diagnostics };
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

  const fillTopN = Math.min(Math.max(1, need), Math.max(2, Number(maxAddPerRun) || 6));
  const allowReviewModeRescue = parseBoolean(settings?.recommendationAllowReviewModeRescue, false);
  let batch = await generateRecommendationsBatch({
    settings,
    keywords: [kw],
    topN: fillTopN,
    excludeUrls: exclude,
    onProgress,
  });
  let fillRescuePlaywrightTried = false;
  let fillRescuePlaywrightApplied = false;
  let fillRescueReviewModeTried = false;
  let fillRescueReviewModeApplied = false;
  const collectDetailTooFewCount = (diag) => {
    const reasonMap = diag?.qcReasonCounts && typeof diag.qcReasonCounts === 'object'
      ? diag.qcReasonCounts
      : {};
    return Object.entries(reasonMap).reduce((sum, [reason, count]) => {
      if (!String(reason || '').includes('상세 이미지가 너무 적습니다')) return sum;
      return sum + (Number(count) || 0);
    }, 0);
  };

  const hasOpenApiListFailure = (diag) => {
    const rows = Array.isArray(diag?.keywordDiagnostics) ? diag.keywordDiagnostics : [];
    return rows.some((row) =>
      (Array.isArray(row?.errors) ? row.errors : []).some((e) =>
        String(e || '').toLowerCase().includes('domeggook_openapi_getitemlist_failed')
      ),
    );
  };

  const noCandidatesCollected = Number(batch?.diagnostics?.collectedCandidates || 0) === 0;
  if (batch.items.length === 0 && (noCandidatesCollected || hasOpenApiListFailure(batch?.diagnostics))) {
    fillRescuePlaywrightTried = true;
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          stage: 'fill_rescue_playwright',
          keyword: kw,
          collectedCandidates: Number(batch?.diagnostics?.collectedCandidates || 0),
        });
      } catch {}
    }
    const rescueBatch = await generateRecommendationsBatch({
      settings,
      keywords: [kw],
      topN: fillTopN,
      excludeUrls: exclude,
      onProgress,
      candidateSourceMode: 'playwright',
    });
    if (rescueBatch.items.length > batch.items.length) {
      batch = rescueBatch;
      fillRescuePlaywrightApplied = true;
    }
  }

  const detailTooFewCount = collectDetailTooFewCount(batch?.diagnostics);
  if (
    allowReviewModeRescue &&
    batch.items.length === 0 &&
    Number(batch?.diagnostics?.qcRejected || 0) > 0 &&
    detailTooFewCount > 0
  ) {
    fillRescueReviewModeTried = true;
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          stage: 'fill_rescue_review_mode',
          keyword: kw,
          qcRejected: Number(batch?.diagnostics?.qcRejected || 0),
          detailTooFew: detailTooFewCount,
        });
      } catch {}
    }
    const reviewModeSettings = {
      ...(settings || {}),
      recommendationRequireQcPass: false,
      recommendationAllowQuickFallback: true,
    };
    const reviewBatch = await generateRecommendationsBatch({
      settings: reviewModeSettings,
      keywords: [kw],
      topN: fillTopN,
      excludeUrls: exclude,
      onProgress,
      candidateSourceMode: 'auto',
    });
    if (reviewBatch.items.length > batch.items.length) {
      batch = reviewBatch;
      fillRescueReviewModeApplied = true;
    }
  }

  const up = await upsertRecommendationsForUser({ userId, items: batch.items, maxKeep: Math.max(60, Number(targetCount) || 20) });
  const diagnostics = {
    ...(batch?.diagnostics || {}),
    fillRescuePlaywrightTried,
    fillRescuePlaywrightApplied,
    fillRescueReviewModeTried,
    fillRescueReviewModeApplied,
  };
  return { ok: true, ...up, keyword: kw, diagnostics };
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
  let activeExcludeUrls = excludeUrls;
  let rescuePlaywrightTried = false;
  let rescuePlaywrightApplied = false;
  let rescueReviewModeTried = false;
  let rescueReviewModeApplied = false;
  let rescueDetailTooFewCount = 0;

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
      activeExcludeUrls = uploadedOnlyExclude;
    }
  }

  const countDetailTooFewReasons = (diag) => {
    const reasonMap = diag?.qcReasonCounts && typeof diag.qcReasonCounts === 'object'
      ? diag.qcReasonCounts
      : {};
    return Object.entries(reasonMap).reduce((sum, [reason, count]) => {
      if (!String(reason || '').includes('상세 이미지가 너무 적습니다')) return sum;
      return sum + (Number(count) || 0);
    }, 0);
  };
  rescueDetailTooFewCount = countDetailTooFewReasons(batch?.diagnostics);
  const allowReviewModeRescue = parseBoolean(settings?.recommendationAllowReviewModeRescue, false);
  const validatedCount = Number(batch?.diagnostics?.validated || 0);
  const underfilledThreshold = Math.max(2, Math.floor(target * 0.4));
  const severelyUnderfilled = batch.items.length < underfilledThreshold;
  const noCandidatesCollected = Number(batch?.diagnostics?.collectedCandidates || 0) === 0;

  // Underfilled-result rescue #1:
  // keep QC strict, but switch candidate source to list scraping (playwright).
  const shouldTryPlaywrightRescue =
    severelyUnderfilled &&
    (validatedCount >= 5 || noCandidatesCollected);
  if (shouldTryPlaywrightRescue) {
    rescuePlaywrightTried = true;
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          stage: 'rescue_playwright',
          validated: Number(batch?.diagnostics?.validated || 0),
          qcRejected: Number(batch?.diagnostics?.qcRejected || 0),
        });
      } catch {}
    }
    const rescueBatch = await generateRecommendationsBatch({
      settings,
      keywords: seed,
      topN: target,
      excludeUrls: activeExcludeUrls,
      onProgress,
      candidateSourceMode: 'playwright',
    });
    if (rescueBatch.items.length > batch.items.length) {
      batch = rescueBatch;
      rescuePlaywrightApplied = true;
    }
    // review-mode rescue should use the latest batch diagnostics.
    rescueDetailTooFewCount = countDetailTooFewReasons(batch?.diagnostics);
  }

  // Underfilled-result rescue #2:
  // when detail-image shortage dominates QC rejections, switch to review mode
  // so operators can still inspect candidates without repetitive reruns.
  const shouldTryReviewModeRescue =
    allowReviewModeRescue &&
    batch.items.length < underfilledThreshold &&
    Number(batch?.diagnostics?.qcRejected || 0) > 0 &&
    rescueDetailTooFewCount > 0;
  if (shouldTryReviewModeRescue) {
    rescueReviewModeTried = true;
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          stage: 'rescue_review_mode',
          detailTooFew: rescueDetailTooFewCount,
          qcRejected: Number(batch?.diagnostics?.qcRejected || 0),
        });
      } catch {}
    }
    const reviewModeSettings = {
      ...(settings || {}),
      recommendationRequireQcPass: false,
      // Review rescue is intentionally quality-relaxed to prevent repeated near-empty fills.
      recommendationAllowQuickFallback: true,
    };
    const reviewBatch = await generateRecommendationsBatch({
      settings: reviewModeSettings,
      keywords: seed,
      topN: target,
      excludeUrls: activeExcludeUrls,
      onProgress,
      candidateSourceMode: 'auto',
    });
    if (reviewBatch.items.length > batch.items.length) {
      batch = reviewBatch;
      rescueReviewModeApplied = true;
    }
  }

  await replaceRecommendationsForUser({ userId, items: batch.items });

  const diagnostics = {
    ...batch.diagnostics,
    initialExcludedCount,
    finalExcludedCount,
    relaxedExclusionAllowed: Boolean(policy.allowRelaxedExclusion),
    relaxedExclusionApplied: usedRelaxedExclusion,
    rescuePlaywrightTried,
    rescuePlaywrightApplied,
    rescueReviewModeTried,
    rescueReviewModeApplied,
    rescueDetailTooFewCount,
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
