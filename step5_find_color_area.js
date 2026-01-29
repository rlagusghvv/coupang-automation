// step5_find_color_area.js
// 목표: 도매꾹 상품 상세 페이지에서 "색상"이라는 글자가 있는 근처를 찾아서
//      그 주변 텍스트를 터미널에 출력한다.
// (색상 옵션의 정확한 위치를 찾기 위한 "탐색기" 단계)

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  try {
    // 1) step4 결과(JSON) 읽기
    const step4Path = path.join("out", "step4_results.json");
    const step4 = JSON.parse(fs.readFileSync(step4Path, "utf-8"));

    // 2) 도매꾹 메인 상품만 필터(1688 제외)
    const domeggookItems = step4.filter(
      (r) =>
        typeof r.url === "string" &&
        r.url.includes("domeggook.com") &&
        !r.url.includes("1688.domeggook.com")
    );

    if (domeggookItems.length === 0) {
      console.log("도매꾹 메인 상품 URL이 없어서 종료합니다.");
      return;
    }

    // 3) 일단 첫 번째 상품으로만 테스트(초보자용: 하나씩 확인)
    const target = domeggookItems[0];
    console.log("테스트 대상 URL:", target.url);

    // 4) 브라우저 열기
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);

    // 5) 페이지 안에서 "색상"이라는 텍스트가 들어간 요소들을 찾는다.
    //    - locator("text=색상") : 화면에 '색상' 글자가 보이는 곳을 찾는 것
    const colorLabelCandidates = page.locator("text=색상");

    const count = await colorLabelCandidates.count();
    console.log("색상 라벨 후보 개수:", count);

    // 후보가 너무 많으면 5개까지만 확인
    const limit = Math.min(count, 5);

    for (let i = 0; i < limit; i++) {
      const el = colorLabelCandidates.nth(i);

      // 요소의 텍스트를 읽어봄
      const labelText = (await el.textContent())?.trim();

      // 요소 주변(부모/근처) 텍스트를 같이 보고 싶어서
      // 가장 가까운 부모 영역을 1단계 위로 잡아 텍스트를 읽어봄
      const parent = el.locator("xpath=..");
      const parentText = (await parent.textContent())?.trim();

      console.log("\n--- 후보", i + 1, "---");
      console.log("라벨 텍스트:", labelText);
      console.log(
        "부모 영역 텍스트(요약):",
        (parentText || "").replace(/\s+/g, " ").slice(0, 300)
      );
    }

    // 디버깅 스크린샷
    const screenshotPath = path.join("out", "step5_find_color_area.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log("\n스크린샷 저장:", screenshotPath);

    await browser.close();
  } catch (err) {
    console.log("에러:", err);
  }
})();
