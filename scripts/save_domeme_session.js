import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const LOGIN_URL = "https://domemedb.domeggook.com/index/";
const OUT_PATH = path.join(process.cwd(), "storageState.domeme.json");

const userId = process.env.DOMEME_ID || "";
const userPw = process.env.DOMEME_PW || "";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

// If credentials provided, try autofill
if (userId && userPw) {
  const idSelectors = [
    "input[name='id']",
    "input[name='user_id']",
    "input#id",
    "input[type='text']",
  ];
  const pwSelectors = [
    "input[name='pw']",
    "input[name='password']",
    "input#pw",
    "input[type='password']",
  ];
  const idInput = page.locator(idSelectors.join(",")).first();
  const pwInput = page.locator(pwSelectors.join(",")).first();
  if (await idInput.count()) await idInput.fill(userId);
  if (await pwInput.count()) await pwInput.fill(userPw);
}

console.log("브라우저가 열렸습니다. 네이버 로그인 후 도매매 로그인이 완료되면 Enter를 눌러주세요.");
process.stdin.setEncoding("utf-8");
await new Promise((resolve) => process.stdin.once("data", resolve));

await context.storageState({ path: OUT_PATH });
console.log("세션 저장 완료:", OUT_PATH);

await page.close();
await context.close();
await browser.close();
