import fs from "node:fs";
import { chromium } from "playwright";

const UPLOAD_URL = "https://domeggook.com/main/myBuy/order/my_orderExcelForm.php";

function firstExisting(paths = []) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

async function bestEffortFindPayUrl(page) {
  // Try to find a link/button that usually leads to payment.
  const candidates = [
    "a:has-text('결제하러')",
    "a:has-text('결제하기')",
    "a:has-text('주문/결제')",
    "button:has-text('결제하러')",
    "button:has-text('결제하기')",
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      const href = await loc.getAttribute("href").catch(() => null);
      if (href) {
        try {
          return new URL(href, page.url()).toString();
        } catch {
          return href;
        }
      }
      // no href => click and take URL
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        loc.click().catch(() => {}),
      ]);
      return page.url();
    }
  }

  return page.url();
}

export async function uploadVendorPurchaseExcel({ vendor, filePath, settings = {}, storageStateDefaultPath = "" }) {
  const v = String(vendor || "").trim();
  if (!v) return { ok: false, error: "missing_vendor" };

  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: "file_not_found", filePath };
  }

  // Prefer per-user configured storageStatePath, then default path from server config.
  const configuredPath =
    v === "domeme"
      ? String(settings.domemeStorageStatePath || "").trim()
      : String(settings.domeggookStorageStatePath || "").trim();

  const storageStatePath = firstExisting([configuredPath, storageStateDefaultPath]);

  const browser = await chromium.launch({ headless: true });
  const context = storageStatePath
    ? await browser.newContext({ storageState: storageStatePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    const fileInput = page.locator("input[type='file']").first();
    if (!(await fileInput.count())) {
      return { ok: false, error: "file_input_not_found", url: page.url() };
    }

    await fileInput.setInputFiles(filePath);

    const uploadBtn = page
      .locator("button:has-text('업로드'), button:has-text('등록'), input[type='submit'], button[type='submit']")
      .first();

    if (await uploadBtn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        uploadBtn.click().catch(() => {}),
      ]);
    }

    // After upload, try to discover the payment URL.
    const payUrl = await bestEffortFindPayUrl(page);

    return { ok: true, vendor: v, payUrl, currentUrl: page.url(), usedStorageState: Boolean(storageStatePath) };
  } catch (e) {
    return { ok: false, error: "upload_failed", detail: String(e?.message || e) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
