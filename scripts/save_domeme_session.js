import { chromium } from "playwright";

import { DOMEME_STORAGE_STATE_PATH } from "../src/config/paths.js";

const LOGIN_URL = "https://domemedb.domeggook.com/index/";
const OUT_PATH = DOMEME_STORAGE_STATE_PATH;

const WAIT_MS = Math.max(30_000, Number(process.env.COUPLUS_SESSION_WAIT_MS || "600000")); // default 10m
const FLAG_PATH = String(process.env.COUPLUS_SESSION_FLAG_PATH || "").trim();

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("[domeme] 브라우저가 열리면 네이버 로그인으로 도매매 로그인을 완료하세요.");
  console.log(`[domeme] ${Math.round(WAIT_MS / 1000)}초 동안 대기 후 세션을 저장합니다 (로그인 완료하면 그냥 기다리면 됨).`);

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  // Wait until user presses "save now" (flag file) or timeout.
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    if (FLAG_PATH) {
      try {
        const fs = await import("node:fs");
        if (fs.existsSync(FLAG_PATH)) break;
      } catch {}
    }
    await page.waitForTimeout(500);
  }

  await context.storageState({ path: OUT_PATH });
  console.log("[domeme] 세션 저장 완료:", OUT_PATH);

  await browser.close();
})();
