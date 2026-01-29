import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

async function pickMainImageSrc(page) {
  // 도매꾹은 mainThumb가 제일 안정적
  const candidates = [
    "img.mainThumb",
    "#lThumbImg",
    "img#lThumbImg",
    "#lThumbWrap img",
    "img",
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "attached", timeout: 8000 });
      const src = normalizeUrl(await loc.getAttribute("src"));
      if (src && src.startsWith("http")) return src;
    } catch {}
  }
  return null;
}

async function downloadImageBufferWithPlaywright({ pageUrl, imageUrl }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 페이지를 먼저 열어 쿠키/세션/리퍼러 컨텍스트를 만든다
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // 같은 컨텍스트로 이미지 요청 (리퍼러 포함)
  const res = await page.request.get(imageUrl, {
    headers: { referer: pageUrl },
  });

  const status = res.status();
  if (status < 200 || status >= 300) {
    await browser.close();
    throw new Error(`image download failed: ${status}\nIMAGE: ${imageUrl}`);
  }

  const buf = await res.body();
  await browser.close();
  return buf;
}

(async () => {
  const pageUrl = process.argv[2];
  if (!pageUrl) {
    console.log("USAGE: node step19_upload_image_from_url.js <domeggookProductUrl>");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const src = await pickMainImageSrc(page);
  await browser.close();

  if (!src) {
    console.log("FAILED: cannot find main image src");
    process.exit(1);
  }

  console.log("MAIN IMAGE SRC:", src);

  const outDir = path.join(process.cwd(), "out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const localPath = path.join(outDir, "tmp_main.jpg");

  console.log("DOWNLOADING...");
  const buf = await downloadImageBufferWithPlaywright({ pageUrl, imageUrl: src });

  fs.writeFileSync(localPath, buf);
  console.log("SAVED:", localPath, "size:", buf.length);
})();
