import {
  COUPANG_VENDOR_ID,
  COUPANG_VENDOR_USER_ID,
  IMAGE_PROXY_BASE,
  COUPANG_ACCESS_KEY,
  COUPANG_SECRET_KEY,
  COUPANG_DELIVERY_COMPANY_CODE,
} from "../config/env.js";
import { classifyUrl } from "../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import { buildSellerProductBody } from "../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../coupang/api/createSellerProduct.js";
import { requestProductApproval } from "../coupang/api/requestProductApproval.js";
import { getCategoryMetas } from "../coupang/api/getCategoryMetas.js";
import { checkAutoCategoryAgreed } from "../coupang/api/checkAutoCategoryAgreed.js";
import { recommendCategory } from "../coupang/api/recommendCategory.js";
import { prepareProxyUrl } from "../utils/imageProxy.js";
import { probeImageUrl } from "../utils/imageProbe.js";
import { extractImageUrls, filterDomeggookUrls, replaceImageSrcs } from "../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";
import { computePrice } from "../utils/price.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;

export async function runUploadFromUrl(inputUrl, settings = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, skipped: true, reason: c.reason, url: c.url };
  }

  // 사용자별 설정 우선
  const accessKey = settings.coupangAccessKey || COUPANG_ACCESS_KEY;
  const secretKey = settings.coupangSecretKey || COUPANG_SECRET_KEY;
  const vendorId = settings.coupangVendorId || COUPANG_VENDOR_ID;
  const vendorUserId = settings.coupangVendorUserId || COUPANG_VENDOR_USER_ID;
  const deliveryCompanyCode =
    settings.coupangDeliveryCompanyCode || COUPANG_DELIVERY_COMPANY_CODE;
  const imageProxyBase = settings.imageProxyBase || IMAGE_PROXY_BASE;

  const draft = await parseProductFromDomaeqq(c.url);

  const imageForCoupang = await prepareProxyUrl(draft.imageUrl, imageProxyBase, draft.sourceUrl);
  const p = await probeImageUrl(imageForCoupang);
  if (!p.ok) {
    return { ok: false, skipped: false, error: "image probe failed", detail: p };
  }

  const imageUrl = p.finalUrl;

  const contentImages = filterDomeggookUrls(extractImageUrls(draft.contentText));
  const settled = await Promise.allSettled(
    contentImages.map((u) => prepareProxyUrl(u, imageProxyBase, draft.sourceUrl)),
  );
  const map = {};
  for (let i = 0; i < contentImages.length; i++) {
    if (settled[i]?.status === "fulfilled") map[contentImages[i]] = settled[i].value;
  }
  const contentHtml = replaceImageSrcs(draft.contentText, map) || draft.contentText;

  const displayCategoryCode = resolveDisplayCategoryCode({
    title: draft.title,
    categoryText: draft.categoryText,
    fallback: DISPLAY_CATEGORY_CODE,
  });

  const finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

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

  let finalCategoryCode = displayCategoryCode;
  let notices = undefined;

  if (allowAutoCategory) {
    finalCategoryCode = null;
    notices = null;
  } else {
    const useRecommend = String(settings.autoCategoryRecommend || process.env.AUTO_CATEGORY_RECOMMEND || "").trim() === "1";
    if (useRecommend) {
      try {
        const rec = await recommendCategory({
          productName: draft.title,
          productDescription: draft.contentText?.slice(0, 2000) || "",
          productImageUrl: imageUrl,
          accessKey,
          secretKey,
        });
        const bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
        const recCode = bodyObj?.data?.predictedCategoryId;
        if (recCode) finalCategoryCode = Number(recCode);
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

  const body = buildSellerProductBody({
    vendorId,
    vendorUserId,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    displayCategoryCode: finalCategoryCode,
    allowAutoCategory,
    sellerProductName: draft.title,
    imageUrl,
    price: finalPrice,
    stock: 10,
    contentText: contentHtml,
    notices,
    requested: autoRequest,
  });

  const res = await createSellerProduct({
    vendorId,
    body,
    accessKey,
    secretKey,
  });

  let createdId = null;
  let createBody = res.body;
  try {
    const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    createdId = bodyObj?.data ?? null;
  } catch {}

  let approval = null;
  if (createdId && !autoRequest) {
    const ar = await requestProductApproval({ sellerProductId: createdId, accessKey, secretKey });
    approval = { status: ar.status, body: ar.body };
  }

  return {
    ok: true,
    draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
    finalPrice,
    category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory },
    create: { status: res.status, body: createBody, sellerProductId: createdId },
    approval,
  };
}
