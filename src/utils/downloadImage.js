import { chromium } from "playwright";

function guessExtFromMime(mime) {
  if (!mime) return ".jpg";
  const m = String(mime).toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  return ".jpg";
}

/**
 * Download an image using Playwright request context with referer.
 * This helps for hotlink-protected CDNs.
 */
export async function downloadImageBufferWithPlaywright({ pageUrl, imageUrl }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  const res = await page.request.get(imageUrl, {
    headers: { referer: pageUrl },
  });

  const status = res.status();
  const headers = res.headers();
  const mime = headers?.["content-type"] || headers?.["Content-Type"];

  if (status < 200 || status >= 300) {
    await browser.close();
    return {
      ok: false,
      status,
      error: `download_failed_${status}`,
      mime,
    };
  }

  const buf = await res.body();
  await browser.close();

  return {
    ok: true,
    buffer: buf,
    mimeType: mime || "image/jpeg",
    ext: guessExtFromMime(mime),
  };
}
