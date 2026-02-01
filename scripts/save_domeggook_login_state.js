import { chromium } from "playwright";

import { DOMEGGOOK_STORAGE_STATE_PATH } from "../src/config/paths.js";

const storagePath = DOMEGGOOK_STORAGE_STATE_PATH;

const WAIT_MS = Math.max(30_000, Number(process.env.COUPLUS_SESSION_WAIT_MS || "600000")); // default 10m
const FLAG_PATH = String(process.env.COUPLUS_SESSION_FLAG_PATH || "").trim();

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("[domeggook] 브라우저가 열리면 네이버 로그인을 완료하세요.");
  console.log(`[domeggook] ${Math.round(WAIT_MS / 1000)}초 동안 대기 후 세션을 저장합니다 (로그인 완료하면 그냥 기다리면 됨).`);

  await page.goto("https://domeggook.com", { waitUntil: "domcontentloaded" });

  // Wait until user presses "save now" (flag file) or timeout.
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    if (FLAG_PATH) {
      try {
        if (await page.evaluate(() => document.hasFocus())) {
          // noop - keep the page active
        }
      } catch {}
      try {
        // flag file created by server when user clicks "지금 저장"
        // (use sync fs in node via dynamic import to keep this file ESM-simple)
        const fs = await import("node:fs");
        if (fs.existsSync(FLAG_PATH)) break;
      } catch {}
    }
    await page.waitForTimeout(500);
  }

  await context.storageState({ path: storagePath });
  console.log("[domeggook] 세션 저장 완료:", storagePath);

  await browser.close();
})();
