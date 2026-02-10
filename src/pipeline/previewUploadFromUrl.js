import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { extractImageUrls } from "../utils/contentImages.js";
import { computePrice } from "../utils/price.js";
import { recommendCategory } from "../coupang/api/recommendCategory.js";
import { suggestTitlesFromNaver, cleanTitle } from "../utils/titleSuggest.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";

const DISPLAY_CATEGORY_CODE = 77723;

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function isLikelyProductImage(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const p = u.pathname || "";

    // Block obvious UI/icon/banner assets
    const bad = [
      "img_lensSearch",
      "kakaolink",
      "/sns/",
      "/upload/event/",
      "/upload/banner/",
      // NOTE: don't block generic /image/ paths (e.g. image.coupangcdn.com)

      "_stt_",
      "ico_",
      "bnr_",
      "arrow",
      "close",
      "warning",
      "caution",
      "pstatic.net/share",
    ];
    const lower = (p + " " + u.href).toLowerCase();
    if (bad.some((k) => lower.includes(String(k).toLowerCase()))) return false;

    // Accept domeggook product upload assets
    const isDomeggook = host === "cdn1.domeggook.com" || host.endsWith(".domeggook.com");
    const isUploadPath = p.includes("/upload/");
    const isProductUpload = p.includes("/upload/item/") || p.includes("/upload/editor/") || p.includes("/upload/contents/");
    if (isDomeggook && isUploadPath && isProductUpload) return true;

    // Some sellers host detail images on external CDNs (e.g. esmplus). Allow a small allowlist.
    const allowedExternalHosts = [
      "gi.esmplus.com",
      "story-img.kakaocdn.net",
      // Domeggook detail pages sometimes embed Coupang CDN images in the description.
      "image.coupangcdn.com",
    ];
    const ext = (p.split("?")[0].split("#")[0].match(/\.(jpg|jpeg|png|webp|gif)$/i) || [])[0];

    // Filter common non-product banners/notices hosted on external CDNs
    const externalBad = [
      "공지",
      "필독",
      "인포",
      "information",
      "당일출고",
      "배송",
      "주의",
      "warning",
      "caution",
      "bnr",
      "banner",
    ];
    const hrefLower = u.href.toLowerCase();
    const decoded = (() => {
      try { return decodeURIComponent(u.href); } catch { return u.href; }
    })().toLowerCase();
    if (externalBad.some((k) => hrefLower.includes(String(k).toLowerCase()) || decoded.includes(String(k).toLowerCase()))) {
      return false;
    }

    if (ext && allowedExternalHosts.includes(host)) return true;

    return false;
  } catch {
    return false;
  }
}

export async function previewUploadFromUrl(inputUrl, settings = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, reason: c.reason, url: c.url };
  }

  const draft = await parseProductFromDomaeqq(c.url);

  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 30;
  const contentImages = extractImageUrls(draft.contentText)
    .filter(isLikelyProductImage)
    .slice(0, Math.max(0, maxContentImages))
    .filter(Boolean);

  let finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

  const shippingFee = Number(draft.shippingFee);
  const shippingPolicy = String(settings.shippingPolicy || "actual").trim();
  const shippingFixed = Number.isFinite(Number(settings.shippingFixedAmount))
    ? Number(settings.shippingFixedAmount)
    : 2500;

  let shippingSurcharge = 0;
  if (shippingPolicy === "none") shippingSurcharge = 0;
  else if (shippingPolicy === "fixed") shippingSurcharge = shippingFee > 0 || shippingFee === -1 ? shippingFixed : 0;
  else if (shippingPolicy === "actual") shippingSurcharge = shippingFee > 0 ? shippingFee : 0;
  else if (shippingPolicy === "error_unknown") shippingSurcharge = shippingFee > 0 ? shippingFee : 0;

  const shouldAddShipping = shippingSurcharge > 0;
  if (shouldAddShipping) {
    finalPrice += shippingSurcharge;
    const roundUnit = Number.isFinite(Number(settings.roundUnit)) ? Number(settings.roundUnit) : 10;
    if (roundUnit > 1) finalPrice = Math.floor(finalPrice / roundUnit) * roundUnit;
    const min = Number.isFinite(Number(settings.priceMin)) ? Number(settings.priceMin) : 1000;
    if (Number.isFinite(min)) finalPrice = Math.max(min, finalPrice);
  }

  const mainImageUrl = draft.imageUrl || "";
  const images = uniq([mainImageUrl, ...contentImages]);

  const overrideCategoryCode = Number(settings.categoryOverrideCode);
  const resolvedCategoryCode = resolveDisplayCategoryCode({
    title: draft.title,
    categoryText: draft.categoryText,
    fallback: DISPLAY_CATEGORY_CODE,
  });
  // Prefer predicted category when available (unless overridden).
  let usedCategoryCode = Number.isFinite(overrideCategoryCode) && overrideCategoryCode > 0
    ? overrideCategoryCode
    : resolvedCategoryCode;
  const options = Array.isArray(draft.options) ? draft.options : [];

  // Title suggestions (best-effort)
  let titleSuggestions = null;
  try {
    titleSuggestions = await suggestTitlesFromNaver({ title: draft.title, maxLen: 15 });
  } catch {
    titleSuggestions = null;
  }

  // Category prediction (best-effort, requires Coupang keys)
  let predictedCategory = null;
  try {
    const accessKey = String(settings.coupangAccessKey || "").trim();
    const secretKey = String(settings.coupangSecretKey || "").trim();
    const usePredict = String(settings.autoCategoryPredict ?? "1").trim() !== "0";
    if (usePredict && accessKey && secretKey) {
      const productName = cleanTitle(String(draft.title || "").split("|")[0]).slice(0, 80);
      const pred = await recommendCategory({
        productName,
        // Avoid noisy page text that can mislead categorization.
        productDescription: "",
        productImageUrl: mainImageUrl,
        accessKey,
        secretKey,
      });
      if (pred.status === 200) {
        const bodyObj = typeof pred.body === "string" ? JSON.parse(pred.body) : pred.body;
        predictedCategory = {
          id: bodyObj?.data?.predictedCategoryId ?? null,
          name: bodyObj?.data?.predictedCategoryName ?? null,
        };
      }
    }
  } catch {}

  // After prediction, prefer predicted category when available (unless overridden).
  if (!(Number.isFinite(overrideCategoryCode) && overrideCategoryCode > 0)) {
    const pid = predictedCategory?.id;
    const n = Number(pid);
    if (pid && Number.isFinite(n) && n > 0) usedCategoryCode = n;
  }

  return {
    ok: true,
    url: c.url,
    draft: {
      title: draft.title || "",
      categoryText: draft.categoryText || "",
      price: draft.price ?? null,
      shippingFee: Number.isFinite(Number(draft.shippingFee)) ? Number(draft.shippingFee) : null,
      imageUrl: mainImageUrl,
      sourceUrl: draft.sourceUrl || c.url,
    },
    computed: {
      finalPrice,
      shippingPolicy,
      shippingFixedAmount: shippingFixed,
      shippingSurchargeApplied: Boolean(shouldAddShipping),
      shippingSurcharge,
      shippingFeeUnknown: shippingFee === -1,
      images,
      contentImageCount: contentImages.length,
      optionsCount: options.length,
    },
    category: {
      overrideCode: settings.categoryOverrideCode ?? null,
      resolvedCode: resolvedCategoryCode,
      usedCode: usedCategoryCode,
      predicted: predictedCategory,
    },
    options,
    titleSuggestions,
    debug: draft.__debug || null,
  };
}
