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
  // organize
  "정리함",
  "수납함",
  "트레이",
  "칸막이",
  "파티션",
  // car
  "송풍구",
  "컵홀더",
  "콘솔",
  "트렁크",
  // pet
  "하네스",
  "리드줄",
  "목줄",
  "급수기",
  "스크래쳐",
  "배변패드",
];

const COUPANG_TITLE_NOISE = [
  "무료배송",
  "당일출고",
  "당일",
  "출고",
  "특가",
  "최저가",
  "인기",
  "추천",
  "신상",
  "도매",
  "도매꾹",
  "도매매",
  "재고",
  "땡처리",
];

const SEO_PRIORITY_TERMS = [
  "차량용",
  "송풍구",
  "거치대",
  "트렁크",
  "컵홀더",
  "시트백",
  "콘솔",
  "멀티탭",
  "전선정리",
  "케이블정리",
  "정리함",
  "수납함",
  "트레이",
  "칸막이",
  "파티션",
  "강아지",
  "고양이",
  "반려동물",
  "하네스",
  "리드줄",
  "배변패드",
  "배변봉투",
  "급수기",
  "스크래쳐",
  "카시트",
];

const CAR_TOKENS = [
  "차량",
  "차량용",
  "자동차",
  "송풍구",
  "대시보드",
  "컵홀더",
  "콘솔",
  "트렁크",
  "시트",
  "시트백",
  "차박",
];

const PET_TOKENS = [
  "반려",
  "반려동물",
  "애견",
  "강아지",
  "고양이",
  "펫",
  "하네스",
  "리드줄",
  "목줄",
  "배변",
  "급수기",
  "스크래쳐",
  "산책",
];

const SEO_SPLIT_HINTS = [
  "반려동물",
  "차량용",
  "휴대폰",
  "멀티탭",
  "전선정리",
  "케이블정리",
  "정리함",
  "수납함",
  "칸막이",
  "파티션",
  "거치대",
  "송풍구",
  "대시보드",
  "트렁크",
  "시트백",
  "컵홀더",
  "강아지",
  "고양이",
  "하네스",
  "리드줄",
  "배변패드",
  "배변봉투",
  "급수기",
  "스크래쳐",
  "특대형",
  "대형",
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

function toCanonicalSeoToken(token = "") {
  const t = String(token || "").replace(/\s+/g, "").toLowerCase();
  if (!t) return "";
  if (/^(차량용|차량|자동차|자동차용)$/.test(t)) return "차량용";
  if (/^(강아지|애견)$/.test(t)) return "강아지";
  if (/^(고양이|캣)$/.test(t)) return "고양이";
  if (/^(반려동물|반려|펫)$/.test(t)) return "반려동물";
  if (/(정리함|수납함|정리대|수납박스|정리박스)/.test(t)) return "정리함";
  if (/(멀티탭|전선정리|케이블정리)/.test(t)) return "멀티탭정리";
  if (/(거치대|홀더)/.test(t)) return "거치대";
  if (/(하네스|가슴줄)/.test(t)) return "하네스";
  if (/(리드줄|산책줄|목줄)/.test(t)) return "리드줄";
  if (/(배변패드|배변봉투|배변)/.test(t)) return "배변";
  if (/(급수기|물병|물그릇)/.test(t)) return "급수기";
  if (/(스크래쳐|스크래처)/.test(t)) return "스크래쳐";
  return t;
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueTokens(tokens = [], canonicalizer = (x) => String(x || "").trim()) {
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    const t = String(token || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const key = String(canonicalizer(t) || t).trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function truncateAtWordBoundary(text, maxLen) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const m = Number(maxLen);
  if (!Number.isFinite(m) || m <= 0) return t;
  if (t.length <= m) return t;
  let cut = t.slice(0, m).trimEnd();
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(m * 0.55)) {
    cut = cut.slice(0, lastSpace).trimEnd();
  }
  return cut;
}

function extractSpecTokens(title = "") {
  const base = String(title || "");
  const out = [];
  const patterns = [
    /(\d{1,4})\s*(개|입|팩|세트|매|장|롤|포|병|캡슐|p|P|pcs|PCS)/g,
    /(\d{1,3})\s*구/g,
    /(\d{1,4})(cm|mm|m|ml|l|L|g|kg|oz|인치|호)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(base))) {
      const token = String(m[0] || "").replace(/\s+/g, "").trim();
      if (!token) continue;
      if (!out.includes(token)) out.push(token);
      if (out.length >= 4) break;
    }
    if (out.length >= 4) break;
  }
  return out;
}

function detectSeoTheme(base = "") {
  const hay = String(base || "").toLowerCase();
  if (CAR_TOKENS.some((k) => hay.includes(String(k).toLowerCase()))) return "car";
  if (PET_TOKENS.some((k) => hay.includes(String(k).toLowerCase()))) return "pet";
  return "general";
}

function explodeSeoTokens(raw = "") {
  let text = String(raw || "").trim();
  if (!text) return [];

  text = text
    .replace(/(\d{1,3}\s*구)(?=[가-힣a-zA-Z])/g, "$1 ")
    .replace(
      /(\d{1,4}\s*(?:개|입|팩|세트|매|장|롤|포|병|캡슐|cm|mm|ml|l|L|g|kg|인치|호))(?=[가-힣a-zA-Z])/g,
      "$1 ",
    );

  for (const hint of SEO_SPLIT_HINTS) {
    const re = new RegExp(`(${escapeRegExp(hint)})`, "gi");
    text = text.replace(re, " $1 ");
  }

  return text
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

function pickThemePrefix(base = "", tokens = []) {
  const theme = detectSeoTheme(base);
  const list = Array.isArray(tokens) ? tokens : [];
  if (theme === "car") return "차량용";
  if (theme === "pet") {
    if (list.some((t) => String(t).includes("강아지") || String(t).includes("애견"))) return "강아지";
    if (list.some((t) => String(t).includes("고양이") || String(t).includes("캣"))) return "고양이";
    return "반려동물";
  }
  return "";
}

function pickPriorityTokens(tokens = []) {
  const list = Array.isArray(tokens) ? tokens : [];
  const out = [];
  for (const term of SEO_PRIORITY_TERMS) {
    const hit = list.find((t) => {
      const token = String(t || "");
      return token.includes(term) || term.includes(token);
    });
    if (hit) out.push(hit);
  }
  return uniqueTokens(out, toCanonicalSeoToken);
}

export function buildCoupangSeoTitle(rawTitle, { maxLen = 55, minLen = 8 } = {}) {
  const max = Number.isFinite(Number(maxLen))
    ? Math.max(20, Math.min(80, Math.floor(Number(maxLen))))
    : 55;
  const min = Number.isFinite(Number(minLen))
    ? Math.max(4, Math.min(max - 2, Math.floor(Number(minLen))))
    : 8;

  const base = cleanTitle(String(rawTitle || "").split("|")[0]);
  if (!base) return "";

  const head = pickProductHead(base);
  const specTokens = extractSpecTokens(base);
  const baseTokens = base
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean)
    .flatMap((t) => explodeSeoTokens(t))
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/하기$/g, "").replace(/정리하기$/g, "정리"))
    .filter((t) => !COUPANG_TITLE_NOISE.some((w) => t.includes(w)));

  const cleanedTokens = baseTokens.filter((t) => !["정리", "수납"].includes(t));
  const themePrefix = pickThemePrefix(base, baseTokens);
  const priorityTokens = pickPriorityTokens(cleanedTokens);
  const contextTokens = [];
  if (cleanedTokens.some((t) => t.includes("멀티탭")) && !cleanedTokens.some((t) => t.includes("전선정리"))) {
    contextTokens.push("전선정리");
  }
  if (cleanedTokens.some((t) => t.includes("서랍")) && !cleanedTokens.some((t) => t.includes("칸막이"))) {
    contextTokens.push("칸막이");
  }

  const ordered = uniqueTokens(
    [
      themePrefix,
      head,
      ...priorityTokens,
      ...contextTokens,
      ...cleanedTokens,
      ...specTokens,
    ],
    toCanonicalSeoToken,
  );

  const titleParts = [];
  for (const token of ordered) {
    const candidate = [...titleParts, token].join(" ").replace(/\s+/g, " ").trim();
    if (!candidate) continue;
    if (candidate.length > max) break;
    titleParts.push(token);
  }

  let out = titleParts.join(" ").replace(/\s+/g, " ").trim();
  if (out.length > max) {
    out = truncateAtWordBoundary(out, max);
  }
  if (!out || out.length < min) {
    out = truncateAtWordBoundary(base, max);
  }
  if (!out || out.length < min) {
    out = String(base).slice(0, max).trim();
  }
  return out.replace(/\s+/g, " ").trim();
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

function extractQtyHint(title) {
  const t = cleanTitle(title);
  // common Korean quantity patterns
  const m = t.match(/(\d{1,4})\s*(매|장|개|팩|입|롤|캡슐|포|매입)/);
  if (!m) return '';
  return `${m[1]}${m[2]}`;
}

export function ruleBasedShortSeoTitle(title, { maxLen = 15 } = {}) {
  const base = cleanTitle(String(title || '').split('|')[0]);
  const head = pickProductHead(base);
  const qty = extractQtyHint(base);

  const tokens = base
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOPWORDS.some((w) => t.includes(w)));

  const uniq = [];
  for (const t of tokens) {
    if (uniq.includes(t)) continue;
    uniq.push(t);
    if (uniq.length >= 6) break;
  }

  // Ensure head is included early
  const parts = [];
  if (head) parts.push(head);
  for (const t of uniq) {
    if (parts.includes(t)) continue;
    parts.push(t);
    if (parts.join(' ').length >= maxLen) break;
  }
  if (qty && !parts.join(' ').includes(qty)) parts.push(qty);

  const out = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!out) return fit15(base).slice(0, maxLen);
  return fit15(out).slice(0, maxLen);
}

export async function suggestTitlesHybrid({ title, maxLen = 15, useNaver = true } = {}) {
  const base = cleanTitle(title);
  const head = pickProductHead(base);

  const ruleTitle = ruleBasedShortSeoTitle(base, { maxLen });

  let naver = null;
  if (useNaver) {
    try {
      naver = await suggestTitlesFromNaver({ title: base, maxLen });
    } catch {
      naver = null;
    }
  }

  const merged = [];
  const push = (t, meta = {}) => {
    const tt = String(t || '').trim();
    if (!tt) return;
    if (merged.some((x) => x.title === tt)) return;
    merged.push({ title: tt, ...meta });
  };

  if (naver?.ok && Array.isArray(naver.suggestions)) {
    for (const s of naver.suggestions) push(s?.title, { source: 'naver', score: s?.score ?? 0, keywords: s?.keywords ?? [] });
  }

  push(ruleTitle, { source: 'rules', score: 0, keywords: ruleTitle.split(' ').filter(Boolean) });
  push(fit15(base).slice(0, maxLen), { source: 'fallback', score: 0, keywords: base.split(' ').filter(Boolean) });

  // Keep only reasonably related suggestions.
  const filtered = merged.filter((s) => jaccardTokenSimilarity(base, s.title) >= 0.15 || includesHead(s.title, head));

  return {
    ok: true,
    baseTitle: base,
    head,
    ruleTitle,
    suggestions: (filtered.length ? filtered : merged).slice(0, 3),
    source: naver?.source || 'hybrid',
    raw: naver?.raw,
  };
}
