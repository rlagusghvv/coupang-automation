import fs from "node:fs";
import { chromium } from "playwright";

const USER_DATA_DIR = "/Users/kimhyunhomacmini/.openclaw/browser/openclaw/user-data";

/**
 * Upload an image via Coupang Wing internal uploader.
 * This avoids external URL reachability issues during approval.
 *
 * Endpoint captured from Wing:
 *  POST https://wing.coupang.com/tenants/seller-web/file/image/upload/v2?imageType=REPRESENTATION
 * Response:
 *  { success: true, message: "vendor_inventory/...jpg", ... }
 */
export async function uploadWingImage({ filePath, imageType = "REPRESENTATION" } = {}) {
  if (!filePath) throw new Error("filePath required");
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1200, height: 800 },
  });

  const page = await context.newPage();
  try {
    // ensure cookies/session are loaded
    await page.goto("https://wing.coupang.com/", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    const fd = new FormData();
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf], { type: "image/jpeg" });
    fd.append("file", blob, "upload.jpg");

    const url = `https://wing.coupang.com/tenants/seller-web/file/image/upload/v2?imageType=${encodeURIComponent(imageType)}`;
    const res = await page.request.post(url, {
      multipart: {
        file: {
          name: "upload.jpg",
          mimeType: "image/jpeg",
          buffer: buf,
        },
      },
    });

    const status = res.status();
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      j = null;
    }

    if (status < 200 || status >= 300) {
      return { ok: false, status, error: "upload_failed", body: text.slice(0, 2000) };
    }

    if (!j || j.success !== true || !j.message) {
      return { ok: false, status, error: "unexpected_response", body: text.slice(0, 2000) };
    }

    return {
      ok: true,
      status,
      vendorPath: String(j.message),
      raw: j,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
