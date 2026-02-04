import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { extractImageUrls } from "../utils/contentImages.js";
import { computePrice } from "../utils/price.js";

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function isLikelyProductImage(url) {
  try {
    const u = new URL(url);

    // Prefer source CDNs / upload paths. Exclude UI/icon assets and social share icons.
    const host = u.hostname;
    const p = u.pathname;

    // Allow: domeggook upload assets (product images / description images)
    const isDomeggookCdn = host === "cdn1.domeggook.com" || host.endsWith(".domeggook.com");
    const isUploadPath = p.includes("/upload/");

    // Prefer product-related upload paths
    const isProductUpload = p.includes("/upload/item/") || p.includes("/upload/editor/") || p.includes("/upload/contents/");
    const isStampOrBadge = p.includes("_stt_") || p.includes("_bnr_") || p.includes("_ico_");
    const isMainOrDetail = p.includes("_img_") || p.includes("/upload/editor/") || p.includes("/upload/contents/");

    // Block: common UI/image assets (often hotlink-protected or irrelevant)
    const isUiAsset = p.includes("/image/") || p.includes("/images/");
    const isShareIcon = p.includes("/sns/") || p.includes("kakaolink") || p.includes("facebook") || p.includes("twitter");
    const isEventAsset = p.includes("/upload/event/") || p.includes("/upload/banner/");

    if (
      isDomeggookCdn &&
      isUploadPath &&
      isProductUpload &&
      isMainOrDetail &&
      !isStampOrBadge &&
      !isUiAsset &&
      !isShareIcon &&
      !isEventAsset
    )
      return true;

    // Otherwise: reject (prevents 쿠팡 image_host_unreachable caused by 3rd-party/blocked assets)
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
  const shippingFeeFallback = Number.isFinite(Number(settings.shippingFeeFallback))
    ? Number(settings.shippingFeeFallback)
    : 2500;
  const shippingSurcharge = shippingFee > 0
    ? shippingFee
    : (shippingFee === -1 ? shippingFeeFallback : 0);
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
  const options = Array.isArray(draft.options) ? draft.options : [];

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
      shippingSurchargeApplied: Boolean(shouldAddShipping),
      shippingSurcharge,
      shippingFeeFallback,
      images,
      contentImageCount: contentImages.length,
      optionsCount: options.length,
    },
    options,
    debug: draft.__debug || null,
  };
}
