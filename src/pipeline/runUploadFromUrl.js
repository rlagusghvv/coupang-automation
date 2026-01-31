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
import { buildSingleItem } from "../coupang/builders/buildSingleItem.js";
import path from "node:path";
import { extractImageUrls, buildImageOnlyHtmlFromUrls } from "../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";
import { computePrice } from "../utils/price.js";
import { resolveLocalImageBase } from "../utils/localImageHost.js";
import { downloadImagesWithPlaywright } from "../utils/playwrightImageDownload.js";
import { deployPagesAssets } from "../utils/pagesDeploy.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];
const IMAGE_CHECK_TIMEOUT_MS = 8000;

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
    const hasValues = Array.isArray(values) && values.length > 0;
    idx += 1;
    out.push({
      label: hasValues ? `${uniqName}` : `${idx}. ${uniqName}`,
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
      const attributeTypeName = rawName
        .replace(/색깔/g, "색상")
        .replace(/크기|사이즈/g, "사이즈");
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

  const draft = await parseProductFromDomaeqq(c.url);
  const localImageBase = resolveLocalImageBase(settings);

  const outDir = path.join(process.cwd(), "out");
  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 30;
  const contentImages = extractImageUrls(draft.contentText).slice(0, Math.max(0, maxContentImages));
  const downloadList = Array.from(new Set([draft.imageUrl, ...contentImages])).filter(Boolean);

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

  const imageUrl = downloaded.urlMap[draft.imageUrl];
  if (!imageUrl) {
    return { ok: false, skipped: false, error: "main image download failed" };
  }

  const imageReachable = await isUrlReachable(imageUrl, IMAGE_CHECK_TIMEOUT_MS);
  if (!imageReachable) {
    return {
      ok: false,
      skipped: false,
      error: "image_host_unreachable",
      imageUrl,
    };
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
      draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
      finalPrice,
      category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory },
      optionsUsed: optionsUsed.map((opt) => opt.label),
    };
  }

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

  return {
    ok: true,
    draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
    finalPrice,
    category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory },
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
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text && text.length < 80) return text;
    } catch {}
  }
  return "";
}

async function isUrlReachable(url, timeoutMs = 8000) {
  if (!url) return false;
  const shouldRetry = url.includes(".pages.dev") || url.includes("/couplus-out/");
  const maxAttempts = shouldRetry ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "HEAD", signal: controller.signal });
      if (res.ok) {
        clearTimeout(timer);
        return true;
      }
    } catch {}
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal });
      if (res.ok) {
        clearTimeout(timer);
        return true;
      }
    } catch {}
    clearTimeout(timer);
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 2000));
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
