// step7_extract_colors_v2.js
// 목표: 도매꾹 상품 상세에서 "옵션 팝업"을 열고,
//      색상 옵션 목록을 실제로 읽어서 표준색상(BLACK/NAVY/...)으로 변환한다.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const COLOR_MAP = require("./color_map");

// (1) 문자열을 쉼표/슬래시/공백 등으로 쪼개는 함수
function splitTokens(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, " ")
    .split(/[,/|·\s]+/) // 쉼표, 슬래시, 파이프, 공백 등 기준 분리
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// (2) 표준 색상으로 바꾸는 함수 (부분 포함 매칭)
function normalizeColorToken(token) {
  if (!token) return null;

  for (const standardColor in COLOR_MAP) {
    for (const v of COLOR_MAP[standardColor]) {
      if (token.includes(v)) return standardColor;
    }
  }
  return null;
}

// (3) 옵션 항목 텍스트에서 "색상 후보"를 뽑는 함수
// 예시 항목: "231007-기모타이즈-블랙XL(+600원) (9999개)"
// 여기서 색상 관련 단어(블랙/그레이/네이비 등)를 찾아낸다.
function extractColorsFromOptionLine(line) {
  const tokens = splitTokens(line);
  const normalized = new Set();

  for (const t of tokens) {
    const c = normalizeColorToken(t);
    if (c) normalized.add(c);
  }

  return Array.from(normalized);
}

// (4) 옵션 팝업 열기 시도
async function openOptionPopupIfPossible(page) {
  // 도매꾹은 페이지마다 버튼 문구/구조가 조금 다를 수 있어 여러 방식 시도
  const candidates = [
    "text=전체옵션보기",
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

  // 버튼이 없으면 false
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
      console.log(`\n[${i + 1}/${targets.length}] 색상 추출(v2): ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);

      // 1) 옵션 팝업 열기 시도
      const opened = await openOptionPopupIfPossible(page);
      console.log(
        "  옵션 팝업 열기:",
        opened ? "성공(또는 이미 열려있음)" : "버튼 못 찾음"
      );

      // 2) 팝업이 열렸다는 가정 하에, 화면 전체에서 "옵션선택" 영역 텍스트를 수집
      //    (초보자용: 우선 화면 전체에서 '색상' 블록 근처를 크게 잡는다)
      //    - "옵션선택" 화면에 '색상'이 존재하면 그 주변 텍스트에 옵션 리스트가 섞여있음
      const colorBlock = page.locator("text=색상").first();

      // 색상이라는 단어가 아예 없으면, 이 페이지는 색상 텍스트 추출이 불가할 수 있음(이미지 옵션 등)
      const colorCount = await colorBlock.count();
      if (colorCount === 0) {
        console.log("  색상 텍스트 자체를 못 찾음 -> 예외로 기록");
        const screenshotPath = path.join(
          "out",
          `step7v2_${i + 1}_NO_COLOR_TEXT.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });

        results.push({
          url,
          rawOptionLines: [],
          normalizedColors: [],
          note: "색상 텍스트 없음(팝업/구조/이미지 옵션 가능)",
          screenshot: screenshotPath,
        });
        continue;
      }

      // 3) 색상 라벨의 "부모/근처 영역"에서 옵션 리스트 텍스트를 최대한 끌어온다
      //    (한 단계 위만 잡으면 부족할 수 있어서, 2단계 위까지도 시도)
      const parent1 = colorBlock.locator("xpath=..");
      const parent2 = parent1.locator("xpath=..");

      const text1 = ((await parent1.textContent()) || "")
        .replace(/\s+/g, " ")
        .trim();
      const text2 = ((await parent2.textContent()) || "")
        .replace(/\s+/g, " ")
        .trim();

      // 4) 더 긴 텍스트를 우선 사용(옵션 리스트가 포함될 확률이 큼)
      const areaText = text2.length > text1.length ? text2 : text1;

      // 5) 옵션 줄 후보를 만들기
      //    화면에서 보이는 옵션이 줄바꿈으로 나뉘는 경우가 많아서 \n 기준도 사용
      const roughLines = areaText
        .split(/(?:\n|색상)/) // '색상' 기준으로 한번 더 쪼개서 옵션이 붙은 부분을 분리
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // 6) 각 라인에서 색상 추출
      const normalizedColors = new Set();
      const rawOptionLines = [];

      for (const line of roughLines) {
        // 너무 긴 문장은 반품/설명일 확률이 높으니 제외(초보자용 안전장치)
        if (line.length > 120) continue;

        const colors = extractColorsFromOptionLine(line);
        if (colors.length > 0) {
          rawOptionLines.push(line);
          colors.forEach((c) => normalizedColors.add(c));
        }
      }

      // 7) 결과 저장 + 스크린샷
      const screenshotPath = path.join("out", `step7v2_${i + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const normalizedList = Array.from(normalizedColors);

      console.log("  옵션 라인 후보:", rawOptionLines);
      console.log("  표준 색상:", normalizedList);

      results.push({
        url,
        rawOptionLines,
        normalizedColors: normalizedList,
        screenshot: screenshotPath,
      });
    }

    await browser.close();

    const outPath = path.join("out", "step7_colors_v2.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
