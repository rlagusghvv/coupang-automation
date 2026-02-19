import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const USER_DATA_DIR = '/Users/kimhyunhomacmini/.openclaw/browser/openclaw/user-data';
const OUT_PATH = path.join(process.cwd(), 'data', 'coupang_meta_capture.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function append(obj) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.appendFileSync(OUT_PATH, JSON.stringify(obj) + '\n');
}

const patterns = [
  // category meta
  'category-related-metas',
  'display-category-codes',
  'category',
  'metas',
  'attributes',
  'product',
  'items',
  'seller-products',

  // image uploader (Wing)
  'imageuploader',
  'image-uploader',
  'image_uploader',
  '/images',
  'upload-image',
  'image/upload',
  'file/upload',
  'attachment',
];

function matchUrl(u) {
  const s = String(u || '').toLowerCase();
  return patterns.some((p) => s.includes(p));
}

console.log('[capture] starting', { USER_DATA_DIR, OUT_PATH, patterns });

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
});

const page = await context.newPage();

page.on('request', (req) => {
  const u = req.url();
  if (matchUrl(u)) {
    const headers = req.headers();
    append({
      t: nowIso(),
      kind: 'request',
      url: u,
      method: req.method(),
      contentType: headers['content-type'] || headers['Content-Type'] || '',
    });
  }
});

page.on('response', async (res) => {
  const u = res.url();
  if (!matchUrl(u)) return;
  const status = res.status();
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  let bodyText = '';
  if (ct.includes('json')) {
    try {
      bodyText = await res.text();
    } catch {}
  }
  append({ t: nowIso(), kind: 'response', url: u, status, contentType: ct, body: bodyText.slice(0, 250000) });
});

await page.goto('https://wing.coupang.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
console.log('[capture] wing opened.');
console.log('[capture] Navigate to 상품등록 and select category 65906.');
console.log('[capture] Logging broad request/response URLs; output:', OUT_PATH);

await page.waitForTimeout(1000 * 60 * 20);
await context.close();
console.log('[capture] done');
