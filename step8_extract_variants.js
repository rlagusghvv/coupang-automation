// step8_extract_variants.js
// 목표: 도매꾹 옵션을 "SKU(옵션 행)" 단위로 뽑아낸다.
// - table(표) 구조면: 표의 각 행에서 '색상' 셀 텍스트를 가져오고, 그 안에서 COLOR/SIZE/추가금을 파싱
// - table이 아니면(text 방식): 색상만으로 SKU를 생성(COLOR만) -> 이후 버전에서 리스트 DOM을 더 정밀하게 파싱 가능

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

// ---------- 파싱 유틸 ----------
function normalizeSpaces(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function splitTokens(text) {
  return normalizeSpaces(text)
    .split(/[,/|·\s-]+/) // 쉼표/공백/하이픈 등
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

// 사이즈 후보를 간단 규칙으로 추출 (필요하면 계속 확장)
function extractSize(text) {
  const s = normalizeSpaces(text).toUpperCase();

  // 가장 흔한 패턴들
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

// "(+600원)" 같은 추가금 파싱
function extractPriceDelta(text) {
  const m = (text || "").match(/\(\s*([+-])\s*([\d,]+)\s*원?\s*\)/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const val = parseInt(m[2].replace(/,/g, ""), 10);
  return sign * (Number.isFinite(val) ? val : 0);
}

// 한 옵션 문자열에서 SKU 속성 파싱
function parseVariantFromOptionText(optionText) {
  const tokens = splitTokens(optionText);

  // COLOR
  let color = null;
  for (const t of tokens) {
    const c = normalizeColorToken(t);
    if (c) {
      color = c;
      break;
    }
  }

  // SIZE
  const size = extractSize(optionText);

  // 추가금
  const priceDelta = extractPriceDelta(optionText);

  return { optionText: normalizeSpaces(optionText), color, size, priceDelta };
}

// ---------- 도매꾹 화면 열기 ----------
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

// ---------- table 방식: 표에서 '색상' 컬럼의 "셀 텍스트" 리스트를 얻기 ----------
async function getColorCellsFromAnyTable(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const cells = await frame.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;

          const firstRow = Array.from(rows[0].querySelectorAll("th, td")).map(
            (el) => (el.textContent || "").trim()
          );
          let colorIndex = firstRow.findIndex((t) => t.includes("색상"));

          // thead도 시도
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
        return { ok: true, method: "table", cells, frameUrl: frame.url() };
      }
    } catch (_) {}
  }
  return { ok: false, method: "table", cells: [], frameUrl: null };
}

// ---------- text 방식: 색상만으로 variant 생성 (2번 같은 케이스용) ----------
async function getColorsByTextFallback(page) {
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

    // step4에서 가격을 공급가(원가)로 사용(임시)
    const priceMap = new Map(step4.map((r) => [r.url, r.price]));

    const targets = step6.filter((x) => x.textOptionPossible === true);
    console.log("옵션(SKU) 추출 대상:", targets.length);

    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const url = targets[i].url;
      console.log(`\n[${i + 1}/${targets.length}] SKU 추출: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);

      await openOptionView(page);

      // A) table 우선
      const tableFound = await getColorCellsFromAnyTable(page);

      let variants = [];
      let method = "";
      let debug = {};

      if (tableFound.ok) {
        method = "table";
        debug.tableFrame = tableFound.frameUrl;

        // table에서 얻은 각 셀 텍스트는 사실상 "옵션 한 줄" 역할을 함
        for (const cellText of tableFound.cells) {
          const v = parseVariantFromOptionText(cellText);
          // 테이블에서 잡힌 건 사이즈/추가금이 같이 들어있는 경우가 많음
          if (v.color) variants.push(v);
        }
      } else {
        method = "text";
        const colors = await getColorsByTextFallback(page);
        // 색상만으로 SKU 생성(사이즈 없음, 추가금 0)
        variants = colors.map((c) => ({
          optionText: `COLOR=${c}`,
          color: c,
          size: null,
          priceDelta: 0,
        }));
        debug.note = "table 미발견 -> text fallback(색상만)";
      }

      const screenshot = path.join("out", `step8_${i + 1}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });

      // URL별 공급가(임시): "25,690원" 같은 문자열 -> 숫자
      const rawPrice = priceMap.get(url) || "";
      const supplyPrice =
        parseInt(String(rawPrice).replace(/[^\d]/g, ""), 10) || null;

      results.push({
        url,
        method,
        supplyPrice,
        variants,
        debug,
        screenshot,
      });

      console.log(
        "  방식:",
        method,
        "| variants:",
        variants.length,
        "| 공급가(임시):",
        supplyPrice
      );
      if (variants[0]) console.log("  예시 variant:", variants[0]);
    }

    await browser.close();

    const outPath = path.join("out", "step8_variants.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
