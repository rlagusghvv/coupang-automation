import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getOrderSheets } from "../coupang/api/getOrderSheets.js";
import {
  COUPANG_ACCESS_KEY,
  COUPANG_SECRET_KEY,
  COUPANG_VENDOR_ID,
} from "../config/env.js";

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
  // dateStr: YYYY-MM-DD
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
      body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    } catch {
      return { ok: false, error: "invalid_json", body: res.body };
    }
    if (!body || body.code !== "SUCCESS") {
      return { ok: false, error: "api_failed", body };
    }
    const data = body.data || [];
    if (Array.isArray(data)) all.push(...data);
    nextToken = body.nextToken || "";
  } while (nextToken && guard < 200);

  return { ok: true, data: all };
}

export async function exportOrdersToDomeme({
  dateFrom,
  dateTo,
  status = "ACCEPT",
  settings = {},
}) {
  const accessKey = String(settings.coupangAccessKey || COUPANG_ACCESS_KEY || "").trim();
  const secretKey = String(settings.coupangSecretKey || COUPANG_SECRET_KEY || "").trim();
  const vendorId = String(settings.coupangVendorId || COUPANG_VENDOR_ID || "").trim();

  const missingEnv = [];
  if (!accessKey) missingEnv.push("COUPANG_ACCESS_KEY");
  if (!secretKey) missingEnv.push("COUPANG_SECRET_KEY");
  if (!vendorId) missingEnv.push("COUPANG_VENDOR_ID");
  if (missingEnv.length > 0) {
    return { ok: false, skipped: true, reason: "missing_coupang_env", missing: missingEnv };
  }

  const createdAtFrom = formatDateKST(dateFrom);
  const createdAtTo = formatDateKST(dateTo);

  const orderRes = await fetchOrderSheetsAll({
    vendorId,
    accessKey,
    secretKey,
    createdAtFrom,
    createdAtTo,
    status,
  });
  if (!orderRes.ok) return orderRes;

  const { map: skuMap, path: skuMapPath } = loadSkuMap(settings);
  const missing = [];

  const rows = [];
  for (const sheet of orderRes.data) {
    const receiver = sheet.receiver || {};
    const delivery = sheet.delivery || {};
    const orderItems = sheet.orderItems || [];
    for (const item of orderItems) {
      const vendorItemId = String(item.vendorItemId || "");
      const key = vendorItemId ? vendorItemId : String(item.sellerProductItemId || "");
      const mapped = skuMap[key] || null;
      if (!mapped) {
        missing.push({ key, vendorItemId, itemName: item.vendorItemName || item.sellerProductName || "" });
      }

      const itemNo = mapped?.itemNo || "";
      const optionCode = mapped?.optionCode || "";
      const optionName = mapped?.optionName || item.vendorItemName || item.sellerProductName || "";
      const qty = Math.max(
        0,
        Number(item.shippingCount || 0) -
          Number(item.holdCountForCancel || 0) -
          Number(item.cancelCount || 0),
      );

      rows.push(
        makeRow({
          market: "쿠팡",
          itemNo,
          optionCode,
          optionName,
          qty,
          receiverName: receiver.name || "",
          postCode: receiver.postCode || "",
          addr1: receiver.addr1 || "",
          addr2: receiver.addr2 || "",
          phone: receiver.safeNumber || receiver.receiverNumber || "",
          altPhone: receiver.receiverNumber || "",
          mallName: "쿠팡",
          memo: "",
          deliveryMemo: delivery.parcelPrintMessage || "",
          pcc: receiver.pcc || "",
        }),
      );
    }
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

  if (py.status !== 0) {
    return {
      ok: false,
      error: "excel_build_failed",
      stderr: py.stderr?.toString() || "",
    };
  }

  if (missing.length > 0) {
    const missingPath = path.join(outDir, "missing_sku_map.json");
    fs.writeFileSync(missingPath, JSON.stringify(missing, null, 2), "utf-8");
  }

  return {
    ok: true,
    filePath: outPath,
    missingMapCount: missing.length,
    skuMapPath,
    rowCount: rows.length,
  };
}
