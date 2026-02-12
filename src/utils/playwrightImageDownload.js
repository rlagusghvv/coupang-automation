import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { buildLocalImageUrl } from "./localImageHost.js";
import { expandCandidateImageUrls, normalizeUrl } from "./imageUrlNormalize.js";

const CONTENT_TYPE_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

// normalizeUrl moved to utils/imageUrlNormalize.js

function guessExtFromUrl(imageUrl) {
  try {
    const p = new URL(imageUrl).pathname || "";
    const ext = path.extname(p).toLowerCase();
    if (ext && ext.length <= 5) return ext;
  } catch {}
  return "";
}

function pickExt({ imageUrl, contentType }) {
  const byType = CONTENT_TYPE_EXT[(contentType || "").split(";")[0]?.trim()];
  if (byType) return byType;
  const byUrl = guessExtFromUrl(imageUrl);
  if (byUrl) return byUrl;
  return ".jpg";
}

function makeFileName(imageUrl, ext, index) {
  const hash = crypto.createHash("sha1").update(String(imageUrl)).digest("hex").slice(0, 12);
  const idx = Number.isInteger(index) ? String(index).padStart(2, "0") : "00";
  return `${hash}_${idx}${ext}`;
}

export async function downloadImagesWithPlaywright({
  pageUrl,
  imageUrls,
  outDir,
  baseUrl,
  storageStatePath,
  timeoutMs = 90000,
  maxImages = 50,
}) {
  const result = { urlMap: {}, files: [] };
  if (!pageUrl || !Array.isArray(imageUrls) || imageUrls.length === 0) return result;

  const normalized = Array.from(
    new Set(
      imageUrls
        .flatMap((u) => expandCandidateImageUrls(u))
        .map(normalizeUrl)
        .filter((u) => u && /^https?:\/\//i.test(u)),
    ),
  ).slice(0, maxImages);

  if (normalized.length === 0) return result;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // Domeggook often blocks/changes responses based on UA.
  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  const extraHTTPHeaders = {
    "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };

  const contextOptions = {
    userAgent,
    extraHTTPHeaders,
    ...(storageStatePath && fs.existsSync(storageStatePath)
      ? { storageState: storageStatePath }
      : {}),
  };

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1200);

    for (let i = 0; i < normalized.length; i += 1) {
      const imageUrl = normalized[i];
      try {
        const res = await page.request.get(imageUrl, {
          maxRedirects: 10,
          headers: {
            referer: pageUrl,
            // Some CDNs require UA also on the request layer.
            "user-agent": userAgent,
          },
        });
        const status = res.status();
        if (status < 200 || status >= 300) continue;

        const contentType = res.headers()["content-type"] || "";
        if (!/^image\//i.test(contentType)) {
          // Avoid saving HTML login pages, etc.
          continue;
        }

        const ext = pickExt({ imageUrl, contentType });
        const fileName = makeFileName(imageUrl, ext, i);
        const filePath = path.join(outDir, fileName);
        const buf = await res.body();
        if (!buf || buf.length < 16) continue;
        fs.writeFileSync(filePath, buf);

        const localUrl = buildLocalImageUrl(baseUrl, fileName);
        result.urlMap[imageUrl] = localUrl;
        result.files.push({ imageUrl, fileName, filePath, localUrl, size: buf.length });
      } catch {
        // ignore individual image failures
      }
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}
