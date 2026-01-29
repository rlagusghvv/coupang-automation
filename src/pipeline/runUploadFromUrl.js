import { COUPANG_VENDOR_ID, COUPANG_VENDOR_USER_ID, IMAGE_PROXY_BASE } from "../config/env.js";
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

export async function runUploadFromUrl(inputUrl) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, skipped: true, reason: c.reason, url: c.url };
  }

  const draft = await parseProductFromDomaeqq(c.url);

  const imageForCoupang = await prepareProxyUrl(draft.imageUrl, IMAGE_PROXY_BASE, draft.sourceUrl);
  const p = await probeImageUrl(imageForCoupang);
  if (!p.ok) {
    return { ok: false, skipped: false, error: "image probe failed", detail: p };
  }

  const imageUrl = p.finalUrl;

  const contentImages = filterDomeggookUrls(extractImageUrls(draft.contentText));
  const settled = await Promise.allSettled(
    contentImages.map((u) => prepareProxyUrl(u, IMAGE_PROXY_BASE, draft.sourceUrl)),
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

  const finalPrice = computePrice(draft.price);

  const useAutoCategory = String(process.env.AUTO_CATEGORY_MATCH || "").trim() === "1";
  let allowAutoCategory = false;
  if (useAutoCategory) {
    try {
      const agreed = await checkAutoCategoryAgreed({ vendorId: COUPANG_VENDOR_ID });
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
    const useRecommend = String(process.env.AUTO_CATEGORY_RECOMMEND || "").trim() === "1";
    if (useRecommend) {
      try {
        const rec = await recommendCategory({
          productName: draft.title,
          productDescription: draft.contentText?.slice(0, 2000) || "",
          productImageUrl: imageUrl,
        });
        const bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
        const recCode = bodyObj?.data?.predictedCategoryId;
        if (recCode) finalCategoryCode = Number(recCode);
      } catch {}
    }

    try {
      const meta = await getCategoryMetas({ displayCategoryCode: finalCategoryCode });
      if (meta.status !== 200) {
        finalCategoryCode = DISPLAY_CATEGORY_CODE;
      }
    } catch {
      finalCategoryCode = DISPLAY_CATEGORY_CODE;
    }
  }

  const body = buildSellerProductBody({
    vendorId: COUPANG_VENDOR_ID,
    vendorUserId: COUPANG_VENDOR_USER_ID,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    displayCategoryCode: finalCategoryCode,
    allowAutoCategory,
    sellerProductName: draft.title,
    imageUrl,
    price: finalPrice,
    stock: 10,
    contentText: contentHtml,
    notices,
  });

  const res = await createSellerProduct({
    vendorId: COUPANG_VENDOR_ID,
    body,
  });

  let createdId = null;
  let createBody = res.body;
  try {
    const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    createdId = bodyObj?.data ?? null;
  } catch {}

  let approval = null;
  if (createdId) {
    const ar = await requestProductApproval({ sellerProductId: createdId });
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
