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

function sanitizeHtml(html, baseUrl) {
  const raw = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .trim();

  if (!baseUrl) return raw;

  return raw.replace(/(src|href)=["']?([^"' >]+)["']?/gi, (m, attr, val) => {
    const v = String(val || "").trim();
    if (!v) return m;
    if (v.startsWith("data:") || v.startsWith("mailto:") || v.startsWith("tel:")) return m;
    if (v.startsWith("http://") || v.startsWith("https://")) return `${attr}="${v}"`;
    if (v.startsWith("//")) return `${attr}="https:${v}"`;
    try {
      const abs = new URL(v, baseUrl).toString();
      return `${attr}="${abs}"`;
    } catch {
      return m;
    }
  });
}

function extractBodyHtml(html) {
  const m = String(html || "").match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m && m[1]) return m[1].trim();
  return String(html || "");
}

function extractImageUrlsFromHtml(html, baseUrl) {
  const out = [];
  const re = /<img[^>]+src=["']?([^"' >]+)["']?/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    let src = String(m[1] || "").trim();
    if (!src) continue;
    if (src.startsWith("//")) src = "https:" + src;
    if (!/^https?:\/\//i.test(src)) {
      try {
        src = new URL(src, baseUrl).toString();
      } catch {}
    }
    if (!out.includes(src)) out.push(src);
  }
  return out;
}

function buildImageHtml(urls) {
  if (!urls || urls.length === 0) return "";
  return urls.map((u) => `<p><img src="${u}" /></p>`).join("");
}

function parseOptionPopupHtml(html) {
  const raw = String(html || "");

  // 1) <option> 태그 우선 추출
  const optMatches = [];
  const optRe = /<option[^>]*>([^<]+)<\/option>/gi;
  let m;
  while ((m = optRe.exec(raw))) {
    const t = String(m[1] || "").trim();
    if (t) optMatches.push(t);
  }

  const blacklist = ["옵션", "상품옵션", "선택", "닫기"];

  const normalize = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .replace(/\(.*?\)/g, "")
      .replace(/[\[\]{}]/g, "")
      .trim();

  const cleanedOptions = Array.from(new Set(optMatches))
    .map(normalize)
    .filter((s) => s.length >= 2 && s.length < 60)
    .filter((s) => !blacklist.some((b) => s.includes(b)));

  if (cleanedOptions.length > 0) return cleanedOptions;

  // 2) fallback: 전체 텍스트에서 추출
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const cleaned = lines
    .map((s) => s.replace(/^\d+\s*[.)-]?\s*/g, "").trim())
    .filter((s) => s.length >= 2 && s.length < 60)
    .filter((s) => !blacklist.some((b) => s.includes(b)));

  return Array.from(new Set(cleaned));
}

function extractJsonObjectAfterKey(text, key, startIndex = 0) {
  const src = String(text || "");
  let idx = Math.max(0, startIndex);
  while (idx < src.length) {
    const keyIdx = src.indexOf(key, idx);
    if (keyIdx === -1) return null;
    const before = src[keyIdx - 1] || "";
    const after = src[keyIdx + key.length] || "";
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) {
      idx = keyIdx + key.length;
      continue;
    }
    const colonIdx = src.indexOf(":", keyIdx + key.length);
    if (colonIdx === -1) return null;
    let i = colonIdx + 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== "{") {
      idx = i + 1;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = i;

    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") inString = false;
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;

      if (depth === 0) {
        const jsonText = src.slice(start, i + 1);
        return jsonText;
      }
    }

    idx = start + 1;
  }
  return null;
}

function extractOptionNamesFromItemOptionController(scriptText) {
  const text = String(scriptText || "");
  if (!text.includes("ItemOptionController")) return [];

  let idx = 0;
  while (idx < text.length) {
    const hit = text.indexOf("ItemOptionController", idx);
    if (hit === -1) break;

    const dataJson = extractJsonObjectAfterKey(text, "data", hit);
    if (dataJson) {
      try {
        const dataObj = JSON.parse(dataJson);
        const names = [];
        const dataMap = dataObj?.data;
        if (dataMap && typeof dataMap === "object") {
          for (const key of Object.keys(dataMap)) {
            const item = dataMap[key];
            const name = String(item?.name || "").trim();
            if (name) names.push(name);
          }
        }
        if (names.length > 0) return Array.from(new Set(names));
      } catch {}
    }

    idx = hit + 1;
  }

  return [];
}

function extractMainBlock(html) {
  const s = String(html || "");
  const idWrap = s.match(/<div[^>]+id=["']?wrap["']?[^>]*>([\s\S]*?)<\/div>/i);
  if (idWrap && idWrap[1]) return idWrap[1].trim();
  const clsWrap = s.match(/<div[^>]+class=["'][^"']*wrap[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (clsWrap && clsWrap[1]) return clsWrap[1].trim();
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

    // ✅ 도매꾹 단가: .lItemPrice 우선
    const priceText =
      (await page.locator(".lItemPrice").first().textContent().catch(() => null))?.trim() ||
      (await page.locator("text=/\\d[\\d,]*\\s*원/").first().textContent().catch(() => null))?.trim();
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

    // ✅ 외부 상세 HTML(예: ai.esmplus.com) 우선 사용
    const detailHtmlUrl = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute("src") || el.getAttribute("href") || "") : "";
      };

      const iframe = pick('iframe[src*="ai.esmplus.com"]');
      if (iframe) return iframe;

      const link = pick('a[href*="ai.esmplus.com"]');
      if (link) return link;

      return "";
    });

    let finalContentHtml = contentHtml;
    if (detailHtmlUrl) {
      try {
        const res = await fetch(detailHtmlUrl, {
          headers: {
            Referer: url,
            "User-Agent": "Mozilla/5.0",
          },
        });
        if (res.ok) {
          const html = await res.text();
          const bodyOnly = extractBodyHtml(html);
          const mainOnly = extractMainBlock(bodyOnly);
          const imgList = extractImageUrlsFromHtml(bodyOnly, detailHtmlUrl);
          const imgHtml = buildImageHtml(imgList);
          // 이미지가 충분하면 이미지 기반으로 구성, 아니면 본문 블럭 사용
          if (imgList.length >= 2) {
            finalContentHtml = sanitizeHtml(imgHtml, detailHtmlUrl) || contentHtml;
          } else {
            finalContentHtml = sanitizeHtml(mainOnly, detailHtmlUrl) || contentHtml;
          }
        }
      } catch {
        // fallback to contentHtml
      }
    }

    const categoryText = await page.evaluate(() => {
      const pick = (sel) =>
        Array.from(document.querySelectorAll(sel))
          .map((el) => el.textContent || "")
          .join(" > ")
          .replace(/\s+/g, " ")
          .trim();

      return (
        pick(".loc_history a") ||
        pick(".breadcrumb a") ||
        pick(".location a") ||
        pick(".category a") ||
        ""
      );
    });

    const options = await page.evaluate(() => {
      const normalize = (s) =>
        String(s || "")
          .replace(/\s+/g, " ")
          .replace(/\(.*?\)/g, "")
          .replace(/[\[\]{}]/g, "")
          .trim();

      const blacklist = [
        "도매매",
        "나까마",
        "교육센터",
        "에그돔",
        "로그아웃",
        "마이페이지",
        "주문전체목록",
        "관심상품",
        "고객센터",
        "공지사항",
        "장바구니",
        "더보기",
      ];

      const scoreContainer = (el) => {
        const text = (el.textContent || "").length;
        const hasSelect = el.querySelectorAll("select").length;
        const hasOptionBtn = el.querySelectorAll("button, li").length;
        return text + hasSelect * 500 + hasOptionBtn * 50;
      };

      const containers = Array.from(
        document.querySelectorAll(
          "[id*='option'], [class*='option'], [id*='opt'], [class*='opt']",
        ),
      )
        .map((el) => ({ el, score: scoreContainer(el) }))
        .sort((a, b) => b.score - a.score);

      const root = containers[0]?.el || document.body;

      const fromSelects = Array.from(root.querySelectorAll("select"))
        .flatMap((sel) => Array.from(sel.options || []).map((o) => o.textContent))
        .map(normalize);

      const fromButtons = Array.from(root.querySelectorAll("button, li"))
        .map((el) => normalize(el.textContent))
        .filter((t) => t && t.length < 60);

      const merged = Array.from(new Set([...fromSelects, ...fromButtons]));
      const cleaned = merged
        .filter((t) => t && t.length < 60)
        .filter((t) => !/선택|옵션|구매|전체옵션보기/i.test(t))
        .filter((t) => !blacklist.some((b) => t.includes(b)));

      return cleaned.slice(0, 20);
    });

    // ✅ 옵션: JS에 박힌 ItemOptionController 데이터 우선 사용
    // 아이가 보듯이 생각하면, "진짜 옵션 상자"를 먼저 연다고 보면 됨.
    let finalOptions = [];
    try {
      const scriptText = await page.evaluate(() =>
        Array.from(document.scripts)
          .map((s) => s.textContent || "")
          .join("\n"),
      );
      const inlineOptions = extractOptionNamesFromItemOptionController(scriptText);
      if (inlineOptions.length > 0) finalOptions = inlineOptions;
    } catch {}

    // ✅ 옵션 팝업(전체보기) fallback
    if (finalOptions.length === 0) {
      try {
        const productId = String(url).match(/\d+/)?.[0] || "";
        const popupUrl = `https://domeggook.com/main/popup/item/popup_itemOptionView.php?no=${encodeURIComponent(
          productId,
        )}&market=dome`;
        const res = await page.request.get(popupUrl, {
          headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
        });
        if (res.ok()) {
          const html = await res.text();
          const parsed = parseOptionPopupHtml(html);
          if (parsed.length > 0) finalOptions = parsed;
        }
      } catch {}
    }

    const garbageWords = [
      "마이페이지",
      "로그아웃",
      "관심상품",
      "공지사항",
      "장바구니",
      "상품문의",
      "회원정보",
      "고객센터",
      "e-money",
      "포인트",
    ];

    const looksGarbage = finalOptions.some((t) => garbageWords.some((g) => t.includes(g)));
    if (finalOptions.length === 0 || looksGarbage) {
      // 팝업 실패/오염 시 옵션 비활성화
      finalOptions = [];
    }

    // ✅ 마지막 fallback: 페이지에서 긁은 옵션 텍스트 사용
    if (finalOptions.length === 0 && Array.isArray(options) && options.length > 0) {
      finalOptions = options;
    }

    return makeDraft({
      sourceUrl: url,
      title: titleText || (await page.title().catch(() => "도매꾹 상품")),
      price,
      imageUrl: imageUrl || "https://via.placeholder.com/1000",
      contentText: finalContentHtml || titleText || "",
      categoryText,
      options: finalOptions,
    });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
