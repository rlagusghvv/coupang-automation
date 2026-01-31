import { chromium } from "playwright";
import path from "node:path";
import readline from "node:readline";

import { DOMEGGOOK_STORAGE_STATE_PATH } from "../src/config/paths.js";

const storagePath = DOMEGGOOK_STORAGE_STATE_PATH;

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("로그인 완료 후 Enter를 눌러주세요: ", () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("브라우저가 열리면 도매꾹에서 네이버 로그인을 완료하세요.");
  await page.goto("https://domeggook.com", { waitUntil: "domcontentloaded" });

  await waitForEnter();

  await context.storageState({ path: storagePath });
  console.log("세션 저장 완료:", storagePath);

  await browser.close();
})();
