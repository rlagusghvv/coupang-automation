import { chromium } from "playwright";

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node src/pipeline/steps/step23_debug_1688_page.js "URL"');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // 네트워크 응답 중 JSON/텍스트로 오는 “상품 데이터 후보”를 일부 저장
  page.on("response", async (res) => {
    try {
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      const u = res.url();

      // 너무 많이 찍히면 노이즈라서 “1688/domeggook” 관련만
      const interesting = /1688|domeggook|product|view|item|detail|api/i.test(u);

      if (interesting && (ct.includes("json") || ct.includes("text"))) {
        const txt = await res.text();
        if (txt && txt.length > 50) {
          // 길이 너무 큰 건 자르고 표시
          console.log("\n[RESPONSE]", res.status(), ct, u);
          console.log(txt.slice(0, 500));
        }
      }
    } catch (_) {}
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);

  // 프레임 URL 목록 출력 (여기서 iframe 안에 실제 상세가 있는지 바로 보임)
  console.log("\n=== FRAMES ===");
  for (const f of page.frames()) {
    console.log("-", f.url());
  }

  await page.screenshot({ path: "out/step23_1688_debug.png", fullPage: true });
  console.log("\nSaved screenshot: out/step23_1688_debug.png");

  await browser.close();
})();
