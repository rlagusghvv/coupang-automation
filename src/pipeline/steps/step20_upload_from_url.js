import { COUPANG_VENDOR_ID, COUPANG_VENDOR_USER_ID, IMAGE_PROXY_BASE } from "../../config/env.js";
import { classifyUrl } from "../../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../../sources/domaeqq/parseProductFromDomaeqq.js";
import { buildSellerProductBody } from "../../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../../coupang/api/createSellerProduct.js";
import { requestProductApproval } from "../../coupang/api/requestProductApproval.js";
import { getCategoryMetas } from "../../coupang/api/getCategoryMetas.js";
import { checkAutoCategoryAgreed } from "../../coupang/api/checkAutoCategoryAgreed.js";
import { recommendCategory } from "../../coupang/api/recommendCategory.js";
import { prepareProxyUrl } from "../../utils/imageProxy.js";
import { probeImageUrl } from "../../utils/imageProbe.js";
import {
  extractImageUrls,
  filterDomeggookUrls,
  replaceImageSrcs,
} from "../../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../../utils/categoryMap.js";
import { computePrice } from "../../utils/price.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;

(async () => {
  try {
    const input = process.argv[2];
    if (!input) {
      console.log(
        'Usage: node src/pipeline/steps/step20_upload_from_url.js "https://상품URL"',
      );
      process.exit(1);
    }

    const c = classifyUrl(input);
    if (!c.ok) {
      console.log("SKIP:", c.reason, c.url);
      process.exit(0);
    }

    const draft = await parseProductFromDomaeqq(c.url);
    console.log("DRAFT:", {
      title: draft.title,
      price: draft.price,
      imageUrl: draft.imageUrl,
    });
    const imageForCoupang = await prepareProxyUrl(draft.imageUrl, IMAGE_PROXY_BASE, draft.sourceUrl);
    const p = await probeImageUrl(imageForCoupang);
    if (!p.ok) {
      console.log("IMAGE PROBE FAIL:", p.reason, p.debug);
      throw new Error("Coupang image URL not accessible as image");
    }

    const imageUrl = p.finalUrl; // ✅ 검증 통과 + 최종 URL

    const contentImages = filterDomeggookUrls(extractImageUrls(draft.contentText));
    const settled = await Promise.allSettled(
      contentImages.map((u) => prepareProxyUrl(u, IMAGE_PROXY_BASE, draft.sourceUrl)),
    );
    const proxiedContentUrls = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
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
          console.log("CATEGORY FALLBACK:", displayCategoryCode, "->", finalCategoryCode);
        }
      } catch {
        finalCategoryCode = DISPLAY_CATEGORY_CODE;
        console.log("CATEGORY FALLBACK:", displayCategoryCode, "->", finalCategoryCode);
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
    console.log("STATUS:", res.status);
    console.log("BODY:", res.body);

    let createdId = null;
    try {
      const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
      createdId = bodyObj?.data ?? null;
    } catch {}

    if (createdId) {
      const ar = await requestProductApproval({ sellerProductId: createdId });
      console.log("APPROVAL STATUS:", ar.status);
      console.log("APPROVAL BODY:", ar.body);
    }
  } catch (e) {
    console.log("STEP20 ERROR:", String(e?.message || e));
    process.exit(1);
  }
})();
