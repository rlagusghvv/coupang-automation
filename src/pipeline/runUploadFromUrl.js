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
import { getCategoryMetas } from "../coupang/api/getCategoryMetas.js";
import { checkAutoCategoryAgreed } from "../coupang/api/checkAutoCategoryAgreed.js";
import { recommendCategory } from "../coupang/api/recommendCategory.js";
import { buildSingleItem } from "../coupang/builders/buildSingleItem.js";
import path from "node:path";
import { extractImageUrls, buildImageOnlyHtmlFromUrls } from "../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";
import { computePrice } from "../utils/price.js";
import { resolveLocalImageBase } from "../utils/localImageHost.js";
import { downloadImagesWithPlaywright } from "../utils/playwrightImageDownload.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];

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
    const uniqName = count === 1 ? base : `${base} (${count})`;
    idx += 1;
    out.push({
      label: `${idx}. ${uniqName}`,
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
      const attributeTypeName = String(v?.optionName || "").trim();
      const attributeValueName = String(v?.optionValue || "").trim();
      if (!attributeTypeName || !attributeValueName) return null;
      return { attributeTypeName, attributeValueName };
    })
    .filter(Boolean);
  return attrs.length > 0 ? attrs : null;
}

export async function runUploadFromUrl(inputUrl, settings = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return { ok: false, skipped: true, reason: c.reason, url: c.url };
  }

  const allowedIpsRaw =
    String(settings.allowedIps || process.env.COUPANG_ALLOWED_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (allowedIpsRaw.length > 0) {
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

  // 사용자별 설정 우선
  const accessKey = settings.coupangAccessKey || COUPANG_ACCESS_KEY;
  const secretKey = settings.coupangSecretKey || COUPANG_SECRET_KEY;
  const vendorId = settings.coupangVendorId || COUPANG_VENDOR_ID;
  const vendorUserId = settings.coupangVendorUserId || COUPANG_VENDOR_USER_ID;
  const deliveryCompanyCode =
    settings.coupangDeliveryCompanyCode || COUPANG_DELIVERY_COMPANY_CODE;
  const draft = await parseProductFromDomaeqq(c.url);
  const localImageBase = resolveLocalImageBase(settings);

  const outDir = path.join(process.cwd(), "out");
  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 30;
  const contentImages = extractImageUrls(draft.contentText).slice(0, Math.max(0, maxContentImages));
  const downloadList = Array.from(new Set([draft.imageUrl, ...contentImages])).filter(Boolean);

  const storageStatePath =
    process.env.DOMEGGOOK_STORAGE_STATE || path.join(process.cwd(), "storageState.json");
  const downloaded = await downloadImagesWithPlaywright({
    pageUrl: draft.sourceUrl,
    imageUrls: downloadList,
    outDir,
    baseUrl: localImageBase,
    storageStatePath,
  });

  const imageUrl = downloaded.urlMap[draft.imageUrl];
  if (!imageUrl) {
    return { ok: false, skipped: false, error: "main image download failed" };
  }

  const contentLocalUrls = contentImages
    .map((u) => downloaded.urlMap[u])
    .filter(Boolean);
  const contentHtml =
    contentLocalUrls.length > 0
      ? buildImageOnlyHtmlFromUrls(contentLocalUrls)
      : draft.contentText || "";

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

  const optionsUsed =
    Array.isArray(draft.options) && draft.options.length > 0
      ? makeUniqueOptions(draft.options)
      : [];

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
    optionsUsed: optionsUsed.map((opt) => opt.label),
    create: { status: res.status, body: createBody, sellerProductId: createdId },
    approval,
  };
}

async function getPublicIp() {
  for (const url of IP_CHECK_URLS) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text && text.length < 80) return text;
    } catch {}
  }
  return "";
}
