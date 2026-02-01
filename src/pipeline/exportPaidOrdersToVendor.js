import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildXlsx({ outPath, headers, rows }) {
  const outDir = path.dirname(outPath);
  ensureDir(outDir);
  const tmpJson = path.join(outDir, `purchase_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify({ headers, rows }, null, 2), "utf-8");

  const py = spawnSync("python3", [
    path.join(process.cwd(), "scripts", "build_order_excel.py"),
    tmpJson,
    outPath,
  ]);

  try {
    fs.unlinkSync(tmpJson);
  } catch {}

  if (py.status !== 0) {
    return {
      ok: false,
      error: "excel_build_failed",
      stderr: py.stderr?.toString() || "",
    };
  }

  return { ok: true, filePath: outPath, rowCount: rows.length };
}

function collectItemsFromOrders(orders = []) {
  const items = [];
  for (const o of orders) {
    const order = o?.order || {};
    const orderItems = Array.isArray(order.items) ? order.items : [];
    for (const it of orderItems) {
      items.push({
        source: it?.source || o?.source || "",
        sourceUrl: String(it?.sourceUrl || "").trim(),
        title: String(it?.title || "").trim(),
        qty: Number(it?.qty || 0) || 0,
        orderId: o?.id,
      });
    }
  }
  return items.filter((x) => x.sourceUrl && x.qty > 0);
}

// Purchase sheet template (based on the official vendor Excel form headers)
// NOTE: For now, we fill required address fields with placeholders for seeded orders.
export async function exportPaidOrdersToVendor({ orders = [], vendor }) {
  const v = String(vendor || "").trim();
  if (!v) return { ok: false, error: "missing_vendor" };

  const items = collectItemsFromOrders(orders).filter((x) => x.source === v);

  // Template columns (Korean headers)
  const headers = [
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

  const guessProductNo = (url) => {
    const m = String(url || "").match(/(\d{6,})/);
    return m ? m[1] : "";
  };

  const rows = items.map((it) => {
    const productNo = guessProductNo(it.sourceUrl);
    // For products without options, Domeggook requires optionCode "00".
    const optionCode = "00";
    const optionName = it.title || "";
    // Placeholders for seeded orders (real Coupang order fields will replace these later)
    const receiver = "테스트";
    const zipcode = "00000";
    const addr1 = "서울특별시";
    const addr2 = "";
    const phone = "010-0000-0000";
    const extraPhone = "";
    const mallName = v === "domeme" ? "쿠팡" : "";
    const memo = String(it.orderId || "");
    const request = v === "domeme" ? "문앞" : "";
    const customsNo = "";

    const market = v === "domeggook" ? "도매꾹" : "도매매";

    return [
      market,
      productNo,
      optionCode,
      optionName,
      it.qty,
      receiver,
      zipcode,
      addr1,
      addr2,
      phone,
      extraPhone,
      mallName,
      memo,
      request,
      customsNo,
    ];
  });

  const outDir = path.join(process.cwd(), "out", "purchase_sheets");
  ensureDir(outDir);
  // Domeggook Excel upload is strict; prefer legacy .xls for maximum compatibility.
  const fileName = `purchase_${safeName(v)}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.xls`;
  const outPath = path.join(outDir, fileName);

  const built = buildXlsx({ outPath, headers, rows });
  if (!built.ok) return built;

  return {
    ok: true,
    vendor: v,
    filePath: built.filePath,
    rowCount: built.rowCount,
    itemCount: items.length,
  };
}

export async function exportPaidOrdersToVendors({ orders = [], vendors = ["domeme", "domeggook"] }) {
  const results = [];
  for (const v of vendors) {
    // eslint-disable-next-line no-await-in-loop
    const r = await exportPaidOrdersToVendor({ orders, vendor: v });
    results.push(r);
  }
  return { ok: true, results };
}
