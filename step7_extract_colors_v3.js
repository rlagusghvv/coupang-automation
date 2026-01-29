// step7_extract_colors_v3.js
// 목표: 도매꾹 상품의 "전체옵션보기" 화면(표)에서
//      '색상' 컬럼을 찾아서 모든 색상 텍스트를 읽고,
//      BLACK/NAVY/GRAY 같은 표준 영어 색상으로 변환한다.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

// 쉼표/공백/기호 기준으로 단어를 쪼개는 함수
function splitTokens(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, " ")
    .split(/[,/|·\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// 단어 하나를 표준 색상으로 바꾸기
function normalizeColorToken(token) {
  if (!token) return null;
  for (const standard in COLOR_MAP) {
    for (const v of COLOR_MAP[standard]) {
      if (token.includes(v)) return standard;
    }
  }
  return null;
}

// 한 줄(예: 231007-기모타이즈-그레이XL)에서 색상만 뽑기
function extractColorsFromLine(line) {
  const tokens = splitTokens(line);
  const out = new Set();
  for (const t of tokens) {
    const c = normalizeColorToken(t);
    if (c) out.add(c);
  }
  return Array.from(out);
}

// "전체옵션보기/옵션선택" 버튼을 눌러 옵션 표를 열어주는 함수
async function openOptionTable(page) {
  const candidates = [
    "text=전체옵션보기",
    "text=상품주문옵션 전체보기",
    "text=옵션선택",
    "text=옵션보기",
    "text=옵션 보기",
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
      console.log(`\n[${i + 1}/${targets.length}] 처리: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);

      // 1) 표(전체옵션보기)를 열기
      const opened = await openOptionTable(page);
      console.log(
        "  옵션 표 열기:",
        opened ? "성공(또는 이미 열려있음)" : "버튼 못 찾음"
      );

      // 2) '색상'이라는 표 헤더(th)가 나타날 때까지 기다리기
      //    (표가 열리면 보통 th에 '색상'이 있음)
      await page
        .locator("th:has-text('색상')")
        .first()
        .waitFor({ timeout: 15000 });

      // 3) 브라우저 안에서:
      //    - 헤더(th) 목록을 읽고
      //    - '색상'이 몇 번째 열인지(index)를 찾고
      //    - 각 행(tr)에서 그 열의 td 텍스트를 전부 뽑는다.
      const colorCells = await page.evaluate(() => {
        // 가능한 테이블 중 '색상' 헤더가 있는 테이블을 찾는다
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const ths = Array.from(table.querySelectorAll("thead th"));
          if (!ths.length) continue;

          const headers = ths.map((th) => (th.textContent || "").trim());
          const colorIndex = headers.findIndex((h) => h.includes("색상"));
          if (colorIndex === -1) continue;

          const rows = Array.from(table.querySelectorAll("tbody tr"));
          const values = [];

          for (const tr of rows) {
            const tds = Array.from(tr.querySelectorAll("td"));
            if (tds.length > colorIndex) {
              const txt = (tds[colorIndex].textContent || "").trim();
              if (txt) values.push(txt);
            }
          }

          // 첫 번째로 찾은 '색상' 테이블의 컬럼 값 반환
          return values;
        }
        return [];
      });

      // 4) 읽어온 색상 셀 텍스트들에서 표준색상 추출
      const normalized = new Set();
      for (const line of colorCells) {
        const colors = extractColorsFromLine(line);
        colors.forEach((c) => normalized.add(c));
      }

      const screenshotPath = path.join("out", `step7v3_${i + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const normalizedList = Array.from(normalized);

      console.log("  색상 컬럼 셀 일부(최대 5개):", colorCells.slice(0, 5));
      console.log("  표준 색상:", normalizedList);

      results.push({
        url,
        colorColumnCells: colorCells,
        normalizedColors: normalizedList,
        screenshot: screenshotPath,
      });
    }

    await browser.close();

    const outPath = path.join("out", "step7_colors_v3.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
