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

const NON_PRODUCT_INFO_PATTERNS = [
  /(^|\/)(notice|info|guide|policy|faq|qna|cs|service)(\/|[_\-.]|$)/i,
  /(^|\/)(delivery|shipping|ship|refund|return|exchange|as)([_\-.]?\d+)?\.(?:jpe?g|png|gif|webp)$/i,
  /(^|[_\-/])(up[_-]?)?(delivery|shipping|ship|refund|return|exchange|policy|privacy|notice|guide|cs|qna)([_\-/]|$)/i,
  /(^|[_\-/])(index[_-]?(?:gift|event|notice|info)|print[-_]?top|banner[-_]?top)([_\-./]|$)/i,
  /배송|교환|반품|환불|안내|공지|문의|고객센터|유의|주의/i,
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

const BLANK_IMAGE_PATTERNS = [
  /(^|[_\-/])(blank|spacer|pixel|transparent|empty|loading|noimg|no-image|placeholder)([_\-./]|$)/i,
  /1x1/i,
];

const SUPPLIER_PRODUCT_PATH_RE = /\/(?:image\/product|productimgs?)\//i;
const SUPPLIER_PRODUCT_FILE_RE = /\.[a-z0-9]{3,5}$/i;

function isSupplierProductAssetPath(path = "", target = "") {
  const normalizedPath = String(path || "").toLowerCase();
  if (!SUPPLIER_PRODUCT_PATH_RE.test(normalizedPath)) return false;

  const fileName = normalizedPath.split("/").pop() || "";
  if (!SUPPLIER_PRODUCT_FILE_RE.test(fileName)) return false;

  const loweredTarget = String(target || normalizedPath).toLowerCase();
  if (NON_PRODUCT_INFO_PATTERNS.some((re) => re.test(loweredTarget))) return false;
  if (SUSPICIOUS_ASSET_PATTERNS.some((re) => re.test(loweredTarget))) return false;

  return true;
}

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

function extractImageUrlsWithBase(html, baseUrl = "") {
  const out = [];
  const push = (raw) => {
    const srcRaw = String(raw || "").trim();
    if (!srcRaw) return;
    let src = srcRaw;
    if (src.startsWith("//")) src = `https:${src}`;
    if (!/^https?:\/\//i.test(src)) {
      try {
        src = new URL(src, baseUrl).toString();
      } catch {
        return;
      }
    }
    if (!/^https?:\/\//i.test(src)) return;
    if (!out.includes(src)) out.push(src);
  };
  const re = /<img[^>]+(?:src|data-src|data-original|data-lazy)=["']?([^"' >]+)["']?/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    push(m[1]);
  }
  return out;
}

function looksLikeProductFileName(fileName = "") {
  const name = String(fileName || "").toLowerCase();
  if (!name) return false;
  if (NON_PRODUCT_INFO_PATTERNS.some((re) => re.test(name))) return false;
  if (SUSPICIOUS_ASSET_PATTERNS.some((re) => re.test(name))) return false;
  if (BLANK_IMAGE_PATTERNS.some((re) => re.test(name))) return false;

  // product assets often contain long numeric ids/hash-like chunks
  if (/[a-z0-9]{8,}/i.test(name)) return true;
  if (/\d{5,}/.test(name)) return true;
  if (/[_-](?:d\d{2,}|img[_-]?\d+|detail[_-]?\d+)/i.test(name)) return true;
  return false;
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function isTransientPlaywrightPageClosedError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("target page, context or browser has been closed") ||
    message.includes("browser has been closed") ||
    message.includes("page has been closed") ||
    message.includes("execution context was destroyed")
  );
}

async function parsePreviewDraftWithRetry(sourceUrl, opts = {}) {
  const maxAttempts = Math.max(1, Math.min(2, Number(opts?.maxAttempts) || 2));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const draft = await parseProductFromDomaeqq(sourceUrl, {
        mode: "preview",
        previewSourceMode: opts.previewSourceMode,
        previewOpenApiTimeoutMs: opts.previewOpenApiTimeoutMs,
        previewSeedTitle: opts.previewSeedTitle,
        previewSeedPrice: opts.previewSeedPrice,
        previewSeedImageUrl: opts.previewSeedImageUrl,
        domeggookOpenApiKey: opts.domeggookOpenApiKey,
        domeggookPrivateApiKey: opts.domeggookPrivateApiKey,
      });
      if (attempt > 1) {
        draft.__debug = {
          ...(draft?.__debug && typeof draft.__debug === "object" ? draft.__debug : {}),
          previewRetry: {
            attempts: attempt,
            recovered: true,
            lastError: String(lastError?.message || lastError || ""),
          },
        };
      }
      return draft;
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts) break;
      if (!isTransientPlaywrightPageClosedError(e)) break;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  }
  throw lastError;
}

function sanitizeOpenApiDetailImages(urls = []) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const u = toUrl(raw);
    if (!u) continue;
    const href = String(u.toString() || "").trim();
    if (!href) continue;

    const key = normalizeUrlForMatch(href) || href;
    if (seen.has(key)) continue;

    const pathSignals = inspectImagePath(u);
    if (pathSignals.blocked) continue;

    const target = `${u.hostname || ""}${u.pathname || ""}${u.search || ""}`.toLowerCase();
    if (NON_PRODUCT_INFO_PATTERNS.some((re) => re.test(target))) continue;
    if (BLANK_IMAGE_PATTERNS.some((re) => re.test(target))) continue;

    const pathname = String(u.pathname || "").toLowerCase();
    const hasImageExt = /\.(?:jpe?g|png|gif|webp|bmp|svg)$/.test(pathname);
    const fileName = pathname.split("/").pop() || "";
    const trustedDomain =
      pathSignals.domain === "esmplus.com" ||
      pathSignals.domain === "alicdn.com" ||
      pathSignals.domain === "ownerclan.com" ||
      pathSignals.domain === "domeggook.com";
    const keep =
      pathSignals.allowed ||
      pathSignals.allowBySupplierProduct ||
      hasImageExt ||
      trustedDomain;
    if (!keep) continue;

    seen.add(key);
    out.push(href);
  }
  return out;
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
  const allowBySupplierProduct = isSupplierProductAssetPath(path, target) && !isThumb;
  const blockedByPath = DETAIL_PATH_BLOCK_PATTERNS.some((re) => re.test(path));
  const blockedByInfoAsset = NON_PRODUCT_INFO_PATTERNS.some((re) => re.test(target));
  const suspiciousByName = SUSPICIOUS_ASSET_PATTERNS.some((re) => re.test(target));

  const blocked =
    isThumb ||
    blockedByPath ||
    blockedByInfoAsset ||
    (
      suspiciousByName &&
      !allowedByPath &&
      !allowByEsmplus &&
      !allowByAlicdn &&
      !allowByOwnerclanCopy
    );
  const suspicious = suspiciousByName || blockedByPath || blockedByInfoAsset || isThumb;

  return {
    allowed:
      allowedByPath || allowByEsmplus || allowByAlicdn || allowByOwnerclanCopy || allowBySupplierProduct,
    blocked,
    suspicious,
    path,
    isThumb,
    domain,
    allowBySupplierProduct,
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
  const hostImageCountMap = new Map();
  for (const rawUrl of rawImages) {
    const parsed = toUrl(rawUrl);
    if (!parsed) continue;
    const h = normalizeHost(parsed.hostname);
    if (!h) continue;
    hostImageCountMap.set(h, (hostImageCountMap.get(h) || 0) + 1);
  }

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
        (pathSignals.domain === "ownerclan.com" &&
          (pathname.includes("/copy/") || pathname.includes("/detail/")));
      const isSupplierProductDetail = Boolean(pathSignals.allowBySupplierProduct);
      const fileName = pathname.split("/").pop() || "";
      const hasImageExt = /\.(?:jpe?g|png|gif|webp|bmp)$/i.test(fileName);
      const hostImageCount = Number(hostImageCountMap.get(host) || 0);
      const isExternalDetailSeries =
        hostImageCount >= 3 &&
        hasImageExt &&
        !pathSignals.blocked &&
        !pathSignals.isThumb;
      const looksProductUploadPath =
        pathname.includes("/upload/item/") ||
        pathname.includes("/upload/editor/") ||
        pathname.includes("/upload/contents/") ||
        pathname.includes("/editor/") ||
        pathname.includes("/contents/") ||
        pathname.includes("/attach/") ||
        pathname.includes("/attachment/") ||
        isTrustedCdnDetail ||
        isSupplierProductDetail ||
        isExternalDetailSeries;
      const looksUiAsset =
        pathname.includes("/image/common/") ||
        pathname.includes("/image/item/") ||
        pathname.includes("/image/event/") ||
        pathSignals.isThumb;
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
      (pathSignals.domain === "ownerclan.com" &&
        (pathname.includes("/copy/") || pathname.includes("/detail/")));
    const isSupplierProductDetail = Boolean(pathSignals.allowBySupplierProduct);
    const hostImageCount = Number(hostImageCountMap.get(host) || 0);
    const fileName = pathname.split("/").pop() || "";
    const hasImageExt = /\.(?:jpe?g|png|gif|webp|bmp)$/i.test(fileName);
    const isExternalDetailSeries =
      mainDomain === "domeggook.com" &&
      hostImageCount >= 3 &&
      hasImageExt &&
      !pathSignals.blocked &&
      !pathSignals.isThumb;
    const score =
      (exactHost ? 2 : 0) +
      (sameDomain ? 1 : 0) +
      (pathSignals.allowed ? 2 : 0) +
      (isTrustedCdnDetail ? 2 : 0) +
      (isExternalDetailSeries ? 2 : 0) +
      (isSupplierProductDetail ? 1 : 0) +
      (overlap >= 2 ? 2 : overlap >= 1 ? 1 : 0) +
      (mainOverlap >= 2 ? 2 : mainOverlap >= 1 ? 1 : 0) +
      (tokens.length === 0 ? -1 : 0) +
      (pathSignals.suspicious && !pathSignals.allowed ? -2 : 0);

    const isTrustedExternalDetail =
      isTrustedCdnDetail || isSupplierProductDetail || isExternalDetailSeries;
    const keepStrict = pathSignals.allowed
      ? score >= 3 && (sameDomain || overlap >= 1 || mainOverlap >= 1 || isTrustedCdnDetail || isSupplierProductDetail)
      : (isTrustedExternalDetail
          ? score >= 2
          : score >= 5 && (exactHost || overlap >= 2 || mainOverlap >= 2));
    const keepLoose = pathSignals.allowed
      ? score >= 2
      : (isTrustedExternalDetail ? score >= 1 : score >= 3);
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
      if (!pathSignals.allowed && !isTrustedExternalDetail) reasonBits.push("path_allow_missing");
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

  const previewSourceModeRaw = String(settings.previewSourceMode || "auto").trim().toLowerCase();
  const previewSourceMode =
    previewSourceModeRaw === "openapi" || previewSourceModeRaw === "playwright"
      ? previewSourceModeRaw
      : "auto";
  const strictMode = String(settings.strictImageMatch || "1").trim() !== "0";
  const maxContentImages = Math.max(
    10,
    Math.min(120, Number(settings.maxContentImages) || 60),
  );
  const draft = await parsePreviewDraftWithRetry(c.url, {
    previewSourceMode,
    previewOpenApiTimeoutMs: settings.previewOpenApiTimeoutMs,
    previewSeedTitle: settings.seedTitle,
    previewSeedPrice: settings.seedPrice,
    previewSeedImageUrl: settings.seedImageUrl,
    domeggookOpenApiKey: settings.domeggookOpenApiKey,
    domeggookPrivateApiKey: settings.domeggookPrivateApiKey,
    maxAttempts: 2,
  });
  const debugOpenApiImages = Array.isArray(draft?.__debug?.openApi?.detailImages)
    ? draft.__debug.openApi.detailImages
        .map((u) => String(u || "").trim())
        .filter(Boolean)
    : [];
  let rawContentImages = unique([
    ...extractImageUrls(draft.contentText),
    ...extractImageUrlsWithBase(draft.contentText, draft.sourceUrl),
    ...debugOpenApiImages,
  ]);
  rawContentImages = rawContentImages.slice(0, maxContentImages);
  rawContentImages = await expandOwnerclanCopyImages(rawContentImages);
  rawContentImages = rawContentImages.slice(0, maxContentImages);
  const detailSource = String(draft?.__debug?.detailSource || "").trim().toLowerCase();
  const isOpenApiDetailSource = detailSource.startsWith("openapi_");
  const openApiIncludeAllImages = parseBoolean(
    settings.previewOpenApiIncludeAllImages ?? settings.recommendationPreviewOpenApiIncludeAllImages,
    true,
  );

  const analyzed = analyzeSameProductImages({
    sourceUrl: draft.sourceUrl,
    mainImageUrl: draft.imageUrl,
    contentImageUrls: rawContentImages,
    strict: strictMode,
  });
  let filteredImages = analyzed.filteredImageUrls.slice(0, maxContentImages);
  let rejectedImages = analyzed.rejectedImages;
  let metrics = analyzed.metrics || {};
  let openApiImagePassthrough = false;

  if (isOpenApiDetailSource && openApiIncludeAllImages && rawContentImages.length > 0) {
    // OpenAPI passthrough mode: keep broad coverage, but remove obviously bad assets
    // to reduce broken placeholders in recommendation cards.
    openApiImagePassthrough = true;
    const sanitizedOpenApiImages = sanitizeOpenApiDetailImages(rawContentImages);
    const mergedPreferred = unique([
      ...analyzed.filteredImageUrls,
      ...sanitizedOpenApiImages,
    ]);
    filteredImages = (mergedPreferred.length > 0
      ? mergedPreferred
      : unique(rawContentImages)
    ).slice(0, maxContentImages);
    rejectedImages = [];
    metrics = {
      ...(metrics || {}),
      imageCountRaw: rawContentImages.length,
      imageCountFiltered: filteredImages.length,
      imageCountRejected: Math.max(0, rawContentImages.length - filteredImages.length),
      rejectedRate:
        rawContentImages.length > 0
          ? Number(
              (
                Math.max(0, rawContentImages.length - filteredImages.length) /
                rawContentImages.length
              ).toFixed(4),
            )
          : 0,
    };
  }

  const imageFingerprint = buildImageFingerprint({
    sourceUrl: draft.sourceUrl,
    title: draft.title,
    mainImageUrl: draft.imageUrl,
    filteredImageUrls: filteredImages,
  });
  const minimumOrderQtyRaw =
    draft?.purchaseConstraints && typeof draft.purchaseConstraints === 'object'
      ? draft.purchaseConstraints.minimumOrderQty
      : null;
  const minimumOrderQty =
    Number.isFinite(Number(minimumOrderQtyRaw)) && Number(minimumOrderQtyRaw) > 0
      ? Number(minimumOrderQtyRaw)
      : 1;

  return {
    ok: true,
    skipped: false,
    url: c.url,
    draft,
    preview: {
      sourceUrl: draft.sourceUrl,
      title: draft.title,
      minimumOrderQty,
      purchaseConstraints: {
        minimumOrderQty,
      },
      mainImageUrl: draft.imageUrl,
      contentImagesRaw: rawContentImages,
      contentImagesFiltered: filteredImages,
      contentImagesRejected: rejectedImages,
      openApiImagePassthrough,
      openApiDetailSource: openApiImagePassthrough ? detailSource : "",
      imageFingerprint,
      ...(metrics || {}),
      imageCountFiltered: filteredImages.length,
    },
  };
}
