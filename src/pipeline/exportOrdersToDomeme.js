import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getOrderSheets } from "../coupang/api/getOrderSheets.js";
import { parseCoupangJson } from "../coupang/parseJson.js";
import {
  COUPANG_ACCESS_KEY,
  COUPANG_SECRET_KEY,
  COUPANG_VENDOR_ID,
} from "../config/env.js";
import {
  getUploadedProductBySellerProductId,
  listUploadedProducts,
  normalizeTitleForDedupe,
  updateUploadedProductById,
} from "../server/storage_sqlite.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";

const DEFAULT_HEADERS = [
  "마켓",
  "상품번호",
  "옵션코드",
  "옵션명",
  "수량",
  "수령자명",
  "우편번호",
  "배송주소",
  "배송 상세주소\n(선택입력)",
  "휴대전화",
  "추가연락처\n(선택입력)",
  "쇼핑몰명\n(도매매 전용)",
  "전달사항",
  "배송요청사항\n(도매매 전용)",
  "통관고유번호\n(해외직배송 전용)",
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function formatDateKST(dateStr) {
  return `${dateStr}+09:00`;
}

function loadSkuMap(settings = {}) {
  const mapPath =
    settings.orderSkuMapPath ||
    process.env.ORDER_SKU_MAP_PATH ||
    path.join(process.cwd(), "data", "sku_map.json");
  if (!fs.existsSync(mapPath)) return { map: {}, path: mapPath };
  try {
    const json = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    return { map: json || {}, path: mapPath };
  } catch {
    return { map: {}, path: mapPath };
  }
}

function makeRow({
  market,
  itemNo,
  optionCode,
  optionName,
  qty,
  receiverName,
  postCode,
  addr1,
  addr2,
  phone,
  altPhone,
  mallName,
  memo,
  deliveryMemo,
  pcc,
}) {
  return [
    market,
    itemNo,
    optionCode,
    optionName,
    qty,
    receiverName,
    postCode,
    addr1,
    addr2,
    phone,
    altPhone,
    mallName,
    memo,
    deliveryMemo,
    pcc,
  ];
}

function extractDomeggookItemNo(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    const pathNo = String(u.pathname || "").match(/\/(\d{6,})(?:\/|$)/);
    if (pathNo?.[1]) return pathNo[1];
    const qNo = String(u.searchParams.get("no") || "").trim();
    if (/^\d{6,}$/.test(qNo)) return qNo;
  } catch {}
  return "";
}

function normalizeOptionText(raw) {
  return String(raw || "")
    .replace(/^\s*\d+\s*[\.\)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizePurchaseSource(raw = {}, sourceUrl = "") {
  const itemNo = String(raw?.itemNo || extractDomeggookItemNo(sourceUrl) || "").trim();
  const minimumOrderQty =
    Number.isFinite(Number(raw?.minimumOrderQty)) && Number(raw.minimumOrderQty) > 0
      ? Number(raw.minimumOrderQty)
      : 1;
  const optionMappings = Array.isArray(raw?.optionMappings)
    ? raw.optionMappings
        .map((mapping) => {
          const sellerItemName = String(mapping?.sellerItemName || "").trim();
          const supplierOptionCode = String(
            mapping?.supplierOptionCode || mapping?.optionCode || "",
          ).trim();
          const supplierOptionName = String(
            mapping?.supplierOptionName || mapping?.optionName || "",
          ).trim();
          const values = Array.isArray(mapping?.values)
            ? mapping.values
                .map((pair) => ({
                  optionName: String(pair?.optionName || "").trim(),
                  optionValue: String(pair?.optionValue || "").trim(),
                }))
                .filter((pair) => pair.optionName && pair.optionValue)
            : [];
          if (!sellerItemName && !supplierOptionCode && !supplierOptionName) return null;
          return {
            sellerItemName,
            supplierOptionCode,
            supplierOptionName,
            values,
          };
        })
        .filter(Boolean)
    : [];

  return {
    vendor: String(raw?.vendor || "domeggook").trim() || "domeggook",
    itemNo,
    minimumOrderQty,
    optionMappings,
  };
}

function buildPurchaseSourceFromDraft(draft = {}) {
  const sourceUrl = String(draft?.sourceUrl || "").trim();
  const purchase = normalizePurchaseSource(draft?.purchaseSource || {}, sourceUrl);
  if (purchase.itemNo || purchase.optionMappings.length > 0) {
    return purchase;
  }

  const minimumOrderQty =
    Number.isFinite(Number(draft?.purchaseConstraints?.minimumOrderQty)) &&
    Number(draft.purchaseConstraints.minimumOrderQty) > 0
      ? Number(draft.purchaseConstraints.minimumOrderQty)
      : 1;

  const optionMappings = Array.isArray(draft?.options)
    ? draft.options
        .map((opt) => {
          const supplierOptionCode = String(
            opt?.sourceOptionCode || opt?.optionCode || "",
          ).trim();
          const supplierOptionName = String(opt?.name || "").trim();
          const values = Array.isArray(opt?.values)
            ? opt.values
                .map((pair) => ({
                  optionName: String(pair?.optionName || "").trim(),
                  optionValue: String(pair?.optionValue || "").trim(),
                }))
                .filter((pair) => pair.optionName && pair.optionValue)
            : [];
          if (!supplierOptionCode && !supplierOptionName) return null;
          return {
            sellerItemName: supplierOptionName,
            supplierOptionCode,
            supplierOptionName,
            values,
          };
        })
        .filter(Boolean)
    : [];

  return normalizePurchaseSource(
    {
      vendor: "domeggook",
      itemNo: extractDomeggookItemNo(sourceUrl),
      minimumOrderQty,
      optionMappings,
    },
    sourceUrl,
  );
}

async function fetchOrderSheetsAll({ vendorId, accessKey, secretKey, createdAtFrom, createdAtTo, status }) {
  const all = [];
  let nextToken = "";
  let guard = 0;
  do {
    guard += 1;
    const res = await getOrderSheets({
      vendorId,
      accessKey,
      secretKey,
      createdAtFrom,
      createdAtTo,
      status,
      nextToken,
      maxPerPage: 50,
    });
    if (res.status !== 200) {
      return { ok: false, error: "coupang_api_error", status: res.status, body: res.body };
    }
    let body;
    try {
      body = typeof res.body === "string" ? parseCoupangJson(res.body) : res.body;
    } catch {
      return { ok: false, error: "invalid_json", body: res.body };
    }
    const code = body?.code;
    const isOk = code === "SUCCESS" || code === 200 || code === "200";
    if (!body || !isOk) {
      return { ok: false, error: "api_failed", body };
    }
    const data = body.data || [];
    if (Array.isArray(data)) all.push(...data);
    nextToken = body.nextToken || "";
  } while (nextToken && guard < 200);

  return { ok: true, data: all };
}

function normalizeStatusList(raw, fallback = ["ACCEPT"]) {
  const src = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
  const out = src
    .map((x) => String(x || "").trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(out.length > 0 ? out : fallback));
}

async function fetchOrderSheetsForStatuses({
  vendorId,
  accessKey,
  secretKey,
  createdAtFrom,
  createdAtTo,
  statuses = [],
}) {
  const statusList = normalizeStatusList(statuses, ["ACCEPT"]);
  const merged = [];
  const warnings = [];
  for (const status of statusList) {
    const res = await fetchOrderSheetsAll({
      vendorId,
      accessKey,
      secretKey,
      createdAtFrom,
      createdAtTo,
      status,
    });
    if (!res.ok) {
      warnings.push({
        status,
        error: res.error || "status_fetch_failed",
        httpStatus: Number(res.status || 0) || null,
      });
      continue;
    }
    merged.push(...res.data);
  }
  if (merged.length === 0 && warnings.length > 0) {
    return {
      ok: false,
      error: "coupang_status_fetch_failed",
      statuses: statusList,
      warnings,
    };
  }
  return { ok: true, data: merged, statuses: statusList, warnings };
}

export async function resolveUploadedProductForOrderItem({ userId, item }) {
  const sellerProductId = String(item?.sellerProductId || "").trim();
  if (sellerProductId) {
    const bySellerProductId = await getUploadedProductBySellerProductId(userId, sellerProductId);
    if (bySellerProductId) return bySellerProductId;
  }

  const titleCandidates = [
    String(item?.sellerProductName || "").trim(),
    String(item?.vendorItemName || "").trim(),
  ].filter(Boolean);
  if (titleCandidates.length === 0) return null;

  const listed = await listUploadedProducts({
    userId,
    q: titleCandidates[0],
    limit: 50,
    offset: 0,
  });
  const normalizedCandidates = new Set(
    titleCandidates.map((title) => normalizeTitleForDedupe(title)).filter(Boolean),
  );
  return (
    (listed.items || []).find((row) => normalizedCandidates.has(normalizeTitleForDedupe(row?.title))) ||
    null
  );
}

export async function resolvePurchaseSourceForUploadedProduct({ uploadedProduct, cache }) {
  const cacheKey = String(uploadedProduct?.id || uploadedProduct?.sourceUrl || "").trim();
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);

  const sourceUrl = String(uploadedProduct?.sourceUrl || uploadedProduct?.meta?.sourceUrl || "").trim();
  let purchase = normalizePurchaseSource(uploadedProduct?.meta?.sourcePurchase || {}, sourceUrl);

  const hadStoredSourcePurchase =
    uploadedProduct?.meta?.sourcePurchase && typeof uploadedProduct.meta.sourcePurchase === "object";
  const needsRebuild = !purchase.itemNo || !hadStoredSourcePurchase;

  if (sourceUrl && needsRebuild) {
    try {
      const parsedDraft = await parseProductFromDomaeqq(sourceUrl);
      const rebuilt = buildPurchaseSourceFromDraft(parsedDraft);
      if (rebuilt.itemNo || rebuilt.optionMappings.length > 0) {
        purchase = rebuilt;
        if (uploadedProduct?.id && uploadedProduct?.userId) {
          try {
            await updateUploadedProductById({
              userId: uploadedProduct.userId,
              id: uploadedProduct.id,
              patch: { metaMerge: { sourcePurchase: rebuilt } },
            });
          } catch {}
        }
      }
    } catch {}
  }

  if (!purchase.itemNo && sourceUrl) {
    purchase = {
      ...purchase,
      itemNo: extractDomeggookItemNo(sourceUrl),
    };
  }

  if (cacheKey) cache.set(cacheKey, purchase);
  return purchase;
}

export function resolveSupplierSelection({ item, purchase, manualMapping = null }) {
  if (manualMapping?.itemNo) {
    return {
      ok: true,
      itemNo: String(manualMapping.itemNo || "").trim(),
      optionCode: String(manualMapping.optionCode || "").trim() || "00",
      optionName: String(manualMapping.optionName || "").trim(),
      source: "manual_map",
    };
  }

  if (!purchase?.itemNo) {
    return { ok: false, reason: "item_no_missing" };
  }

  const optionMappings = Array.isArray(purchase.optionMappings) ? purchase.optionMappings : [];
  if (optionMappings.length === 0) {
    return {
      ok: true,
      itemNo: purchase.itemNo,
      optionCode: "00",
      optionName: "",
      source: "source_purchase_single",
    };
  }

  const candidateNames = [
    String(item?.vendorItemName || "").trim(),
    String(item?.sellerProductItemName || "").trim(),
    String(item?.itemName || "").trim(),
  ].filter(Boolean);
  const normalizedCandidates = candidateNames.map((name) => normalizeOptionText(name)).filter(Boolean);

  const matched = optionMappings.find((mapping) => {
    const sellerItemName = normalizeOptionText(mapping?.sellerItemName || "");
    const supplierOptionName = normalizeOptionText(mapping?.supplierOptionName || "");
    return (
      (sellerItemName && normalizedCandidates.includes(sellerItemName)) ||
      (supplierOptionName && normalizedCandidates.includes(supplierOptionName))
    );
  });

  if (matched) {
    return {
      ok: true,
      itemNo: purchase.itemNo,
      optionCode: String(matched.supplierOptionCode || "").trim(),
      optionName: String(
        matched.supplierOptionName || matched.sellerItemName || candidateNames[0] || "",
      ).trim(),
      source: "source_purchase_option",
    };
  }

  if (optionMappings.length === 1) {
    const only = optionMappings[0] || {};
    return {
      ok: true,
      itemNo: purchase.itemNo,
      optionCode: String(only.supplierOptionCode || "").trim() || "00",
      optionName: String(only.supplierOptionName || only.sellerItemName || "").trim(),
      source: "source_purchase_single_option_fallback",
    };
  }

  return {
    ok: false,
    reason: "option_mapping_missing",
    candidates: candidateNames,
    optionMappings,
  };
}

export async function exportOrdersToDomeme({
  userId = "",
  dateFrom,
  dateTo,
  status = "ACCEPT",
  statuses = [],
  vendor = "domeggook",
  settings = {},
  allowEnvFallback = true,
}) {
  const accessKey = String(
    settings.coupangAccessKey || (allowEnvFallback ? COUPANG_ACCESS_KEY : "") || "",
  ).trim();
  const secretKey = String(
    settings.coupangSecretKey || (allowEnvFallback ? COUPANG_SECRET_KEY : "") || "",
  ).trim();
  const vendorId = String(
    settings.coupangVendorId || (allowEnvFallback ? COUPANG_VENDOR_ID : "") || "",
  ).trim();

  const missingEnv = [];
  if (!accessKey) missingEnv.push("COUPANG_ACCESS_KEY");
  if (!secretKey) missingEnv.push("COUPANG_SECRET_KEY");
  if (!vendorId) missingEnv.push("COUPANG_VENDOR_ID");
  if (missingEnv.length > 0) {
    return { ok: false, skipped: true, reason: "missing_coupang_env", missing: missingEnv };
  }

  const createdAtFrom = formatDateKST(dateFrom);
  const createdAtTo = formatDateKST(dateTo);
  const statusList = normalizeStatusList(
    statuses,
    normalizeStatusList(status, ["ACCEPT", "INSTRUCT", "READY"]),
  );

  const orderRes = await fetchOrderSheetsForStatuses({
    vendorId,
    accessKey,
    secretKey,
    createdAtFrom,
    createdAtTo,
    statuses: statusList,
  });
  if (!orderRes.ok) return orderRes;

  const { map: skuMap, path: skuMapPath } = loadSkuMap(settings);
  const missing = [];
  const sourcePurchaseCache = new Map();
  const normalizedVendor = String(vendor || "domeggook").trim().toLowerCase() || "domeggook";
  const marketLabel = normalizedVendor === "domeme" ? "도매매" : "도매꾹";
  const mallName = normalizedVendor === "domeme" ? "쿠팡" : "";

  const rows = [];
  const seenRowKeys = new Set();
  for (const sheet of orderRes.data) {
    const receiver = sheet.receiver || {};
    const delivery = sheet.delivery || {};
    const orderItems = Array.isArray(sheet.orderItems) ? sheet.orderItems : [];

    for (const item of orderItems) {
      const dedupeKey = [
        String(sheet?.shipmentBoxId || "").trim(),
        String(sheet?.orderId || "").trim(),
        String(item?.vendorItemId || "").trim(),
        String(item?.orderItemId || "").trim(),
      ].join("\t");
      if (seenRowKeys.has(dedupeKey)) continue;

      const qty = Math.max(
        0,
        Number(item.shippingCount || 0) -
          Number(item.holdCountForCancel || 0) -
          Number(item.cancelCount || 0),
      );
      if (qty <= 0) continue;

      const vendorItemId = String(item.vendorItemId || "").trim();
      const sellerProductItemId = String(item.sellerProductItemId || "").trim();
      const manualKey = vendorItemId || sellerProductItemId;
      const manualMapping = manualKey ? skuMap[manualKey] || null : null;

      let resolution = resolveSupplierSelection({
        item,
        purchase: null,
        manualMapping,
      });

      let uploadedProduct = null;
      if (!resolution.ok && userId) {
        uploadedProduct = await resolveUploadedProductForOrderItem({ userId, item });
        if (uploadedProduct) {
          const purchase = await resolvePurchaseSourceForUploadedProduct({
            uploadedProduct,
            cache: sourcePurchaseCache,
          });
          resolution = resolveSupplierSelection({
            item,
            purchase,
            manualMapping,
          });
        }
      }

      if (!resolution.ok) {
        missing.push({
          reason: resolution.reason || "mapping_missing",
          key: manualKey,
          vendorItemId,
          sellerProductItemId,
          sellerProductId: String(item.sellerProductId || "").trim(),
          sellerProductName: String(item.sellerProductName || "").trim(),
          vendorItemName: String(item.vendorItemName || "").trim(),
          sourceUrl: String(uploadedProduct?.sourceUrl || "").trim(),
          itemNo: String(uploadedProduct?.meta?.sourcePurchase?.itemNo || "").trim(),
          source: uploadedProduct ? "uploaded_product" : (manualMapping ? "manual_map" : "unresolved"),
        });
        continue;
      }

      seenRowKeys.add(dedupeKey);
      rows.push(
        makeRow({
          market: marketLabel,
          itemNo: resolution.itemNo,
          optionCode: resolution.optionCode || "00",
          optionName: resolution.optionName || "",
          qty,
          receiverName: receiver.name || "",
          postCode: receiver.postCode || "",
          addr1: receiver.addr1 || "",
          addr2: receiver.addr2 || "",
          phone: receiver.safeNumber || receiver.receiverNumber || "",
          altPhone: receiver.receiverNumber || "",
          mallName,
          memo: "",
          deliveryMemo: delivery.parcelPrintMessage || "",
          pcc: receiver.pcc || "",
        }),
      );
    }
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error: "supplier_mapping_missing",
      missingMapCount: missing.length,
      missing,
      skuMapPath,
      rowCount: 0,
    };
  }

  const outDir = path.join(process.cwd(), "out", "order_exports");
  ensureDir(outDir);
  const fileName = `order_batch_${dateFrom.replace(/-/g, "")}_${dateTo.replace(/-/g, "")}.xlsx`;
  const outPath = path.join(outDir, fileName);
  const tempJson = path.join(outDir, `order_batch_${Date.now()}.json`);
  fs.writeFileSync(tempJson, JSON.stringify({ headers: DEFAULT_HEADERS, rows }, null, 2), "utf-8");

  const py = spawnSync("python3", [
    path.join(process.cwd(), "scripts", "build_order_excel.py"),
    tempJson,
    outPath,
  ]);

  try {
    fs.unlinkSync(tempJson);
  } catch {}

  if (py.status !== 0) {
    return {
      ok: false,
      error: "excel_build_failed",
      stderr: py.stderr?.toString() || "",
    };
  }

  const missingPath = path.join(outDir, "missing_sku_map.json");
  fs.writeFileSync(missingPath, JSON.stringify(missing, null, 2), "utf-8");

  return {
    ok: true,
    filePath: outPath,
    missingMapCount: missing.length,
    missingPath,
    skuMapPath,
    rowCount: rows.length,
    statuses: statusList,
    warnings: Array.isArray(orderRes.warnings) ? orderRes.warnings : [],
  };
}
