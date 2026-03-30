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
  domeggookPrivateApiLogin,
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

async function resolveShippingMethodCode({ uploadedProduct }) {
  const meta = uploadedProduct?.meta && typeof uploadedProduct.meta === "object"
    ? uploadedProduct.meta
    : {};
  const sourceUrl = String(uploadedProduct?.sourceUrl || "").trim();
  const cached = Number(meta?.sourceShippingFee);
  if (Number.isFinite(cached)) return cached === 0 ? "S" : "P";
  if (!sourceUrl) return "P";
  try {
    const parsed = await parseProductFromDomaeqq(sourceUrl);
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

export async function createDomeggookOrderForCoupangOrder({
  userId = "",
  settings = {},
  orderRecord = null,
  receipt = 0,
  dryRun = false,
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

  if (uploadedProduct?.meta?.sourcePurchase?.minimumOrderQty > 1) {
    return {
      ok: false,
      error: "minimum_order_qty_gt_1",
      minimumOrderQty: uploadedProduct.meta.sourcePurchase.minimumOrderQty,
    };
  }

  const shippingMethodCode = await resolveShippingMethodCode({ uploadedProduct });
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
  const payloadPreview = {
    receipt: Number(receipt) === 1 ? 1 : 0,
    itemEntries,
    deliinfo,
    alliance: "",
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      payloadPreview,
      mapping: {
        source: resolution.source,
        itemNo: resolution.itemNo,
        optionCode: resolution.optionCode || "00",
        optionName: resolution.optionName || "",
      },
    };
  }

  const login = await domeggookPrivateApiLogin({
    apiKey: creds.apiKey,
    memberId: creds.memberId,
    password: creds.password,
    userAgent: "Couplus/1.0",
  });
  const created = await domeggookPrivateApiCreateOrder({
    apiKey: creds.apiKey,
    memberId: creds.memberId,
    sessionId: String(login?.sId || "").trim(),
    receipt,
    itemEntries,
    deliinfo,
    alliance: "",
  });
  const normalized = normalizeDomeggookPrivateCreateOrder(created);

  return {
    ok: true,
    payloadPreview,
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
