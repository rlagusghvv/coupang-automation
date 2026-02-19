import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const USER_DATA_DIR = '/Users/kimhyunhomacmini/.openclaw/browser/openclaw/user-data';
const OUT_DIR = path.join(process.cwd(), 'data', 'coupang_wing_meta');
fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  {
    name: 'attribute_2910',
    url: 'https://wing.coupang.com/vendor-inventory/attribute?categoryId=2910&approvedOnce=false',
  },
  {
    name: 'fullPath_65906',
    url: 'https://wing.coupang.com/tenants/seller-web/v2/vendor-inventory/displayCategory/fullPath?displayCategoryCode=65906&categoryId=2910',
  },
];

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: true });
const page = await ctx.newPage();
await page.goto('https://wing.coupang.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });

for (const t of targets) {
  const res = await page.request.get(t.url, { headers: { referer: 'https://wing.coupang.com/' } });
  const status = res.status();
  const headers = res.headers();
  const body = await res.text();
  const outPath = path.join(OUT_DIR, `${t.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ fetchedAt: new Date().toISOString(), url: t.url, status, headers, body }, null, 2));
  console.log('[ok]', t.name, status, outPath);
}

await ctx.close();
