// step6_classify_options.js
// 목표:
// 1) step4_results.json에 있는 도매꾹 상품 URL들을 읽는다.
// 2) 각 페이지에서 "옵션(색상/사이즈 등)이 텍스트로 존재하는지" 간단히 검사한다.
// 3) 결과를 out/step6_option_classification.json에 저장한다.
//
// 쉬운 원리:
// - 페이지에서 '색상', '사이즈', '옵션' 같은 단어가 "버튼/선택 영역 근처"에 있으면 옵션 텍스트 가능성이 높다.
// - 반대로 상세/반품 문구에만 나오면 "이미지 옵션"일 가능성이 높다.
// - 이 단계는 100% 정확도를 목표로 하지 않고, 자동화 가능한 것과 예외를 빨리 나누는 게 목적이다.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function isLikelyOptionArea(text) {
  // 옵션 영역에 자주 붙는 단어들(초보자용 간단 규칙)
  const keywords = ["색상", "사이즈", "옵션", "선택", "종류"];
  return keywords.some((k) => text.includes(k));
}

(async () => {
  try {
    const step4Path = path.join("out", "step4_results.json");
    const step4 = JSON.parse(fs.readFileSync(step4Path, "utf-8"));

    const domeggookItems = step4.filter(
      (r) =>
        typeof r.url === "string" &&
        r.url.includes("domeggook.com") &&
        !r.url.includes("1688.domeggook.com")
    );

    console.log("도매꾹 메인 상품 개수:", domeggookItems.length);

    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    const results = [];

    for (let i = 0; i < domeggookItems.length; i++) {
      const url = domeggookItems[i].url;
      console.log(`\n[${i + 1}/${domeggookItems.length}] 방문: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);

      // 페이지에서 "색상"이라는 단어가 있는 요소들을 모두 찾는다.
      const colorEls = page.locator("text=색상");
      const count = await colorEls.count();

      // 각 후보의 "부모 텍스트"를 짧게 모아서 검사해본다.
      let optionHint = "";
      const limit = Math.min(count, 6);
      for (let k = 0; k < limit; k++) {
        const parent = colorEls.nth(k).locator("xpath=..");
        const t = ((await parent.textContent()) || "")
          .replace(/\s+/g, " ")
          .trim();
        // 너무 길면 자른다
        optionHint += " | " + t.slice(0, 120);
      }

      // 아주 단순 규칙:
      // - 옵션 힌트에 '선택/옵션/사이즈/종류' 같은 게 같이 있으면 → 텍스트 옵션 가능
      // - 없으면 → 이미지 옵션(예외) 가능성이 높음
      const textOptionPossible = isLikelyOptionArea(optionHint);

      const screenshotPath = path.join("out", `step6_${i + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      results.push({
        no: i + 1,
        url,
        textOptionPossible, // true면 "텍스트 옵션 있을 가능성"
        optionHint,
        screenshot: screenshotPath,
      });

      console.log("  텍스트 옵션 가능?:", textOptionPossible ? "YES" : "NO");
    }

    await browser.close();

    const outPath = path.join("out", "step6_option_classification.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("\n저장 완료:", outPath);
  } catch (err) {
    console.log("에러:", err);
  }
})();
