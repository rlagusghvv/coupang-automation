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

const DETAIL_PATH_ALLOW_PATTERNS = [
  /\/upload\/item\//i,
  /\/upload\/editor\//i,
  /\/editor\//i,
  /\/contents?\//i,
  /\/attach(?:ment)?\//i,
];

const DETAIL_PATH_BLOCK_PATTERNS = [
  /\/image\/common\//i,
  /\/image\/item\//i,
  /\/image\/event\//i,
  /\/(?:sns|social)\//i,
  /\/icons?\//i,
  /\/banners?\//i,
  /\/logos?\//i,
  /\/(?:button|btn)\//i,
  /\/share\//i,
];

const SUSPICIOUS_ASSET_PATTERNS = [
  /(^|[_\-/])logo([_\-./]|$)/i,
  /(^|[_\-/])icon([_\-./]|$)/i,
  /(^|[_\-/])banner([_\-./]|$)/i,
  /(^|[_\-/])sns([_\-./]|$)/i,
  /facebook|twitter|kakao|naver|share/i,
  /(^|[_\-/])btn([_\-./]|$)/i,
  /sprite/i,
];

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

function normalizePath(urlObj) {
  if (!urlObj) return "";
  try {
    return decodeURIComponent(String(urlObj.pathname || "")).toLowerCase();
  } catch {
    return String(urlObj.pathname || "").toLowerCase();
  }
}

function inspectImagePath(urlObj) {
  const path = normalizePath(urlObj);
  const query = String(urlObj?.search || "").toLowerCase();
  const target = path + query;
  const host = normalizeHost(urlObj?.hostname || "");
  const domain = getDomain(host);

  const isThumb =
    /(?:^|[\/_-])stt_\d+\./i.test(target) ||
    /(?:^|[\/_-])thumb(?:nail)?([\/_\-.]|$)/i.test(target);
  const allowedByPath = DETAIL_PATH_ALLOW_PATTERNS.some((re) => re.test(path));
  const allowByEsmplus = domain === "esmplus.com" && !isThumb;
  const allowByAlicdn = domain === "alicdn.com" && !isThumb;
  const allowByOwnerclanCopy = domain === "ownerclan.com" && /\/copy\//i.test(path) && !isThumb;
  const blockedByPath = DETAIL_PATH_BLOCK_PATTERNS.some((re) => re.test(path));
  const suspiciousByName = SUSPICIOUS_ASSET_PATTERNS.some((re) => re.test(target));

  const blocked =
    isThumb ||
    blockedByPath ||
    (
      suspiciousByName &&
      !allowedByPath &&
      !allowByEsmplus &&
      !allowByAlicdn &&
      !allowByOwnerclanCopy
    );
  const suspicious = suspiciousByName || blockedByPath || isThumb;

  return {
    allowed: allowedByPath || allowByEsmplus || allowByAlicdn || allowByOwnerclanCopy,
    blocked,
    suspicious,
    path,
    isThumb,
    domain,
  };
}

function parseOwnerclanCopySequence(rawUrl) {
  const u = toUrl(rawUrl);
  if (!u) return null;
  const domain = getDomain(u.hostname);
  if (domain !== "ownerclan.com") return null;
  const pathname = normalizePath(u);
  const m = pathname.match(/^(.*)\((\d{1,3})\)(\.[a-z0-9]+)$/i);
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isFinite(index) || index <= 0) return null;
  return {
    origin: u.origin,
    prefix: m[1],
    suffix: m[3],
    index,
    search: String(u.search || ""),
  };
}

async function probeImageHead(url, timeoutMs = 1400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(600, Number(timeoutMs) || 1400));
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://domeggook.com/",
      },
    });
    if (!res.ok) return false;
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    return contentType.includes("image") || !contentType;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function expandOwnerclanCopyImages(urls = []) {
  const raw = unique(urls || []);
  if (raw.length === 0 || raw.length > 2) return raw;

  const seeds = raw
    .map((u) => parseOwnerclanCopySequence(u))
    .filter(Boolean);
  if (seeds.length === 0) return raw;

  const out = new Set(raw);
  let probeBudget = 6;
  for (const seed of seeds) {
    const around = [];
    for (let d = 1; d <= 3; d += 1) {
      around.push(seed.index - d, seed.index + d);
    }
    for (const n of around) {
      if (probeBudget <= 0) break;
      if (!Number.isFinite(n) || n <= 0) continue;
      const candidate = `${seed.origin}${seed.prefix}(${n})${seed.suffix}${seed.search}`;
      if (out.has(candidate)) continue;
      probeBudget -= 1;
      const ok = await probeImageHead(candidate);
      if (ok) out.add(candidate);
    }
    if (probeBudget <= 0) break;
  }
  return unique(Array.from(out));
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
        exactHostMatchRate: 0,
        sameDomainRate: 0,
        pathAllowRateRaw: 0,
        pathBlockedRateRaw: 0,
        suspiciousPathRateRaw: 0,
        pathAllowCountRaw: 0,
        pathAllowCountFiltered: 0,
        pathBlockedCountRaw: 0,
        suspiciousPathCountRaw: 0,
        suspiciousPathCountFiltered: 0,
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
  let exactHostMatchedCount = 0;
  let sameDomainCount = 0;
  let pathAllowCountRaw = 0;
  let pathBlockedCountRaw = 0;
  let suspiciousPathCountRaw = 0;
  let pathAllowCountFiltered = 0;
  let suspiciousPathCountFiltered = 0;
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

    const pathSignals = inspectImagePath(u);
    if (pathSignals.allowed) pathAllowCountRaw += 1;
    if (pathSignals.blocked) pathBlockedCountRaw += 1;
    if (pathSignals.suspicious) suspiciousPathCountRaw += 1;

    // Domeggook 페이지는 추천/썸네일 자산 혼입이 많아 경로를 강하게 제한한다.
    if (mainDomain === "domeggook.com") {
      const isTrustedCdnDetail =
        pathSignals.domain === "esmplus.com" ||
        pathSignals.domain === "alicdn.com" ||
        (pathSignals.domain === "ownerclan.com" && pathname.includes("/copy/"));
      const looksProductUploadPath =
        pathname.includes("/upload/item/") ||
        pathname.includes("/upload/editor/") ||
        pathname.includes("/upload/contents/") ||
        pathname.includes("/editor/") ||
        pathname.includes("/contents/") ||
        pathname.includes("/attach/") ||
        pathname.includes("/attachment/") ||
        isTrustedCdnDetail;
      const looksUiAsset =
        pathname.includes("/image/common/") ||
        pathname.includes("/image/item/") ||
        pathname.includes("/image/event/") ||
        pathSignals.isThumb;
      const fileName = pathname.split("/").pop() || "";
      const isThumbLike =
        pathSignals.isThumb ||
        /_stt_\d+\.(png|jpe?g|webp)$/i.test(fileName) ||
        fileName.includes("_stt_");
      if (!looksProductUploadPath || looksUiAsset || isThumbLike) {
        rejected.push({
          url,
          reason: isThumbLike ? "thumbnail_asset" : "non_product_asset",
          host,
          path: pathname,
        });
        continue;
      }
    }

    if (pathSignals.blocked) {
      rejected.push({
        url,
        reason: "path_blocked",
        host,
        path: pathSignals.path,
      });
      continue;
    }

    const tokens = tokenizeUrl(url);
    const overlap = countOverlap(tokens, referenceTokens);
    const mainOverlap = countOverlap(tokens, mainTokenSet);

    if (overlap > 0) tokenMatchedCount += 1;

    const exactHost = host && host === mainHost;
    if (exactHost) exactHostMatchedCount += 1;

    const sameDomain = domain && mainDomain && domain === mainDomain;
    if (sameDomain) sameDomainCount += 1;

    const isTrustedCdnDetail =
      pathSignals.domain === "esmplus.com" ||
      pathSignals.domain === "alicdn.com" ||
      (pathSignals.domain === "ownerclan.com" && pathname.includes("/copy/"));
    const score =
      (exactHost ? 2 : 0) +
      (sameDomain ? 1 : 0) +
      (pathSignals.allowed ? 2 : 0) +
      (isTrustedCdnDetail ? 2 : 0) +
      (overlap >= 2 ? 2 : overlap >= 1 ? 1 : 0) +
      (mainOverlap >= 2 ? 2 : mainOverlap >= 1 ? 1 : 0) +
      (tokens.length === 0 ? -1 : 0) +
      (pathSignals.suspicious && !pathSignals.allowed ? -2 : 0);

    const keepStrict = pathSignals.allowed
      ? score >= 3 && (sameDomain || overlap >= 1 || mainOverlap >= 1 || isTrustedCdnDetail)
      : score >= 5 && (exactHost || overlap >= 2 || mainOverlap >= 2);
    const keepLoose = pathSignals.allowed ? score >= 2 : score >= 3;
    const keep = strict ? keepStrict : keepLoose;

    if (keep) {
      kept.push(url);
      filteredHosts.add(host);
      if (pathSignals.allowed) pathAllowCountFiltered += 1;
      if (pathSignals.suspicious) suspiciousPathCountFiltered += 1;
    } else {
      const reasonBits = [];
      if (!sameDomain) reasonBits.push("domain_mismatch");
      if (overlap < 1) reasonBits.push("token_overlap_low");
      if (!pathSignals.allowed) reasonBits.push("path_allow_missing");
      rejected.push({
        url,
        reason: reasonBits.length > 0 ? reasonBits.join("+") : "unmatched",
        host,
        overlap,
        mainOverlap,
        score,
        path: pathSignals.path,
      });
    }
  }

  const imageCountRaw = rawImages.length;
  const imageCountFiltered = kept.length;
  const imageCountRejected = rejected.length;
  const tokenMatchRate = imageCountRaw > 0 ? tokenMatchedCount / imageCountRaw : 0;
  const rejectedRate = imageCountRaw > 0 ? imageCountRejected / imageCountRaw : 0;
  const exactHostMatchRate = imageCountRaw > 0 ? exactHostMatchedCount / imageCountRaw : 0;
  const sameDomainRate = imageCountRaw > 0 ? sameDomainCount / imageCountRaw : 0;
  const pathAllowRateRaw = imageCountRaw > 0 ? pathAllowCountRaw / imageCountRaw : 0;
  const pathBlockedRateRaw = imageCountRaw > 0 ? pathBlockedCountRaw / imageCountRaw : 0;
  const suspiciousPathRateRaw = imageCountRaw > 0 ? suspiciousPathCountRaw / imageCountRaw : 0;

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
      exactHostMatchRate: Number(exactHostMatchRate.toFixed(4)),
      sameDomainRate: Number(sameDomainRate.toFixed(4)),
      pathAllowRateRaw: Number(pathAllowRateRaw.toFixed(4)),
      pathBlockedRateRaw: Number(pathBlockedRateRaw.toFixed(4)),
      suspiciousPathRateRaw: Number(suspiciousPathRateRaw.toFixed(4)),
      pathAllowCountRaw,
      pathAllowCountFiltered,
      pathBlockedCountRaw,
      suspiciousPathCountRaw,
      suspiciousPathCountFiltered,
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
  const maxContentImages = Math.max(
    10,
    Math.min(120, Number(settings.maxContentImages) || 60),
  );
  const draft = await parseProductFromDomaeqq(c.url);
  let rawContentImages = unique(extractImageUrls(draft.contentText));
  rawContentImages = rawContentImages.slice(0, maxContentImages);
  rawContentImages = await expandOwnerclanCopyImages(rawContentImages);
  rawContentImages = rawContentImages.slice(0, maxContentImages);
  const filtered = analyzeSameProductImages({
    sourceUrl: draft.sourceUrl,
    mainImageUrl: draft.imageUrl,
    contentImageUrls: rawContentImages,
    strict: strictMode,
  });
  const filteredImages = filtered.filteredImageUrls.slice(0, maxContentImages);

  const imageFingerprint = buildImageFingerprint({
    sourceUrl: draft.sourceUrl,
    title: draft.title,
    mainImageUrl: draft.imageUrl,
    filteredImageUrls: filteredImages,
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
      contentImagesFiltered: filteredImages,
      contentImagesRejected: filtered.rejectedImages,
      imageFingerprint,
      ...(filtered.metrics || {}),
      imageCountFiltered: filteredImages.length,
    },
  };
}
