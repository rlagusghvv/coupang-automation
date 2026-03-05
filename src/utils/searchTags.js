const SEARCH_TAG_NOISE = [
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

export function normalizeSearchTagToken(raw, { minLen = 2, maxLen = 20 } = {}) {
  const cleaned = String(raw || "")
    .replace(/[^0-9A-Za-z가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length < Math.max(1, Number(minLen) || 2)) return "";
  const sliced = cleaned.length > Math.max(2, Number(maxLen) || 20)
    ? cleaned.slice(0, Math.max(2, Number(maxLen) || 20)).trim()
    : cleaned;
  if (!sliced) return "";
  if (SEARCH_TAG_NOISE.some((w) => sliced.includes(w))) return "";
  return sliced;
}

export function normalizeSearchTags(values = [], { max = 10 } = {}) {
  const src = Array.isArray(values)
    ? values
    : String(values || "")
        .split(/\n|,/)
        .map((x) => String(x || "").trim())
        .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const raw of src) {
    const token = normalizeSearchTagToken(raw);
    if (!token) continue;
    const key = token.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= Math.max(1, Math.min(20, Number(max) || 10))) break;
  }
  return out;
}

export function buildSearchTags({
  title = "",
  keyword = "",
  extraTags = [],
  max = 10,
} = {}) {
  const titleText = String(title || "").trim();
  const keywordText = String(keyword || "").trim();
  const extras = Array.isArray(extraTags)
    ? extraTags
    : String(extraTags || "")
        .split(/\n|,/)
        .map((x) => String(x || "").trim())
        .filter(Boolean);

  const titleWords = titleText
    .replace(/[^0-9A-Za-z가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
    .filter((x) => !SEARCH_TAG_NOISE.some((w) => x.includes(w)));

  const bigrams = [];
  for (let i = 0; i < Math.min(6, titleWords.length - 1); i += 1) {
    const one = `${titleWords[i]} ${titleWords[i + 1]}`.trim();
    if (one.length >= 2 && one.length <= 20) bigrams.push(one);
  }

  return normalizeSearchTags(
    [
      keywordText,
      ...extras,
      ...bigrams,
      ...titleWords.slice(0, 8),
    ],
    { max },
  );
}
