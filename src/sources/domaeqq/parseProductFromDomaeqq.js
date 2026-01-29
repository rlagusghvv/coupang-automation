import { chromium } from "playwright";
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

// ✅ 도매꾹 CDN의 _img_330 같은 리사이즈 파라미터를 큰 값으로 치환
function upgradeDomeggookImage(url) {
  if (!url) return url;
  let u = String(url).trim();
  if (u.startsWith("//")) u = "https:" + u;

  // ..._img_330 -> ..._img_1000 (330/400/450 같은 것 방지)
  u = u.replace(/_img_(\d+)(\?|$)/, (m, n, tail) => {
    const size = Number(n);
    if (!Number.isNaN(size) && size < 600) return `_img_1000${tail}`;
    return m;
  });

  return u;
}

export async function parseProductFromDomaeqq(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

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

    // 대표 이미지: og:image 우선
    let imageUrl = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);

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

    imageUrl = upgradeDomeggookImage(imageUrl || "");

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

    // 상세 HTML 내부의 _img_330도 서버단에서 치환
    const upgradedContentHtml = String(contentHtml || "").replace(/_img_(\d+)(\?|")/g, (m, n, tail) => {
      const size = Number(n);
      if (!Number.isNaN(size) && size < 600) return `_img_1000${tail}`;
      return m;
    });

    return makeDraft({
      sourceUrl: url,
      title: titleText || (await page.title().catch(() => "도매꾹 상품")),
      price,
      imageUrl: imageUrl || "https://via.placeholder.com/1000",
      contentText: upgradedContentHtml || titleText || "",
    });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
