// step7_extract_colors_v5.js
// 목표(진짜 결정판):
// - 1번처럼 "옵션 표(table)"인 상품은 table에서 '색상' 컬럼을 읽는다.
// - 2번처럼 "옵션 리스트/텍스트"인 상품은 화면 텍스트에서 색상 토큰을 읽는다.
// - 둘 중 하나라도 성공하면 결과로 채택한다.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

// -------------------- 공통 유틸 --------------------
function splitTokens(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, " ")
    .split(/[,/|·\s-]+/) // 쉼표/공백/하이픈 포함
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
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

function extractStandardColorsFromText(text) {
  const tokens = splitTokens(text);
  const out = new Set();
  for (const t of tokens) {
    const c = normalizeColorToken(t);
    if (c) out.add(c);
  }
  return Array.from(out);
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

// -------------------- 방식 A: Table에서 '색상' 컬럼 읽기 --------------------
async function findColorColumnCellsAnywhere(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const cells = await frame.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;

          const firstRowCells = Array.from(
            rows[0].querySelectorAll("th, td")
          ).map((el) => (el.textContent || "").trim());
          let colorIndex = firstRowCells.findIndex((t) => t.includes("색상"));

          if (colorIndex === -1) {
            const theadCells = Array.from(
              table.querySelectorAll("thead th, thead td")
            ).map((el) => (el.textContent || "").trim());
            if (theadCells.length > 0) {
              colorIndex = theadCells.findIndex((t) => t.includes("색상"));
            }
          }

          if (colorIndex === -1) continue;

          const values = [];
          for (let i = 1; i < rows.length; i++) {
            const cells = Array.from(rows[i].querySelectorAll("td, th"));
            if (cells.length <= colorIndex) continue;
            const txt = (cells[colorIndex].textContent || "").trim();
            if (!txt || txt === "색상") continue;
            values.push(txt);
          }

          if (values.length > 0) return values;
        }
        return [];
      });

      if (Array.isArray(cells) && cells.length > 0) {
        return { ok: true, method: "table", cells, frameUrl: frame.url() };
      }
    } catch (_) {}
  }
  return { ok: false, method: "table", cells: [], frameUrl: null };
}

async function waitForColorTable(page, maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const found = await findColorColumnCellsAnywhere(page);
    if (found.ok) return found;
    await page.waitForTimeout(500);
  }
  return { ok: false, method: "table", cells: [], frameUrl: null };
}

// -------------------- 방식 B: Table이 없을 때(리스트/텍스트 방식) --------------------
// 아이디어:
// - 2번 상품처럼 옵션이 표가 아닌 경우, '색상' 근처 텍스트를 읽어 색상 토큰을 뽑는다.
// - v2에서 성공했던 방식이 여기로 들어감.
async function extractColorsByTextAroundColorLabel(page) {
  const colorLabel = page.locator("text=색상").first();
  if ((await colorLabel.count()) === 0) {
    return { ok: false, method: "text", rawText: "", colors: [] };
  }

  // 색상 라벨 주변(2단계 위)까지 텍스트를 크게 잡아서 읽음
  const parent1 = colorLabel.locator("xpath=..");
  const parent2 = parent1.locator("xpath=..");

  const t1 = (await parent1.textContent()) || "";
  const t2 = (await parent2.textContent()) || "";

  const areaText = t2.length > t1.length ? t2 : t1;

  // 너무 긴 설명/정책 텍스트가 섞일 수 있어서 2,000자까지만 사용
  const clipped = areaText.replace(/\s+/g, " ").trim().slice(0, 2000);

  const colors = extractStandardColorsFromText(clipped);

  return {
    ok: colors.length > 0,
    method: "text",
    rawTextSample: clipped.slice(0, 300),
    colors,
  };
}

(async () => {
  try {
    const inputPath = path.join("out", "step6_option_classification.json");
    const items = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    const targets = items.filter((i) => i.textOptionPossible === true);

    console.log("색상 추출 대상 상품 개수:", targets.length);

    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const url = targets[i].url;
      console.log(`\n[${i + 1}/${targets.length}] 처리(v5): ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);

      // 옵션 화면 열기(가능하면 열기)
      await openOptionView(page);

      // A) table 방식 먼저 시도
      const tableFound = await waitForColorTable(page, 12000);

      let finalColors = [];
      let usedMethod = "";
      let debug = {};

      if (tableFound.ok) {
        // table 셀 텍스트들에서 색상 추출
        const normalized = new Set();
        for (const cell of tableFound.cells) {
          extractStandardColorsFromText(cell).forEach((c) => normalized.add(c));
        }
        finalColors = Array.from(normalized);
        usedMethod = "table";
        debug = {
          tableFrame: tableFound.frameUrl,
          cellsSample: tableFound.cells.slice(0, 6),
        };
      } else {
        // B) text 방식 fallback
        const byText = await extractColorsByTextAroundColorLabel(page);
        finalColors = byText.colors;
        usedMethod = "text";
        debug = { rawTextSample: byText.rawTextSample };
      }

      const screenshotPath = path.join("out", `step7v5_${i + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      console.log("  사용 방식:", usedMethod);
      console.log("  표준 색상:", finalColors);

      results.push({
        url,
        method: usedMethod,
        normalizedColors: finalColors,
        debug,
        screenshot: screenshotPath,
      });
    }

    await browser.close();

    const outPath = path.join("out", "step7_colors_v5.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
