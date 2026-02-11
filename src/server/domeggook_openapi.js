import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://domeggook.com/ssl/api/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return undefined;
}

export async function callDomeggookOpenApi({ aid, ver, mode, params = {}, timeoutMs = 25_000 }) {
  const key = String(aid || '').trim();
  if (!key) throw new Error('missing_openapi_key');

  const url = new URL(API_BASE);
  url.searchParams.set('ver', String(ver || '').trim());
  url.searchParams.set('mode', String(mode || '').trim());
  url.searchParams.set('aid', key);

  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    url.searchParams.set(k, s);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`openapi_http_${res.status}`);
    }
    const json = JSON.parse(text);

    // API responses often wrap under "domeggook" or "domeme" keys.
    const root = pick(json, ['domeggook', 'domeme', 'dome', 'supply']) || json;

    // Some errors are inside header/message.
    const header = root?.header || {};
    const err = header?.error || header?.err || root?.error;
    if (err) {
      throw new Error(String(err));
    }

    return { ok: true, url: String(url), root, raw: json };
  } finally {
    clearTimeout(t);
  }
}

function flattenCategoryTree(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  // node keys are numeric strings.
  for (const k of Object.keys(node)) {
    const c = node[k];
    const code = String(c?.code || '').trim();
    const name = String(c?.name || '').trim();
    if (code && name) {
      out.push({
        code,
        name,
        locked: String(c?.locked || '').trim(),
        int: String(c?.int || '').trim(),
      });
    }
    if (c?.child) flattenCategoryTree(c.child, out);
  }
  return out;
}

export async function getCategoryList({ aid, isReg = true }) {
  const r = await callDomeggookOpenApi({
    aid,
    ver: '1.0',
    mode: 'getCategoryList',
    params: {
      om: 'json',
      isReg: isReg ? 'true' : 'false',
    },
  });
  const items = r?.root?.items || {};
  const flat = flattenCategoryTree(items, []);
  return { ok: true, categories: flat };
}

export function isSearchableCategoryCode(code) {
  const c = String(code || '').trim();
  const parts = c.split('_');
  if (parts.length !== 5) return false;
  // must be 2-digit pairs
  if (!parts.every((p) => /^\d{2}$/.test(p))) return false;
  // major-only is not allowed (second pair must be non-zero)
  if (parts[1] === '00') return false;
  return true;
}

export function loadCategoryKeywordSeeds() {
  const p = path.join(process.cwd(), 'data', 'domeggook_categories.txt');
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function pickCategoryCodes({ categories, seeds, maxCodes = 12 }) {
  const list = Array.isArray(categories) ? categories : [];
  const wanted = Array.isArray(seeds) ? seeds : [];

  const out = [];
  const seen = new Set();

  for (const w of wanted) {
    const q = String(w || '').trim();
    if (!q) continue;
    // match by substring
    const hit = list.filter((c) => c?.name && String(c.name).includes(q));
    for (const c of hit) {
      const code = String(c.code || '').trim();
      if (!isSearchableCategoryCode(code)) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      out.push({ code, name: String(c.name || '').trim() });
      if (out.length >= maxCodes) return out;
    }
  }

  // fallback: pick some random searchable categories if none matched
  if (out.length === 0) {
    for (const c of list) {
      const code = String(c?.code || '').trim();
      if (!isSearchableCategoryCode(code)) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      out.push({ code, name: String(c?.name || '').trim() });
      if (out.length >= Math.min(8, maxCodes)) break;
    }
  }

  return out;
}

export async function getItemList({ aid, market = 'dome', ca, pg = 1, sz = 40, so = 'rd' }) {
  const r = await callDomeggookOpenApi({
    aid,
    ver: '4.1',
    mode: 'getItemList',
    params: {
      market,
      om: 'json',
      ca,
      pg,
      sz,
      so,
    },
    timeoutMs: 30_000,
  });

  const header = r?.root?.header || {};
  const list = r?.root?.list || {};
  const items = Array.isArray(list?.item) ? list.item : (list?.item ? [list.item] : []);

  return {
    ok: true,
    header,
    items: items.map((it) => {
      const no = String(it?.no || '').trim();
      const title = String(it?.title || '').trim();
      const price = Number(it?.price);
      const url = String(it?.url || (no ? `https://domeggook.com/${no}` : '')).trim();
      const thumb = String(it?.thumb || '').trim();
      const deliWho = String(it?.deli?.who || '').trim();
      const deliFee = Number(it?.deli?.fee);

      return {
        no,
        title,
        price: Number.isFinite(price) ? price : null,
        url,
        thumb,
        deli: {
          who: deliWho,
          fee: Number.isFinite(deliFee) ? deliFee : null,
        },
      };
    }),
  };
}

export async function collectOpenApiCandidates({ aid, market = 'dome', categories, perCategory = 30, pages = 1, sleepMs = 220 }) {
  const cats = Array.isArray(categories) ? categories : [];
  const out = [];
  const seen = new Set();

  for (const c of cats) {
    const code = String(c?.code || '').trim();
    if (!code) continue;
    const label = String(c?.name || '').trim();

    for (let pg = 1; pg <= Math.max(1, Math.min(5, Number(pages) || 1)); pg += 1) {
      const r = await getItemList({
        aid,
        market,
        ca: code,
        pg,
        sz: Math.max(1, Math.min(200, Number(perCategory) || 30)),
        so: 'rd',
      });

      for (const it of r.items) {
        if (!it?.url || seen.has(it.url)) continue;
        seen.add(it.url);
        out.push({
          url: it.url,
          title: it.title,
          price: it.price,
          thumb: it.thumb,
          shipping: it.deli,
          category: { code, name: label },
        });
      }

      await sleep(sleepMs);
    }
  }

  return { ok: true, items: out };
}
