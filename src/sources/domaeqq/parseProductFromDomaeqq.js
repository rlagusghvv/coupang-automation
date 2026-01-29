import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { makeDraft } from "../../domain/productDraft.js";

function floorTo10Won(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return NaN;
  return Math.floor(x / 10) * 10;
}

function pickPriceFromText(allText) {
  const m = String(allText).match(/(\d[\d,]{1,})\s*원/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

async function pickMainImageSrc(page) {
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

export async function parseProductFromDomaeqq(url) {
  const browser = await chromium.launch({ headless: true });
  const storageStatePath =
    process.env.DOMEGGOOK_STORAGE_STATE ||
    path.join(process.cwd(), "storageState.json");

  const context = fs.existsSync(storageStatePath)
    ? await browser.newContext({ storageState: storageStatePath })
    : await browser.newContext();

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2000);

    const titleCandidate = page.locator("h1, h2").first();
    const titleText = (await titleCandidate.textContent().catch(() => null))?.trim();

    const priceCandidate = page.locator("text=/\\d[\\d,]*\\s*원/").first();
    const priceText = (await priceCandidate.textContent().catch(() => null))?.trim();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const priceRaw =
      Number(String(priceText || "").replace(/[^\d]/g, "")) ||
      pickPriceFromText(bodyText) ||
      9900;

    const price = Math.max(1000, floorTo10Won(priceRaw) || 1000);

    // 대표 이미지: 메인 썸네일 우선
    let imageUrl = await pickMainImageSrc(page);

    // 없으면 og:image
    if (!imageUrl) {
      imageUrl = normalizeUrl(
        await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null),
      );
    }

    // 없으면 첫 이미지 후보
    if (!imageUrl) {
      imageUrl = await page.evaluate(() => {
        const imgs = Array.from(document.images)
          .map((img) => img.currentSrc || img.src)
          .filter((src) => src && src.startsWith("http"))
          .filter((src) => !/logo|icon|menu|sprite/i.test(src));
        return imgs[0] || null;
      });
    }

    // ✅ 상세 HTML 추출(스크립트/스타일 제거 + img src 정리 + 업그레이드)
    const contentHtml = await page.evaluate(() => {
      const normHtml = (html) =>
        String(html || "")
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .trim();

      const blocks = Array.from(document.querySelectorAll("div, section, article"))
        .map((el) => {
          const id = (el.id || "").toLowerCase();
          const cls = (el.className || "").toString().toLowerCase();
          const html = el.innerHTML || "";
          const score =
            html.length +
            (id.includes("detail") || cls.includes("detail") ? 5000 : 0) +
            (id.includes("content") || cls.includes("content") ? 3000 : 0) +
            (id.includes("product") || cls.includes("product") ? 1000 : 0);
          return { el, score, html };
        })
        .sort((a, b) => b.score - a.score);

      const wrapper = document.createElement("div");
      wrapper.innerHTML = blocks[0] ? blocks[0].html : "";

      wrapper.querySelectorAll("img").forEach((img) => {
        const ds = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy");
        if ((!img.getAttribute("src") || img.getAttribute("src") === "") && ds) img.setAttribute("src", ds);
      });

      // 상대경로 보정
      wrapper.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (src.startsWith("//")) img.setAttribute("src", "https:" + src);
        else if (src.startsWith("/")) img.setAttribute("src", location.origin + src);
      });

      return normHtml(wrapper.innerHTML);
    });

    return makeDraft({
      sourceUrl: url,
      title: titleText || (await page.title().catch(() => "도매꾹 상품")),
      price,
      imageUrl: imageUrl || "https://via.placeholder.com/1000",
      contentText: contentHtml || titleText || "",
    });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
