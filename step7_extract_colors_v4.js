// step7_extract_colors_v4.js
// 목표(결정판):
// 1) 도매꾹 상품 페이지로 이동
// 2) "전체옵션보기/옵션선택"을 눌러 옵션 표(테이블)를 연다
// 3) (th가 있든 없든) 표의 "색상" 컬럼을 자동으로 찾아서 모든 값을 읽는다
// 4) 색상 값을 BLACK/NAVY/GRAY 등 영어 표준으로 변환한다
// 5) 결과를 out/step7_colors_v4.json에 저장한다
//
// 핵심 아이디어(초보자 설명):
// - 우리는 더 이상 'th:has-text(색상)' 같은 한 가지 구조만 믿지 않는다.
// - 페이지(혹은 iframe) 안에 있는 모든 table을 뒤져서,
//   "색상"이라는 헤더가 들어있는 열(column)을 찾아 그 열의 값만 싹 긁는다.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

// 문자열을 단어로 쪼개기 (쉼표/공백/하이픈/슬래시 등 포함)
function splitTokens(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, " ")
    .split(/[,/|·\s-]+/) // ✅ 하이픈(-)도 분리 기준에 포함
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// 단어 하나를 표준 색상으로 변환
function normalizeColorToken(token) {
  if (!token) return null;
  for (const standard in COLOR_MAP) {
    for (const v of COLOR_MAP[standard]) {
      if (token.includes(v)) return standard;
    }
  }
  return null;
}

// 한 셀 텍스트(예: "231007-기모타이즈-그레이XL")에서 색상만 뽑기
function extractStandardColorsFromCell(cellText) {
  const tokens = splitTokens(cellText);
  const out = new Set();
  for (const t of tokens) {
    const c = normalizeColorToken(t);
    if (c) out.add(c);
  }
  return Array.from(out);
}

// 옵션 표 열기(버튼 문구가 여러 개일 수 있어 후보를 다 시도)
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

// 페이지/iframe(frames) 전체에서 "색상 컬럼을 가진 table"을 찾아 색상 셀들을 뽑아오는 함수
async function findColorColumnCellsAnywhere(page) {
  // page.frames()에는 메인 문서 + iframe들이 모두 포함됨
  const frames = page.frames();

  for (const frame of frames) {
    try {
      const cells = await frame.evaluate(() => {
        // 1) 문서 내 모든 table을 확인
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          // 표의 모든 행 가져오기
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;

          // 2) "헤더로 보이는 행" 찾기
          // - 많은 사이트는 첫 행이 헤더 역할(td 또는 th)
          // - 또는 thead가 있을 수 있음
          // 여기서는 단순하게: 첫 번째 행의 셀 텍스트를 헤더로 우선 시도
          const firstRowCells = Array.from(
            rows[0].querySelectorAll("th, td")
          ).map((el) => (el.textContent || "").trim());

          let colorIndex = firstRowCells.findIndex((t) => t.includes("색상"));

          // 만약 첫 행에서 못 찾으면, thead의 th를 한 번 더 시도
          if (colorIndex === -1) {
            const theadCells = Array.from(
              table.querySelectorAll("thead th, thead td")
            ).map((el) => (el.textContent || "").trim());
            if (theadCells.length > 0) {
              colorIndex = theadCells.findIndex((t) => t.includes("색상"));
            }
          }

          if (colorIndex === -1) continue; // 이 테이블은 색상 컬럼이 없음

          // 3) 색상 컬럼 값 수집
          const values = [];

          // rows[0]이 헤더일 가능성이 높으므로 rows[1]부터 시작
          for (let i = 1; i < rows.length; i++) {
            const cells = Array.from(rows[i].querySelectorAll("td, th"));
            if (cells.length <= colorIndex) continue;

            const txt = (cells[colorIndex].textContent || "").trim();
            // 헤더 같은 줄이 섞일 수 있어 너무 짧거나 "색상" 자체는 제외
            if (!txt) continue;
            if (txt === "색상") continue;

            values.push(txt);
          }

          // 이 테이블에서 색상 값이 1개라도 있으면 반환(가장 먼저 찾은 유효 테이블 사용)
          if (values.length > 0) return values;
        }

        return [];
      });

      if (Array.isArray(cells) && cells.length > 0) {
        return { cells, frameUrl: frame.url() };
      }
    } catch (_) {
      // 어떤 frame은 접근 불가(보안)일 수 있어 그냥 넘김
    }
  }

  return { cells: [], frameUrl: null };
}

// 기다리기(폴링) 함수: 옵션 표가 늦게 뜨는 경우를 대비
async function waitForColorTable(page, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const found = await findColorColumnCellsAnywhere(page);
    if (found.cells.length > 0) return found;
    await page.waitForTimeout(500);
  }
  return { cells: [], frameUrl: null };
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
      console.log(`\n[${i + 1}/${targets.length}] 처리(v4): ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);

      // 1) 옵션 표 열기 시도
      const opened = await openOptionView(page);
      console.log(
        "  옵션 표 열기:",
        opened ? "시도 완료" : "버튼 못 찾음(이미 열려있을 수도)"
      );

      // 2) 표가 뜰 때까지 기다리면서(폴링) 색상 컬럼 찾기
      const found = await waitForColorTable(page, 25000);

      // 3) 색상 셀 텍스트 → 표준 색상으로 변환
      const normalized = new Set();
      for (const cellText of found.cells) {
        // 예: "검정,네이비" 같은 케이스도 splitTokens가 자동 분리해줌
        const colors = extractStandardColorsFromCell(cellText);
        colors.forEach((c) => normalized.add(c));
      }

      const screenshotPath = path.join("out", `step7v4_${i + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const normalizedList = Array.from(normalized);

      console.log(
        "  (디버그) 색상 셀 일부(최대 6개):",
        found.cells.slice(0, 6)
      );
      console.log("  (디버그) 표준 색상:", normalizedList);
      if (found.frameUrl)
        console.log("  (디버그) 표를 찾은 frame:", found.frameUrl);

      results.push({
        url,
        colorColumnCellsSample: found.cells.slice(0, 30), // 너무 길어질 수 있어 30개까지만 저장
        normalizedColors: normalizedList,
        tableFoundInFrame: found.frameUrl,
        screenshot: screenshotPath,
      });
    }

    await browser.close();

    const outPath = path.join("out", "step7_colors_v4.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
