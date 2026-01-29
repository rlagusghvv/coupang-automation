// step8_extract_variants_v3.js
// 목표: 도매꾹 옵션이 한 덩어리로 붙어 있어도
//      "(9,999개)" 같은 재고 표기를 기준으로 옵션을 '줄 단위'로 분리한 뒤
//      각 줄에서 COLOR/SIZE/추가금을 뽑아 variants로 만든다.

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

// ✅ 핵심: 한 덩어리 텍스트를 "(9,999개)" 같은 패턴으로 분리해서 옵션 줄 배열 만들기
function splitOptionLinesByStockMark(bigText) {
  const t = normalizeSpaces(bigText).replace(/^색상/, ""); // 맨 앞에 '색상' 붙는 경우 제거

  // "(숫자개)" 패턴을 구분자로 사용
  // split 하면 옵션 텍스트 조각들이 나오고, 각 조각은 "한 옵션"에 해당
  const parts = t
    .split(/\(\s*\d[\d,]*\s*개\s*\)/g)
    .map((p) => normalizeSpaces(p))
    .filter((p) => p.length > 0);

  // parts 안에는 "231007-... (+600원)" 같은 단위가 섞여있음
  // 너무 짧거나 의미 없는 조각 제거
  return parts.filter((p) => p.length >= 6);
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

// table/iframe 상관없이 "색상 컬럼처럼 보이는 텍스트 덩어리"를 가져온다(이미 v4에서 성공했던 방식)
async function findColorColumnCellsAnywhere(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const cells = await frame.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;

          const header = Array.from(rows[0].querySelectorAll("th, td")).map(
            (el) => (el.textContent || "").trim()
          );
          let colorIndex = header.findIndex((t) => t.includes("색상"));

          if (colorIndex === -1) {
            const thead = Array.from(
              table.querySelectorAll("thead th, thead td")
            ).map((el) => (el.textContent || "").trim());
            if (thead.length)
              colorIndex = thead.findIndex((t) => t.includes("색상"));
          }

          if (colorIndex === -1) continue;

          const values = [];
          for (let i = 1; i < rows.length; i++) {
            const cols = Array.from(rows[i].querySelectorAll("td, th"));
            if (cols.length <= colorIndex) continue;
            const txt = (cols[colorIndex].textContent || "").trim();
            if (!txt || txt === "색상") continue;
            values.push(txt);
          }

          if (values.length) return values;
        }
        return [];
      });

      if (Array.isArray(cells) && cells.length) {
        return { ok: true, cells, frameUrl: frame.url() };
      }
    } catch (_) {}
  }
  return { ok: false, cells: [], frameUrl: null };
}

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
      console.log(`\n[${i + 1}/${targets.length}] SKU 추출(v3): ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);
      await openOptionView(page);

      const found = await findColorColumnCellsAnywhere(page);

      let method = "";
      let variants = [];
      let debug = {};

      if (found.ok) {
        method = "table_cell_split";
        debug.tableFrame = found.frameUrl;

        // ✅ 중요: cells가 여러 개일 수도 있지만,
        // 1번 상품처럼 '옵션 전체가 한 덩어리'인 경우가 있으니 전부 분해
        const allLines = [];
        for (const cellText of found.cells) {
          const lines = splitOptionLinesByStockMark(cellText);
          allLines.push(...lines);
        }

        // 각 줄을 variant로 변환
        const parsed = [];
        for (const line of allLines) {
          const v = parseVariant(line);
          if (v.color) parsed.push(v);
        }

        // 중복 제거
        const uniq = new Map();
        for (const v of parsed) {
          const key = `${v.color}|${v.size || ""}|${v.priceDelta}`;
          uniq.set(key, v);
        }
        variants = Array.from(uniq.values());

        debug.linesSample = allLines.slice(0, 8);
      } else {
        method = "text_fallback";
        const colors = await extractColorsByTextFallback(page);
        variants = colors.map((c) => ({
          optionText: `COLOR=${c}`,
          color: c,
          size: null,
          priceDelta: 0,
        }));
        debug.note = "table 미발견 -> text fallback";
      }

      const rawPrice = priceMap.get(url) || "";
      const supplyPrice =
        parseInt(String(rawPrice).replace(/[^\d]/g, ""), 10) || null;

      const screenshot = path.join("out", `step8v3_${i + 1}.png`);
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

    const outPath = path.join("out", "step8_variants_v3.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
