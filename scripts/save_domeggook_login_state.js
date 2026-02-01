import { chromium } from "playwright";

import { DOMEGGOOK_STORAGE_STATE_PATH } from "../src/config/paths.js";

const storagePath = DOMEGGOOK_STORAGE_STATE_PATH;

async function waitForLoggedIn(page, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();
  // IMPORTANT: Do NOT accept "some cookies exist" as logged-in.
  // We only treat it as logged-in when the UI shows an authenticated indicator.
  const selectors = [
    'text=로그아웃',
    'a:has-text("로그아웃")',
    'a[href*="logout"]',
    'a[href*="mypage"]',
    'a[href*="member"]',
  ];

  while (Date.now() - started < timeoutMs) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0) return true;
      } catch {}
    }

    await page.waitForTimeout(1000);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("브라우저가 열리면 도매꾹에서 네이버 로그인을 완료하세요.");
  await page.goto("https://domeggook.com", { waitUntil: "domcontentloaded" });

  const ok = await waitForLoggedIn(page);
  if (!ok) {
    console.error("로그인 감지 실패(타임아웃). 브라우저에서 로그인 후 다시 시도하세요.");
    await browser.close();
    process.exit(2);
  }

  await context.storageState({ path: storagePath });
  console.log("세션 저장 완료:", storagePath);

  await browser.close();
})();
