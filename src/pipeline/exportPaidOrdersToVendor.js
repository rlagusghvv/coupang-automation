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

// MVP: We generate a very simple purchase sheet (URL + qty + title)
// This is meant for automation smoke-tests from seeded orders.
export async function exportPaidOrdersToVendor({ orders = [], vendor }) {
  const v = String(vendor || "").trim();
  if (!v) return { ok: false, error: "missing_vendor" };

  const items = collectItemsFromOrders(orders).filter((x) => x.source === v);

  const headers = ["sourceUrl", "qty", "title", "orderId"];
  const rows = items.map((it) => [it.sourceUrl, it.qty, it.title, String(it.orderId || "")]);

  const outDir = path.join(process.cwd(), "out", "purchase_sheets");
  ensureDir(outDir);
  const fileName = `purchase_${safeName(v)}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.xlsx`;
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
