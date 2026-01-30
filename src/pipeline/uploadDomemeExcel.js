import fs from "node:fs";
import { chromium } from "playwright";

const LOGIN_URL = "https://domemedb.domeggook.com/index/";
const EXCEL_URL = "https://domeggook.com/main/myBuy/order/my_orderExcelForm.php";

export async function uploadDomemeExcel({ filePath, settings = {} }) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: "file_not_found" };
  }

  const userId = String(settings.domemeId || "").trim();
  const userPw = String(settings.domemePw || "").trim();
  if (!userId || !userPw) {
    return { ok: false, error: "missing_domeme_credentials" };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    // best-effort login
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

    if (await idInput.count()) {
      await idInput.fill(userId);
    }
    if (await pwInput.count()) {
      await pwInput.fill(userPw);
    }

    const loginBtn = page.locator("button:has-text('로그인'), input[type='submit'], button[type='submit']").first();
    if (await loginBtn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded"),
        loginBtn.click(),
      ]).catch(() => {});
    }

    await page.goto(EXCEL_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    const fileInput = page.locator("input[type='file']").first();
    if (!(await fileInput.count())) {
      return { ok: false, error: "file_input_not_found" };
    }

    await fileInput.setInputFiles(filePath);

    const uploadBtn = page
      .locator("button:has-text('업로드'), button:has-text('등록'), input[type='submit']")
      .first();

    if (await uploadBtn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        uploadBtn.click(),
      ]).catch(() => {});
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: "upload_failed", detail: String(e?.message || e) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
