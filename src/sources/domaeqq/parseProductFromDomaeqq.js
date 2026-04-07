import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { makeDraft } from "../../domain/productDraft.js";
import { stripDomeggookPromoBlocks } from "../../utils/domeggookDetailHtml.js";

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

function pickPrimaryNumericAmount(values) {
  const nums = Array.from(values || [])
    .map((value) => Number(value))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;

  const usable = nums.filter((n) => n >= 1000);
  const pool = usable.length > 0 ? usable : nums;
  return Math.min(...pool);
}

function pickPrimaryKrwAmount(text) {
  const amounts = Array.from(String(text || "").matchAll(/(\d[\d,]*)\s*원/g))
    .map((m) => Number(String(m[1] || "").replace(/,/g, "")));
  return pickPrimaryNumericAmount(amounts);
}

function parseShippingFeeFromText(allText) {
  const t = String(allText || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  const extraShippingContext = /(도서산간|제주|추가\s*배송비|추가배송비|반품\s*배송비|교환\s*배송비|왕복\s*배송비|반품비|교환비)/;
  const paidCandidates = [];
  const pushCandidate = (value, contextText = "") => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    if (n < 0) return;
    if (extraShippingContext.test(contextText)) return;
    paidCandidates.push(Math.floor(n));
  };

  const patterns = [
    /(?:기본\s*배송비|택배비|배송정보|배송비|배송\s*비용)\s*[:\-]?\s*(\d[\d,]*)\s*원/g,
    /(?:배송비|택배비)[^\d]{0,16}(\d[\d,]*)\s*원/g,
    /(\d[\d,]*)\s*원[^\S\r\n]{0,3}(?:배송비|택배비|택배)/g,
    /(?:택배|배송)\s*\/\s*수량별\s*비례(?:\s*적용)?\s*\/\s*주문시\s*결제[^0-9]{0,24}(\d[\d,]*)\s*원/g,
    /(?:수량별\s*비례(?:\s*적용)?|주문시\s*결제)[^0-9]{0,20}(\d[\d,]*)\s*원/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t))) {
      const amount = Number(String(m[1] || "").replace(/,/g, ""));
      const start = Math.max(0, Number(m.index || 0) - 16);
      const end = Math.min(t.length, Number(m.index || 0) + String(m[0] || "").length + 16);
      const context = t.slice(start, end);
      pushCandidate(amount, context);
    }
  }
  const positivePaid = paidCandidates.filter((n) => n > 0);
  if (positivePaid.length > 0) return Math.min(...positivePaid);

  const hasFreeShipping = /무료\s*배송|배송비\s*무료|택배비\s*무료/.test(t);
  const hasPaidUnknown = /착불|배송비\s*별도|택배비\s*별도|배송비\s*유료|유료\s*배송|유료\s*택배|주문시\s*결제|수량별\s*비례|배송비\s*견적\s*요청|추가\s*배송비/.test(t);
  if (hasFreeShipping && !hasPaidUnknown) return 0;
  if (paidCandidates.includes(0) && !hasPaidUnknown) return 0;

  // paid shipping unknown
  if (hasPaidUnknown) return -1;

  return null;
}

function parseShippingTierTableFee(text) {
  const t = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (!/[+|]/.test(t)) return null;

  // getItemView deli.*.tbl format example:
  // "1+2500|20+2350|40+2100"
  const matches = Array.from(
    t.matchAll(/(?:^|[|])\s*\d[\d,]*\s*\+\s*(\d[\d,]*)/g),
  );
  if (matches.length === 0) return null;

  const fees = matches
    .map((m) => Number(String(m?.[1] || "").replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 50000);
  if (fees.length === 0) return null;
  // Conservative estimate for recommendation safety.
  return Math.max(...fees);
}

function parseShippingFeeFromAnyText(text) {
  const direct = parseShippingFeeFromText(text);
  const tierFee = parseShippingTierTableFee(text);
  if (Number.isFinite(Number(direct))) return Number(direct);
  if (Number.isFinite(Number(tierFee))) return Number(tierFee);
  return null;
}

function hasExplicitFreeShippingText(text) {
  const t = String(text || "");
  if (!t) return false;
  const free = /무료\s*배송|배송비\s*무료|택배비\s*무료/i.test(t);
  if (!free) return false;
  const paid = /착불|배송비\s*별도|택배비\s*별도|유료\s*배송|유료\s*택배|주문시\s*결제|수량별\s*비례|배송비\s*견적\s*요청|추가\s*배송비/i.test(t);
  return !paid;
}

async function extractDomeggookQuantityPriceTiers(page) {
  // Returns tiers like: [{ minQty: 1, unitPrice: 96500 }, ...]
  // Domeggook often shows range prices (e.g. 87,000원 ~ 96,500원) and a quantity table.
  try {
    const tiers = await page.evaluate(() => {
      const parseNum = (t) => {
        const m = String(t || "").match(/(\d[\d,]*)/);
        return m ? Number(m[1].replace(/,/g, "")) : null;
      };
      const parsePrice = (t) => {
        const m = String(t || "").match(/(\d[\d,]*)\s*원/);
        return m ? Number(m[1].replace(/,/g, "")) : null;
      };
      const parseMinQty = (t) => {
        const s = String(t || "");
        // examples: "1개 이상", "50개 이상", "100개 이상"
        const m = s.match(/^\s*(\d[\d,]*)\s*개/);
        if (m) return Number(m[1].replace(/,/g, ""));
        // examples: "1 ~", "10+", "50 이상"
        const m2 = s.match(/^\s*(\d[\d,]*)\s*(?:~|\+|이상)\b/);
        if (m2) return Number(m2[1].replace(/,/g, ""));
        // bare number is allowed only if the cell is quantity-only
        if (/^\s*\d[\d,]*\s*$/.test(s)) return Number(s.replace(/,/g, ""));
        return null;
      };

      const out = [];
      const tables = Array.from(document.querySelectorAll("table"));
      for (const tbl of tables) {
        const rows = Array.from(tbl.querySelectorAll("tr"));
        if (rows.length < 2) continue;

        const headerText = rows
          .slice(0, 2)
          .map((r) => (r.innerText || "").replace(/\s+/g, " ").trim())
          .join(" ");

        // Heuristic: table likely contains quantity pricing
        if (!/수량/.test(headerText) || !/(단가|가격)/.test(headerText)) continue;

        for (const r of rows) {
          const cells = Array.from(r.querySelectorAll("th,td"))
            .map((c) => (c.innerText || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          if (cells.length < 2) continue;

          const minQty = parseMinQty(cells[0]);
          const unitPrice = parsePrice(cells[1]);
          if (!minQty || !unitPrice) continue;
          if (/옵션|합본|재고/i.test(cells[0])) continue;
          if (minQty > 2000) continue;

          out.push({ minQty, unitPrice });
        }
      }

      // Fallback: some pages render quantity pricing as plain text blocks.
      // Pattern A) "수량(개) 1~ 50~ 100~" + next line "단가(원) 96,500 91,500 87,000"
      if (out.length === 0) {
        const fullRaw = String(document.body?.innerText || "");
        const full = fullRaw.replace(/\r/g, "");
        const lines = full
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter(Boolean);

        const qtyLineIdx = lines.findIndex((l) => l.includes("수량(개)"));
        const priceLineIdx = lines.findIndex((l) => l.includes("단가(원)"));

        if (qtyLineIdx >= 0 && priceLineIdx >= 0) {
          const qtyLine = lines[qtyLineIdx];
          const priceLine = lines[priceLineIdx];

          const qtyNums = (qtyLine.match(/(\d[\d,]*)/g) || []).map((x) =>
            Number(String(x).replace(/,/g, "")),
          );
          const priceNums = (priceLine.match(/(\d[\d,]*)/g) || []).map((x) =>
            Number(String(x).replace(/,/g, "")),
          );

          const n = Math.min(qtyNums.length, priceNums.length);
          for (let i = 0; i < n; i += 1) {
            const minQty = qtyNums[i];
            const unitPrice = priceNums[i];
            if (!Number.isFinite(minQty) || !Number.isFinite(unitPrice)) continue;
            if (minQty <= 0 || unitPrice <= 0) continue;
            out.push({ minQty, unitPrice });
          }
        }
      }

      // Pattern B) "N개 이상 ... 12,345원" style
      if (out.length === 0) {
        const full = (document.body?.innerText || "").replace(/\s+/g, " ");
        const idx = full.indexOf("수량별가격");
        const scope = idx >= 0 ? full.slice(idx, idx + 3000) : full;
        const re = /(\d[\d,]*)\s*개\s*이상[^\d]{0,20}(\d[\d,]*)\s*원/g;
        let m;
        while ((m = re.exec(scope))) {
          const minQty = Number(String(m[1]).replace(/,/g, ""));
          const unitPrice = Number(String(m[2]).replace(/,/g, ""));
          if (!Number.isFinite(minQty) || !Number.isFinite(unitPrice)) continue;
          if (minQty <= 0 || unitPrice <= 0) continue;
          out.push({ minQty, unitPrice });
          if (out.length >= 20) break;
        }
      }

      // de-dupe + sort
      const seen = new Set();
      const uniq = [];
      for (const t of out) {
        const k = `${t.minQty}:${t.unitPrice}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(t);
      }
      uniq.sort((a, b) => a.minQty - b.minQty);
      return uniq;
    });

    return Array.isArray(tiers) ? tiers : [];
  } catch {
    return [];
  }
}

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

function extractDomeggookItemNo(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    const pathNo = String(u.pathname || "").match(/\/(\d{6,})(?:\/|$)/);
    if (pathNo && pathNo[1]) return pathNo[1];
    const qNo = String(u.searchParams.get("no") || "").trim();
    if (/^\d{6,}$/.test(qNo)) return qNo;
  } catch {}
  return "";
}

function buildDraftPurchaseSource({
  sourceUrl,
  itemNo = "",
  options = [],
  minimumOrderQty = 1,
} = {}) {
  const resolvedItemNo = String(itemNo || extractDomeggookItemNo(sourceUrl) || "").trim();
  const normalizedMinimumOrderQty =
    Number.isFinite(Number(minimumOrderQty)) && Number(minimumOrderQty) > 0
      ? Number(minimumOrderQty)
      : 1;

  const optionMappings = Array.isArray(options)
    ? options
        .map((opt) => {
          const supplierOptionCode = String(
            opt?.sourceOptionCode || opt?.optionCode || "",
          ).trim();
          const supplierOptionName = String(opt?.name || opt?.optionName || "").trim();
          const values = Array.isArray(opt?.values)
            ? opt.values
                .map((pair) => ({
                  optionName: String(pair?.optionName || "").trim(),
                  optionValue: String(pair?.optionValue || "").trim(),
                }))
                .filter((pair) => pair.optionName && pair.optionValue)
            : [];
          if (!supplierOptionCode && !supplierOptionName) return null;
          return {
            supplierOptionCode,
            supplierOptionName,
            values,
          };
        })
        .filter(Boolean)
    : [];

  return {
    vendor: "domeggook",
    itemNo: resolvedItemNo,
    minimumOrderQty: normalizedMinimumOrderQty,
    optionMappings,
  };
}

function attachPurchaseSourceToDraft(
  draft,
  { sourceUrl, itemNo = "", options = [], minimumOrderQty = 1 } = {},
) {
  if (!draft || typeof draft !== "object") return draft;
  draft.purchaseSource = buildDraftPurchaseSource({
    sourceUrl,
    itemNo,
    options,
    minimumOrderQty,
  });
  return draft;
}

function toAbsoluteUrl(raw, baseUrl) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("//")) return `https:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  try {
    return new URL(v, baseUrl).toString();
  } catch {
    return "";
  }
}

function parsePriceNumber(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(value || "");
  if (!text) return null;
  const krwAmount = pickPrimaryKrwAmount(text);
  if (Number.isFinite(Number(krwAmount))) return Number(krwAmount);
  const nums = text.match(/(\d[\d,]{1,})/g) || [];
  const parsed = nums.map((x) => Number(String(x).replace(/,/g, "")));
  return pickPrimaryNumericAmount(parsed);
}

function collectOpenApiSignals(node, state, parentKey = "", baseUrl = "") {
  const key = String(parentKey || "").toLowerCase();
  if (node == null) return;

  if (typeof node === "string") {
    const raw = String(node).trim();
    if (!raw) return;
    const text = decodeHtmlEntities(raw);
    const looksHtml = /<[^>]+>/.test(text);
    const detailKey = /(detail|contents?|desc|explain|html|editor)/i.test(key);
    const titleKey = /(title|name)/i.test(key);
    const imageKey = /(img|image|thumb|thumbnail|photo)/i.test(key);
    const priceKey = /(price|amount|cost|sell|sale|supply)/i.test(key) && !/(delivery|ship|fee)/i.test(key);
    const shippingKey = /(delivery|ship|fee|deli|배송|택배)/i.test(key);

    if ((detailKey || (looksHtml && text.length >= 120)) && /<img|<div|<p|<table|<br/i.test(text)) {
      state.detailHtmlCandidates.push(text);
    }
    if (titleKey && !looksHtml && text.length >= 2 && text.length <= 140) {
      state.titles.push(text);
    }
    if (priceKey) {
      const n = parsePriceNumber(text);
      if (Number.isFinite(n) && n > 0) state.prices.push(n);
    }
    if (shippingKey || /배송|택배|착불/.test(text)) {
      const shipText = parseShippingFeeFromText(text);
      const shipTier = parseShippingTierTableFee(text);
      const ship = Number.isFinite(Number(shipText))
        ? Number(shipText)
        : (Number.isFinite(Number(shipTier)) ? Number(shipTier) : null);
      if (Number.isFinite(Number(ship))) {
        const n = Number(ship);
        if (n < 0) state.shippingUnknownPaid = true;
        else if (n <= 50000) state.shippingFees.push(Math.floor(n));
      }
    }

    const abs = toAbsoluteUrl(text, baseUrl);
    if (abs) {
      const lower = abs.toLowerCase();
      const looksImage =
        /\.(?:jpe?g|png|gif|webp|bmp)(?:$|\?)/i.test(lower) ||
        /\/upload\/|\/image\/|\/img\//i.test(lower);
      const looksDetailLink = /(detail|contents?|editor|desc)/i.test(key) && !looksImage;
      if (looksImage || imageKey) state.images.push(abs);
      if (looksDetailLink) state.detailLinks.push(abs);
    }
    return;
  }

  if (typeof node === "number") {
    const priceKey = /(price|amount|cost|sell|sale|supply)/i.test(key) && !/(delivery|ship|fee)/i.test(key);
    if (priceKey && Number.isFinite(node) && node > 0) state.prices.push(Number(node));
    const shippingKey = /(delivery|ship|deli|배송|택배)/i.test(key);
    const shippingAmountKey =
      /(fee|cost|amount|price|배송비|택배비)/i.test(key) ||
      /(^|\.)deli\.(dome|supply|ggook)$/i.test(key);
    if (shippingKey && shippingAmountKey && Number.isFinite(node) && node >= 0 && node <= 50000) {
      state.shippingFees.push(Math.floor(Number(node)));
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) collectOpenApiSignals(item, state, parentKey, baseUrl);
    return;
  }

  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const nextKey = key ? `${key}.${k}` : String(k || "");
      collectOpenApiSignals(v, state, nextKey, baseUrl);
    }
  }
}

function pickBestOpenApiDetailHtml(candidates, baseUrl) {
  const uniq = Array.from(new Set((candidates || []).map((s) => String(s || "").trim()).filter(Boolean)));
  if (uniq.length === 0) return "";
  const scored = uniq
    .map((html) => {
      const sanitized = sanitizeHtml(html, baseUrl);
      const score = scoreDetailHtmlCandidate(sanitized, baseUrl);
      return { html: sanitized, score };
    })
    .sort((a, b) => {
      if (b.score.usableCount !== a.score.usableCount) return b.score.usableCount - a.score.usableCount;
      if (a.score.garbageCount !== b.score.garbageCount) return a.score.garbageCount - b.score.garbageCount;
      return b.score.score - a.score.score;
    });
  const best = scored[0];
  if (!best || best.score.totalCount === 0) return "";
  return best.html;
}

function pickBestOpenApiImage(images, baseUrl) {
  const uniq = Array.from(new Set((images || []).map((u) => toAbsoluteUrl(u, baseUrl)).filter(Boolean)));
  if (uniq.length === 0) return "";
  const ranked = uniq
    .map((url) => {
      const cls = classifyDetailImageUrl(url);
      const path = String(url).toLowerCase();
      let score = 0;
      if (cls.usable) score += 8;
      if (cls.esmplus) score += 2;
      if (/\/upload\/item\//i.test(path)) score += 5;
      if (/\/upload\/editor\//i.test(path) || /\/contents?\//i.test(path)) score += 4;
      if (cls.thumb) score -= 8;
      if (cls.garbage) score -= 4;
      return { url, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.url || "";
}

function pickBestOpenApiDetailImages(images, baseUrl, mainImageUrl = "") {
  const main = toAbsoluteUrl(mainImageUrl, baseUrl);
  const uniq = Array.from(new Set((images || []).map((u) => toAbsoluteUrl(u, baseUrl)).filter(Boolean)));
  if (uniq.length === 0) return [];

  const ranked = uniq
    .map((url) => {
      const cls = classifyDetailImageUrl(url);
      const path = String(url).toLowerCase();
      let score = 0;
      if (cls.usable) score += 10;
      if (cls.esmplus) score += 2;
      if (/\/upload\/item\//i.test(path)) score += 4;
      if (/\/upload\/editor\//i.test(path) || /\/contents?\//i.test(path)) score += 3;
      if (cls.thumb) score -= 8;
      if (cls.garbage) score -= 6;
      if (main && url === main) score -= 5;
      return { url, score, cls };
    })
    .sort((a, b) => b.score - a.score);

  const preferred = ranked
    .filter((x) => x.cls.usable && x.url !== main)
    .map((x) => x.url);
  if (preferred.length >= 2) return preferred.slice(0, 80);

  const fallback = ranked
    .filter((x) => !x.cls.garbage && !x.cls.thumb && x.url !== main)
    .map((x) => x.url);
  if (fallback.length > 0) return fallback.slice(0, 80);

  return main ? [main] : [];
}

function buildOpenApiDetailHtmlBundle(raw, baseUrl, opts = {}) {
  const includeDeli = opts?.includeDeli !== false;
  const contents =
    raw?.domeggook?.desc?.contents && typeof raw.domeggook.desc.contents === "object"
      ? raw.domeggook.desc.contents
      : {};
  const itemHtml = String(contents?.item || "").trim();
  const deliHtml = String(contents?.deli || "").trim();
  const eventHtml = String(contents?.event || "").trim();
  const otherItemHtml = String(contents?.otherItem || "").trim();

  const parts = [];
  if (itemHtml) parts.push(itemHtml);
  if (includeDeli && deliHtml) parts.push(deliHtml);

  // Keep event/other blocks as fallback only.
  if (parts.length === 0 && eventHtml) parts.push(eventHtml);
  if (parts.length === 0 && otherItemHtml) parts.push(otherItemHtml);

  const mergedRaw = parts.join("\n");
  const mergedHtml = mergedRaw ? sanitizeHtml(mergedRaw, baseUrl) : "";

  return {
    mergedHtml,
    itemHtml: itemHtml ? sanitizeHtml(itemHtml, baseUrl) : "",
    deliHtml: deliHtml ? sanitizeHtml(deliHtml, baseUrl) : "",
  };
}

async function fetchDetailHtmlFromLinks(links, baseUrl, opts = {}) {
  const timeoutMs = Math.max(800, Math.min(6000, Number(opts?.timeoutMs) || 2000));
  const maxFetch = Math.max(0, Math.min(3, Number(opts?.maxFetch) || 2));
  const out = [];
  const uniq = Array.from(new Set((links || []).map((u) => toAbsoluteUrl(u, baseUrl)).filter(Boolean)));
  for (const link of uniq.slice(0, maxFetch)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(link, {
        signal: controller.signal,
        headers: {
          Referer: baseUrl,
          "User-Agent": "Mozilla/5.0",
        },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      if (String(html || "").length >= 120) out.push(html);
    } catch {}
  }
  return out;
}

async function fetchTextWithTimeout(url, opts = {}) {
  const timeoutMs = Math.max(800, Math.min(12000, Number(opts?.timeoutMs) || 5000));
  const headers = opts?.headers && typeof opts.headers === "object" ? opts.headers : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: "", error: String(error?.message || error || "fetch_error") };
  } finally {
    clearTimeout(timer);
  }
}

async function loadQuickDetailHtmlCandidate(itemUrl, opts = {}) {
  const timeoutMs = Math.max(1200, Math.min(8000, Number(opts?.timeoutMs) || 3200));
  const res = await fetchTextWithTimeout(itemUrl, {
    timeoutMs,
    headers: {
      Referer: "https://domeggook.com/",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!res.ok) {
    return {
      ok: false,
      reason: `quick_detail_fetch_failed_${Number(res.status || 0) || 0}`,
      detailHtml: "",
      detailImages: [],
    };
  }

  const raw = String(res.text || "");
  const candidates = [];
  const bufMatch = raw.match(/<textarea[^>]*id=["']contentsBuffer["'][^>]*>([\s\S]*?)<\/textarea>/i);
  if (bufMatch && bufMatch[1]) candidates.push(String(bufMatch[1]));
  const bodyOnly = extractBodyHtml(raw);
  if (bodyOnly) candidates.push(bodyOnly);
  const mainOnly = extractMainBlock(bodyOnly);
  if (mainOnly) candidates.push(mainOnly);

  const detailHtml =
    pickBestOpenApiDetailHtml(candidates, itemUrl) ||
    sanitizeHtml(mainOnly || bodyOnly || raw, itemUrl);
  const detailImages = extractImageUrlsFromHtml(detailHtml, itemUrl);

  return {
    ok: Boolean(detailHtml),
    reason: "",
    detailHtml,
    detailImages,
  };
}

async function loadQuickShippingFeeCandidate(itemUrl, opts = {}) {
  const timeoutMs = Math.max(1200, Math.min(9000, Number(opts?.timeoutMs) || 3000));
  const productId = extractDomeggookItemNo(itemUrl);
  const fetchTargets = [
    { url: itemUrl, source: "desktop" },
    ...(productId ? [{ url: `https://mobile.domeggook.com/${productId}`, source: "mobile" }] : []),
  ];

  let unknownPaidDetected = false;
  let explicitFreeDetected = false;
  let lastError = "";

  for (const target of fetchTargets) {
    const res = await fetchTextWithTimeout(target.url, {
      timeoutMs,
      headers: {
        Referer: "https://domeggook.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) {
      lastError = `quick_shipping_fetch_failed_${target.source}_${Number(res.status || 0) || 0}`;
      continue;
    }

    const raw = String(res.text || "");
    if (!raw) continue;

    const bodyOnly = extractBodyHtml(raw);
    const mainOnly = extractMainBlock(bodyOnly);
    const candidates = [
      raw,
      bodyOnly,
      mainOnly,
      ...(Array.from(
        raw.matchAll(
          /<textarea[^>]*id=["']contentsBuffer["'][^>]*>([\s\S]*?)<\/textarea>/gi,
        ),
      ).map((m) => String(m?.[1] || ""))),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const fee = parseShippingFeeFromAnyText(candidate);
      if (!Number.isFinite(Number(fee))) {
        if (hasExplicitFreeShippingText(candidate)) explicitFreeDetected = true;
        continue;
      }
      const n = Number(fee);
      if (n > 0) {
        return { ok: true, fee: n, source: target.source, reason: "" };
      }
      if (n < 0) {
        unknownPaidDetected = true;
      } else if (n === 0 && hasExplicitFreeShippingText(candidate)) {
        explicitFreeDetected = true;
      }
    }
  }

  if (unknownPaidDetected) {
    return { ok: true, fee: -1, source: "text", reason: "shipping_unknown_paid" };
  }
  if (explicitFreeDetected) {
    return { ok: true, fee: 0, source: "text", reason: "" };
  }
  return { ok: false, fee: null, source: "", reason: lastError || "shipping_not_found" };
}

async function loadOpenApiItemViewCandidate(itemUrl, opts = {}) {
  const fastMode = Boolean(opts?.fastMode);
  const includeDeli = opts?.includeDeli !== false;
  const timeoutMs = Math.max(
    1200,
    Math.min(10000, Number(opts?.timeoutMs) || (fastMode ? 5500 : 15000)),
  );
  const itemNo = extractDomeggookItemNo(itemUrl);
  if (!itemNo) return { ok: false, reason: "openapi_item_no_missing", itemNo: "" };

  try {
    const { domeggookOpenApiGetItemView } = await import("../../utils/domeggook_openapi.js");
    const view = await domeggookOpenApiGetItemView({
      itemNo,
      ver: "4.5",
      om: "json",
      timeoutMs,
    });
    const raw = view?.raw;
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: "openapi_empty_response", itemNo };
    }

    const state = {
      detailHtmlCandidates: [],
      detailLinks: [],
      images: [],
      titles: [],
      prices: [],
      shippingFees: [],
      shippingUnknownPaid: false,
    };
    collectOpenApiSignals(raw, state, "", itemUrl);

    const detailBundle = buildOpenApiDetailHtmlBundle(raw, itemUrl, { includeDeli });

    const linkHtml = fastMode
      ? []
      : await fetchDetailHtmlFromLinks(state.detailLinks, itemUrl, {
          timeoutMs: 1600,
          maxFetch: 1,
        });
    const scoredDetailHtml = pickBestOpenApiDetailHtml(
      [...state.detailHtmlCandidates, ...linkHtml],
      itemUrl,
    );
    const detailHtml = detailBundle.mergedHtml || scoredDetailHtml;
    const detailHtmlImages = extractImageUrlsFromHtml(detailHtml, itemUrl);
    let imageUrl = pickBestOpenApiImage(state.images, itemUrl);
    const detailImages = pickBestOpenApiDetailImages(
      [...detailHtmlImages, ...state.images],
      itemUrl,
      imageUrl,
    );
    if (!imageUrl && detailImages.length > 0) {
      imageUrl = detailImages[0];
    }
    const price = pickPrimaryNumericAmount(state.prices);
    const shippingSignalText = [
      String(detailBundle?.mergedHtml || ""),
      String(detailBundle?.deliHtml || ""),
      String(detailHtml || ""),
    ].join(" ");
    const shippingFromText = parseShippingFeeFromAnyText(shippingSignalText);
    const explicitFreeShipping = hasExplicitFreeShippingText(shippingSignalText);
    const shippingCandidates = state.shippingFees
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 50000);
    const shippingPositive = shippingCandidates.filter((n) => n > 0);
    let shippingFee = null;
    if (shippingPositive.length > 0) {
      shippingFee = Math.min(...shippingPositive);
    } else if (shippingCandidates.includes(0) && explicitFreeShipping) {
      shippingFee = 0;
    }
    if (Number.isFinite(Number(shippingFromText))) {
      const fromText = Number(shippingFromText);
      if (fromText > 0) {
        shippingFee = Number.isFinite(Number(shippingFee))
          ? Math.min(Number(shippingFee), fromText)
          : fromText;
      } else if (fromText === 0 && explicitFreeShipping && shippingFee == null) {
        shippingFee = 0;
      } else if (fromText < 0 && shippingFee == null) {
        shippingFee = -1;
      }
    }
    if (shippingFee == null && state.shippingUnknownPaid) {
      shippingFee = -1;
    }
    const title = state.titles.find((t) => t && !/<[^>]+>/.test(String(t)));

    return {
      ok: Boolean(detailHtml || imageUrl || price || title),
      reason: "",
      itemNo,
      detailHtml,
      imageUrl,
      detailImages,
      price,
      shippingFee,
      title: String(title || "").trim(),
      diagnostics: {
        detailHtmlCandidates: state.detailHtmlCandidates.length + linkHtml.length,
        bundleItemPresent: Boolean(detailBundle.itemHtml),
        bundleDeliPresent: Boolean(detailBundle.deliHtml),
        bundleUsed: Boolean(detailBundle.mergedHtml),
        bundleImageCandidates: detailHtmlImages.length,
        imageCandidates: state.images.length,
        detailImageCandidates: detailImages.length,
        priceCandidates: state.prices.length,
        shippingCandidates: shippingCandidates.length,
        shippingFromText: Number.isFinite(Number(shippingFromText)) ? Number(shippingFromText) : null,
      },
    };
  } catch (e) {
    const reason = String(e?.message || e || "openapi_error");
    return { ok: false, reason, itemNo };
  }
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
    const rawName = line.slice(0, idx).trim();
    const name = rawName
      .replace(/색깔/g, "색상")
      .replace(/크기|사이즈/g, "사이즈");
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
  const cleaned = stripDomeggookPromoBlocks(raw);

  if (!baseUrl) return cleaned;

  return cleaned.replace(/(src|href)=["']?([^"' >]+)["']?/gi, (m, attr, val) => {
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
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const tag = String(m[0] || "");
    const attrs = [];
    const attrRe = /(?:\s|^)(src|data-src|data-original|data-lazy)=["']?([^"' >]+)["']?/gi;
    let am;
    while ((am = attrRe.exec(tag))) {
      attrs.push(String(am[2] || "").trim());
    }
    for (const raw of attrs) {
      let src = String(raw || "").trim();
      if (!src || src.startsWith("data:")) continue;
      if (src.startsWith("//")) src = "https:" + src;
      if (!/^https?:\/\//i.test(src)) {
        try {
          src = new URL(src, baseUrl).toString();
        } catch {
          continue;
        }
      }
      if (!out.includes(src)) out.push(src);
    }
  }
  return out;
}

const DETAIL_GARBAGE_PATTERNS = [
  /\/image\/common\//i,
  /\/image\/item\//i,
  /\/image\/event\//i,
  /\/(?:sns|social)\//i,
  /(^|[_\-/])icon([_\-./]|$)/i,
  /(^|[_\-/])logo([_\-./]|$)/i,
  /(^|[_\-/])banner([_\-./]|$)/i,
  /(^|[_\-/])btn([_\-./]|$)/i,
  /sprite/i,
  /facebook|twitter|kakao|share/i,
  /(^|\/)(notice|info|guide|policy|faq|qna|cs|service)(\/|[_\-.]|$)/i,
  /(^|\/)(delivery|shipping|ship|refund|return|exchange|as)([_\-.]?\d+)?\.(?:jpe?g|png|gif|webp)$/i,
  /(^|[_\-/])(index[_-]?(?:gift|event|notice|info)|print[-_]?top|banner[-_]?top)([_\-./]|$)/i,
  /배송|교환|반품|환불|안내|공지|문의|고객센터|유의|주의/i,
];

const SUPPLIER_PRODUCT_PATH_RE = /\/(?:image\/product|productimgs?)\//i;
const SUPPLIER_PRODUCT_FILE_RE = /\.[a-z0-9]{3,5}$/i;

function isSupplierProductAssetPath(path = "") {
  const normalizedPath = String(path || "").toLowerCase();
  if (!SUPPLIER_PRODUCT_PATH_RE.test(normalizedPath)) return false;
  const fileName = normalizedPath.split("/").pop() || "";
  if (!SUPPLIER_PRODUCT_FILE_RE.test(fileName)) return false;
  if (DETAIL_GARBAGE_PATTERNS.some((re) => re.test(normalizedPath))) return false;
  return true;
}

function classifyDetailImageUrl(rawUrl) {
  let url = String(rawUrl || "").trim();
  if (!url) {
    return { usable: false, garbage: true, thumb: false, esmplus: false };
  }

  let host = "";
  let path = url.toLowerCase();
  try {
    const u = new URL(url);
    host = String(u.hostname || "").toLowerCase();
    path = (String(u.pathname || "") + String(u.search || "")).toLowerCase();
  } catch {}

  const thumb =
    /(?:^|[\/_-])stt_\d+\./i.test(path) ||
    /(?:^|[\/_-])thumb(?:nail)?([\/_\-.]|$)/i.test(path);
  const garbage = thumb || DETAIL_GARBAGE_PATTERNS.some((re) => re.test(path));
  const esmplus = /(^|\.)esmplus\.com$/i.test(host);
  const likelyDetail =
    esmplus ||
    /\/upload\/item\//i.test(path) ||
    /\/upload\/editor\//i.test(path) ||
    /\/upload\/contents\//i.test(path) ||
    /\/editor\//i.test(path) ||
    /\/contents\//i.test(path) ||
    /\/attach(?:ment)?\//i.test(path) ||
    isSupplierProductAssetPath(path);

  return {
    usable: Boolean(!garbage && likelyDetail),
    garbage,
    thumb,
    esmplus,
  };
}

function scoreDetailHtmlCandidate(html, baseUrl) {
  const urls = extractImageUrlsFromHtml(html, baseUrl);
  let usableCount = 0;
  let garbageCount = 0;
  let thumbCount = 0;
  let esmplusCount = 0;

  for (const u of urls) {
    const c = classifyDetailImageUrl(u);
    if (c.usable) usableCount += 1;
    if (c.garbage) garbageCount += 1;
    if (c.thumb) thumbCount += 1;
    if (c.esmplus) esmplusCount += 1;
  }

  const score = usableCount * 8 + esmplusCount * 2 - garbageCount * 6 - thumbCount * 4;
  return {
    score,
    totalCount: urls.length,
    usableCount,
    garbageCount,
    thumbCount,
    esmplusCount,
  };
}

function shouldReplaceDetailHtml(currentScore, candidateScore) {
  if (!currentScore) return true;
  if (!candidateScore) return false;

  if (candidateScore.usableCount > currentScore.usableCount) return true;
  if (candidateScore.usableCount === currentScore.usableCount && candidateScore.garbageCount < currentScore.garbageCount) {
    return true;
  }
  return candidateScore.score > currentScore.score + 2;
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

async function extractOptionVariantsFromRuntimeOptController(page) {
  try {
    const variants = await page.evaluate(() => {
      const pick = (v, path = [], depth = 0, out = []) => {
        if (!v || typeof v !== "object") return out;
        if (depth > 5) return out;

        // A "data" object that looks like the ItemOptionController option payload
        // Shape: { type, set/orgSet, data: { key: {name, domPrice, qty, hid} } }
        const d = v.data && v.data.data && (v.data.set || v.data.orgSet) ? v.data : null;
        if (d && typeof d === "object") {
          out.push({ path, data: d });
        }

        // Traverse plain objects/arrays
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i += 1) pick(v[i], path.concat([String(i)]), depth + 1, out);
          return out;
        }

        const keys = Object.keys(v);
        for (const k of keys) {
          // avoid huge recursion
          if (k === "parent" || k === "ownerDocument" || k === "document") continue;
          try {
            pick(v[k], path.concat([k]), depth + 1, out);
          } catch {}
        }
        return out;
      };

      const roots = [];
      try {
        // Common global used by Domeggook
        if (window.lItem && window.lItem.optController) roots.push(window.lItem.optController);
      } catch {}
      try {
        if (window.optController) roots.push(window.optController);
      } catch {}

      const hits = [];
      for (const r of roots) pick(r, ["root"], 0, hits);

      // Choose the richest dataset
      hits.sort((a, b) => {
        const aLen = a?.data?.data ? Object.keys(a.data.data).length : 0;
        const bLen = b?.data?.data ? Object.keys(b.data.data).length : 0;
        return bLen - aLen;
      });

      const best = hits[0]?.data;
      if (!best || !best.data || typeof best.data !== "object") return [];

      const setMap = best.set || best.orgSet || {};
      const setKeys = Object.keys(setMap)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
        .map((n) => String(n));

      const variants = [];
      for (const key of Object.keys(best.data)) {
        const item = best.data[key];
        const name = String(item?.name || "").trim();
        if (!name) continue;
        const hidden = Number(item?.hid ?? 0);
        if (hidden === 1) continue;

        const priceDelta = Number(item?.domPrice ?? 0);
        const stock = Number(item?.qty ?? 0);

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
              (setInfo.opts && setInfo.opts[optIdx] != null ? String(setInfo.opts[optIdx]) : "") || "";
            if (optionValue) values.push({ optionName, optionValue });
          }
        }

        variants.push({
          name,
          priceDelta: Number.isNaN(priceDelta) ? 0 : priceDelta,
          stock: Number.isNaN(stock) ? 0 : stock,
          sourceOptionCode: String(key || "").trim(),
          values,
        });
      }

      return variants;
    });

    if (!Array.isArray(variants) || variants.length === 0) return [];

    // de-dupe
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
  } catch {
    return [];
  }
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
              sourceOptionCode: String(key || "").trim(),
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
    // common stable selectors
    "img.mainThumb",
    "#lThumbImg",
    "img#lThumbImg",
    "#lThumbWrap img",
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "attached", timeout: 3000 });
      const src = normalizeUrl(await loc.getAttribute("src"));
      if (src && src.startsWith("http")) return src;
    } catch {}
  }

  // Fallback: pick the largest likely product image (avoid header/icons)
  try {
    const src = await page.evaluate(() => {
      const normalize = (u) => {
        if (!u) return "";
        const s = String(u).trim();
        if (s.startsWith("//")) return "https:" + s;
        if (s.startsWith("/")) return location.origin + s;
        return s;
      };

      const bad = [
        "/image/mobile_v2/image/common/",
        "/image/mobile_v2/image/item/view/",
        "/image/common/",
        "/image/item/",
        "ico_",
        "arrow",
        "close",
        "back.png",
        "home.png",
        "cart.png",
        "search.png",
      ];

      const imgs = Array.from(document.images)
        .map((img) => {
          const src = normalize(img.currentSrc || img.src);
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          return { src, w, h, area: w * h };
        })
        .filter((x) => x.src && x.src.startsWith("http"))
        .filter((x) => {
          const u = x.src.toLowerCase();
          return !bad.some((k) => u.includes(String(k).toLowerCase()));
        })
        // prefer known item upload paths
        .sort((a, b) => {
          const au = a.src.includes("/upload/item/") ? 1 : 0;
          const bu = b.src.includes("/upload/item/") ? 1 : 0;
          if (au !== bu) return bu - au;
          return b.area - a.area;
        });

      return imgs[0]?.src || "";
    });
    if (src && src.startsWith("http")) return src;
  } catch {}

  return null;
}

export async function parseProductFromDomaeqq(url, opts = {}) {
  const mode = String(opts?.mode || "full").trim().toLowerCase();
  const previewSourceMode = (() => {
    const raw = String(opts?.previewSourceMode || "auto").trim().toLowerCase();
    if (raw === "openapi" || raw === "playwright") return raw;
    return "auto";
  })();
  const previewOpenApiTimeoutMs = Math.max(
    1600,
    Math.min(9000, Number(opts?.previewOpenApiTimeoutMs) || 4500),
  );
  const previewSeedTitle = String(opts?.previewSeedTitle || "").trim();
  const previewSeedPrice = Number(opts?.previewSeedPrice);
  const previewSeedImageUrl = normalizeUrl(String(opts?.previewSeedImageUrl || "").trim());
  const previewPlaywrightFast = mode === "preview" && previewSourceMode === "playwright";
  const is1688 = String(url || "").includes("1688.domeggook.com");
  const isMobile = (() => {
    try {
      const h = new URL(String(url || "")).hostname || "";
      return /^mobile\./i.test(h);
    } catch {
      return false;
    }
  })();

  // Recommendation preview path: prefer fast OpenAPI item-view parse
  // to avoid repeated Playwright timeouts.
  if (mode === "preview" && !is1688 && previewSourceMode !== "playwright") {
    let openApiFailureReason = "";
    try {
      const openApiItemView = await loadOpenApiItemViewCandidate(url, {
        fastMode: true,
        timeoutMs: previewOpenApiTimeoutMs,
      });
      openApiFailureReason = String(openApiItemView?.reason || "").trim();
      const fastTitle = String(openApiItemView?.title || previewSeedTitle || "").trim();
      const openApiPrice = Number(openApiItemView?.price);
      const fastPrice = Number.isFinite(openApiPrice) && openApiPrice > 0
        ? openApiPrice
        : previewSeedPrice;
      const fastImageUrl = normalizeUrl(openApiItemView?.imageUrl || previewSeedImageUrl || "");
      const openApiShippingFee = Number(openApiItemView?.shippingFee);
      const openApiDetailHtml = stripDomeggookPromoBlocks(
        String(openApiItemView?.detailHtml || "").trim(),
      );
      const openApiDetailImagesRaw = Array.isArray(openApiItemView?.detailImages)
        ? openApiItemView.detailImages.map((u) => normalizeUrl(u)).filter(Boolean)
        : [];
      const openApiDetailHtmlImageCount = openApiDetailHtml
        ? extractImageUrlsFromHtml(openApiDetailHtml, url).length
        : 0;
      const quickDetail =
        !openApiDetailHtml
          ? await loadQuickDetailHtmlCandidate(url, {
              timeoutMs: Math.min(4500, previewOpenApiTimeoutMs + 800),
            })
          : { ok: false, reason: "openapi_detail_present", detailHtml: "", detailImages: [] };
      const mergedDetailImages = Array.from(
        new Set([
          ...openApiDetailImagesRaw,
          ...(Array.isArray(quickDetail?.detailImages) ? quickDetail.detailImages : []),
        ]),
      );
      const fastContentHtml = openApiDetailHtml
        ? (
            openApiDetailHtmlImageCount > 0
              ? openApiDetailHtml
              : `${openApiDetailHtml}\n${buildImageHtml(mergedDetailImages.slice(0, 80))}`
          )
        : (
            String(quickDetail?.detailHtml || "").trim() ||
            buildImageHtml(mergedDetailImages.slice(0, 80))
          );
      const shippingSignalText = `${fastTitle} ${fastContentHtml}`;
      const parsedShippingFromFastText = parseShippingFeeFromAnyText(shippingSignalText);
      const explicitFreeFromFastText = hasExplicitFreeShippingText(shippingSignalText);
      let quickShippingProbe = { ok: false, fee: null, source: "", reason: "not_needed" };
      const fastShippingFee = await (async () => {
        const openApiPositive = Number.isFinite(openApiShippingFee) && openApiShippingFee > 0
          ? openApiShippingFee
          : null;
        const textParsed = Number.isFinite(Number(parsedShippingFromFastText))
          ? Number(parsedShippingFromFastText)
          : null;
        const textPositive = Number.isFinite(textParsed) && textParsed > 0 ? textParsed : null;
        const positiveCandidates = [textPositive, openApiPositive].filter((n) => Number.isFinite(n) && n > 0);
        if (positiveCandidates.length > 0) {
          return Math.min(...positiveCandidates);
        }

        // OpenAPI often returns "0" as a weak default. Verify via quick page fetch first.
        quickShippingProbe = await loadQuickShippingFeeCandidate(url, {
          timeoutMs: Math.min(5000, previewOpenApiTimeoutMs + 1200),
        });
        if (Number.isFinite(Number(quickShippingProbe?.fee))) {
          const quickFee = Number(quickShippingProbe.fee);
          if (quickFee > 0) return quickFee;
          if (quickFee < 0) return -1;
          if (quickFee === 0) return 0;
        }

        if (Number.isFinite(textParsed) && textParsed < 0) return -1;
        if (Number.isFinite(openApiShippingFee) && openApiShippingFee < 0) return -1;

        // Only accept zero-shipping when free-shipping text is explicit.
        if (Number.isFinite(textParsed) && textParsed === 0 && explicitFreeFromFastText) return 0;
        if (Number.isFinite(openApiShippingFee) && openApiShippingFee === 0 && explicitFreeFromFastText) return 0;

        return null;
      })();
      const hasSeedCore =
        Boolean(fastTitle) &&
        Number.isFinite(fastPrice) &&
        fastPrice > 0 &&
        Boolean(fastImageUrl);
      const hasUsableDetail = Boolean(fastContentHtml) || mergedDetailImages.length > 0;

      if (
        hasSeedCore &&
        (openApiItemView?.ok || Boolean(quickDetail?.ok) || hasUsableDetail)
      ) {
        const draft = makeDraft({
          sourceUrl: String(url || "").trim(),
          title: fastTitle,
          price: fastPrice,
          imageUrl: fastImageUrl,
          contentText: fastContentHtml || fastTitle,
          categoryText: "",
          options: [],
          shippingFee: Number.isFinite(Number(fastShippingFee)) ? Number(fastShippingFee) : null,
        });
        draft.__debug = {
          source: "domeggook",
          is1688,
          isMobile,
          mode,
          optionStrategy: "preview.openapi_item_view",
          finalOptionsCount: 0,
          detailSource: openApiDetailHtml
            ? "openapi_item_view_fast_path"
            : (quickDetail?.ok ? "openapi_quick_http_fallback" : "openapi_item_view_fast_path"),
          openApi: {
            attempted: true,
            ok: Boolean(openApiItemView?.ok),
            reason: String(openApiItemView?.reason || ""),
            itemNo: String(openApiItemView?.itemNo || ""),
            diagnostics: openApiItemView?.diagnostics || null,
            sourceMode: previewSourceMode,
            quickDetail: {
              attempted: !openApiDetailHtml,
              ok: Boolean(quickDetail?.ok),
              reason: String(quickDetail?.reason || ""),
              detailImages: mergedDetailImages.length,
            },
            detailImages: mergedDetailImages.slice(0, 120),
            seedFallbackUsed: Boolean(
              (!String(openApiItemView?.title || "").trim() && previewSeedTitle) ||
              (!(Number.isFinite(openApiPrice) && openApiPrice > 0) && Number.isFinite(previewSeedPrice)) ||
              (!normalizeUrl(openApiItemView?.imageUrl || "") && previewSeedImageUrl),
            ),
            shippingFeeRaw: Number.isFinite(openApiShippingFee) ? openApiShippingFee : null,
            shippingFromFastText: Number.isFinite(Number(parsedShippingFromFastText))
              ? Number(parsedShippingFromFastText)
              : null,
            quickShippingProbe,
            shippingFee: Number.isFinite(Number(fastShippingFee)) ? Number(fastShippingFee) : null,
            usedDetail: Boolean(fastContentHtml),
            usedImage: true,
          },
        };
        return attachPurchaseSourceToDraft(draft, {
          sourceUrl: String(url || "").trim(),
          itemNo: String(openApiItemView?.itemNo || "").trim(),
          options: [],
          minimumOrderQty: 1,
        });
      }
    } catch (e) {
      openApiFailureReason = String(e?.message || e || "openapi_error").trim();
    }
    if (previewSourceMode === "openapi") {
      throw new Error(
        `preview_openapi_failed:${openApiFailureReason || "openapi_item_view_insufficient"}`,
      );
    }
  } else if (mode === "preview" && previewSourceMode === "openapi") {
    throw new Error("preview_openapi_failed:not_domeggook_item_view");
  }

  const browser = await chromium.launch({ headless: true });
  const storageStatePath =
    process.env.DOMEGGOOK_STORAGE_STATE ||
    path.join(process.cwd(), "storageState.json");

  const context = fs.existsSync(storageStatePath)
    ? await browser.newContext({ storageState: storageStatePath })
    : await browser.newContext();

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: previewPlaywrightFast ? 12000 : 90000,
    });
    await page.waitForTimeout(previewPlaywrightFast ? 800 : 2000);

    // short link(예: domeggook.com/SeznkY)인 경우 실제 상품 URL로 리다이렉트됨
    // 옵션 팝업/리퍼러/상품번호 추출은 최종 URL을 기준으로 해야 정확함
    const refererUrl = page.url();
    const openApiItemView =
      !is1688
        ? await loadOpenApiItemViewCandidate(refererUrl || url, {
            fastMode: previewPlaywrightFast,
            timeoutMs: previewPlaywrightFast ? Math.min(previewOpenApiTimeoutMs, 2800) : 12000,
          })
        : { ok: false, reason: "not_domeggook_item_view" };

    // Best-effort: open option layer if the page hides options behind a button/layer.
    if (!is1688 && !previewPlaywrightFast) {
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
          const normalizeName = (n) =>
            String(n || "")
              .replace(/색깔/g, "색상")
              .replace(/크기|사이즈/g, "사이즈")
              .trim();
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
              const name = normalizeName(line.slice(0, idx));
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
      (await page.locator(".lDiscountAmt").first().textContent().catch(() => null))?.trim() ||
      (await page.locator(".lItemPrice").first().textContent().catch(() => null))?.trim() ||
      (await page.locator("text=/\\d[\\d,]*\\s*원/").first().textContent().catch(() => null))?.trim();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const reliablePagePrice = await page.evaluate(() => {
      const parseNum = (value) => {
        const text = String(value ?? "").replace(/,/g, " ").trim();
        const match = text.match(/(\d[\d,]*)/);
        if (!match) return null;
        const parsed = Number(String(match[1] || "").replace(/,/g, ""));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      };

      const candidates = [];

      try {
        const state = window?.lItem?.store?.getState?.();
        const baseAmtDome = parseNum(state?.baseAmtDome);
        if (baseAmtDome) candidates.push(baseAmtDome);
      } catch {}

      try {
        const og = document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute("content");
        const ogPrice = parseNum(og);
        if (ogPrice) candidates.push(ogPrice);
      } catch {}

      try {
        const enpPrice = parseNum(window?.ENP_VAR?.collect?.price);
        if (enpPrice) candidates.push(enpPrice);
      } catch {}

      try {
        const itemPrice = parseNum(window?.itemPrice);
        if (itemPrice) candidates.push(itemPrice);
      } catch {}

      return candidates.find((n) => Number.isFinite(n) && n > 0) || null;
    }).catch(() => null);
    let shippingFee = parseShippingFeeFromText(bodyText);

    // Mobile domeggook pages often contain clearer shipping info ("배송정보 3,000원 ~").
    // If we are on desktop domeggook and shippingFee is missing/0, try the mobile URL once.
    try {
      const cur = new URL(url);
      const isDesktopDomeggook = cur.hostname === "domeggook.com";
      const idMatch = (cur.pathname || "").match(/\/(\d{6,})/);
      const productId = idMatch ? idMatch[1] : null;
      if (!previewPlaywrightFast && isDesktopDomeggook && productId) {
        const mobileUrl = `https://mobile.domeggook.com/${productId}`;
        const mobilePage = await context.newPage();
        try {
          await mobilePage.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
          await mobilePage.waitForTimeout(600);
          const mobileText = await mobilePage.locator("body").innerText().catch(() => "");
          const mobileFee = parseShippingFeeFromText(mobileText);
          if (Number.isFinite(Number(mobileFee)) && Number(mobileFee) !== 0) {
            shippingFee = mobileFee;
          }
        } finally {
          await mobilePage.close().catch(() => {});
        }
      }
    } catch {}

    const variantPrices = Array.isArray(variantTable?.variants)
      ? variantTable.variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n))
      : [];
    const minVariantPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : null;

    // Domeggook quantity-tier pricing: prefer unit price for minQty=1 when available.
    let qtyPriceTiers = [];
    if (!is1688 && !previewPlaywrightFast) {
      qtyPriceTiers = await extractDomeggookQuantityPriceTiers(page);
    }
    const qtyPriceForOne = Array.isArray(qtyPriceTiers)
      ? qtyPriceTiers.find((t) => Number(t.minQty) === 1)?.unitPrice
      : null;
    const qtyTierFirst = Array.isArray(qtyPriceTiers) && qtyPriceTiers.length > 0
      ? qtyPriceTiers[0]
      : null;
    const qtyPriceMinQty = Number.isFinite(Number(qtyTierFirst?.unitPrice))
      ? Number(qtyTierFirst.unitPrice)
      : null;
    const qtyMinQty = Number.isFinite(Number(qtyTierFirst?.minQty))
      ? Number(qtyTierFirst.minQty)
      : null;
    const qtyMinPriceUsable =
      Number.isFinite(Number(qtyPriceMinQty)) &&
      Number.isFinite(Number(qtyMinQty)) &&
      Number(qtyMinQty) > 0 &&
      Number(qtyMinQty) <= 5;

    const priceFromPriceText = pickPrimaryKrwAmount(priceText);

    const openApiPrice = Number.isFinite(Number(openApiItemView?.price))
      ? Number(openApiItemView.price)
      : null;
    const fallbackQtyPrice =
      (Number.isFinite(Number(qtyPriceForOne)) ? Number(qtyPriceForOne) : null) ||
      (qtyMinPriceUsable ? Number(qtyPriceMinQty) : null) ||
      null;
    const priceRaw =
      (is1688 && Number.isFinite(minVariantPrice) ? minVariantPrice : null) ||
      (Number.isFinite(Number(reliablePagePrice)) ? Number(reliablePagePrice) : null) ||
      (Number.isFinite(openApiPrice) ? openApiPrice : null) ||
      (Number.isFinite(Number(priceFromPriceText)) ? Number(priceFromPriceText) : null) ||
      pickPriceFromText(bodyText) ||
      fallbackQtyPrice ||
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
    let imageFromOpenApi = false;
    if (!imageUrl && openApiItemView?.imageUrl) {
      imageUrl = normalizeUrl(openApiItemView.imageUrl);
      imageFromOpenApi = Boolean(imageUrl);
    }

    // ✅ 상세 HTML 추출(스크립트/스타일 제거 + img src 정리 + 업그레이드)
    // Some pages fill #contentsBuffer (textarea) asynchronously.
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('#contentsBuffer');
        const v = el && (el.value || el.textContent || '');
        return v && String(v).trim().length > 200;
      }, { timeout: previewPlaywrightFast ? 1800 : 5000 });
    } catch {}

    const contentHtml = await page.evaluate(() => {
      const normHtml = (html) =>
        String(html || "")
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .trim();

      // Some pages store the detail HTML inside a hidden textarea.
      const buf = document.querySelector('#contentsBuffer');
      const bufHtml = buf && (buf.value || buf.textContent || '');
      if (bufHtml && String(bufHtml).trim().length > 200) {
        return normHtml(String(bufHtml));
      }

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

    let finalContentHtml = sanitizeHtml(contentHtml, url) || contentHtml || "";
    let finalContentBaseUrl = url;
    let finalContentScore = scoreDetailHtmlCandidate(finalContentHtml, finalContentBaseUrl);
    let finalContentSource = finalContentHtml ? "page_dom" : "empty";

    const adoptDetailCandidate = (candidateHtml, candidateBaseUrl, source = "candidate") => {
      const sanitized = sanitizeHtml(candidateHtml, candidateBaseUrl) || "";
      if (!sanitized) return;
      const score = scoreDetailHtmlCandidate(sanitized, candidateBaseUrl || url);
      if (shouldReplaceDetailHtml(finalContentScore, score)) {
        finalContentHtml = sanitized;
        finalContentBaseUrl = candidateBaseUrl || url;
        finalContentScore = score;
        finalContentSource = source;
      }
    };

    // API-first: try OpenAPI item view detail before HTML scraping fallbacks.
    if (openApiItemView?.detailHtml) {
      adoptDetailCandidate(openApiItemView.detailHtml, refererUrl || url, "openapi_item_view");
    }

    if (detailHtmlUrl) {
      try {
        const res = await fetchTextWithTimeout(detailHtmlUrl, {
          timeoutMs: previewPlaywrightFast ? 3000 : 7000,
          headers: {
            Referer: url,
            "User-Agent": "Mozilla/5.0",
          },
        });
        if (res.ok) {
          const html = res.text;
          const bodyOnly = extractBodyHtml(html);
          const mainOnly = extractMainBlock(bodyOnly);
          const imgList = extractImageUrlsFromHtml(bodyOnly, detailHtmlUrl);
          const imgHtml = buildImageHtml(imgList);
          if (imgList.length >= 2) {
            adoptDetailCandidate(imgHtml, detailHtmlUrl, "esmplus_iframe_images");
          } else {
            adoptDetailCandidate(mainOnly, detailHtmlUrl, "esmplus_iframe_html");
          }
        }
      } catch {
        // fallback to existing candidate
      }
    }

    // ✅ Raw HTML의 contentsBuffer도 항상 평가한다.
    // 페이지 블럭이 추천상품/썸네일을 많이 포함하는 경우, contentsBuffer가 더 정확한 상세인 경우가 많다.
    try {
      const res = await fetchTextWithTimeout(url, {
        timeoutMs: previewPlaywrightFast ? 2600 : 6000,
        headers: {
          Referer: "https://domeggook.com/",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (res.ok) {
        const raw = res.text;
        const m = String(raw).match(/<textarea[^>]*id=["']contentsBuffer["'][^>]*>([\s\S]*?)<\/textarea>/i);
        const bufHtml = m && m[1] ? String(m[1]).trim() : "";
        if (bufHtml.length > 200) {
          adoptDetailCandidate(bufHtml, url, "raw_contents_buffer");
        }
      }
    } catch {}

    const pageTitleText = String(await page.title().catch(() => "") || "").trim();
    const resolvedTitle =
      String(titleText || "").trim() ||
      String(openApiItemView?.title || "").trim() ||
      previewSeedTitle ||
      pageTitleText ||
      "도매꾹 상품";

    if (previewPlaywrightFast) {
      const draft = makeDraft({
        sourceUrl: url,
        title: resolvedTitle,
        price,
        imageUrl: imageUrl || "https://via.placeholder.com/1000",
        contentText: finalContentHtml || resolvedTitle || "",
        categoryText: "",
        options: [],
        shippingFee,
      });
      draft.__debug = {
        source: "domeggook",
        is1688,
        isMobile,
        mode,
        optionStrategy: "preview.playwright_fast",
        finalOptionsCount: 0,
        detailSource: finalContentSource,
        openApi: {
          attempted: !is1688,
          ok: Boolean(openApiItemView?.ok),
          reason: String(openApiItemView?.reason || ""),
          itemNo: String(openApiItemView?.itemNo || ""),
          diagnostics: openApiItemView?.diagnostics || null,
          usedDetail: finalContentSource === "openapi_item_view",
          usedImage: imageFromOpenApi,
          sourceMode: previewSourceMode,
        },
      };
      return attachPurchaseSourceToDraft(draft, {
        sourceUrl: url,
        itemNo: String(openApiItemView?.itemNo || "").trim(),
        options: [],
        minimumOrderQty: 1,
      });
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
      // ✅ 옵션: 런타임에 생성된 ItemOptionController 데이터를 직접 읽기(가장 안정적)
      // (mobile 페이지는 inline script가 JSON이 아니거나 분리되어 있어 text 파싱이 실패할 수 있음)
      try {
        const runtimeOptions = await extractOptionVariantsFromRuntimeOptController(page);
        if (runtimeOptions.length > 0) {
          optionStrategy = "runtimeOptController";
          finalOptions = runtimeOptions;
        }
      } catch {}

      // ✅ 옵션: inline script 텍스트 파싱 fallback
      if (finalOptions.length === 0) {
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
    }

    // ✅ 옵션 팝업(전체보기) fallback
    if (!is1688 && finalOptions.length === 0) {
      try {
        const productId = String(refererUrl || url).match(/\d+/)?.[0] || "";
        const popupUrl = `https://domeggook.com/main/popup/item/popup_itemOptionView.php?no=${encodeURIComponent(
          productId,
        )}&market=dome`;
        const res = await page.request.get(popupUrl, {
          headers: {
            // mobile referer가 차단되는 케이스가 있어 도매꾹 도메인 기준으로 고정
            Referer: "https://domeggook.com/",
            "User-Agent": "Mozilla/5.0",
          },
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

    // ✅ 최종 옵션 정리: 메뉴/안내 텍스트 제거 + 진짜 옵션처럼 보이는 것만 남김
    if (Array.isArray(finalOptions) && finalOptions.length > 0) {
      finalOptions = finalOptions
        .filter((t) => {
          const name = String(t?.name || t || "");
          return !OPTION_TEXT_IGNORE.some((g) => name.includes(g));
        })
        .filter((t) => {
          const name = normalizeOptionText(String(t?.name || t || ""));
          return isLikelyOptionText(name);
        });

      if (finalOptions.length === 0) {
        optionStrategy = "none";
      }
    }

    // ✅ 마지막 fallback: 페이지에서 긁은 옵션 텍스트 사용
    if (finalOptions.length === 0 && Array.isArray(options) && options.length > 0) {
      optionStrategy = "pageText";
      finalOptions = options.map((name) => ({ name, priceDelta: 0, stock: 0, values: [] }));
    }

    const draft = makeDraft({
      sourceUrl: url,
      title: resolvedTitle,
      price,
      imageUrl: imageUrl || "https://via.placeholder.com/1000",
      contentText: finalContentHtml || resolvedTitle || "",
      categoryText,
      options: finalOptions,
      shippingFee,
    });

    draft.purchaseConstraints = {
      minimumOrderQty: Number.isFinite(Number(qtyMinQty)) && Number(qtyMinQty) > 0
        ? Number(qtyMinQty)
        : 1,
      quantityPriceTiers: Array.isArray(qtyPriceTiers) ? qtyPriceTiers.slice(0, 10) : [],
    };
    attachPurchaseSourceToDraft(draft, {
      sourceUrl: url,
      itemNo: String(openApiItemView?.itemNo || "").trim(),
      options: finalOptions,
      minimumOrderQty: draft.purchaseConstraints.minimumOrderQty,
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
      price: {
        picked: price,
        raw: priceRaw,
        reliablePagePrice: Number.isFinite(Number(reliablePagePrice)) ? Number(reliablePagePrice) : null,
        openApiPrice: Number.isFinite(Number(openApiPrice)) ? Number(openApiPrice) : null,
        priceFromPriceText: Number.isFinite(Number(priceFromPriceText)) ? Number(priceFromPriceText) : null,
        fallbackQtyPrice: Number.isFinite(Number(fallbackQtyPrice)) ? Number(fallbackQtyPrice) : null,
        qtyTiers: Array.isArray(qtyPriceTiers) ? qtyPriceTiers.slice(0, 10) : [],
      },
      detailSource: finalContentSource,
      openApi: {
        attempted: !is1688,
        ok: Boolean(openApiItemView?.ok),
        reason: String(openApiItemView?.reason || ""),
        itemNo: String(openApiItemView?.itemNo || ""),
        diagnostics: openApiItemView?.diagnostics || null,
        usedDetail: finalContentSource === "openapi_item_view",
        usedImage: imageFromOpenApi,
      },
    };

    return draft;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
