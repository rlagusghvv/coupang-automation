// step3_read_title_price.js
// 목표: 상품명/가격 읽기 + 스크린샷을 "out" 폴더에 100% 저장하기
// (왜 out 폴더? -> 저장 위치를 확실히 해서 "어디에 저장됐는지" 문제를 제거)

const { chromium } = require("playwright");
const path = require("path");

(async () => {
  // 혹시 에러가 나면 어디서 났는지 보기 쉽게 try/catch로 감싼다.
  try {
    console.log("현재 실행 폴더(cwd):", process.cwd());

    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    const PRODUCT_URL = "https://domeggook.com/49608924?advcnt=mainCenter2024";

    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const titleCandidate = page.locator("h1, h2").first();
    const priceCandidate = page.locator("text=/\\d[\\d,]*\\s*원/").first();

    const titleText = (await titleCandidate.textContent())?.trim();
    const priceText = (await priceCandidate.textContent())?.trim();

    console.log("==== 읽어온 결과 ====");
    console.log("상품명:", titleText || "(못 찾음)");
    console.log("가격:", priceText || "(못 찾음)");

    // ✅ 저장 경로를 "out/step3_product.png"로 고정
    const screenshotPath = path.join("out", "step3_product.png");

    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log("스크린샷 저장 완료:", screenshotPath);

    await browser.close();
  } catch (err) {
    console.log("에러 발생:", err);
  }
})();
