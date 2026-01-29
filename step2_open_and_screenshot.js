// step2_open_and_screenshot.js
// 목표: 브라우저를 자동으로 열어서 도매꾹(또는 지정한 URL)을 방문하고,
//      스크린샷을 저장하는 "첫 자동화 성공"을 만든다.

const { chromium } = require("playwright");

(async () => {
  // 1) 크롬(Chromium) 브라우저를 "실제로 화면에 보이게" 실행한다.
  //    - headless: false  => 브라우저 창이 실제로 뜬다 (초보자에게 확인하기 좋음)
  const browser = await chromium.launch({ headless: false });

  // 2) 새 브라우저 탭(페이지)을 만든다.
  const page = await browser.newPage();

  // 3) 이동할 URL
  //    - 일단은 접근 가능한 페이지로 테스트하는 게 목적
  //    - 도매꾹 메인으로 열어본다.
  const url = "https://domeggook.com/main/index.php";

  // 4) 해당 URL로 이동한다.
  //    - waitUntil: "domcontentloaded" => 페이지의 기본 HTML이 로딩되면 다음으로 진행
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // 5) 2초 기다린다.
  //    - 이유: 페이지가 로딩되면서 이미지/스크립트가 조금 더 붙는 시간을 준다.
  await page.waitForTimeout(2000);

  // 6) 스크린샷 저장
  //    - fullPage: true => 화면 아래까지 전체를 캡처한다.
  await page.screenshot({ path: "step2_domaeqq.png", fullPage: true });

  // 7) 브라우저 닫기
  await browser.close();

  console.log("완료: step2_domaeqq.png 스크린샷을 저장했어.");
})();
