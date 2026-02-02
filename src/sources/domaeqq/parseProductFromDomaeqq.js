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

const OPTION_TEXT_IGNORE = [
  // Global/nav/menu junk (user reports)
  "로그인",
  "회원가입",
  "상품명",
  "상품번호",
  "1:1문의",
  "1:1 문의",
  "e-money",
  "e money",
  "포인트",
  "회원정보수정",
  "회원정보 수정",
  "이미지 파일 업로드",
  // Common site sections
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

const OPTION_MARKER_RE = /[0-9]|\b(XXXL|XXL|XL|L|M|S|FREE|Free|F)\b|[:：\/\-\+\[\]\(\)]/;
const OPTION_COLOR_WORDS = [
  "블랙",
  "화이트",
  "레드",
  "블루",
  "그린",
  "핑크",
  "베이지",
  "브라운",
  "그레이",
  "옐로",
  "퍼플",
  "네이비",
  "실버",
  "골드",
  "투명",
  "클리어",
];

function normalizeOptionText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\(.*?\)/g, "")
    .replace(/[\[\]{}]/g, "")
    .trim();
}

function isLikelyOptionText(s) {
  const t = normalizeOptionText(s);
  if (!t) return false;
  if (t.length < 2 || t.length > 80) return false;
  if (/^(선택|옵션|상품옵션|닫기)$/i.test(t)) return false;
  if (/선택\s*하세요|옵션\s*선택|전체\s*옵션\s*보기/i.test(t)) return false;
  if (OPTION_TEXT_IGNORE.some((w) => t.includes(w))) return false;

  // Too generic / UI controls
  if (/^(구매|바로구매|장바구니|주문|취소|확인|닫기|저장|검색)$/i.test(t)) return false;

  // Must look like a real value: has digits/markers or known color words
  if (OPTION_COLOR_WORDS.some((c) => t.includes(c))) return true;
  return OPTION_MARKER_RE.test(t);
}

function parseOptionValuesFromLabel(label) {
  const text = String(label || "").trim();
  if (!text) return [];

  const partsByPair = text.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  const pairValues = [];
  for (const part of partsByPair) {
    const pair = part.split(/[:：]/).map((s) => s.trim());
    if (pair.length === 2 && pair[0] && pair[1]) {
      pairValues.push({ optionName: pair[0], optionValue: pair[1] });
    }
  }
  if (pairValues.length > 0) return pairValues;

  const bracketMatch = text.match(/^(.+?)\s*[\[\(](.+?)[\]\)]\s*$/);
  if (bracketMatch) {
    const left = bracketMatch[1].trim();
    const right = bracketMatch[2].trim();
    const sizePattern = /(\d+(\.\d+)?\s*(cm|mm|m|인치|inch))/i;
    const colorWords = [
      "블랙",
      "화이트",
      "레드",
      "블루",
      "그린",
      "핑크",
      "베이지",
      "브라운",
      "그레이",
      "옐로",
      "퍼플",
      "네이비",
      "실버",
      "골드",
      "투명",
      "클리어",
    ];
    const leftName = sizePattern.test(left) ? "크기" : "옵션1";
    const rightName = colorWords.some((c) => right.includes(c)) ? "색상" : "옵션2";
    return [
      { optionName: leftName, optionValue: left },
      { optionName: rightName, optionValue: right },
    ];
  }

  const parts = text.split(/[\/]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts.map((p, idx) => ({ optionName: `옵션${idx + 1}`, optionValue: p }));
  }

  return [{ optionName: "옵션", optionValue: text }];
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&#10;/g, "\n")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function parseTitlePairsFromText(titleText) {
  if (!titleText) return [];
  const lines = String(titleText)
    .replace(/\r/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const withColon = lines.filter((s) => s.includes(":"));
  const koOnly = withColon.filter((s) => /[가-힣]/.test(s));
  const use = koOnly.length > 0 ? koOnly : withColon;
  const pairs = [];
  for (const line of use) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name || !value) continue;
    if (pairs.find((p) => p.optionName === name)) continue;
    pairs.push({ optionName: name, optionValue: value });
  }
  return pairs;
}

function parse1688VariantsFromHtml(html) {
  const raw = String(html || "");
  const out = [];
  const optRe = /<div[^>]*class="[^"]*optlist[^"]*"[^>]*>/gi;
  let m;
  while ((m = optRe.exec(raw))) {
    const tag = m[0];
    const krwMatch = tag.match(/krwstr="([^"]+)"/i);
    const priceText = krwMatch ? decodeHtmlEntities(krwMatch[1]) : "";
    const priceNum = Number(String(priceText).replace(/[^\d]/g, "")) || 0;
    const start = m.index;
    const slice = raw.slice(start, start + 2500);
    const titleMatch = slice.match(/title="([^"]+)"/i);
    const titleRaw = titleMatch ? decodeHtmlEntities(titleMatch[1]) : "";
    const values = parseTitlePairsFromText(titleRaw);
    const sizeMatch = slice.match(/class="wid150"[^>]*>([^<]+)</i);
    const sizeText = sizeMatch ? decodeHtmlEntities(sizeMatch[1]) : "";
    const stockMatch =
      slice.match(/(\d[\d,]*)\s*부\s*판매\s*가능/i) ||
      slice.match(/(\d[\d,]*)\s*개\s*판매\s*가능/i) ||
      slice.match(/(\d[\d,]*)\s*개/i);
    const stock = stockMatch ? Number(stockMatch[1].replace(/,/g, "")) : 0;
    let label = values.length > 0 ? values.map((v) => v.optionValue).join(" / ") : "";
    if (!label) label = sizeText || "";
    if (!label) label = titleRaw.replace(/\s+/g, " ").trim();
    if (!label) label = `옵션${out.length + 1}`;
    out.push({
      label,
      price: priceNum || 0,
      stock: Number.isFinite(stock) ? stock : 0,
      values,
    });
  }
  const seen = new Set();
  const uniq = [];
  for (const item of out) {
    const key = `${item.label}::${item.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(item);
  }
  return uniq;
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

  const cleanedOptions = Array.from(new Set(optMatches))
    .map(normalizeOptionText)
    .filter((s) => isLikelyOptionText(s));

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
    .map(normalizeOptionText)
    .filter((s) => isLikelyOptionText(s));

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

function extractOptionVariantsFromItemOptionController(scriptText) {
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
        const variants = [];
        const setMap = dataObj?.set || dataObj?.orgSet || {};
        const setKeys = Object.keys(setMap)
          .map((k) => Number(k))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)
          .map((n) => String(n));
        const dataMap = dataObj?.data;
        if (dataMap && typeof dataMap === "object") {
          for (const key of Object.keys(dataMap)) {
            const item = dataMap[key];
            const name = String(item?.name || "").trim();
            if (!name) continue;
            // domPrice is the per-option price delta (can be negative)
            const priceDelta = Number(item?.domPrice ?? 0);
            const stock = Number(item?.qty ?? 0);
            const hidden = Number(item?.hid ?? 0);
            if (hidden === 1) continue;

            const values = [];
            if (setKeys.length > 0) {
              const idxParts = String(key || "").split("_");
              for (let i = 0; i < setKeys.length; i += 1) {
                const setKey = setKeys[i];
                const setInfo = setMap[setKey] || {};
                const optionName = String(setInfo.name || `옵션${i + 1}`).trim();
                const rawIdx = idxParts[i];
                const optIdx = Number.isFinite(Number(rawIdx)) ? String(Number(rawIdx)) : rawIdx;
                const optionValue =
                  (setInfo.opts && setInfo.opts[optIdx] != null
                    ? String(setInfo.opts[optIdx])
                    : "") || "";
                if (optionValue) values.push({ optionName, optionValue });
              }
            }

            variants.push({
              name,
              priceDelta,
              stock: Number.isNaN(stock) ? 0 : stock,
              values,
            });
          }
        }
        if (variants.length > 0) {
          const seen = new Set();
          const uniq = [];
          for (const v of variants) {
            const valKey = Array.isArray(v.values)
              ? v.values.map((x) => `${x.optionName}:${x.optionValue}`).join("|")
              : "";
            const k = `${v.name}::${v.priceDelta}::${valKey}`;
            if (seen.has(k)) continue;
            seen.add(k);
            uniq.push(v);
          }
          return uniq;
        }
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
  const is1688 = String(url || "").includes("1688.domeggook.com");
  const isMobile = (() => {
    try {
      const h = new URL(String(url || "")).hostname || "";
      return /^mobile\./i.test(h);
    } catch {
      return false;
    }
  })();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2000);

    // Best-effort: open option layer if the page hides options behind a button/layer.
    if (!is1688) {
      const openOptBtn = page
        .locator("text=/전체\\s*옵션\\s*보기|옵션\\s*보기|옵션\\s*선택|옵션\\s*열기/i")
        .first();
      try {
        if ((await openOptBtn.count()) > 0) {
          await openOptBtn.click({ timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(800);
        }
      } catch {}
    }

    const titleCandidate = page.locator("h1, h2").first();
    const titleText = (await titleCandidate.textContent().catch(() => null))?.trim();

    let variantTable = is1688
      ? await page.evaluate(() => {
          const clean = (s) =>
            String(s || "")
              .replace(/\s+/g, " ")
              .replace(/\(필수\)|\[필수\]/g, "")
              .trim();
          const parsePrice = (t) => {
            const m = String(t || "").match(/(\d[\d,]*)\s*원/);
            return m ? Number(m[1].replace(/,/g, "")) : null;
          };
          const parseStock = (t) => {
            const m = String(t || "").match(/(\d[\d,]*)\s*(부|개)\s*판매 가능/);
            if (m) return Number(m[1].replace(/,/g, ""));
            const m2 = String(t || "").match(/(\d[\d,]*)\s*개/);
            return m2 ? Number(m2[1].replace(/,/g, "")) : null;
          };
          const parseTitle = (title) => {
            if (!title) return [];
            const lines = String(title)
              .replace(/&#10;/g, "\n")
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
            const withColon = lines.filter((s) => s.includes(":"));
            const koOnly = withColon.filter((s) => /[가-힣]/.test(s));
            const use = koOnly.length > 0 ? koOnly : withColon;
            const pairs = [];
            for (const line of use) {
              const idx = line.indexOf(":");
              if (idx === -1) continue;
              const name = line.slice(0, idx).trim();
              const value = line.slice(idx + 1).trim();
              if (!name || !value) continue;
              if (pairs.find((p) => p.optionName === name)) continue;
              pairs.push({ optionName: name, optionValue: value });
            }
            return pairs;
          };
          const items = [];
          const optList = Array.from(document.querySelectorAll(".optlist"));
          for (const el of optList) {
            const krwstr = el.getAttribute("krwstr") || "";
            const price = parsePrice(krwstr) || parsePrice(el.textContent || "");
            if (!price) continue;
            const stock = parseStock(el.textContent || "");
            const titleEl = el.querySelector("[title]");
            const title = titleEl ? titleEl.getAttribute("title") : "";
            const values = parseTitle(title);
            const sizeText = clean(el.querySelector(".wid150")?.textContent || "");
            let label = values.length > 0 ? values.map((v) => v.optionValue).join(" / ") : "";
            if (!label) label = sizeText || clean(el.textContent || "");
            items.push({
              label: label || `옵션${items.length + 1}`,
              price,
              stock: Number.isFinite(stock) ? stock : 0,
              values,
            });
          }
          const seen = new Set();
          const uniq = [];
          for (const item of items) {
            const key = `${item.label}::${item.price}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(item);
          }
          return { variants: uniq };
        })
      : { variants: [] };

    if (is1688 && (!variantTable?.variants || variantTable.variants.length === 0)) {
      try {
        const res = await page.request.get(url, {
          headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
        });
        if (res.ok()) {
          const html = await res.text();
          const variants = parse1688VariantsFromHtml(html);
          variantTable = { variants };
        }
      } catch {}
    }

    // ✅ 도매꾹 단가: .lItemPrice 우선
    const priceText =
      (await page.locator(".lItemPrice").first().textContent().catch(() => null))?.trim() ||
      (await page.locator("text=/\\d[\\d,]*\\s*원/").first().textContent().catch(() => null))?.trim();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const variantPrices = Array.isArray(variantTable?.variants)
      ? variantTable.variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n))
      : [];
    const minVariantPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : null;

    const priceRaw =
      (is1688 && Number.isFinite(minVariantPrice) ? minVariantPrice : null) ||
      Number(String(priceText || "").replace(/[^\d]/g, "")) ||
      pickPriceFromText(bodyText) ||
      9900;

    const price = Math.max(1000, floorTo10Won(priceRaw) || 1000);

    // 대표 이미지: 메인 썸네일 우선
    let imageUrl = await pickMainImageSrc(page);

    if (is1688 && (!imageUrl || /1688logo\.png/i.test(imageUrl))) {
      imageUrl = await page.evaluate(() => {
        const imgs = Array.from(document.images)
          .map((img) => ({
            src: img.currentSrc || img.src,
            w: img.naturalWidth || img.width || 0,
            h: img.naturalHeight || img.height || 0,
          }))
          .filter((x) => x.src && x.src.includes("alicdn.com"));
        imgs.sort((a, b) => b.w * b.h - a.w * a.h);
        return imgs[0]?.src || "";
      });
    }

    if (is1688 && (!imageUrl || /1688logo\.png/i.test(imageUrl))) {
      try {
        const res = await page.request.get(url, {
          headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
        });
        if (res.ok()) {
          const html = await res.text();
          const matches = html.match(/https?:\/\/[^\"'\\s>]+alicdn\\.com[^\"'\\s>]+/gi) || [];
          imageUrl = matches.find((u) => /cbu01|ibank/i.test(u)) || matches[0] || imageUrl;
        }
      } catch {}
    }

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

    const optionProbe = await page.evaluate(({ isMobile }) => {
      const uniqPush = (arr, v) => {
        const t = String(v || "").trim();
        if (!t) return;
        if (!arr.includes(t)) arr.push(t);
      };

      const scoreContainer = (el) => {
        const textLen = (el.textContent || "").length;
        const hasSelect = el.querySelectorAll("select").length;
        const hasOptionNodes = el.querySelectorAll("option, li, button").length;
        return textLen + hasSelect * 10000 + hasOptionNodes * 50;
      };

      const rootSelectors = [
        // common desktop containers
        "#contents",
        "#container",
        "#wrap",
        "#goods_view",
        "#itemView",
        "#itemInfo",
        "form",
        // mobile containers
        ".m_wrap",
        ".m_container",
        ".goods_view",
        ".item_view",
        ".view_wrap",
      ];

      const roots = [];
      for (const sel of rootSelectors) {
        document.querySelectorAll(sel).forEach((el) => roots.push(el));
      }

      // bonus: anything that looks like an option box
      document
        .querySelectorAll("[id*='option'],[class*='option'],[id*='opt'],[class*='opt']")
        .forEach((el) => roots.push(el));

      const scored = Array.from(new Set(roots))
        .map((el) => ({ el, score: scoreContainer(el) }))
        .sort((a, b) => b.score - a.score);

      const root = scored[0]?.el || document.body;
      const candidates = [];

      // 1) SELECT options (most reliable)
      root.querySelectorAll("select").forEach((sel) => {
        const nameAttr = (sel.getAttribute("name") || "") + " " + (sel.id || "");
        // Avoid capturing unrelated selects (category/search)
        if (!/opt|option|item/i.test(nameAttr) && sel.options.length < 2) return;

        Array.from(sel.options || []).forEach((o) => {
          const txt = (o.textContent || "").trim();
          uniqPush(candidates, txt);
        });
      });

      // 2) Option layer / list items under option-like containers
      const optionRoots = Array.from(
        root.querySelectorAll("[id*='option'],[class*='option'],[id*='opt'],[class*='opt']"),
      );
      for (const optRoot of optionRoots.slice(0, 8)) {
        optRoot.querySelectorAll("li, button, a, span, div").forEach((el) => {
          const cls = String(el.className || "");
          const id = String(el.id || "");
          // restrict to option-ish nodes to avoid nav
          const ok = /opt|option/i.test(cls) || /opt|option/i.test(id) || el.tagName === "LI";
          if (!ok) return;
          const txt = (el.textContent || "").trim();
          if (txt) uniqPush(candidates, txt);
        });
      }

      // 3) mobile pages often keep option labels in buttons
      if (isMobile) {
        root.querySelectorAll("button").forEach((btn) => {
          const txt = (btn.textContent || "").trim();
          if (txt) uniqPush(candidates, txt);
        });
      }

      return {
        rootTag: root.tagName,
        rootId: root.id || "",
        rootClass: String(root.className || ""),
        candidates,
      };
    }, { isMobile });

    const options = Array.from(new Set(optionProbe?.candidates || []))
      .map(normalizeOptionText)
      .filter((t) => isLikelyOptionText(t))
      .slice(0, 40);

    let optionStrategy = "none";
    let finalOptions = [];
    if (is1688 && Array.isArray(variantTable?.variants) && variantTable.variants.length > 0) {
      optionStrategy = "1688.variantTable";
      finalOptions = variantTable.variants.map((v) => ({
        name: v.label,
        priceDelta: Number(v.price) - price,
        stock: Number.isFinite(Number(v.stock)) ? Number(v.stock) : 0,
        values:
          Array.isArray(v.values) && v.values.length > 0
            ? v.values
            : parseOptionValuesFromLabel(v.label),
      }));
    } else {
      // ✅ 옵션: JS에 박힌 ItemOptionController 데이터 우선 사용
      // 아이가 보듯이 생각하면, "진짜 옵션 상자"를 먼저 연다고 보면 됨.
      try {
        const scriptText = await page.evaluate(() =>
          Array.from(document.scripts)
            .map((s) => s.textContent || "")
            .join("\n"),
        );
        const inlineOptions = extractOptionVariantsFromItemOptionController(scriptText);
        if (inlineOptions.length > 0) {
          optionStrategy = "ItemOptionController";
          finalOptions = inlineOptions;
        }
      } catch {}
    }

    // ✅ 옵션 팝업(전체보기) fallback
    if (!is1688 && finalOptions.length === 0) {
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
          if (parsed.length > 0) {
            optionStrategy = "optionPopup";
            finalOptions = parsed.map((name) => ({
              name,
              priceDelta: 0,
              stock: 0,
              values: [],
            }));
          }
        }
      } catch {}
    }

    const looksGarbage = finalOptions.some((t) => {
      const name = String(t?.name || t || "");
      return OPTION_TEXT_IGNORE.some((g) => name.includes(g));
    });
    if (finalOptions.length === 0 || looksGarbage) {
      // 팝업 실패/오염 시 옵션 비활성화
      finalOptions = [];
    }

    // ✅ 마지막 fallback: 페이지에서 긁은 옵션 텍스트 사용
    if (finalOptions.length === 0 && Array.isArray(options) && options.length > 0) {
      optionStrategy = "pageText";
      finalOptions = options.map((name) => ({ name, priceDelta: 0, stock: 0, values: [] }));
    }

    const draft = makeDraft({
      sourceUrl: url,
      title: titleText || (await page.title().catch(() => "도매꾹 상품")),
      price,
      imageUrl: imageUrl || "https://via.placeholder.com/1000",
      contentText: finalContentHtml || titleText || "",
      categoryText,
      options: finalOptions,
    });

    // Debug payload for preview (safe: contains no secrets)
    draft.__debug = {
      source: "domeggook",
      is1688,
      isMobile,
      optionStrategy,
      optionProbe,
      optionCandidatesCount: Array.isArray(optionProbe?.candidates) ? optionProbe.candidates.length : 0,
      optionFilteredCount: Array.isArray(options) ? options.length : 0,
      finalOptionsCount: Array.isArray(finalOptions) ? finalOptions.length : 0,
      finalOptionNameSamples: Array.isArray(finalOptions)
        ? finalOptions.slice(0, 10).map((o) => String(o?.name || ""))
        : [],
    };

    return draft;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
