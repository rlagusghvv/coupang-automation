// step4_batch_read.js
// 목표: urls.txt에 있는 URL들을 한 줄씩 읽어서,
//      각 상품 페이지에서 "상품명"과 "가격"을 뽑아 표처럼 출력한다.
//
// 아주 쉬운 원리:
// - fs.readFileSync : 파일(urls.txt)을 읽는다
// - split("\n") : 줄 단위로 나눠서 URL 목록을 만든다
// - for문으로 URL을 하나씩 방문(page.goto)
// - locator로 글자를 읽어온다(textContent)
// - 결과를 배열에 모아서 마지막에 한 번에 출력한다

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  try {
    console.log("현재 실행 폴더:", process.cwd());

    // 1) urls.txt 파일에서 URL 목록 읽기
    const urlFilePath = path.join(process.cwd(), "urls.txt");
    const raw = fs.readFileSync(urlFilePath, "utf-8");

    // 2) 줄바꿈으로 쪼개서 배열로 만들기 + 빈 줄 제거
    const urls = raw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`총 URL 개수: ${urls.length}`);

    // 3) 브라우저 실행
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    // 결과를 모아둘 배열
    const results = [];
    // 4) URL을 하나씩 처리
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n[${i + 1}/${urls.length}] 방문: ${url}`);

      // ✅ 여기서부터는 "실패해도 다음으로" 넘어가게 try/catch로 감싼다.
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1500);

        // ✅ URL 종류(도메인)에 따라 읽는 방법을 나눈다.
        let titleText = "(못 찾음)";
        let priceText = "(못 찾음)";

        // 1) 도매꾹 일반 상품 페이지(메인 도메인)
        if (
          url.includes("domeggook.com") &&
          !url.includes("1688.domeggook.com")
        ) {
          // "h1/h2"는 임시 방식. 그래도 도매꾹 메인 상품은 보통 잘 잡힘.
          const titleCandidate = page.locator("h1, h2").first();
          const priceCandidate = page
            .locator("text=/\\d[\\d,]*\\s*원/")
            .first();

          // ✅ 기다리는 시간을 줄여서 막히면 빨리 넘어가게 함
          titleText =
            (await titleCandidate.textContent({ timeout: 8000 }))?.trim() ||
            "(못 찾음)";
          priceText =
            (await priceCandidate.textContent({ timeout: 8000 }))?.trim() ||
            "(못 찾음)";
        }

        // 2) 1688 도메인(이번 단계에서는 "스킵" 처리)
        else if (url.includes("1688.domeggook.com")) {
          titleText = "(1688 페이지 - 다음 단계에서 처리)";
          priceText = "(1688 페이지 - 다음 단계에서 처리)";
        }

        // 3) 그 외(알 수 없는 링크)
        else {
          titleText = "(알 수 없는 도메인)";
          priceText = "(알 수 없는 도메인)";
        }

        // 디버깅용 스크린샷(항상 남기기)
        const screenshotPath = path.join("out", `step4_${i + 1}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        results.push({
          no: i + 1,
          url,
          title: titleText,
          price: priceText,
          screenshot: screenshotPath,
          ok: !(
            titleText.includes("다음 단계") ||
            titleText.includes("알 수 없는") ||
            titleText === "(못 찾음)"
          ),
        });

        console.log("  상품명:", titleText);
        console.log("  가격:", priceText);
      } catch (err) {
        // ✅ 실패해도 중단하지 않고, 실패 결과를 기록하고 다음으로 넘어감
        const screenshotPath = path.join("out", `step4_${i + 1}_ERROR.png`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (_) {}

        results.push({
          no: i + 1,
          url,
          title: "(에러)",
          price: "(에러)",
          screenshot: screenshotPath,
          ok: false,
          error: String(err),
        });

        console.log("  ❌ 이 URL은 실패. 다음으로 넘어감.");
        console.log("  에러 요약:", String(err).slice(0, 200));
      }
    }

    // 5) 마지막에 표처럼 출력
    console.log("\n==== 최종 결과 표 ====");
    console.table(
      results.map((r) => ({
        no: r.no,
        title: r.title,
        price: r.price,
        url: r.url,
      }))
    );

    // 6) 결과를 파일로도 저장(다음 단계에서 DB로 바꾸기 쉬움)
    const outJsonPath = path.join("out", "step4_results.json");
    fs.writeFileSync(outJsonPath, JSON.stringify(results, null, 2), "utf-8");
    console.log("결과 JSON 저장:", outJsonPath);
  } catch (err) {
    console.log("에러 발생:", err);
  }
})();
