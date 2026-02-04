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

  const finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

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
      imageUrl: mainImageUrl,
      sourceUrl: draft.sourceUrl || c.url,
    },
    computed: {
      finalPrice,
      images,
      contentImageCount: contentImages.length,
      optionsCount: options.length,
    },
    options,
    debug: draft.__debug || null,
  };
}
