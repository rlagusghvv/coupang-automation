import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { buildLocalImageUrl } from "./localImageHost.js";
import { normalizeImageForCoupang } from "./imageNormalize.js";

const CONTENT_TYPE_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (s.startsWith("//")) return `https:${s}`;
  return s;
}

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
        .map(normalizeUrl)
        .filter((u) => u && /^https?:\/\//i.test(u)),
    ),
  ).slice(0, maxImages);

  if (normalized.length === 0) return result;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = storageStatePath && fs.existsSync(storageStatePath)
    ? await browser.newContext({ storageState: storageStatePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1200);

    for (let i = 0; i < normalized.length; i += 1) {
      const imageUrl = normalized[i];
      try {
        const res = await page.request.get(imageUrl, {
          headers: { referer: pageUrl },
        });
        const status = res.status();
        if (status < 200 || status >= 300) continue;

        const contentType = res.headers()["content-type"] || "";
        const ext = pickExt({ imageUrl, contentType });
        const tmpName = makeFileName(imageUrl, ext, i);
        const tmpPath = path.join(outDir, tmpName);
        const buf = await res.body();
        fs.writeFileSync(tmpPath, buf);

        // Normalize (convert to safe JPEG size/dimensions for Coupang).
        // Always output .jpg for stability.
        const jpgName = makeFileName(imageUrl, ".jpg", i);
        const jpgPath = path.join(outDir, jpgName);
        const normPath = jpgPath === tmpPath ? `${tmpPath}.norm.jpg` : jpgPath;

        try {
          await normalizeImageForCoupang({ inputPath: tmpPath, outputPath: normPath });

          // Replace target
          if (normPath !== jpgPath) {
            try {
              // On macOS, rename won't overwrite an existing file.
              if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);
            } catch {}
            try { fs.renameSync(normPath, jpgPath); } catch {}
          }

          // Remove original if different
          if (jpgPath !== tmpPath) {
            try { fs.unlinkSync(tmpPath); } catch {}
          }
        } catch {
          // If normalization fails, fall back to original.
          try {
            if (normPath !== tmpPath && fs.existsSync(normPath)) fs.unlinkSync(normPath);
          } catch {}
        }

        const finalName = fs.existsSync(jpgPath) ? jpgName : tmpName;
        const finalPath = fs.existsSync(jpgPath) ? jpgPath : tmpPath;

        const localUrl = buildLocalImageUrl(baseUrl, finalName);
        result.urlMap[imageUrl] = localUrl;
        result.files.push({ imageUrl, fileName: finalName, filePath: finalPath, localUrl, size: buf.length });
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
