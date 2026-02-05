import { fetchKeywordTool, normalizeMonthlyCount } from "./naverSearchAd.js";

const TAG_RE = /\[[^\]]*\]|\([^\)]*\)/g;
const PUNCT_RE = /[~!@#$%^&*+=|\\:;"'`<>,.?/{}\[\]()-]/g;

const STOPWORDS = [
  "신상",
  "꿀템",
  "정품",
  "무료배송",
  "당일",
  "출고",
  "국내",
  "최저가",
  "특가",
  "세트",
  // salesy / not-product-identity words (common in domeggook titles)
  "재고",
  "땡처리",
  "재고땡처리",
  "고급진",
  "할머니",
  "김장",
  "빈티지",
  "가성비",
  "인기",
  "추천",
  "대박",
  "필수",
];

const PRODUCT_HEAD_HINTS = [
  // apparel
  "조끼",
  "베스트",
  "장갑",
  "모자",
  "양말",
  "티셔츠",
  "후드",
  "맨투맨",
  "바지",
  "청바지",
  "스커트",
  "원피스",
  "자켓",
  "점퍼",
  "코트",
  "가디건",
  "니트",
  "목도리",
  "머플러",
  "스카프",
  // home/kitchen
  "텀블러",
  "컵",
  "머그",
  "그릇",
  "접시",
  "수저",
  "도마",
  "칼",
  "팬",
  "냄비",
  // electronics
  "케이블",
  "충전기",
  "거치대",
  "배터리",
];

export function cleanTitle(raw) {
  return String(raw || "")
    .replace(TAG_RE, " ")
    .replace(PUNCT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractKeywordCandidates(title) {
  const cleaned = cleanTitle(title);
  const parts = cleaned
    .split(" ")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 2)
    .filter((x) => !STOPWORDS.some((w) => x.includes(w)));

  // uniq
  const uniq = Array.from(new Set(parts));

  // bigrams (2-word phrases)
  const bi = [];
  for (let i = 0; i < uniq.length - 1; i += 1) {
    const p = `${uniq[i]} ${uniq[i + 1]}`;
    if (p.length <= 15) bi.push(p);
  }

  return Array.from(new Set([...uniq, ...bi])).slice(0, 12);
}

export function pickProductHead(title) {
  const cleaned = cleanTitle(title);
  const tokens = cleaned.split(" ").map((t) => t.trim()).filter(Boolean);

  // 1) direct hit by hints
  for (const h of PRODUCT_HEAD_HINTS) {
    if (tokens.some((t) => t.includes(h))) return h;
  }

  // 2) fallback: last meaningful token (often the product type)
  const filtered = tokens.filter((t) => !STOPWORDS.some((w) => t.includes(w)));
  return filtered.length > 0 ? filtered[filtered.length - 1] : "";
}

function includesHead(title, head) {
  if (!head) return true;
  return String(title || "").replace(/\s+/g, "").includes(String(head).replace(/\s+/g, ""));
}

function jaccardTokenSimilarity(a, b) {
  const A = new Set(cleanTitle(a).split(" ").filter(Boolean));
  const B = new Set(cleanTitle(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

async function fetchVolumes(keywords) {
  const res = await fetchKeywordTool({ hintKeywords: keywords, showDetail: 1 });
  if (!res.ok) return { ok: false, volumes: {}, raw: res };

  const body = res.body;
  const list = Array.isArray(body?.keywordList) ? body.keywordList : [];
  const volumes = {};
  for (const row of list) {
    const kw = String(row?.relKeyword ?? "").trim();
    if (!kw) continue;
    const pc = normalizeMonthlyCount(row?.monthlyPcQcCnt);
    const mobile = normalizeMonthlyCount(row?.monthlyMobileQcCnt);
    volumes[kw] = { pc, mobile, total: pc + mobile };
  }
  return { ok: true, volumes, raw: body };
}

function scoreKeyword(vol) {
  const v = vol?.total ?? 0;
  return Number.isFinite(v) ? v : 0;
}

function fit15(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= 15) return t;
  return t.slice(0, 15).trimEnd();
}

function normalizePhraseWords(s) {
  const words = String(s || "").split(" ").map((w) => w.trim()).filter(Boolean);
  const out = [];
  for (const w of words) {
    if (out.includes(w)) continue;
    out.push(w);
  }
  return out.join(" ");
}

function buildCombos(tokens) {
  const t = tokens.filter(Boolean);
  const combos = [];
  if (t[0]) combos.push(t[0]);
  if (t[0] && t[1]) combos.push(`${t[0]} ${t[1]}`);
  if (t[0] && t[1] && t[2]) combos.push(`${t[0]} ${t[1]} ${t[2]}`);
  if (t[1] && t[2]) combos.push(`${t[1]} ${t[2]}`);
  return combos.map(normalizePhraseWords);
}

export async function suggestTitlesFromNaver({ title, maxLen = 15 } = {}) {
  const base = cleanTitle(title);
  const head = pickProductHead(base);

  const candidates = extractKeywordCandidates(base);
  if (candidates.length === 0) {
    return {
      ok: true,
      baseTitle: base,
      head,
      suggestions: [{ title: fit15(base), keywords: [], score: 0 }],
      source: "fallback",
    };
  }

  // Query at most 5 at once (API supports comma hints)
  const batch = candidates.slice(0, 5);
  const volRes = await fetchVolumes(batch);

  // Expand with Naver related keywords, but keep only those that still express the product head.
  const related = Array.isArray(volRes.raw?.keywordList)
    ? volRes.raw.keywordList.map((r) => String(r?.relKeyword || "").trim()).filter(Boolean)
    : [];

  const expanded = Array.from(new Set([...candidates, ...related]))
    .map((kw) => kw.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((kw) => !STOPWORDS.some((w) => kw.includes(w)))
    .filter((kw) => includesHead(kw, head));

  // Score known keywords first, fallback to 0.
  const scored = expanded
    .map((kw) => ({ kw, vol: volRes.volumes?.[kw] || null, score: scoreKeyword(volRes.volumes?.[kw]) }))
    .sort((a, b) => b.score - a.score);

  // Prefer top scored, but ensure head appears.
  const top = scored
    .filter((x) => includesHead(x.kw, head))
    .slice(0, 6)
    .map((x) => x.kw);

  const combos = buildCombos(top)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((s) => includesHead(s, head));

  const uniq = Array.from(new Set(combos))
    .map((s) => ({
      title: fit15(s).slice(0, maxLen),
      keywords: s.split(" ").filter(Boolean),
    }))
    .filter((x) => x.title.length > 0 && x.title.length <= maxLen)
    // Similarity guard: don't allow totally off-topic titles
    .filter((x) => jaccardTokenSimilarity(base, x.title) >= 0.15);

  // Always include a safe fallback: cleaned original trimmed to 15 chars.
  const safe = { title: fit15(base).slice(0, maxLen), keywords: base.split(" ").filter(Boolean), score: 0 };

  const finalList = uniq.length > 0 ? uniq : [safe];

  const suggestions = finalList.slice(0, 3).map((s) => ({
    title: s.title,
    keywords: s.keywords,
    score: s.keywords.reduce((acc, k) => acc + scoreKeyword(volRes.volumes?.[k]), 0),
    volumes: s.keywords.reduce((acc, k) => {
      acc[k] = volRes.volumes?.[k] || null;
      return acc;
    }, {}),
  }));

  // If safe fallback isn't in the top 3, append it (ensures a product-faithful option).
  if (!suggestions.some((s) => s.title === safe.title)) {
    suggestions.push({ title: safe.title, keywords: safe.keywords.slice(0, 6), score: 0, volumes: {} });
  }

  return {
    ok: true,
    baseTitle: base,
    head,
    suggestions: suggestions.slice(0, 3),
    source: volRes.ok ? "naver" : "fallback",
    raw: volRes.raw,
  };
}
