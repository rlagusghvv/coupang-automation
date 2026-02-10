import crypto from 'node:crypto';

import { previewUploadFromUrl } from '../pipeline/previewUploadFromUrl.js';
import { dbAll, dbRun, openDb } from './storage_sqlite_internal.js';

// NOTE: storage_sqlite.js doesn't currently export low-level db helpers.
// We keep this module standalone by using the internal helper shim.

function nowIso() {
  return new Date().toISOString();
}

export const DEFAULT_BAN_KEYWORDS = [
  // regulated
  '식품', '건기식', '건강기능', '의약', '의료', '치료', '진단',
  '화장품', '미백', '주름', '탈모',
  // batteries/electric
  '배터리', '충전기', '전동', '전기', '220v', '110v',
  // kids safety / certifications
  'KC', '인증', '전파', '어린이', '유아', '안전인증',
  // high risk
  '액체', '향수', '스프레이',
];

export function defaultKeywordSet() {
  // v0: compact but broad. We'll expand/learn later.
  return [
    // storage/organizing
    '수납', '정리', '서랍정리', '케이블정리', '옷정리', '주방정리', '냉장고정리', '욕실정리',
    // party/season
    '생일 파티', '풍선 세트', '가랜드', '케이크 토퍼', '포장 리본', '포장 스티커',
    // desk/car
    '차량 수납', '차량 거치대', '책상 정리', '노트북 거치대',
    // hobby/diy
    '키링', '스티커', '다꾸', 'DIY 세트', '취미 공구',
    // pet (low risk items)
    '강아지 장난감', '고양이 장난감', '배변 봉투', '펫 브러쉬',
  ];
}

export async function fetchDomeggookUrlsByKeyword({ keyword, limit = 40 }) {
  const q = String(keyword || '').trim();
  if (!q) return [];

  // Domeggook list page (best-effort)
  const url = `https://domeggook.com/main/item/itemList.php?sw=${encodeURIComponent(q)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://domeggook.com/' },
  });
  if (!r.ok) return [];
  const html = await r.text();

  // Capture item numbers from links.
  const out = [];
  const seen = new Set();
  const re = /(\/main\/item\/itemView\.php\?no=|https?:\/\/domeggook\.com\/)(\d{6,})/g;
  let m;
  while ((m = re.exec(html))) {
    const no = m[2];
    if (!no) continue;
    if (seen.has(no)) continue;
    seen.add(no);
    out.push(`https://domeggook.com/${no}`);
    if (out.length >= limit) break;
  }
  return out;
}

function containsBanKeyword(text, banList) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (banList || []).some((k) => t.includes(String(k || '').toLowerCase()));
}

export function scoreRecommendation({ preview, minProfit = 3000, minMarginRate = 0.30, banKeywords = DEFAULT_BAN_KEYWORDS }) {
  const draft = preview?.draft || {};
  const computed = preview?.computed || {};

  const title = String(draft.title || '');
  if (!title) return { ok: false, reason: 'no_title' };
  if (containsBanKeyword(title, banKeywords)) return { ok: false, reason: 'banned_keyword' };

  const sourcePrice = Number(draft.price);
  const finalPrice = Number(computed.finalPrice);
  if (!Number.isFinite(sourcePrice) || !Number.isFinite(finalPrice) || sourcePrice <= 0 || finalPrice <= 0) {
    return { ok: false, reason: 'bad_price' };
  }

  // Profit heuristic v0: treat shipping as pass-through (user charges shipping anyway).
  // So we don't subtract shipping here; we only require an absolute profit >= minProfit.
  const profit = finalPrice - sourcePrice;
  const marginRate = profit / finalPrice;

  if (!Number.isFinite(profit) || profit < minProfit) return { ok: false, reason: 'profit_too_low', profit, marginRate };
  if (!Number.isFinite(marginRate) || marginRate < minMarginRate) return { ok: false, reason: 'margin_too_low', profit, marginRate };

  const contentImageCount = Number(computed.contentImageCount) || 0;
  if (contentImageCount < 2) return { ok: false, reason: 'detail_images_too_few', contentImageCount };

  // Simple score: favor higher profit and sufficient detail images.
  const score = profit + Math.min(2000, contentImageCount * 200);
  const reason = `profit≈${Math.round(profit)} / margin≈${Math.round(marginRate * 100)}% / detailImages=${contentImageCount}`;

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

export async function listRecommendations(userId, { limit = 50 } = {}) {
  const db = openDb();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await dbAll(
    db,
    `SELECT id, source_url, keyword, title, main_image_url, source_price, shipping_fee, final_price, profit, margin_rate, score, reason, created_at
     FROM recommendations
     WHERE user_id = ?
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

export async function generateRecommendationsForUser({ userId, settings, keywords, topN = 20 }) {
  const seed = Array.isArray(keywords) && keywords.length > 0 ? keywords : defaultKeywordSet();
  const candidates = [];

  for (const kw of seed.slice(0, 60)) {
    const urls = await fetchDomeggookUrlsByKeyword({ keyword: kw, limit: 30 }).catch(() => []);
    for (const u of urls) {
      candidates.push({ keyword: kw, url: u });
      if (candidates.length >= 400) break;
    }
    if (candidates.length >= 400) break;
  }

  // de-dupe
  const uniq = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    uniq.push(c);
  }

  const scored = [];
  for (const c of uniq) {
    const prev = await previewUploadFromUrl(c.url, {
      ...(settings || {}),
      maxContentImages: 30,
      // ensure we compute finalPrice using existing margin settings
      marginRate: settings?.marginRate ?? 0.5,
      marginAdd: settings?.marginAdd ?? 0,
    }).catch(() => null);

    if (!prev?.ok) continue;
    const s = scoreRecommendation({
      preview: prev,
      minProfit: 3000,
      minMarginRate: 0.30,
      banKeywords: DEFAULT_BAN_KEYWORDS,
    });
    if (!s.ok) continue;

    scored.push({
      sourceUrl: c.url,
      keyword: c.keyword,
      ...s,
      payload: { preview: { url: prev.url, draft: prev.draft, computed: prev.computed } },
    });

    if (scored.length >= 120) break;
  }

  scored.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const top = scored.slice(0, topN);
  await replaceRecommendationsForUser({ userId, items: top });
  return { ok: true, count: top.length };
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
