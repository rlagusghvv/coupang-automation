import fs from "node:fs";
import path from "node:path";
import {
  getUploadedProductBySellerProductId,
  listUploadedProducts,
  normalizeTitleForDedupe,
  updateUploadedProductById,
} from "../server/storage_sqlite.js";
import { parseProductFromDomaeqq } from "../sources/domaeqq/parseProductFromDomaeqq.js";
import {
  domeggookPrivateApiCreateOrder,
  domeggookPrivateApiGetMyAsset,
  domeggookPrivateApiLogin,
  normalizeDomeggookPrivateAsset,
  normalizeDomeggookPrivateCreateOrder,
  resolveDomeggookPrivateCredentials,
} from "../utils/domeggook_private_api.js";
import {
  resolvePurchaseSourceForUploadedProduct,
  resolveSupplierSelection,
} from "./exportOrdersToDomeme.js";

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

function sanitizeField(value) {
  return String(value || "").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
}

function pickFirst(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

async function withTimeout(task, timeoutMs, label = "timeout") {
  const ms = Math.max(1_000, Number(timeoutMs) || 0);
  return await Promise.race([
    Promise.resolve().then(() => task),
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(label);
        reject(error);
      }, ms);
    }),
  ]);
}

function normalizePhone(value) {
  const text = sanitizeField(value);
  return text;
}

function computeOrderQty(item = {}) {
  return Math.max(
    0,
    Number(item.shippingCount || 0) -
      Number(item.holdCountForCancel || 0) -
      Number(item.cancelCount || 0),
  );
}

async function resolveUploadedProductForOrderItem({ userId, item }) {
  const sellerProductId = String(item?.sellerProductId || "").trim();
  if (sellerProductId) {
    const bySellerProductId = await getUploadedProductBySellerProductId(
      userId,
      sellerProductId,
    );
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
    (listed.items || []).find((row) =>
      normalizedCandidates.has(normalizeTitleForDedupe(row?.title)),
    ) || null
  );
}

function resolveCachedSourcePrice(uploadedProduct) {
  const meta =
    uploadedProduct?.meta && typeof uploadedProduct.meta === "object"
      ? uploadedProduct.meta
      : {};
  const direct = Number(meta?.sourcePrice);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const audited = Number(meta?.priceAudit?.sourcePrice);
  if (Number.isFinite(audited) && audited > 0) return audited;
  return null;
}

async function resolveShippingMethodCode({
  uploadedProduct,
  allowSourceParse = false,
} = {}) {
  const meta = uploadedProduct?.meta && typeof uploadedProduct.meta === "object"
    ? uploadedProduct.meta
    : {};
  const sourceUrl = String(uploadedProduct?.sourceUrl || "").trim();
  const cached = Number(meta?.sourceShippingFee);
  if (Number.isFinite(cached)) return cached === 0 ? "S" : "P";
  if (!sourceUrl || !allowSourceParse) return "P";
  try {
    const parsed = await withTimeout(
      parseProductFromDomaeqq(sourceUrl),
      6_000,
      "source_shipping_parse_timeout",
    );
    const shippingFee = Number(parsed?.shippingFee);
    const sourceShippingFee = Number.isFinite(shippingFee) ? shippingFee : null;
    if (uploadedProduct?.id && uploadedProduct?.userId && sourceShippingFee != null) {
      try {
        await updateUploadedProductById({
          userId: uploadedProduct.userId,
          id: uploadedProduct.id,
          patch: { metaMerge: { sourceShippingFee } },
        });
      } catch {}
    }
    return sourceShippingFee === 0 ? "S" : "P";
  } catch {
    return "P";
  }
}

function buildDeliInfo(receiver = {}, buyer = {}) {
  const receiverName = sanitizeField(receiver.name);
  const email = sanitizeField(buyer.email || "");
  const postCode = sanitizeField(receiver.postCode);
  const addr1 = sanitizeField(receiver.addr1);
  const addr2 = sanitizeField(receiver.addr2);
  const mobile = normalizePhone(receiver.safeNumber || receiver.receiverNumber);
  const phone = normalizePhone(receiver.receiverNumber || "");
  const company = sanitizeField(receiver.companyName || "");
  return [
    receiverName,
    email,
    postCode,
    addr1,
    addr2,
    mobile,
    phone,
    company,
  ].join("|");
}

function buildItemEntry({
  itemNo,
  optionCode = "00",
  qty = 1,
  shippingMethodCode = "P",
  memo = "",
  deliveryMemo = "",
} = {}) {
  return `dome||${sanitizeField(shippingMethodCode || "P")}||${sanitizeField(
    optionCode || "00",
  )}|${Math.max(1, Number(qty) || 1)}||${sanitizeField(memo)}||${sanitizeField(
    deliveryMemo,
  )}`;
}

async function estimateSupplierCharge({
  uploadedProduct,
  qty = 1,
  shippingMethodCode = "P",
  allowSourceParse = false,
} = {}) {
  const sourceUrl = String(uploadedProduct?.sourceUrl || "").trim();
  const cachedUnitPrice = resolveCachedSourcePrice(uploadedProduct);
  const cachedShippingFee = Number(
    uploadedProduct?.meta && typeof uploadedProduct.meta === "object"
      ? uploadedProduct.meta?.sourceShippingFee
      : NaN,
  );
  const orderQty = Math.max(1, Number(qty) || 1);

  if (Number.isFinite(cachedUnitPrice) && cachedUnitPrice > 0) {
    const shippingFee =
      shippingMethodCode === "S"
        ? 0
        : Number.isFinite(cachedShippingFee) && cachedShippingFee > 0
          ? cachedShippingFee
          : 0;
    return {
      unitPrice: cachedUnitPrice,
      qty: orderQty,
      shippingFee,
      total: cachedUnitPrice * orderQty + shippingFee,
      source: "cached_meta",
    };
  }

  if (!sourceUrl || !allowSourceParse) return null;
  try {
    const parsed = await withTimeout(
      parseProductFromDomaeqq(sourceUrl),
      6_000,
      "source_price_parse_timeout",
    );
    const unitPrice = Number(parsed?.price);
    const shippingFeeRaw = Number(parsed?.shippingFee);
    const shippingFee =
      shippingMethodCode === "S"
        ? 0
        : Number.isFinite(shippingFeeRaw) && shippingFeeRaw > 0
          ? shippingFeeRaw
          : 0;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
    return {
      unitPrice,
      qty: orderQty,
      shippingFee,
      total: unitPrice * orderQty + shippingFee,
      source: "parsed_source",
    };
  } catch {
    return null;
  }
}

async function refreshMinimumOrderQtyFromSource({
  uploadedProduct,
  qty = 1,
  timeoutMs = 8_000,
} = {}) {
  const sourceUrl = String(uploadedProduct?.sourceUrl || uploadedProduct?.meta?.sourceUrl || "").trim();
  if (!uploadedProduct || !sourceUrl) return null;
  try {
    const parsed = await withTimeout(
      parseProductFromDomaeqq(sourceUrl),
      timeoutMs,
      "source_moq_parse_timeout",
    );
    const rawMinimumOrderQty =
      parsed?.minimumOrderQty ??
      parsed?.purchaseConstraints?.minimumOrderQty ??
      parsed?.draft?.purchaseConstraints?.minimumOrderQty;
    const minimumOrderQty =
      Number.isFinite(Number(rawMinimumOrderQty)) && Number(rawMinimumOrderQty) > 0
        ? Number(rawMinimumOrderQty)
        : 1;
    const sourcePurchase =
      uploadedProduct?.meta?.sourcePurchase && typeof uploadedProduct.meta.sourcePurchase === "object"
        ? { ...uploadedProduct.meta.sourcePurchase, minimumOrderQty }
        : { minimumOrderQty };
    const sourcePrice = Number(parsed?.price);
    const sourceShippingFee = Number(parsed?.shippingFee);
    if (uploadedProduct?.id && uploadedProduct?.userId) {
      const metaMerge = {
        sourcePurchase,
        sourceMoqCheckedAt: new Date().toISOString(),
      };
      if (Number.isFinite(sourcePrice) && sourcePrice > 0) {
        metaMerge.sourcePrice = sourcePrice;
      }
      if (Number.isFinite(sourceShippingFee)) {
        metaMerge.sourceShippingFee = sourceShippingFee;
      }
      if (minimumOrderQty > Math.max(1, Number(qty) || 1)) {
        metaMerge.orderBlock = {
          code: "minimum_order_qty_gt_1",
          minimumOrderQty,
          detectedAt: new Date().toISOString(),
          source: "domeggook_source_parse",
        };
      }
      try {
        await updateUploadedProductById({
          userId: uploadedProduct.userId,
          id: uploadedProduct.id,
          patch: { metaMerge },
        });
      } catch {}
    }
    return {
      minimumOrderQty,
      source: "parsed_source",
    };
  } catch {
    return null;
  }
}

async function markMinimumOrderQtyBlocked({
  uploadedProduct,
  minimumOrderQty = 2,
  source = "domeggook_setOrder",
} = {}) {
  const minQty =
    Number.isFinite(Number(minimumOrderQty)) && Number(minimumOrderQty) > 1
      ? Number(minimumOrderQty)
      : 2;
  if (!uploadedProduct?.id || !uploadedProduct?.userId) return;
  const sourcePurchase =
    uploadedProduct?.meta?.sourcePurchase && typeof uploadedProduct.meta.sourcePurchase === "object"
      ? { ...uploadedProduct.meta.sourcePurchase, minimumOrderQty: minQty }
      : { minimumOrderQty: minQty };
  try {
    await updateUploadedProductById({
      userId: uploadedProduct.userId,
      id: uploadedProduct.id,
      patch: {
        metaMerge: {
          sourcePurchase,
          orderBlock: {
            code: "minimum_order_qty_gt_1",
            minimumOrderQty: minQty,
            detectedAt: new Date().toISOString(),
            source,
          },
        },
      },
    });
  } catch {}
}

export async function createDomeggookOrderForCoupangOrder({
  userId = "",
  settings = {},
  orderRecord = null,
  receipt = 0,
  dryRun = false,
  includeAssetCheck = false,
} = {}) {
  if (!userId) throw new Error("userId required");
  if (!orderRecord || typeof orderRecord !== "object") {
    throw new Error("orderRecord required");
  }

  const raw = orderRecord.order && typeof orderRecord.order === "object" ? orderRecord.order : {};
  const sheet = raw.sheet && typeof raw.sheet === "object" ? raw.sheet : {};
  const item = raw.item && typeof raw.item === "object" ? raw.item : {};
  const receiver = sheet.receiver && typeof sheet.receiver === "object" ? sheet.receiver : {};
  const buyer = sheet.orderer && typeof sheet.orderer === "object" ? sheet.orderer : {};

  const qty = computeOrderQty(item);
  if (qty <= 0) {
    return { ok: false, error: "invalid_order_qty" };
  }

  const creds = resolveDomeggookPrivateCredentials(settings);
  if (!creds.apiKey || !creds.memberId || !creds.password) {
    return { ok: false, error: "missing_domeggook_private_credentials" };
  }

  const { map: skuMap, path: skuMapPath } = loadSkuMap(settings);
  const vendorItemId = String(item?.vendorItemId || "").trim();
  const sellerProductItemId = String(item?.sellerProductItemId || "").trim();
  const manualKey = vendorItemId || sellerProductItemId;
  const manualMapping = manualKey ? skuMap[manualKey] || null : null;

  let resolution = resolveSupplierSelection({
    item,
    purchase: null,
    manualMapping,
  });
  let uploadedProduct = null;
  if (!resolution.ok) {
    uploadedProduct = await resolveUploadedProductForOrderItem({ userId, item });
    if (uploadedProduct) {
      const purchase = await resolvePurchaseSourceForUploadedProduct({
        uploadedProduct,
        cache: new Map(),
      });
      resolution = resolveSupplierSelection({
        item,
        purchase,
        manualMapping,
      });
    }
  }

  if (!resolution.ok) {
    return {
      ok: false,
      error: resolution.reason || "supplier_mapping_missing",
      resolution,
      skuMapPath,
    };
  }

  if (!uploadedProduct) {
    uploadedProduct = await resolveUploadedProductForOrderItem({ userId, item });
  }

  const storedMinimumOrderQty = Number(uploadedProduct?.meta?.sourcePurchase?.minimumOrderQty || 1);
  if (Number.isFinite(storedMinimumOrderQty) && storedMinimumOrderQty > qty) {
    return {
      ok: false,
      error: "TOO_LESS_AMOUNT",
      details: "공급처 최소 주문수량보다 쿠팡 주문수량이 적습니다.",
      minimumOrderQty: storedMinimumOrderQty,
      orderQty: qty,
    };
  }

  const shippingMethodCode = await resolveShippingMethodCode({
    uploadedProduct,
    allowSourceParse: dryRun !== true,
  });
  const deliveryMemo = pickFirst(
    sheet?.delivery?.parcelPrintMessage,
    receiver?.parcelPrintMessage,
  );
  const itemEntries = {
    [resolution.itemNo]: buildItemEntry({
      itemNo: resolution.itemNo,
      optionCode: resolution.optionCode || "00",
      qty,
      shippingMethodCode,
      memo: "",
      deliveryMemo,
    }),
  };
  const deliinfo = buildDeliInfo(receiver, buyer);
  const estimate = await estimateSupplierCharge({
    uploadedProduct,
    qty,
    shippingMethodCode,
    allowSourceParse: false,
  });

  if (!dryRun) {
    const refreshedMinimum = await refreshMinimumOrderQtyFromSource({
      uploadedProduct,
      qty,
    });
    if (
      refreshedMinimum &&
      Number.isFinite(Number(refreshedMinimum.minimumOrderQty)) &&
      Number(refreshedMinimum.minimumOrderQty) > qty
    ) {
      return {
        ok: false,
        error: "TOO_LESS_AMOUNT",
        details: "공급처 최소 주문수량보다 쿠팡 주문수량이 적습니다.",
        minimumOrderQty: Number(refreshedMinimum.minimumOrderQty),
        orderQty: qty,
        minimumOrderQtySource: refreshedMinimum.source,
        mapping: {
          source: resolution.source,
          itemNo: resolution.itemNo,
          optionCode: resolution.optionCode || "00",
          optionName: resolution.optionName || "",
          shippingMethodCode,
        },
      };
    }
  }

  const payloadPreview = {
    receipt: Number(receipt) === 1 ? 1 : 0,
    itemEntries,
    deliinfo,
    alliance: "",
  };

  let login = null;
  let asset = null;
  let canOrder = null;
  let canOrderReason = "unchecked";
  try {
    if (includeAssetCheck || !dryRun) {
      login = await domeggookPrivateApiLogin({
        apiKey: creds.apiKey,
        memberId: creds.memberId,
        password: creds.password,
        userAgent: "Couplus/1.0",
      });
      const assetRaw = await domeggookPrivateApiGetMyAsset({
        apiKey: creds.apiKey,
        memberId: creds.memberId,
        sessionId: String(login?.sId || "").trim(),
      });
      asset = normalizeDomeggookPrivateAsset(assetRaw);
      if (estimate && Number.isFinite(Number(estimate.total))) {
        canOrder = Number(asset.emoneyCash || 0) >= Number(estimate.total || 0);
        canOrderReason = canOrder ? "enough_emoney" : "too_less_emoney";
      } else {
        canOrder = null;
        canOrderReason = "estimate_unavailable";
      }
    }
  } catch (e) {
    const upstreamError = String(e?.message || e).trim();
    if (upstreamError === "TOO_LESS_AMOUNT") {
      await markMinimumOrderQtyBlocked({
        uploadedProduct,
        minimumOrderQty: Math.max(qty + 1, 2),
        source: "domeggook_setOrder",
      });
    }
    return {
      ok: false,
      error: upstreamError,
      details: String(e?.details || "").trim(),
      minimumOrderQty: upstreamError === "TOO_LESS_AMOUNT" ? Math.max(qty + 1, 2) : undefined,
      orderQty: qty,
      payloadPreview,
      estimate,
      asset,
      canOrder,
      canOrderReason,
      mapping: {
        source: resolution.source,
        itemNo: resolution.itemNo,
        optionCode: resolution.optionCode || "00",
        optionName: resolution.optionName || "",
        shippingMethodCode,
      },
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      payloadPreview,
      estimate,
      asset,
      canOrder,
      canOrderReason,
      mapping: {
        source: resolution.source,
        itemNo: resolution.itemNo,
        optionCode: resolution.optionCode || "00",
        optionName: resolution.optionName || "",
      },
    };
  }

  if (canOrder === false) {
    return {
      ok: false,
      error: "too_less_emoney_precheck",
      payloadPreview,
      estimate,
      asset,
      canOrder,
      canOrderReason,
      mapping: {
        source: resolution.source,
        itemNo: resolution.itemNo,
        optionCode: resolution.optionCode || "00",
        optionName: resolution.optionName || "",
        shippingMethodCode,
      },
    };
  }

  let normalized = null;
  try {
    const created = await domeggookPrivateApiCreateOrder({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      sessionId: String(login?.sId || "").trim(),
      receipt,
      itemEntries,
      deliinfo,
      alliance: "",
    });
    normalized = normalizeDomeggookPrivateCreateOrder(created);
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
      payloadPreview,
      estimate,
      asset,
      canOrder,
      canOrderReason,
      mapping: {
        source: resolution.source,
        itemNo: resolution.itemNo,
        optionCode: resolution.optionCode || "00",
        optionName: resolution.optionName || "",
        shippingMethodCode,
      },
    };
  }

  return {
    ok: true,
    payloadPreview,
    estimate,
    asset,
    canOrder,
    canOrderReason,
    mapping: {
      source: resolution.source,
      itemNo: resolution.itemNo,
      optionCode: resolution.optionCode || "00",
      optionName: resolution.optionName || "",
      shippingMethodCode,
    },
    orderCreate: normalized,
  };
}
