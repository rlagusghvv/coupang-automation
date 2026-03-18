import fs from "node:fs";
import { chromium } from "playwright";

const LOGIN_URL = "https://domemedb.domeggook.com/index/";
const UPLOAD_URL = "https://domeggook.com/main/myBuy/order/my_orderExcelForm.php";

function firstExisting(paths = []) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

async function bestEffortFindPayUrl(page) {
  // Try to find a link/button that usually leads to payment.
  const candidates = [
    "a:has-text('결제하러')",
    "a:has-text('결제하기')",
    "a:has-text('주문/결제')",
    "button:has-text('결제하러')",
    "button:has-text('결제하기')",
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      const href = await loc.getAttribute("href").catch(() => null);
      if (href) {
        try {
          return new URL(href, page.url()).toString();
        } catch {
          return href;
        }
      }
      // no href => click and take URL
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        loc.click().catch(() => {}),
      ]);
      return page.url();
    }
  }

  return page.url();
}

async function bestEffortDomemeLogin(page, settings = {}) {
  const userId = String(settings.domemeId || "").trim();
  const userPw = String(settings.domemePw || "").trim();
  if (!userId || !userPw) return false;

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

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

  const loginBtn = page
    .locator("button:has-text('로그인'), input[type='submit'], button[type='submit']")
    .first();
  if (await loginBtn.count()) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      loginBtn.click().catch(() => {}),
    ]);
  }
  return true;
}

export async function uploadVendorPurchaseExcel({ vendor, filePath, settings = {}, storageStateDefaultPath = "" }) {
  const v = String(vendor || "").trim();
  if (!v) return { ok: false, error: "missing_vendor" };

  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: "file_not_found", filePath };
  }

  // Prefer per-user configured storageStatePath, then default path from server config.
  const configuredPath =
    v === "domeme"
      ? String(settings.domemeStorageStatePath || "").trim()
      : String(settings.domeggookStorageStatePath || "").trim();

  const storageStatePath = firstExisting([configuredPath, storageStateDefaultPath]);
  const hasDomemeCredentials =
    String(settings.domemeId || "").trim().isNotEmpty &&
    String(settings.domemePw || "").trim().isNotEmpty;

  if (v === "domeme" && !storageStatePath && !hasDomemeCredentials) {
    return { ok: false, error: "missing_domeme_session_or_credentials" };
  }

  const browser = await chromium.launch({ headless: true });
  const context = storageStatePath
    ? await browser.newContext({ storageState: storageStatePath })
    : await browser.newContext();
  const page = await context.newPage();

  try {
    if (!storageStatePath && v === "domeme") {
      await bestEffortDomemeLogin(page, settings);
    }

    await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    // IMPORTANT: There are multiple file inputs on the page (e.g., image upload).
    // We must target the Excel upload input: <form id="lFrmUpload"> ... <input type="file" name="xls"> ...
    const fileInput = page.locator("#lFrmUpload input[type='file'][name='xls']").first();
    if (!(await fileInput.count())) {
      // fallback
      const anyFile = page.locator("#lFrmUpload input[type='file'], input[type='file']").first();
      if (!(await anyFile.count())) {
        return { ok: false, error: "file_input_not_found", url: page.url() };
      }
      await anyFile.setInputFiles(filePath);
    } else {
      await fileInput.setInputFiles(filePath);
    }

    // IMPORTANT: Page has unrelated "업로드" buttons (e.g. image upload). Prefer the Excel form submit.
    const uploadBtn = page
      .locator(
        "#lFrmUpload input[type='image'][title*='파일'], #lFrmUpload input[type='image'][alt*='파일'], #lFrmUpload input[type='image'], #lFrmUpload input[type='submit'], #lFrmUpload button[type='submit']",
      )
      .first();

    if (await uploadBtn.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        uploadBtn.click().catch(() => {}),
      ]);

      // Form submit often updates the page via XHR/DOM; give it a moment.
      await page.waitForTimeout(2500).catch(() => {});
    }

    // Basic validation: ensure the page is no longer asking to upload a file.
    let pageText = "";
    try {
      pageText = await page.locator("body").innerText();
    } catch {}

    const stillEmpty = pageText.includes("엑셀파일을 업로드해주세요");
    if (stillEmpty) {
      // Try to surface any visible error block for debugging.
      let detail = "";
      try {
        if (pageText.includes("오류발생내역")) {
          const lines = pageText
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const s = lines.findIndex((l) => l.includes("오류발생내역"));
          const e = lines.findIndex((l) => l.includes("주문가능내역"));
          const block = s >= 0 ? lines.slice(s, e > s ? e : s + 40).slice(0, 10) : [];
          detail = block.join(" | ");
        }
      } catch {}

      return {
        ok: false,
        error: "upload_not_applied",
        detail: detail || undefined,
        currentUrl: page.url(),
        usedStorageState: Boolean(storageStatePath),
      };
    }

    // Domeggook shows an "오류발생내역" block even for non-fatal warnings (e.g., e-money required).
    let warning = "";
    let fatalError = "";
    if (pageText.includes("오류발생내역")) {
      const lines = pageText
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);

      // Fatal: any actual row like "2행 ... 오류내용"
      const fatal = lines.find((l) => /^\d+행\s+/.test(l));
      if (fatal) fatalError = fatal;

      // Warning: e-money required
      const warn = lines.find((l) => l.includes("이머니") || l.includes("바로결제"));
      if (warn) warning = warn;

      if (fatalError) {
        return {
          ok: false,
          error: "vendor_validation_failed",
          detail: fatalError,
          currentUrl: page.url(),
          usedStorageState: Boolean(storageStatePath),
        };
      }
    }

    // After upload, try to discover the payment URL.
    const payUrl = await bestEffortFindPayUrl(page);

    return {
      ok: true,
      vendor: v,
      payUrl,
      currentUrl: page.url(),
      usedStorageState: Boolean(storageStatePath),
      warning: warning || undefined,
    };
  } catch (e) {
    return { ok: false, error: "upload_failed", detail: String(e?.message || e) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
