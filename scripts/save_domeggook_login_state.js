import { chromium } from "playwright";

import { DOMEGGOOK_STORAGE_STATE_PATH } from "../src/config/paths.js";

const storagePath = DOMEGGOOK_STORAGE_STATE_PATH;

const WAIT_MS = Math.max(30_000, Number(process.env.COUPLUS_SESSION_WAIT_MS || "600000")); // default 10m

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("[domeggook] 브라우저가 열리면 네이버 로그인을 완료하세요.");
  console.log(`[domeggook] ${Math.round(WAIT_MS / 1000)}초 동안 대기 후 세션을 저장합니다 (로그인 완료하면 그냥 기다리면 됨).`);

  await page.goto("https://domeggook.com", { waitUntil: "domcontentloaded" });

  // Give user time to log in manually. Avoid brittle auto-detect.
  await page.waitForTimeout(WAIT_MS);

  await context.storageState({ path: storagePath });
  console.log("[domeggook] 세션 저장 완료:", storagePath);

  await browser.close();
})();
