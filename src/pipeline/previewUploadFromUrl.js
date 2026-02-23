import crypto from "node:crypto";
import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { extractImageUrls } from "../utils/contentImages.js";

const TRACKING_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "from",
  "advcnt",
  "traceid",
  "rank",
  "searchid",
  "sourceType",
]);

const GENERIC_TOKENS = new Set([
  "http",
  "https",
  "www",
  "img",
  "image",
  "images",
  "detail",
  "goods",
  "item",
  "product",
  "thumb",
  "thumbnail",
  "upload",
  "cdn",
  "com",
  "net",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "php",
  "html",
  "asp",
  "do",
  "kr",
]);

function toUrl(raw) {
  try {
    if (!raw) return null;
    return new URL(String(raw).trim());
  } catch {
    return null;
  }
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function getDomain(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

function normalizeUrlForMatch(raw) {
  const u = toUrl(raw);
  if (!u) return "";
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_QUERY_KEYS.has(key)) {
      u.searchParams.delete(key);
    }
  }
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of sorted) {
    u.searchParams.append(k, v);
  }
  return u.toString();
}

function tokenize(raw) {
  return String(raw || "")
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

function tokenizeUrl(rawUrl) {
  const u = toUrl(rawUrl);
  if (!u) return [];
  const base = [u.hostname, u.pathname, u.search]
    .filter(Boolean)
    .join("|");
  return tokenize(base);
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function countOverlap(tokens, referenceSet) {
  let n = 0;
  for (const t of tokens) {
    if (referenceSet.has(t)) n += 1;
  }
  return n;
}

export function buildImageFingerprint({
  sourceUrl,
  title,
  mainImageUrl,
  filteredImageUrls,
} = {}) {
  const normalizedSource = normalizeUrlForMatch(sourceUrl);
  const normalizedMain = normalizeUrlForMatch(mainImageUrl);
  const normalizedDetail = unique(filteredImageUrls || [])
    .map((u) => normalizeUrlForMatch(u))
    .filter(Boolean)
    .slice(0, 12);
  const titleNorm = tokenize(title || "").join("|");
  const payload = [normalizedSource, titleNorm, normalizedMain, ...normalizedDetail].join("||");
  return crypto.createHash("sha1").update(payload).digest("hex");
}

export function analyzeSameProductImages({
  sourceUrl,
  mainImageUrl,
  contentImageUrls,
  strict = true,
} = {}) {
  const main = toUrl(mainImageUrl);
  const rawImages = unique(contentImageUrls || []);

  if (!main) {
    return {
      filteredImageUrls: [],
      rejectedImages: rawImages.map((url) => ({ url, reason: "invalid_main_image" })),
      metrics: {
        imageCountRaw: rawImages.length,
        imageCountFiltered: 0,
        imageCountRejected: rawImages.length,
        hostDiversityRaw: 0,
        hostDiversityFiltered: 0,
        tokenMatchRate: 0,
        rejectedRate: rawImages.length > 0 ? 1 : 0,
        strictMode: Boolean(strict),
        mainImageHost: "",
        mainImageTokenCount: 0,
      },
    };
  }

  const mainHost = normalizeHost(main.hostname);
  const mainDomain = getDomain(mainHost);
  const mainTokens = tokenizeUrl(mainImageUrl);
  const sourceTokens = tokenizeUrl(sourceUrl);
  const referenceTokens = new Set([...mainTokens, ...sourceTokens]);
  const mainTokenSet = new Set(mainTokens);

  const kept = [];
  const rejected = [];

  let tokenMatchedCount = 0;
  const rawHosts = new Set();
  const filteredHosts = new Set();

  for (const url of rawImages) {
    const u = toUrl(url);
    if (!u) {
      rejected.push({ url, reason: "invalid_image_url" });
      continue;
    }

    const host = normalizeHost(u.hostname);
    const domain = getDomain(host);
    const pathname = String(u.pathname || '').toLowerCase();
    rawHosts.add(host);

    // Domeggook page chrome/icons/sns 자산 제거: 실제 상품 업로드 이미지 경로만 허용
    if (mainDomain === 'domeggook.com') {
      const looksProductUploadPath =
        pathname.includes('/upload/item/') ||
        pathname.includes('/upload/editor/') ||
        pathname.includes('/upload/contents/');
      const looksUiAsset =
        pathname.includes('/image/common/') ||
        pathname.includes('/image/item/') ||
        pathname.includes('/image/event/');
      if (!looksProductUploadPath || looksUiAsset) {
        rejected.push({ url, reason: 'non_product_asset', host });
        continue;
      }
    }

    const tokens = tokenizeUrl(url);
    const overlap = countOverlap(tokens, referenceTokens);
    const mainOverlap = countOverlap(tokens, mainTokenSet);

    if (overlap > 0) tokenMatchedCount += 1;

    const sameDomain = domain && mainDomain && domain === mainDomain;
    const keepStrict = (sameDomain && overlap >= 1) || mainOverlap >= 2;
    const keepLoose = sameDomain || overlap >= 2 || mainOverlap >= 1;
    const keep = strict ? keepStrict : keepLoose;

    if (keep) {
      kept.push(url);
      filteredHosts.add(host);
    } else {
      const reasonBits = [];
      if (!sameDomain) reasonBits.push("domain_mismatch");
      if (overlap < 1) reasonBits.push("token_overlap_low");
      rejected.push({
        url,
        reason: reasonBits.length > 0 ? reasonBits.join("+") : "unmatched",
        host,
        overlap,
        mainOverlap,
      });
    }
  }

  const imageCountRaw = rawImages.length;
  const imageCountFiltered = kept.length;
  const imageCountRejected = rejected.length;
  const tokenMatchRate = imageCountRaw > 0 ? tokenMatchedCount / imageCountRaw : 0;
  const rejectedRate = imageCountRaw > 0 ? imageCountRejected / imageCountRaw : 0;

  return {
    filteredImageUrls: kept,
    rejectedImages: rejected,
    metrics: {
      imageCountRaw,
      imageCountFiltered,
      imageCountRejected,
      hostDiversityRaw: rawHosts.size,
      hostDiversityFiltered: filteredHosts.size,
      tokenMatchRate: Number(tokenMatchRate.toFixed(4)),
      rejectedRate: Number(rejectedRate.toFixed(4)),
      strictMode: Boolean(strict),
      mainImageHost: mainHost,
      mainImageTokenCount: mainTokens.length,
    },
  };
}

export async function previewUploadFromUrl(inputUrl, settings = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, skipped: true, reason: c.reason, url: c.url };
  }

  const strictMode = String(settings.strictImageMatch || "1").trim() !== "0";
  const draft = await parseProductFromDomaeqq(c.url);
  const rawContentImages = unique(extractImageUrls(draft.contentText));
  const filtered = analyzeSameProductImages({
    sourceUrl: draft.sourceUrl,
    mainImageUrl: draft.imageUrl,
    contentImageUrls: rawContentImages,
    strict: strictMode,
  });

  const imageFingerprint = buildImageFingerprint({
    sourceUrl: draft.sourceUrl,
    title: draft.title,
    mainImageUrl: draft.imageUrl,
    filteredImageUrls: filtered.filteredImageUrls,
  });

  return {
    ok: true,
    skipped: false,
    url: c.url,
    draft,
    preview: {
      sourceUrl: draft.sourceUrl,
      title: draft.title,
      mainImageUrl: draft.imageUrl,
      contentImagesRaw: rawContentImages,
      contentImagesFiltered: filtered.filteredImageUrls,
      contentImagesRejected: filtered.rejectedImages,
      imageFingerprint,
      ...filtered.metrics,
    },
  };
}
