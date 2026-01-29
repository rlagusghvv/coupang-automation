// step7_extract_colors.js
// 목표:
// 1) step6_option_classification.json을 읽는다
// 2) 텍스트 옵션 가능 상품(YES)만 대상으로
// 3) 색상 옵션 텍스트를 실제로 추출한다
// 4) color_map을 이용해 영어 표준 색상으로 변환한다
// 5) 결과를 out/step7_colors.json으로 저장한다

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

// 색상 텍스트를 표준 영어 색상으로 바꾸는 함수
function normalizeColor(text) {
  if (!text) return null;

  for (const standardColor in COLOR_MAP) {
    const variants = COLOR_MAP[standardColor];
    for (const v of variants) {
      if (text.includes(v)) {
        return standardColor;
      }
    }
  }
  return null; // 매칭 실패
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
      const { url } = targets[i];
      console.log(`\n[${i + 1}/${targets.length}] 색상 추출: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);

      // 1) 페이지에서 '색상'이라는 텍스트를 찾는다
      const colorLabel = page.locator("text=색상").first();

      // 2) 그 부모 영역에서 버튼/텍스트 전체를 읽는다
      const area = colorLabel.locator("xpath=..");
      const areaText = (await area.textContent()) || "";

      // 3) 줄 단위로 쪼개서 후보 만들기
      const rawCandidates = areaText
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const foundColors = new Set();
      const matchedColors = new Set();

      for (const token of rawCandidates) {
        const normalized = normalizeColor(token);
        if (normalized) {
          foundColors.add(token);
          matchedColors.add(normalized);
        }
      }

      results.push({
        url,
        rawColorTexts: Array.from(foundColors),
        normalizedColors: Array.from(matchedColors),
      });

      console.log("  원본 색상 텍스트:", Array.from(foundColors));
      console.log("  표준 색상:", Array.from(matchedColors));
    }

    await browser.close();

    const outPath = path.join("out", "step7_colors.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

    console.log("\n색상 추출 결과 저장:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
