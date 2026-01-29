import fs from "fs";
import path from "path";

import { COUPANG_VENDOR_ID, COUPANG_VENDOR_USER_ID, IMAGE_PROXY_BASE } from "../../config/env.js";
import { classifyUrl } from "../../utils/urlFilter.js";
import { parseProductFromDomaeqq } from "../../sources/domaeqq/parseProductFromDomaeqq.js";
import { buildSellerProductBody } from "../../coupang/builders/buildSellerProductBody.js";
import { createSellerProduct } from "../../coupang/api/createSellerProduct.js";
import { prepareProxyUrl } from "../../utils/imageProxy.js";
import { extractImageUrls, filterDomeggookUrls, replaceImageSrcs } from "../../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../../utils/categoryMap.js";
import { getCategoryMetas } from "../../coupang/api/getCategoryMetas.js";
import { checkAutoCategoryAgreed } from "../../coupang/api/checkAutoCategoryAgreed.js";
import { recommendCategory } from "../../coupang/api/recommendCategory.js";
import { computePrice } from "../../utils/price.js";
import { getCategoryMetas } from "../../coupang/api/getCategoryMetas.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;

const URLS_FILE = path.resolve(process.cwd(), "urls.txt");
const OUT_DIR = path.resolve(process.cwd(), "out");
const RESULT_JSONL = path.join(OUT_DIR, "upload_results.jsonl");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readUrls() {
  if (!fs.existsSync(URLS_FILE)) throw new Error("urls.txt not found at project root");
  const raw = fs.readFileSync(URLS_FILE, "utf-8");
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function appendJsonl(obj) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(RESULT_JSONL, JSON.stringify(obj) + "\n");
}

async function uploadOne(line) {
  const parts = String(line).split("|");
  const maybeCode = parts.length > 1 ? parts[0].trim() : null;
  const url = parts.length > 1 ? parts.slice(1).join("|").trim() : String(line).trim();

  const startedAt = new Date().toISOString();
  const c = classifyUrl(url);

  if (!c.ok) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      url,
      ok: false,
      skipped: true,
      skipReason: c.reason,
      sellerProductId: null,
      responseCode: "SKIPPED",
      message: c.reason,
    };
  }

  try {
    const draft = await parseProductFromDomaeqq(c.url);

    const imageForCoupang = await prepareProxyUrl(draft.imageUrl, IMAGE_PROXY_BASE, draft.sourceUrl);
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
      fallback: (maybeCode ? Number(maybeCode) : DISPLAY_CATEGORY_CODE),
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
            productImageUrl: imageForCoupang,
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
      imageUrl: imageForCoupang,
      price: finalPrice,
      stock: 10,
      contentText: contentHtml,
      notices,
    });

    const res = await createSellerProduct({ vendorId: COUPANG_VENDOR_ID, body });
    const bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body;

    const ok = bodyObj?.code === "SUCCESS";
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      url: c.url,
      ok,
      skipped: false,
      sellerProductId: bodyObj?.data ?? null,
      responseCode: bodyObj?.code,
      message: bodyObj?.message,
    };
  } catch (e) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      url: c.url,
      ok: false,
      skipped: false,
      sellerProductId: null,
      responseCode: "EXCEPTION",
      message: String(e?.message || e),
    };
  }
}

(async () => {
  const urls = readUrls();
  console.log("URL COUNT:", urls.length);
  console.log("RESULT FILE:", RESULT_JSONL);

  const delayMs = Number(process.env.BATCH_DELAY_MS || 3000);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log("\n[" + (i + 1) + "/" + urls.length + "]", url);

    const result = await uploadOne(url);
    appendJsonl(result);

    if (result.skipped) {
      console.log("-> SKIPPED:", result.skipReason);
    } else {
      console.log("-> ok:", result.ok, "sellerProductId:", result.sellerProductId);
      if (!result.ok) console.log("-> message:", result.message);
    }

    if (i < urls.length - 1) await sleep(delayMs);
  }

  console.log("\nDONE. results saved to:", RESULT_JSONL);
})();
