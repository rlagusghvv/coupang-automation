import {
  COUPANG_VENDOR_ID,
  COUPANG_VENDOR_USER_ID,
  COUPANG_ACCESS_KEY,
  COUPANG_SECRET_KEY,
  COUPANG_DELIVERY_COMPANY_CODE,
} from "../config/env.js";
import { classifyUrl } from "../utils/urlFilter.js";
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
import { buildImageOnlyHtmlFromUrls } from "../utils/contentImages.js";
import { resolveDisplayCategoryCode } from "../utils/categoryMap.js";
import { computePrice } from "../utils/price.js";
import { resolveLocalImageBase } from "../utils/localImageHost.js";
import { downloadImagesWithPlaywright } from "../utils/playwrightImageDownload.js";
import { deployPagesAssets } from "../utils/pagesDeploy.js";
import { previewUploadFromUrl } from "./previewUploadFromUrl.js";
import { evaluateQcGate } from "./qcGate.js";

const OUTBOUND_SHIPPING_PLACE_CODE = "24093380";
const DISPLAY_CATEGORY_CODE = 77723;
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];
const IMAGE_CHECK_TIMEOUT_MS = 8000;
const CREATE_RETRY_MAX = 1;

const CATEGORY_REQUIRED_ATTRIBUTES = {
  78838: [
    { attributeTypeName: "차종", attributeValueName: "상세페이지 참조" },
    { attributeTypeName: "제품상태", attributeValueName: "새상품" },
    { attributeTypeName: "수량", attributeValueName: "1개" },
  ],
};

function emptyCreate() {
  return {
    status: null,
    body: null,
    sellerProductId: null,
  };
}

function emptyFollowUp() {
  return {
    statusName: null,
  };
}

function normalizeFollowUp(followUp) {
  if (!followUp || typeof followUp !== "object") return emptyFollowUp();
  return {
    ...followUp,
    statusName: String(followUp.statusName || "").trim() || null,
  };
}

function normalizeQc(qc) {
  if (!qc || typeof qc !== "object") {
    return { ok: false, metrics: {} };
  }
  return {
    ok: Boolean(qc.ok),
    metrics: qc.metrics && typeof qc.metrics === "object" ? qc.metrics : {},
  };
}

function buildResult(overrides = {}) {
  const {
    qc: qcOverride,
    create: createOverride,
    followUp: followUpOverride,
    ...rest
  } = overrides || {};

  return {
    ...rest,
    ok: Boolean(rest.ok),
    skipped: Boolean(rest.skipped),
    error: rest.error ?? null,
    reason: rest.reason ?? null,
    detail: rest.detail ?? null,
    qc: normalizeQc(qcOverride),
    create: {
      ...emptyCreate(),
      ...(createOverride || {}),
      sellerProductId:
        createOverride?.sellerProductId == null
          ? null
          : String(createOverride.sellerProductId),
    },
    followUp: normalizeFollowUp(followUpOverride),
  };
}

function buildQcBlockedResult({ qcGate, previewResult, draft }) {
  return buildResult({
    ok: false,
    skipped: true,
    error: "qc_gate_failed",
    detail: {
      reasons: Array.isArray(qcGate?.reasons) ? qcGate.reasons : [],
      metrics: qcGate?.metrics && typeof qcGate.metrics === "object" ? qcGate.metrics : {},
    },
    qc: {
      ok: false,
      metrics: qcGate?.metrics && typeof qcGate.metrics === "object" ? qcGate.metrics : {},
    },
    preview: previewResult?.preview || null,
    draft: draft
      ? { title: draft.title, price: draft.price, imageUrl: draft.imageUrl }
      : undefined,
  });
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

export async function runUploadFromUrl(inputUrl, settings = {}, runtime = {}) {
  const c = classifyUrl(inputUrl);
  if (!c.ok) {
    return buildResult({
      ok: false,
      skipped: true,
      reason: c.reason,
      error: c.reason,
      url: c.url,
      qc: { ok: false, metrics: {} },
    });
  }

  const payloadOnly = String(settings.payloadOnly || "").trim() === "1";
  const allowedIpsRaw = String(settings.allowedIps || process.env.COUPANG_ALLOWED_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!payloadOnly && allowedIpsRaw.length > 0) {
    const currentIp = await getPublicIp().catch(() => "");
    if (!currentIp || !allowedIpsRaw.includes(currentIp)) {
      return buildResult({
        ok: false,
        skipped: true,
        reason: "ip_not_allowed",
        error: "ip_not_allowed",
        ip: currentIp || "",
        allowedIps: allowedIpsRaw,
        qc: { ok: false, metrics: {} },
      });
    }
  }

  // 사용자별 설정 우선
  const accessKey = settings.coupangAccessKey || COUPANG_ACCESS_KEY;
  const secretKey = settings.coupangSecretKey || COUPANG_SECRET_KEY;
  const vendorId = settings.coupangVendorId || COUPANG_VENDOR_ID;
  const vendorUserId = settings.coupangVendorUserId || COUPANG_VENDOR_USER_ID;
  const deliveryCompanyCode = settings.coupangDeliveryCompanyCode || COUPANG_DELIVERY_COMPANY_CODE;

  const previewResult = runtime?.preview?.ok
    ? runtime.preview
    : await previewUploadFromUrl(c.url, settings);

  if (!previewResult?.ok || !previewResult?.draft) {
    return buildResult({
      ok: false,
      skipped: true,
      error: previewResult?.error || "preview_failed",
      reason: previewResult?.reason || "preview_failed",
      preview: previewResult?.preview || null,
      qc: { ok: false, metrics: {} },
    });
  }

  const draft = previewResult.draft;
  const qcGate = evaluateQcGate(previewResult.preview || {}, settings);
  if (!qcGate.ok) {
    return buildQcBlockedResult({ qcGate, previewResult, draft });
  }

  const qcInfo = { ok: true, metrics: qcGate.metrics || {} };
  const localImageBase = resolveLocalImageBase(settings);

  const outDir = path.join(process.cwd(), "out");
  const rawMax = Number(settings.maxContentImages);
  const maxContentImages = Number.isFinite(rawMax) ? rawMax : 30;
  const filteredImages = Array.isArray(previewResult?.preview?.contentImagesFiltered)
    ? previewResult.preview.contentImagesFiltered
    : [];
  const contentImages = filteredImages.slice(0, Math.max(0, maxContentImages));
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

  if (String(settings.pagesAutoDeploy || "").trim() === "1") {
    const deployRes = await deployPagesAssets({
      directory: outDir,
      subDirName: "couplus-out",
      projectName: String(settings.pagesProjectName || "").trim(),
      apiToken: String(settings.pagesApiToken || "").trim(),
      accountId: String(settings.pagesAccountId || "").trim(),
    });
    if (!deployRes.ok) {
      return buildResult({
        ok: false,
        skipped: false,
        error: "pages_deploy_failed",
        detail: deployRes.error,
        deploy: {
          code: deployRes.code ?? null,
          stdout: deployRes.stdout || "",
          stderr: deployRes.stderr || "",
        },
        qc: qcInfo,
        preview: previewResult.preview,
        draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
      });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const imageUrl = downloaded.urlMap[draft.imageUrl];
  if (!imageUrl) {
    return buildResult({
      ok: false,
      skipped: false,
      error: "main image download failed",
      qc: qcInfo,
      preview: previewResult.preview,
      draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
    });
  }

  const imageReachable = await isUrlReachable(imageUrl, IMAGE_CHECK_TIMEOUT_MS);
  if (!imageReachable) {
    return buildResult({
      ok: false,
      skipped: false,
      error: "image_host_unreachable",
      imageUrl,
      qc: qcInfo,
      preview: previewResult.preview,
      draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
    });
  }

  const contentLocalUrls = contentImages.map((u) => downloaded.urlMap[u]).filter(Boolean);
  const contentHtml =
    contentLocalUrls.length > 0 ? buildImageOnlyHtmlFromUrls(contentLocalUrls) : draft.contentText || "";

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

  const useAutoCategory =
    String(settings.autoCategoryMatch || process.env.AUTO_CATEGORY_MATCH || "").trim() === "1";
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
    const useRecommend =
      String(settings.autoCategoryRecommend || process.env.AUTO_CATEGORY_RECOMMEND || "").trim() ===
      "1";
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

  const disableOptions = String(settings.disableOptions ?? '0').trim() === '1';
  const optionsUsed =
    !disableOptions && Array.isArray(draft.options) && draft.options.length > 0
      ? makeUniqueOptions(draft.options)
      : [];

  const baseBody = buildSellerProductBody({
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
            const minPrice = Number.isFinite(Number(settings.priceMin)) ? Number(settings.priceMin) : 1000;
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
    items: baseBody?.items || [],
  });

  if (payloadOnly) {
    return buildResult({
      ok: true,
      payloadOnly: true,
      payload: baseBody,
      payloadCheck,
      qc: qcInfo,
      preview: previewResult.preview,
      draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
      finalPrice,
      category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory },
      optionsUsed: optionsUsed.map((opt) => opt.label),
      create: emptyCreate(),
      followUp: emptyFollowUp(),
    });
  }

  // Safety guard: QC false인 경우 어떤 경로에서도 create 호출 금지.
  if (qcGate.ok !== true) {
    return buildQcBlockedResult({ qcGate, previewResult, draft });
  }

  const createAttempt = await createWithErrorItemRetry({
    vendorId,
    body: baseBody,
    accessKey,
    secretKey,
    finalCategoryCode,
    createFn: runtime?.createSellerProductFn || createSellerProduct,
  });
  const res = createAttempt.response;

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

  return buildResult({
    ok: true,
    draft: { title: draft.title, price: draft.price, imageUrl: draft.imageUrl },
    finalPrice,
    category: { requested: displayCategoryCode, used: finalCategoryCode, auto: allowAutoCategory },
    optionsUsed: optionsUsed.map((opt) => opt.label),
    payloadCheck,
    qc: qcInfo,
    preview: previewResult.preview,
    createRetry: createAttempt.retry,
    create: { status: res.status, body: createBody, sellerProductId: createdId },
    approval,
    followUp: normalizeFollowUp(followUp),
  });
}

async function createWithErrorItemRetry({
  vendorId,
  body,
  accessKey,
  secretKey,
  finalCategoryCode,
  createFn = createSellerProduct,
}) {
  if (typeof createFn !== "function") {
    throw new Error("createFn must be a function");
  }

  let currentBody = cloneJson(body);
  let response = await createFn({ vendorId, body: currentBody, accessKey, secretKey });
  let retry = { attempts: 0, appliedFixes: [], errorItems: [] };

  for (let attempt = 1; attempt <= CREATE_RETRY_MAX; attempt += 1) {
    const parsed = safeJson(response.body);
    const errorItems = extractErrorItems(parsed);
    if (isCreateSuccess(parsed)) break;
    if (errorItems.length === 0) break;

    const fix = applyErrorItemFixes({ body: currentBody, errorItems, finalCategoryCode });
    if (!fix.changed) {
      retry = {
        attempts: attempt - 1,
        appliedFixes: retry.appliedFixes,
        errorItems,
      };
      break;
    }

    retry = {
      attempts: attempt,
      appliedFixes: [...retry.appliedFixes, ...fix.appliedFixes],
      errorItems,
    };

    currentBody = fix.body;
    response = await createFn({ vendorId, body: currentBody, accessKey, secretKey });
  }

  return { response, retry };
}

function isCreateSuccess(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object") return false;
  if (parsedBody.code === "SUCCESS") return true;
  return false;
}

function extractErrorItems(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object") return [];
  const items = parsedBody?.data?.errorItems || parsedBody?.errorItems || [];
  return Array.isArray(items) ? items : [];
}

function applyErrorItemFixes({ body, errorItems, finalCategoryCode }) {
  const cloned = cloneJson(body);
  const items = Array.isArray(cloned?.items) ? cloned.items : [];
  if (items.length === 0) {
    return { changed: false, body: cloned, appliedFixes: [] };
  }

  const textBlob = errorItems
    .map((item) => [item?.message, item?.errorMessage, item?.field].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();

  const needsAttributes =
    textBlob.includes("attribute") ||
    textBlob.includes("속성") ||
    textBlob.includes("필수") ||
    textBlob.includes("required");

  const appliedFixes = [];
  let changed = false;

  if (needsAttributes) {
    const requiredAttrs = getRequiredAttributes(finalCategoryCode);
    for (const item of items) {
      const before = Array.isArray(item.attributes) ? item.attributes.length : 0;
      item.attributes = mergeAttributes(item.attributes, requiredAttrs);
      const after = Array.isArray(item.attributes) ? item.attributes.length : 0;
      if (after > before) changed = true;
    }
    if (changed) {
      appliedFixes.push(`required_attributes_autofill:${String(finalCategoryCode || "auto")}`);
    }
  }

  return {
    changed,
    body: cloned,
    appliedFixes,
  };
}

function getRequiredAttributes(categoryCode) {
  const code = Number(categoryCode);
  const byCategory = CATEGORY_REQUIRED_ATTRIBUTES[code];
  if (Array.isArray(byCategory) && byCategory.length > 0) return byCategory;
  return [
    { attributeTypeName: "사이즈", attributeValueName: "FREE" },
    { attributeTypeName: "수량", attributeValueName: "1개" },
  ];
}

function mergeAttributes(current, required) {
  const out = Array.isArray(current) ? [...current] : [];
  const map = new Map(
    out
      .map((attr) => {
        const type = String(attr?.attributeTypeName || "").trim().toLowerCase();
        return type ? [type, true] : null;
      })
      .filter(Boolean),
  );

  for (const req of required) {
    const type = String(req?.attributeTypeName || "").trim();
    const value = String(req?.attributeValueName || "").trim();
    if (!type || !value) continue;
    const key = type.toLowerCase();
    if (map.has(key)) continue;
    out.push({ attributeTypeName: type, attributeValueName: value });
    map.set(key, true);
  }
  return out;
}

function safeJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
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
    const expectedStock = Number.isFinite(opt.stock) && Number(opt.stock) > 0 ? Number(opt.stock) : 10;
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
