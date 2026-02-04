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

  return Array.from(new Set([...uniq, ...bi])).slice(0, 10);
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

function buildCombos(tokens) {
  const t = tokens.filter(Boolean);
  const combos = [];
  if (t[0]) combos.push(t[0]);
  if (t[0] && t[1]) combos.push(`${t[0]} ${t[1]}`);
  if (t[0] && t[1] && t[2]) combos.push(`${t[0]} ${t[1]} ${t[2]}`);
  if (t[1] && t[2]) combos.push(`${t[1]} ${t[2]}`);
  return combos;
}

export async function suggestTitlesFromNaver({ title, maxLen = 15 } = {}) {
  const base = cleanTitle(title);
  const candidates = extractKeywordCandidates(base);
  if (candidates.length === 0) {
    return {
      ok: true,
      baseTitle: base,
      suggestions: [{ title: fit15(base), keywords: [], score: 0 }],
      source: "fallback",
    };
  }

  // Query at most 5 at once (API supports comma hints)
  const batch = candidates.slice(0, 5);
  const volRes = await fetchVolumes(batch);

  // Score known keywords first, fallback to 0.
  const scored = candidates
    .map((kw) => ({ kw, vol: volRes.volumes?.[kw] || null, score: scoreKeyword(volRes.volumes?.[kw]) }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 5).map((x) => x.kw);

  const combos = buildCombos(top)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const uniq = Array.from(new Set(combos))
    .map((s) => ({
      title: fit15(s).slice(0, maxLen),
      keywords: s.split(" ").filter(Boolean),
    }))
    .filter((x) => x.title.length > 0 && x.title.length <= maxLen);

  // Ensure at least one option
  if (uniq.length === 0) {
    uniq.push({ title: fit15(base).slice(0, maxLen), keywords: [], score: 0 });
  }

  const suggestions = uniq.slice(0, 3).map((s) => ({
    title: s.title,
    keywords: s.keywords,
    score: s.keywords.reduce((acc, k) => acc + scoreKeyword(volRes.volumes?.[k]), 0),
    volumes: s.keywords.reduce((acc, k) => {
      acc[k] = volRes.volumes?.[k] || null;
      return acc;
    }, {}),
  }));

  return {
    ok: true,
    baseTitle: base,
    suggestions,
    source: volRes.ok ? "naver" : "fallback",
    raw: volRes.ok ? volRes.raw : volRes.raw,
  };
}
