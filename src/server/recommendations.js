import crypto from 'node:crypto';

import { previewUploadFromUrl } from '../pipeline/previewUploadFromUrl.js';
import { dbAll, dbRun, openDb } from './storage_sqlite_internal.js';
import { fetchWithRetry } from './net_limit.js';

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
  '올리브유', '카놀라', '카놀라유', '식용유', '오일', '식초', '발사믹', '꿀', '차', '커피', 'coffee',
  '소금', 'salt', '설탕', 'sugar', '쌀', '잡곡', '면', '국수', '파스타', '라면', '식재료',
  '과자', '간식', '스틱',
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

export async function fetchDomeggookUrlsByKeyword({ keyword, limit = 40, storageStatePath = '', maxPages = 4 }) {
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

  const want = Math.max(1, Math.min(10, Number(maxPages) || 1));

  // 1) Try plain fetch across pages (best-effort; may be limited by bot mitigation)
  try {
    const all = [];
    for (let pageNo = 1; pageNo <= want && all.length < limit; pageNo += 1) {
      const listUrl = pageNo === 1 ? baseUrl : `${baseUrl}&page=${pageNo}`;
      const r = await fetchWithRetry(listUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://domeggook.com/' },
        // Domeggook is sensitive: space requests and retry on 429
        spacingMs: 650,
        retries: 3,
        retryOn: [429, 503],
        baseDelayMs: 650,
        maxDelayMs: 8000,
      });
      if (r.status === 429) throw new Error('domeggook_rate_limited');
      if (!r.ok) break;
      const html = await r.text();
      await new Promise((r) => setTimeout(r, 450));
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
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1100);
      await page.waitForTimeout(350);
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

export async function listRecommendations(userId, { limit = 50 } = {}) {
  const db = openDb();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await dbAll(
    db,
    `SELECT id, source_url, keyword, title, main_image_url, source_price, shipping_fee, final_price, profit, margin_rate, score, reason, created_at
     FROM recommendations
     WHERE user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM uploaded_products up
         WHERE up.user_id = recommendations.user_id
           AND up.source_url = recommendations.source_url
       )
     ORDER BY score DESC
     LIMIT ?`,
    [userId, lim],
  );
  db.close();
  return rows.map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    keyword: r.keyword,
    title: r.title,
    mainImageUrl: r.main_image_url,
    sourcePrice: r.source_price,
    shippingFee: r.shipping_fee,
    finalPrice: r.final_price,
    profit: r.profit,
    marginRate: r.margin_rate,
    score: r.score,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

function parseWon(text) {
  const s = String(text || '');
  const m = s.match(/(\d[\d,]{2,})\s*원/);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchFastCandidatesFromList({ keyword, limit = 80, storageStatePath = '' }) {
  // v1: Prefer extracting (url,title,price) directly from list pages (far fewer requests).
  // Fallback: fetch individual item HTML only when needed.
  const q = String(keyword || '').trim();
  if (!q) return [];

  // 1) Playwright list-page extraction
  try {
    const { chromium } = await import('playwright');
    const fs = await import('node:fs');

    const hasState = storageStatePath && fs.existsSync(storageStatePath);
    const browser = await chromium.launch();
    const context = hasState ? await browser.newContext({ storageState: storageStatePath }) : await browser.newContext();
    const page = await context.newPage();

    const listUrl = `https://domeggook.com/main/item/itemList.php?sw=${encodeURIComponent(q)}&sf=ttl`;
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1800);

    const rows = await page.evaluate(() => {
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

        const title = text.replace(/\d[\d,]{2,}\s*원/g, '').trim().slice(0, 80);
        if (!title) continue;

        seen.add(id);
        out.push({ url: `https://domeggook.com/${id}`, title, price });
        if (out.length >= 120) break;
      }

      return out;
    });

    await browser.close();

    if (rows && rows.length) {
      return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 80)));
    }
  } catch {
    // ignore and fallback
  }

  // 2) Fallback: get URLs then fetch each item HTML (may hit 429)
  const urls = await fetchDomeggookUrlsByKeyword({ keyword: q, limit, storageStatePath }).catch(() => []);
  const out = [];

  for (const u of urls) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      const r = await fetchWithRetry(u, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://domeggook.com/' },
        spacingMs: 650,
        retries: 2,
        retryOn: [429, 503],
        baseDelayMs: 650,
        maxDelayMs: 8000,
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

      if (!title || !price) continue;
      out.push({ url: u, title, price });
      if (out.length >= limit) break;
    } catch (e) {
      if (String(e?.message || e).includes('rate_limited')) throw e;
    }

    await new Promise((r) => setTimeout(r, 180));
  }

  return out;
}

function strictValidatePreview(preview, banKeywords = DEFAULT_BAN_KEYWORDS) {
  if (!preview?.ok) return { ok: false, reason: 'preview_failed' };
  const title = String(preview?.draft?.title || '');
  if (!title) return { ok: false, reason: 'no_title' };
  if (containsBanKeyword(title, banKeywords)) return { ok: false, reason: 'banned_keyword' };
  const contentImageCount = Number(preview?.computed?.contentImageCount) || 0;
  if (contentImageCount < 1) return { ok: false, reason: 'detail_images_too_few', contentImageCount };
  return { ok: true };
}

function keywordTokens(keyword) {
  return String(keyword || '')
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 6);
}

function titleMatchesKeyword(keyword, title) {
  const kw = String(keyword || '').trim();
  if (!kw) return true;
  const t = String(title || '').toLowerCase();
  const toks = keywordTokens(kw);
  if (!toks || toks.length === 0) return t.includes(kw.toLowerCase());
  // Require at least a majority of tokens to appear (reduces irrelevant leakage,
  // but avoids being overly strict for real-world titles).
  const need = Math.max(1, Math.ceil(toks.length * 0.6));
  let hit = 0;
  for (const x of toks) {
    if (t.includes(x.toLowerCase())) hit += 1;
  }
  return hit >= need;
}

async function generateRecommendationsBatch({ settings, keywords, topN = 20, excludeUrls = new Set(), onProgress = null }) {
  const seed = Array.isArray(keywords) && keywords.length > 0 ? keywords : defaultKeywordSet();
  const startedAt = Date.now();

  const candidates = [];
  for (const kw of seed.slice(0, 12)) {
    if (Date.now() - startedAt > 6 * 60_000) break;
    let list = [];
    try {
      list = await fetchFastCandidatesFromList({
        keyword: kw,
        limit: 40,
        storageStatePath: String(settings?.domeggookStorageStatePath || ''),
      });
    } catch (e) {
      if (String(e?.message || e).includes('rate_limited')) {
        if (typeof onProgress === 'function') {
          try { onProgress({ stage: 'rate_limited', keyword: kw, candidates: candidates.length }); } catch {}
        }
        throw e;
      }
      list = [];
    }

    for (const it of list) {
      if (excludeUrls.has(it.url)) continue;
      // Domeggook search can leak irrelevant items; filter by keyword tokens.
      if (!titleMatchesKeyword(kw, it.title)) continue;
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
    if (Date.now() - startedAt > 8.5 * 60_000) break;
    if (containsBanKeyword(c.title, DEFAULT_BAN_KEYWORDS)) continue;

    const fakePreview = {
      ok: true,
      url: c.url,
      draft: { title: c.title, price: c.price, shippingFee: null, imageUrl: '' },
      computed: { contentImageCount: 1 },
    };

    const s = scoreRecommendation({ preview: fakePreview, minProfit: 3000, minMarginRate: 0.30, banKeywords: DEFAULT_BAN_KEYWORDS });
    if (!s.ok) continue;

    scoredPool.push({
      sourceUrl: c.url,
      keyword: c.keyword,
      ...s,
      payload: { fast: true },
    });

    if (scoredPool.length >= 500) break;
  }

  scoredPool.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  const final = [];
  let validated = 0;
  for (const cand of scoredPool) {
    if (final.length >= topN) break;
    if (Date.now() - startedAt > 12 * 60_000) break;
    if (excludeUrls.has(cand.sourceUrl)) continue;

    const prev = await withTimeout(
      previewUploadFromUrl(cand.sourceUrl, {
        ...(settings || {}),
        maxContentImages: 30,
      }),
      45_000,
      'preview_timeout',
    ).catch(() => null);

    validated += 1;
    if (typeof onProgress === 'function' && validated % 3 === 0) {
      try { onProgress({ stage: 'validate', validated, kept: final.length, target: topN }); } catch {}
    }

    const v = strictValidatePreview(prev, DEFAULT_BAN_KEYWORDS);
    if (!v.ok) continue;

    final.push({
      ...cand,
      payload: { ...cand.payload, preview: { url: prev.url, draft: prev.draft, computed: prev.computed } },
    });
  }

  return { ok: true, items: final, validated };
}

export async function generateRecommendationsForUser({ userId, settings, keywords, topN = 20, onProgress = null }) {
  const batch = await generateRecommendationsBatch({ settings, keywords, topN, excludeUrls: new Set(), onProgress });
  await replaceRecommendationsForUser({ userId, items: batch.items });
  return { ok: true, count: batch.items.length };
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
  if (need <= 0) return { ok: true, inserted: 0, count: exclude.size, keyword: kw };

  const batch = await generateRecommendationsBatch({
    settings,
    keywords: [kw],
    topN: Math.min(Math.max(1, need), Math.max(2, Number(maxAddPerRun) || 6)),
    excludeUrls: exclude,
    onProgress,
  });

  const up = await upsertRecommendationsForUser({ userId, items: batch.items, maxKeep: Math.max(60, Number(targetCount) || 20) });
  return { ok: true, ...up, keyword: kw };
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
