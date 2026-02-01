import { chromium } from "playwright";

import { DOMEME_STORAGE_STATE_PATH } from "../src/config/paths.js";

const LOGIN_URL = "https://domemedb.domeggook.com/index/";
const OUT_PATH = DOMEME_STORAGE_STATE_PATH;

async function waitForLoggedIn(page, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();
  const selectors = [
    'text=로그아웃',
    'a[href*="logout"]',
    'a[href*="mypage"]',
    'a[href*="order"]',
  ];
  while (Date.now() - started < timeoutMs) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0) return true;
      } catch {}
    }
    try {
      const u = page.url();
      if (u && !u.includes("nid.naver.com") && u.includes("domemedb.domeggook.com")) {
        const cookies = await page.context().cookies();
        if (Array.isArray(cookies) && cookies.length > 0) return true;
      }
    } catch {}
    await page.waitForTimeout(1000);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  console.log("브라우저가 열렸습니다. 네이버 로그인으로 도매매 로그인을 완료하세요.");

  const ok = await waitForLoggedIn(page);
  if (!ok) {
    console.error("로그인 감지 실패(타임아웃). 브라우저에서 로그인 후 다시 시도하세요.");
    await browser.close();
    process.exit(2);
  }

  await context.storageState({ path: OUT_PATH });
  console.log("세션 저장 완료:", OUT_PATH);

  await browser.close();
})();
