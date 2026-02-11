import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export function vendorLoginUrl(vendor) {
  const v = String(vendor || '').trim();
  if (v === 'domeggook') return 'https://domeggook.com/';
  if (v === 'domeme') return 'https://domemedb.domeggook.com/index/';
  return 'https://domeggook.com/';
}

function looksLoggedInDomeggook(html) {
  const h = String(html || '');
  // best-effort signals
  return /로그아웃/.test(h) || /myBuy|마이페이지|회원정보/.test(h);
}

function looksLoggedInDomeme(html) {
  const h = String(html || '');
  // If login form is present, likely not logged in.
  if (/input[^>]+type=["']password["']/i.test(h) && /로그인/.test(h)) return false;
  return /로그아웃/.test(h) || /주문|엑셀|마이/.test(h);
}

export async function checkVendorSession({ vendor, storageStatePath }) {
  const v = String(vendor || '').trim();
  const p = String(storageStatePath || '').trim();

  const exists = Boolean(p) && fs.existsSync(p);
  let updatedAt = '';
  if (exists) {
    try {
      const st = fs.statSync(p);
      updatedAt = new Date(st.mtimeMs).toISOString();
    } catch {}
  }

  // If no file, can't be logged in.
  if (!exists) return { ok: true, exists: false, updatedAt, loggedIn: false };

  // Real check (headless): open a page with storageState and detect login signals.
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: p });
    const page = await context.newPage();

    const url = vendorLoginUrl(v);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1200);

    const html = await page.content();
    const loggedIn = v === 'domeme' ? looksLoggedInDomeme(html) : looksLoggedInDomeggook(html);

    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    return { ok: true, exists: true, updatedAt, loggedIn };
  } catch (e) {
    return { ok: false, exists: true, updatedAt, loggedIn: false, error: String(e?.message || e) };
  }
}

export function resetVendorSession({ storageStatePath }) {
  const p = String(storageStatePath || '').trim();
  if (!p) return { ok: false, error: 'missing_path' };
  try {
    fs.rmSync(p, { force: true });
  } catch {}
  return { ok: true };
}

export function ensureParentDir(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}
