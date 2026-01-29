// step8_extract_variants_v2.js
// 목표: table 구조에서 "행(tr)" 단위로 옵션(SKU)을 정확히 분리해서 variants를 만든다.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

function normalizeSpaces(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function splitTokens(text) {
  return normalizeSpaces(text)
    .split(/[,/|·\s-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeColorToken(token) {
  if (!token) return null;
  for (const standard in COLOR_MAP) {
    for (const v of COLOR_MAP[standard]) {
      if (token.includes(v)) return standard;
    }
  }
  return null;
}

function extractSize(text) {
  const s = normalizeSpaces(text).toUpperCase();
  const patterns = [
    /\b(XXXL|3XL)\b/,
    /\b(XXL|2XL)\b/,
    /\b(XL)\b/,
    /\b(L)\b/,
    /\b(M)\b/,
    /\b(S)\b/,
    /\b(FREE|F)\b/,
    /\b(90|95|100|105|110)\b/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractPriceDelta(text) {
  const m = (text || "").match(/\(\s*([+-])\s*([\d,]+)\s*원?\s*\)/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const val = parseInt(m[2].replace(/,/g, ""), 10);
  return sign * (Number.isFinite(val) ? val : 0);
}

function parseVariant(optionText) {
  const tokens = splitTokens(optionText);
  let color = null;
  for (const t of tokens) {
    const c = normalizeColorToken(t);
    if (c) {
      color = c;
      break;
    }
  }
  const size = extractSize(optionText);
  const priceDelta = extractPriceDelta(optionText);

  return {
    optionText: normalizeSpaces(optionText),
    color,
    size,
    priceDelta,
  };
}

async function openOptionView(page) {
  const candidates = [
    "text=상품주문옵션 전체보기",
    "text=전체옵션보기",
    "text=전체 옵션 보기",
    "text=옵션선택",
    "text=옵션 보기",
    "text=옵션보기",
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      try {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(1200);
        return true;
      } catch (_) {}
    }
  }
  return false;
}

// ✅ 핵심: table에서 "색상 열 index"를 찾고, tbody의 각 행에서 그 열 td를 하나씩 뽑는다.
async function extractVariantsFromTableRows(page) {
  const frames = page.frames();

  for (const frame of frames) {
    try {
      const rowsData = await frame.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));

        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;

          // 헤더 후보: 첫 행(th/td)
          const headerCells = Array.from(
            rows[0].querySelectorAll("th, td")
          ).map((el) => (el.textContent || "").trim());

          let colorIndex = headerCells.findIndex((t) => t.includes("색상"));

          // thead 기반도 시도
          if (colorIndex === -1) {
            const theadCells = Array.from(
              table.querySelectorAll("thead th, thead td")
            ).map((el) => (el.textContent || "").trim());
            if (theadCells.length)
              colorIndex = theadCells.findIndex((t) => t.includes("색상"));
          }

          if (colorIndex === -1) continue;

          // 실제 옵션 행: rows[1..] (헤더 다음부터)
          const out = [];
          for (let i = 1; i < rows.length; i++) {
            const tds = Array.from(rows[i].querySelectorAll("td, th"));
            if (tds.length <= colorIndex) continue;

            const colorCell = (tds[colorIndex].textContent || "").trim();
            if (!colorCell || colorCell === "색상") continue;

            // 행 전체 텍스트도 같이 가져와서(추가금, 수량 등) 파싱에 활용
            const rowText = (rows[i].textContent || "").trim();

            out.push({
              colorCell,
              rowText,
            });
          }

          // 옵션 행이 실제로 여러 개면 이 테이블이 맞다
          if (out.length >= 2) return out;
        }

        return [];
      });

      if (Array.isArray(rowsData) && rowsData.length >= 2) {
        return { ok: true, frameUrl: frame.url(), rowsData };
      }
    } catch (_) {}
  }

  return { ok: false, frameUrl: null, rowsData: [] };
}

// text fallback(2번 같은 케이스)
async function extractColorsByTextFallback(page) {
  const label = page.locator("text=색상").first();
  if ((await label.count()) === 0) return [];

  const p1 = label.locator("xpath=..");
  const p2 = p1.locator("xpath=..");
  const t1 = normalizeSpaces(await p1.textContent());
  const t2 = normalizeSpaces(await p2.textContent());
  const area = (t2.length > t1.length ? t2 : t1).slice(0, 2000);

  const colors = new Set();
  for (const tok of splitTokens(area)) {
    const c = normalizeColorToken(tok);
    if (c) colors.add(c);
  }
  return Array.from(colors);
}

(async () => {
  try {
    const step6Path = path.join("out", "step6_option_classification.json");
    const step4Path = path.join("out", "step4_results.json");
    const step6 = JSON.parse(fs.readFileSync(step6Path, "utf-8"));
    const step4 = JSON.parse(fs.readFileSync(step4Path, "utf-8"));

    const priceMap = new Map(step4.map((r) => [r.url, r.price]));
    const targets = step6.filter((x) => x.textOptionPossible === true);

    console.log("옵션(SKU) 추출 대상:", targets.length);

    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const url = targets[i].url;
      console.log(`\n[${i + 1}/${targets.length}] SKU 추출(v2): ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);

      await openOptionView(page);

      const table = await extractVariantsFromTableRows(page);

      let method = "";
      let variants = [];
      let debug = {};

      if (table.ok) {
        method = "table_rows";
        debug.tableFrame = table.frameUrl;

        // ✅ 행 단위로 variants 생성
        for (const r of table.rowsData) {
          // colorCell이 가장 “옵션명”에 가까움(예: 231007-기모타이즈-블랙XL)
          // rowText에는 수량/추가금 등이 더 섞여 있음
          // 둘을 합쳐서 파싱하면 누락이 줄어듦
          const merged = `${r.colorCell} ${r.rowText}`;
          const v = parseVariant(merged);
          if (v.color) variants.push(v);
        }

        // 중복 제거(같은 color/size/priceDelta가 반복되면 1개로)
        const uniq = new Map();
        for (const v of variants) {
          const key = `${v.color}|${v.size || ""}|${v.priceDelta}`;
          uniq.set(key, v);
        }
        variants = Array.from(uniq.values());
      } else {
        method = "text_fallback";
        const colors = await extractColorsByTextFallback(page);
        variants = colors.map((c) => ({
          optionText: `COLOR=${c}`,
          color: c,
          size: null,
          priceDelta: 0,
        }));
        debug.note = "table 행 추출 실패 -> text fallback";
      }

      const rawPrice = priceMap.get(url) || "";
      const supplyPrice =
        parseInt(String(rawPrice).replace(/[^\d]/g, ""), 10) || null;

      const screenshot = path.join("out", `step8v2_${i + 1}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });

      console.log(
        "  방식:",
        method,
        "| variants:",
        variants.length,
        "| 공급가(임시):",
        supplyPrice
      );
      if (variants[0]) console.log("  예시 variant:", variants[0]);

      results.push({ url, method, supplyPrice, variants, debug, screenshot });
    }

    await browser.close();

    const outPath = path.join("out", "step8_variants_v2.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
