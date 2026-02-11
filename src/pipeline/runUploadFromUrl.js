import {
  COUPANG_VENDOR_ID,
  COUPANG_VENDOR_USER_ID,
  COUPANG_ACCESS_KEY,
  COUPANG_SECRET_KEY,
  COUPANG_DELIVERY_COMPANY_CODE,
} from "../config/env.js";
import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { buildSellerProductBody } from "../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../coupang/api/createSellerProduct.js";
import { requestProductApproval } from "../coupang/api/requestProductApproval.js";
import { getSellerProduct } from "../coupang/api/getSellerProduct.js";
import { getSellerProductHistories } from "../coupang/api/getSellerProductHistories.js";
import { getCategoryMetas } from "../coupang/api/getCategoryMetas.js";
import { checkAutoCategoryAgreed } from "../coupang/api/checkAutoCategoryAgreed.js";
import { recommendCategory } from "../coupang/api/recommendCategory.js";
import { suggestTitlesFromNaver, cleanTitle } from "../utils/titleSuggest.js";
import { buildSingleItem } from "../coupang/builders/buildSingleItem.js";
import path from "node:path";
import { extractImageUrls, buildImageOnlyHtmlFromUrls } from "../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";
import { computePrice } from "../utils/price.js";
import { resolveLocalImageBase } from "../utils/localImageHost.js";
import { downloadImagesWithPlaywright } from "../utils/playwrightImageDownload.js";
import { deployPagesAssets } from "../utils/pagesDeploy.js";
import { downloadImageBufferWithPlaywright } from "../utils/downloadImage.js";
import { uploadMarketplaceImage } from "../coupang/api/uploadMarketplaceImage.js";
import { fetchWithRetry } from "../server/net_limit.js";
import { getItemView as getDomeggookItemView } from "../server/domeggook_openapi.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];
const IMAGE_CHECK_TIMEOUT_MS = 8000;

function limitLen(s, max = 30) {
  const str = String(s || "").replace(/\s+/g, " ").trim();
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function makeUniqueOptions(list) {
  const seen = new Map();
  const out = [];
  let idx = 0;
  for (const raw of list) {
    const rawName = typeof raw === "object" && raw ? raw.name : raw;
    const priceDelta =
      typeof raw === "object" && raw && Number.isFinite(Number(raw.priceDelta))
        ? Number(raw.priceDelta)
        : 0;
    const stock =
      typeof raw === "object" && raw && Number.isFinite(Number(raw.stock))
        ? Number(raw.stock)
        : null;
    const values =
      typeof raw === "object" && raw && Array.isArray(raw.values) ? raw.values : [];

    const base = String(rawName || "").replace(/\s+/g, " ").trim();
    if (!base) continue;
    const valueKey = values
      .map((v) => `${String(v.optionName || "").trim()}:${String(v.optionValue || "").trim()}`)
      .join("|");
    const key = `${base.toLowerCase()}::${priceDelta}::${valueKey}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    const uniqNameRaw = count === 1 ? base : `${base} (${count})`;
    const uniqName = limitLen(uniqNameRaw, 30);
    const hasValues = Array.isArray(values) && values.length > 0;
    idx += 1;
    out.push({
      label: hasValues ? `${uniqName}` : limitLen(`${idx}. ${uniqName}`, 30),
      priceDelta,
      stock,
      values,
    });
  }
  return out;
}

function buildItemAttributesFromOptionValues(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const attrs = values
    .map((v) => {
      const rawName = String(v?.optionName || "").trim();
      const attributeTypeName = limitLen(
        rawName
          .replace(/색깔/g, "색상")
          .replace(/크기|사이즈/g, "사이즈"),
        30,
      );
      const attributeValueName = limitLen(String(v?.optionValue || "").trim(), 30);
      if (!attributeTypeName || !attributeValueName) return null;
      return { attributeTypeName, attributeValueName };
    })
    .filter(Boolean);
  return attrs.length > 0 ? attrs : null;
}

export async function runUploadFromUrl(inputUrl, settings = {}) {
  const onProgress = typeof settings?.onProgress === 'function' ? settings.onProgress : null;
  const pushProgress = (p) => {
    try { if (onProgress) onProgress(p || {}); } catch {}
  };

  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, skipped: true, reason: c.reason, url: c.url };
  }

  pushProgress({ stage: 'classified', percent: 2, url: c.url });

  const payloadOnly = String(settings.payloadOnly || "").trim() === "1";
  const allowedIpsRaw =
    String(settings.allowedIps || process.env.COUPANG_ALLOWED_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (!payloadOnly && allowedIpsRaw.length > 0) {
    const currentIp = await getPublicIp().catch(() => "");
    if (!currentIp || !allowedIpsRaw.includes(currentIp)) {
      return {
        ok: false,
        skipped: true,
        reason: "ip_not_allowed",
        ip: currentIp || "",
        allowedIps: allowedIpsRaw,
      };
    }
  }

  pushProgress({ stage: 'preflight_ok', percent: 5, url: c.url });

  // 사용자별 설정 우선
  const accessKey = String(settings.coupangAccessKey || COUPANG_ACCESS_KEY || "").trim();
  const secretKey = String(settings.coupangSecretKey || COUPANG_SECRET_KEY || "").trim();
  const vendorId = String(settings.coupangVendorId || COUPANG_VENDOR_ID || "").trim();
  const vendorUserId = String(
    settings.coupangVendorUserId || COUPANG_VENDOR_USER_ID || "",
  ).trim();
  const deliveryCompanyCode = String(
    settings.coupangDeliveryCompanyCode || COUPANG_DELIVERY_COMPANY_CODE || "",
  ).trim();

  // 서버는 키 없이도 뜰 수 있어야 하므로, 여기서만 검증한다.
  if (!payloadOnly) {
    const missing = [];
    if (!accessKey) missing.push("COUPANG_ACCESS_KEY");
    if (!secretKey) missing.push("COUPANG_SECRET_KEY");
    if (!vendorId) missing.push("COUPANG_VENDOR_ID");
    if (!vendorUserId) missing.push("COUPANG_VENDOR_USER_ID");
    if (!deliveryCompanyCode) missing.push("COUPANG_DELIVERY_COMPANY_CODE");
    if (missing.length > 0) {
      return { ok: false, skipped: true, reason: "missing_coupang_env", missing };
    }
  }

  // OpenAPI-first: use stable product info (title/thumb/detail HTML) when available.
  const openApiKey = String(settings.domeggookOpenApiKey || '').trim();
  let open = null;
  try {
    if (openApiKey) {
      const m = String(c.url || '').match(/\/(\d{6,})(?:\b|\?|#|$)/);
      const no = m ? m[1] : '';
      if (no) {
        open = await getDomeggookItemView({ aid: openApiKey, no });
        if (!open?.ok) open = null;
      }
    }
  } catch {
    open = null;
  }

  // Parse is fallback only (time-bounded) because it can be flaky/slow.
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

  let draft = null;
  try {
    draft = await withTimeout(parseProductFromDomaeqq(c.url), 12_000);
  } catch {
    draft = { title: '', categoryText: '', price: null, shippingFee: null, imageUrl: '', sourceUrl: c.url, contentText: '', options: [] };
  }

  // Prefer OpenAPI fields
  if (open) {
    draft = {
      ...draft,
      title: String(open.title || draft.title || '').trim(),
      imageUrl: String(open.thumbOriginal || draft.imageUrl || '').trim(),
      shippingFee: open.shippingFee != null ? open.shippingFee : draft.shippingFee,
      // supplement contentText for image extraction
      contentText: String(open.html || draft.contentText || ''),
    };
  }

  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 20;

  const openApiDetailHtml = String(open?.html || '');

  function isLikelyProductImage(url) {
    try {
      const u = new URL(url);
      const host = u.hostname;
      const p = u.pathname || "";

      const bad = [
        "img_lensSearch",
        "kakaolink",
        "/sns/",
        "/upload/event/",
        "/upload/banner/",
        "/image/",
        "/images/",
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

      const isDomeggook = host === "cdn1.domeggook.com" || host.endsWith(".domeggook.com");
      const isUploadPath = p.includes("/upload/");
      const isProductUpload = p.includes("/upload/item/") || p.includes("/upload/editor/") || p.includes("/upload/contents/");
      if (isDomeggook && isUploadPath && isProductUpload) return true;

      // allow external-hosted detail images if they look like real image files (small allowlist)
      const allowedExternalHosts = ["gi.esmplus.com", "story-img.kakaocdn.net"];
      const ext = (p.split("?")[0].split("#")[0].match(/\.(jpg|jpeg|png|webp|gif)$/i) || [])[0];

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

  const imagesOverride = Array.isArray(settings.imagesOverride)
    ? settings.imagesOverride.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const extractedFromDraft = extractImageUrls(draft.contentText).filter(isLikelyProductImage);
  const extractedFromOpenApi = openApiDetailHtml
    ? extractImageUrls(openApiDetailHtml).filter(isLikelyProductImage)
    : [];

  const contentImages = (imagesOverride.length > 0
    ? imagesOverride
    : (extractedFromDraft.length > 0 ? extractedFromDraft : extractedFromOpenApi))
    .slice(0, Math.max(0, maxContentImages))
    .filter(Boolean);

  function stripImgTags(html) {
    return String(html || "").replace(/<img\b[^>]*>/gi, "");
  }

  // Default outputs
  let imageUrl = draft.imageUrl;
  // Never fall back to raw page text; keep details image-only.
  let contentHtml = "";

  // ✅ Best-effort: Upload images to Coupang first (prevents image_host_unreachable)
  // If disabled, falls back to the previous "public hosting" approach.
  // Image upload endpoints are not always available per account.
  // Allow disabling this to fall back to public hosting (imageProxyBase / Cloudflare Pages).
  // Default to using Coupang image upload because hotlink-protected CDNs often break.
  const useCoupangImageUpload = String(settings.useCoupangImageUpload ?? "1").trim() !== "0";

  // Try Coupang upload first; if it fails, fall back to public hosting instead of hard-failing.
  if (!payloadOnly && useCoupangImageUpload) {
    try {
      // 1) Main image
      pushProgress({ stage: 'image_main_download', percent: 30 });
      const mainDl = await downloadImageBufferWithPlaywright({
        pageUrl: draft.sourceUrl,
        imageUrl: draft.imageUrl,
      });

      if (!mainDl?.ok) throw new Error("main_image_download_failed");

      pushProgress({ stage: 'image_main_upload', percent: 40 });
      const mainUp = await uploadMarketplaceImage({
        vendorId,
        buffer: mainDl.buffer,
        fileName: `main${mainDl.ext || ".jpg"}`,
        mimeType: mainDl.mimeType || "image/jpeg",
        accessKey,
        secretKey,
      });

      if (!mainUp.ok || !(mainUp.vendorPath || mainUp.cdnPath)) throw new Error("coupang_image_upload_failed");

      imageUrl = mainUp.vendorPath || mainUp.cdnPath;

      // 2) Content images (optional)
      const uploadedContentUrls = [];
      let idx = 0;
      for (const u of contentImages) {
        idx += 1;
        try {
          const base = 50;
          const span = 25;
          const ratio = contentImages.length > 0 ? (idx / contentImages.length) : 1;
          pushProgress({ stage: 'image_content_upload', percent: Math.round(base + span * ratio), index: idx, total: contentImages.length });

          const dl = await downloadImageBufferWithPlaywright({
            pageUrl: draft.sourceUrl,
            imageUrl: u,
          });
          if (!dl?.ok) continue;

          const up = await uploadMarketplaceImage({
            vendorId,
            buffer: dl.buffer,
            fileName: `content${dl.ext || ".jpg"}`,
            mimeType: dl.mimeType || "image/jpeg",
            accessKey,
            secretKey,
          });
          const src = up?.cdnPath || up?.vendorPath;
          if (src) uploadedContentUrls.push(src);
        } catch {
          // ignore single image failure
        }
      }

      // Build clean HTML with only Coupang-hosted images
      if (uploadedContentUrls.length > 0) {
        contentHtml = buildImageOnlyHtmlFromUrls(uploadedContentUrls);
      }
    } catch {
      // Fall back to public hosting approach below
    }
  }

  const needFallbackHosting =
    (
      !useCoupangImageUpload ||
      imageUrl === draft.imageUrl ||
      (contentImages.length > 0 && !contentHtml)
    );

  if (needFallbackHosting) {
    // Fallback: download images and expose via local/public base URL
    const localImageBase = resolveLocalImageBase(settings);
    const outDir = path.join(process.cwd(), "out");

    // If main image is already uploaded to Coupang, we only need content images.
    const downloadList = Array.from(
      new Set(
        imageUrl === draft.imageUrl
          ? [draft.imageUrl, ...contentImages]
          : [...contentImages],
      ),
    ).filter(Boolean);

    const { DOMEGGOOK_STORAGE_STATE_PATH } = await import("../config/paths.js");
    const storageStatePath = DOMEGGOOK_STORAGE_STATE_PATH;
    const downloaded = await downloadImagesWithPlaywright({
      pageUrl: draft.sourceUrl,
      imageUrls: downloadList,
      outDir,
      baseUrl: localImageBase,
      storageStatePath,
    });

    if (String(settings.pagesAutoDeploy || "").trim() === "1") {
      const deployRes = await deployPagesAssets({
        directory: outDir,
        subDirName: "couplus-out",
        projectName: String(settings.pagesProjectName || "").trim(),
        apiToken: String(settings.pagesApiToken || "").trim(),
        accountId: String(settings.pagesAccountId || "").trim(),
      });
      if (!deployRes.ok) {
        return {
          ok: false,
          skipped: false,
          error: "pages_deploy_failed",
          detail: deployRes.error,
          deploy: {
            code: deployRes.code ?? null,
            stdout: deployRes.stdout || "",
            stderr: deployRes.stderr || "",
          },
        };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Update main image only if we haven't already uploaded it to Coupang.
    if (imageUrl === draft.imageUrl) {
      const mappedMain = downloaded.urlMap[draft.imageUrl];
      if (!mappedMain) {
        return { ok: false, skipped: false, error: "main_image_download_failed" };
      }

      const imageReachable = await isUrlReachable(mappedMain, IMAGE_CHECK_TIMEOUT_MS);
      if (!imageReachable) {
        return {
          ok: false,
          skipped: false,
          error: "image_host_unreachable",
          imageUrl: mappedMain,
        };
      }

      imageUrl = mappedMain;
    }

    const contentLocalUrls = contentImages.map((u) => downloaded.urlMap[u]).filter(Boolean);
    contentHtml = contentLocalUrls.length > 0 ? buildImageOnlyHtmlFromUrls(contentLocalUrls) : "";

    // If we have detail images but couldn't host/resolve them, fail instead of uploading empty detail.
    if (contentImages.length > 0 && !contentHtml) {
      return {
        ok: false,
        skipped: false,
        error: 'detail_images_unavailable',
        detail: {
          contentImagesCount: contentImages.length,
          resolvedCount: contentLocalUrls.length,
          hint: 'Enable Coupang image upload (useCoupangImageUpload=1) or ensure image hosting works.',
        },
        draft: {
          title: draft.title,
          price: draft.price,
          imageUrl: draft.imageUrl,
          detailImages: contentImages,
        },
        detailImages: contentImages,
      };
    }
  }

  const displayCategoryCode = resolveDisplayCategoryCode({
    title: draft.title,
    categoryText: draft.categoryText,
    fallback: DISPLAY_CATEGORY_CODE,
  });

  let finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

  // Coupang constraint guard: item price must be >= 10 KRW (practically >= 1000).
  // Prevent accidental 0 price from config bugs / missing draft price.
  const COUPANG_MIN_PRICE = 1000;
  if (!Number.isFinite(Number(finalPrice)) || Number(finalPrice) < 10) {
    finalPrice = COUPANG_MIN_PRICE;
  }

  // 배송비가 유료면 "실제 배송비"만큼 판매가에 가산
  // shippingFee: 0=무료, >0=유료(금액), -1=유료(금액 표기 없음)
  const shippingFee = Number(draft.shippingFee);

  // 배송비 가격정책
  // - none: 반영 안함
  // - actual: 실제 배송비만큼 가산
  // - fixed: 유료면 고정 금액 가산
  // - error_unknown: 유료인데 금액 못 읽으면 에러
  const shippingPolicy = String(settings.shippingPolicy || "actual").trim();
  const shippingFixed = Number.isFinite(Number(settings.shippingFixedAmount))
    ? Number(settings.shippingFixedAmount)
    : 2500;

  if (shippingFee === -1 && shippingPolicy === "error_unknown") {
    return {
      ok: false,
      skipped: false,
      error: "shipping_fee_unknown",
      detail: {
        message: "배송비가 유료(착불/배송비별도)로 표시되지만 금액을 확인할 수 없어 업로드를 중단했습니다.",
        sourceUrl: draft.sourceUrl,
      },
      draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl, shippingFee: draft.shippingFee },
    };
  }

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

  const useAutoCategory = String(settings.autoCategoryMatch || process.env.AUTO_CATEGORY_MATCH || "").trim() === "1";
  let allowAutoCategory = false;
  if (useAutoCategory) {
    try {
      const agreed = await checkAutoCategoryAgreed({ vendorId, accessKey, secretKey });
      allowAutoCategory = agreed.status === 200;
    } catch {
      allowAutoCategory = false;
    }
  }

  // Allow manual override
  const overrideCategoryCode = Number(settings.categoryOverrideCode);
  let finalCategoryCode = Number.isFinite(overrideCategoryCode) && overrideCategoryCode > 0
    ? overrideCategoryCode
    : displayCategoryCode;
  let notices = undefined;

  // If vendor category text is missing, try Coupang category prediction API for better accuracy.
  // This prevents bad defaults (e.g. adult-only categories).
  const canPredictCategory = accessKey && secretKey;
  const usePredict = String(settings.autoCategoryPredict ?? "1").trim() !== "0";
  if (
    canPredictCategory &&
    usePredict &&
    (!draft.categoryText || String(draft.categoryText).trim() === "") &&
    (finalCategoryCode === DISPLAY_CATEGORY_CODE)
  ) {
    try {
      const pred = await recommendCategory({
        productName: draft.title,
        productDescription: String(draft.contentText || "").replace(/<[^>]+>/g, " ").slice(0, 500),
        productImageUrl: imageUrl,
        accessKey,
        secretKey,
      });
      if (pred.status === 200) {
        const bodyObj = typeof pred.body === "string" ? JSON.parse(pred.body) : pred.body;
        const predicted = Number(bodyObj?.data?.predictedCategoryId);
        const predictedName = String(bodyObj?.data?.predictedCategoryName || "");
        const looksAdult = /성인|19\s*세|청소년\s*이용\s*불가|미성년\s*불가/i.test(predictedName);
        if (looksAdult) {
          return {
            ok: false,
            skipped: false,
            error: "adult_category_blocked",
            detail: { predictedCategoryId: predicted, predictedCategoryName: predictedName },
            draft: { title: sellerProductName, price: draft.price, imageUrl: draft.imageUrl },
          };
        }
        if (Number.isFinite(predicted) && predicted > 0) {
          // validate predicted category
          try {
            const meta = await getCategoryMetas({
              displayCategoryCode: predicted,
              accessKey,
              secretKey,
            });
            if (meta.status === 200) {
              finalCategoryCode = predicted;
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (allowAutoCategory) {
    finalCategoryCode = null;
    notices = null;
  } else {
    const usePredict = String(settings.autoCategoryPredict ?? "1").trim() !== "0";
    const useRecommend =
      String(settings.autoCategoryRecommend || process.env.AUTO_CATEGORY_RECOMMEND || "").trim() === "1" ||
      usePredict;
    if (useRecommend) {
      try {
        const productName = cleanTitle(String(draft.title || "").split("|")[0]).slice(0, 80);
        const rec = await recommendCategory({
          productName,
          // Avoid noisy page text that can mislead categorization.
          productDescription: "",
          productImageUrl: imageUrl,
          accessKey,
          secretKey,
        });
        const bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
        const recCode = bodyObj?.data?.predictedCategoryId;
        const recName = bodyObj?.data?.predictedCategoryName;
        if (recCode) finalCategoryCode = Number(recCode);
        // attach for result/UI (non-persistent)
        settings.__predictedCategory = { id: recCode ?? null, name: recName ?? null };
      } catch {}
    }

    try {
      const meta = await getCategoryMetas({ displayCategoryCode: finalCategoryCode, accessKey, secretKey });
      if (meta.status !== 200) {
        finalCategoryCode = DISPLAY_CATEGORY_CODE;
      }
    } catch {
      finalCategoryCode = DISPLAY_CATEGORY_CODE;
    }
  }

  const autoRequest = String(settings.autoRequest || "").trim() === "1";

  const optionsUsed =
    Array.isArray(draft.options) && draft.options.length > 0
      ? makeUniqueOptions(draft.options)
      : [];

  const overrideTitle = String(settings.titleOverride || "").trim();

  // If user didn't pick a title in the UI, auto-apply the best 15-char suggestion.
  // This makes "Upload" behave like it benefited from the preview step.
  let autoSuggestedTitle = "";
  const autoTitleSuggest = String(settings.autoTitleSuggest ?? "1").trim() !== "0";
  if (!overrideTitle && autoTitleSuggest) {
    try {
      const sug = await suggestTitlesFromNaver({ title: draft.title, maxLen: 15 });
      const first = sug?.suggestions?.[0]?.title;
      if (first) autoSuggestedTitle = String(first).trim();
    } catch {}
  }

  const sellerProductName = overrideTitle || autoSuggestedTitle || draft.title;

  const body = buildSellerProductBody({
    vendorId,
    vendorUserId,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    deliveryCompanyCode: settings.coupangDeliveryCompanyCode,
    displayCategoryCode: finalCategoryCode,
    allowAutoCategory,
    sellerProductName,
    imageUrl,
    price: finalPrice,
    stock: 10,
    contentText: contentHtml,
    notices,
    requested: autoRequest,
    items:
      optionsUsed.length > 0
        ? optionsUsed.map((opt) => {
            const rawPrice = finalPrice + (opt.priceDelta || 0);
            const minPrice = Number.isFinite(Number(settings.priceMin))
              ? Number(settings.priceMin)
              : 1000;
            const itemPrice = Math.max(minPrice, rawPrice);

            return buildSingleItem({
              itemName: opt.label,
              price: itemPrice,
              stock: Number.isFinite(opt.stock) && opt.stock > 0 ? opt.stock : 10,
              outboundShippingTimeDay: 1,
              imageUrl,
              contentText: contentHtml,
              notices,
              attributes: buildItemAttributesFromOptionValues(opt.values) || undefined,
            });
          })
        : undefined,
  });

  const payloadCheck = buildPayloadCheck({
    optionsUsed,
    finalPrice,
    priceMin: settings.priceMin,
    items: body?.items || [],
  });

  if (payloadOnly) {
    return {
      ok: true,
      payloadOnly: true,
      payload: body,
      payloadCheck,
      draft: {
        title: sellerProductName,
        price: draft.price,
        imageUrl: draft.imageUrl,
        detailImages: contentImages,
      },
      detailImages: contentImages,
      finalPrice,
      category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
      optionsUsed: optionsUsed.map((opt) => opt.label),
    };
  }

  pushProgress({ stage: 'coupang_create', percent: 85 });
  const res = await createSellerProduct({
    vendorId,
    body,
    accessKey,
    secretKey,
  });

  let createdId = null;
  let createBody = res.body;
  let createBodyObj = null;

  // If HTTP itself failed (e.g., 429), do not treat as success.
  if (Number(res?.status) && Number(res.status) !== 200) {
    const err = Number(res.status) === 429 ? 'coupang_rate_limited' : `coupang_create_http_${res.status}`;
    return {
      ok: false,
      error: err,
      detail: { status: res.status, body: createBody },
      draft: {
        title: sellerProductName,
        price: draft.price,
        imageUrl: draft.imageUrl,
        detailImages: contentImages,
      },
      detailImages: contentImages,
      finalPrice,
      category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
      optionsUsed: optionsUsed.map((opt) => opt.label),
      payloadCheck,
      create: { status: res.status, body: createBody, sellerProductId: null },
    };
  }

  try {
    createBodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    if (createBodyObj?.code && String(createBodyObj.code).toUpperCase() !== "SUCCESS") {
      return {
        ok: false,
        error: "coupang_create_failed",
        detail: createBodyObj,
        draft: {
          title: sellerProductName,
          price: draft.price,
          imageUrl: draft.imageUrl,
          detailImages: contentImages,
        },
        detailImages: contentImages,
        finalPrice,
        category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
        optionsUsed: optionsUsed.map((opt) => opt.label),
        payloadCheck,
        create: { status: res.status, body: createBody, sellerProductId: null },
      };
    }
    createdId = createBodyObj?.data ?? null;
  } catch {}

  if (!createdId) {
    return {
      ok: false,
      error: 'coupang_create_no_id',
      detail: createBodyObj || { status: res.status, body: createBody },
      draft: {
        title: sellerProductName,
        price: draft.price,
        imageUrl: draft.imageUrl,
        detailImages: contentImages,
      },
      detailImages: contentImages,
      finalPrice,
      category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
      optionsUsed: optionsUsed.map((opt) => opt.label),
      payloadCheck,
      create: { status: res.status, body: createBody, sellerProductId: null },
    };
  }

  let approval = null;
  if (createdId && !autoRequest) {
    const ar = await requestProductApproval({ sellerProductId: createdId, accessKey, secretKey });
    approval = { status: ar.status, body: ar.body };
  }

  let followUp = null;
  if (createdId) {
    followUp = await pollApprovalStatus({
      sellerProductId: createdId,
      accessKey,
      secretKey,
      attempts: 3,
      delayMs: 3000,
    });
  }

  pushProgress({ stage: 'done', percent: 100, sellerProductId: createdId || null });
  return {
    ok: true,
    draft: {
      title: draft.title,
      price: draft.price,
      imageUrl: draft.imageUrl,
      detailImages: contentImages,
    },
    detailImages: contentImages,
    finalPrice,
    category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory, predicted: settings.__predictedCategory || null },
    optionsUsed: optionsUsed.map((opt) => opt.label),
    payloadCheck,
    create: { status: res.status, body: createBody, sellerProductId: createdId },
    approval,
    followUp,
  };
}

async function getPublicIp() {
  for (const url of IP_CHECK_URLS) {
    try {
      // Best-effort: avoid spamming the IP check providers.
      const res = await fetchWithRetry(url, {
        method: "GET",
        spacingMs: 250,
        retries: 2,
        retryOn: [429, 500, 502, 503, 504],
        baseDelayMs: 500,
        maxDelayMs: 4000,
      });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text && text.length < 80) return text;
    } catch {}
  }
  return "";
}

async function isUrlReachable(url, timeoutMs = 8000) {
  if (!url) return false;

  // Cloudflare Pages or our static out hosting can be a bit flaky right after write.
  // Retry a few times.
  const shouldRetry = url.includes(".pages.dev") || url.includes("/couplus-out/");
  const maxAttempts = shouldRetry ? 4 : 2;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Prefer HEAD (cheap)
      const res = await fetchWithRetry(url, {
        method: "HEAD",
        signal: controller.signal,
        spacingMs: 250,
        retries: shouldRetry ? 2 : 1,
        retryOn: [429, 500, 502, 503, 504],
        baseDelayMs: 500,
        maxDelayMs: 6000,
      });
      if (res.ok) {
        clearTimeout(timer);
        return true;
      }
      // Some hosts reject HEAD; fall back to GET.
    } catch {}

    try {
      const res = await fetchWithRetry(url, {
        method: "GET",
        signal: controller.signal,
        spacingMs: 250,
        retries: shouldRetry ? 2 : 1,
        retryOn: [429, 500, 502, 503, 504],
        baseDelayMs: 500,
        maxDelayMs: 6000,
      });
      if (res.ok) {
        clearTimeout(timer);
        return true;
      }
    } catch {}

    clearTimeout(timer);

    // Backoff with jitter
    if (attempt < maxAttempts - 1) {
      const base = 650 * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, Math.min(8000, base + jitter)));
    }
  }

  return false;
}

async function pollApprovalStatus({
  sellerProductId,
  accessKey,
  secretKey,
  attempts = 3,
  delayMs = 3000,
}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await getSellerProduct({ sellerProductId, accessKey, secretKey });
      const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
      const data = bodyObj?.data || {};
      const statusName = data?.statusName || data?.status?.statusName || data?.status || "";
      const productId = data?.productId || data?.displayProductId || null;
      const vendorItemId = data?.vendorItemId || null;
      const approved =
        String(statusName).includes("승인완료") || String(statusName).toUpperCase() === "APPROVED";
      last = {
        status: res.status,
        statusName,
        approved,
        productId,
        vendorItemId,
      };
      if (approved) break;

      try {
        const hist = await getSellerProductHistories({ sellerProductId, accessKey, secretKey });
        const histBody = typeof hist.body === "string" ? JSON.parse(hist.body) : hist.body;
        const items = histBody?.data || [];
        if (Array.isArray(items) && items.length > 0) {
          last.lastHistory = items[0];
        }
      } catch {}
    } catch {}

    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (last?.productId) {
    last.productUrl = `https://www.coupang.com/vp/products/${last.productId}`;
  }
  return last;
}

function buildPayloadCheck({ optionsUsed = [], finalPrice, priceMin, items = [] } = {}) {
  const minPrice = Number.isFinite(Number(priceMin)) ? Number(priceMin) : 1000;
  const itemList = Array.isArray(items) ? items : [];
  const itemMap = new Map(itemList.map((item) => [item?.itemName, item]));

  if (!Array.isArray(optionsUsed) || optionsUsed.length === 0) {
    const single = itemList[0] || {};
    const expectedPrice = Number(finalPrice);
    const expectedStock = 10;
    const actualPrice = Number(single?.salePrice ?? single?.originalPrice ?? single?.price);
    const actualStock = Number(single?.maximumBuyCount ?? single?.stock);
    const priceOk = Number.isFinite(actualPrice) && actualPrice === expectedPrice;
    const stockOk = Number.isFinite(actualStock) && actualStock === expectedStock;
    const check = {
      label: single?.itemName || "단품",
      expectedPrice,
      actualPrice: Number.isFinite(actualPrice) ? actualPrice : null,
      expectedStock,
      actualStock: Number.isFinite(actualStock) ? actualStock : null,
      usedMinPrice: false,
      priceOk,
      stockOk,
    };
    const summary = {
      total: 1,
      missingItem: priceOk || stockOk ? 0 : 1,
      priceMismatch: priceOk ? 0 : 1,
      stockMismatch: stockOk ? 0 : 1,
    };
    return { ok: priceOk && stockOk, summary, checks: [check] };
  }

  const checks = optionsUsed.map((opt) => {
    const item = itemMap.get(opt.label);
    const rawExpected = Number(finalPrice) + Number(opt.priceDelta || 0);
    const expectedPrice = Math.max(minPrice, rawExpected);
    const expectedStock =
      Number.isFinite(opt.stock) && Number(opt.stock) > 0 ? Number(opt.stock) : 10;
    const actualPrice = Number(item?.salePrice ?? item?.originalPrice ?? item?.price);
    const actualStock = Number(item?.maximumBuyCount ?? item?.stock);
    const priceOk = Number.isFinite(actualPrice) && actualPrice === expectedPrice;
    const stockOk = Number.isFinite(actualStock) && actualStock === expectedStock;
    return {
      label: opt.label,
      priceDelta: Number(opt.priceDelta || 0),
      expectedPrice,
      actualPrice: Number.isFinite(actualPrice) ? actualPrice : null,
      expectedStock,
      actualStock: Number.isFinite(actualStock) ? actualStock : null,
      usedMinPrice: rawExpected < minPrice,
      priceOk,
      stockOk,
    };
  });

  const summary = {
    total: checks.length,
    missingItem: checks.filter((c) => c.actualPrice == null && c.actualStock == null).length,
    priceMismatch: checks.filter((c) => !c.priceOk).length,
    stockMismatch: checks.filter((c) => !c.stockOk).length,
  };
  const ok = summary.priceMismatch === 0 && summary.stockMismatch === 0;
  return { ok, summary, checks };
}
