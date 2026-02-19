import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { DOMEGGOOK_OPENAPI_KEY } from "../config/env.js";
import { domeggookOpenApiGetItemView } from "../utils/domeggook_openapi.js";
import { extractImageUrls } from "../utils/contentImages.js";
import { requestHeadOrGetProbe } from "../utils/requestHeadOrGetProbe.js";
import { computePrice } from "../utils/price.js";
import { recommendCategory } from "../coupang/api/recommendCategory.js";
import { suggestTitlesHybrid, cleanTitle } from "../utils/titleSuggest.js";
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

  let draft = null;

  // Prefer Domeggook OpenAPI detail for domeggook item URLs when key is available.
  // This dramatically improves stability vs scraping (and yields structured desc/opts).
  const mNo = String(c.url || '').match(/domeggook\.com\/(\d{6,})/);
  const itemNo = mNo ? mNo[1] : '';

  if (itemNo && String(DOMEGGOOK_OPENAPI_KEY || '').trim()) {
    try {
      const r = await domeggookOpenApiGetItemView({ itemNo, ver: '4.5', om: 'json' });
      const root = r?.raw?.domeggook || r?.raw || {};
      const basis = root?.basis || {};
      const price = root?.price || {};
      const deli = root?.deli || {};
      const thumb = root?.thumb || {};
      const desc = root?.desc || {};

      const title = String(basis?.title || '').trim() || `도매꾹 상품 ${itemNo}`;

      // Prefer dome price when available; fallback to supply.
      const pDome = price?.dome;
      const pSupply = price?.supply;
      const picked = Number.isFinite(Number(pDome)) ? Number(pDome) : (Number.isFinite(Number(pSupply)) ? Number(pSupply) : null);

      const imageUrl = String(thumb?.large || thumb?.original || thumb?.small || '').trim();

      // Best-effort: build contentText from desc.contents.item/deli/event/otherItem.
      const contents = desc?.contents || {};
      const contentText = [contents?.item, contents?.deli, contents?.event, contents?.otherItem]
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .join('\n\n');

      // Shipping fee: use dome fee when fixed.
      const shipFee = Number(deli?.dome?.fee);
      const shippingFee = Number.isFinite(shipFee) ? shipFee : null;

      // Options: OpenAPI exposes selectOpt as JSON string (per docs). Keep as raw string for now.
      const selectOptRaw = root?.selectOpt;
      const options = [];
      if (selectOptRaw) {
        try {
          const obj = typeof selectOptRaw === 'string' ? JSON.parse(selectOptRaw) : selectOptRaw;
          // We don't know the exact schema; store keys for downstream parsing later.
          options.push({ name: 'selectOpt', priceDelta: 0, stock: 0, values: [], raw: obj });
        } catch {
          options.push({ name: 'selectOpt', priceDelta: 0, stock: 0, values: [], raw: String(selectOptRaw) });
        }
      }

      draft = {
        sourceUrl: c.url,
        title,
        price: picked ?? 0,
        imageUrl: imageUrl || 'https://via.placeholder.com/1000',
        contentText: contentText || title,
        categoryText: '',
        options,
        shippingFee,
      };
    } catch {
      draft = null;
    }
  }

  if (!draft) {
    draft = await parseProductFromDomaeqq(c.url);
  }

  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 30;

  // Extract detail images from HTML.
  // Some vendors host images on external CDNs with non-standard URLs (no extension).
  // In that case, a lightweight HEAD/GET probe can verify it's actually an image.
  const extracted = extractImageUrls(draft.contentText);
  const wanted = Math.max(0, maxContentImages);

  const contentImages = [];
  const seenImg = new Set();

  const pushImg = (u) => {
    const s = String(u || '').trim();
    if (!s) return;
    if (seenImg.has(s)) return;
    seenImg.add(s);
    contentImages.push(s);
  };

  // 1) Fast path: keep images that look like product images.
  for (const u of extracted) {
    if (contentImages.length >= wanted) break;
    if (!isLikelyProductImage(u)) continue;
    pushImg(u);
  }

  // 2) Probe remaining candidates (best-effort).
  if (contentImages.length < wanted) {
    const remain = extracted.filter((u) => !seenImg.has(String(u || '').trim())).slice(0, 60);
    for (const u of remain) {
      if (contentImages.length >= wanted) break;
      try {
        const pr = await requestHeadOrGetProbe(u, {
          timeoutMs: 8000,
          headers: { Referer: 'https://domeggook.com' },
        });
        const ct = String(pr?.headers?.['content-type'] || '').toLowerCase();
        const finalUrl = String(pr?.finalUrl || '');
        const looksImage = ct.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(finalUrl);
        if (pr?.ok && looksImage) pushImg(u);
      } catch {
        // ignore
      }
    }
  }


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
    titleSuggestions = await suggestTitlesHybrid({ title: draft.title, maxLen: 15, useNaver: true });
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
