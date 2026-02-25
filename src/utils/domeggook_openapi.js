import fetch from 'node-fetch';
import { DOMEGGOOK_OPENAPI_KEY } from '../config/env.js';

function assertKey(apiKey = '') {
  const k = String(apiKey || DOMEGGOOK_OPENAPI_KEY || '').trim();
  if (!k) throw new Error('domeggook_openapi_key_missing');
  return k;
}

function toUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u;
}

async function fetchText(url) {
  const r = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Couplus/1.0 (+https://app.splui.com)'
    },
    timeout: 30_000,
  });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

// Domeggook OpenAPI: Item list
// Ref: https://openapi.domeggook.com/main/reference/detail?api_no=68&scope_code=SCP_OPEN
// Required params:
//  - ver, mode=getItemList, aid(API Key), market(dome|supply), om(json|xml)
// Optional: sz, pg, so, kw
export async function domeggookOpenApiGetItemList({
  apiKey = '',
  keyword,
  market = 'dome',
  page = 1,
  pageSize = 40,
  sort = 'se',
  // getItemList works on 4.0/4.1 (older versions return GONE)
  ver = '4.1',
  om = 'json',
}) {
  const key = assertKey(apiKey);
  const kw = String(keyword || '').trim();

  // NOTE: Request URL shown in docs: https://domeggook.com/ssl/api/
  const url = toUrl('https://domeggook.com/ssl/api/', {
    ver,
    mode: 'getItemList',
    aid: key,
    market,
    om,
    sz: Math.max(1, Math.min(200, Number(pageSize) || 40)),
    pg: Math.max(1, Number(page) || 1),
    so: sort,
    kw: kw || undefined,
  });

  const r = await fetchText(url);

  // Some errors redirect to HTML error pages; treat HTML as failure for json requests.
  const looksHtml = /<html|<!doctype/i.test(r.text || '');
  if (!r.ok || looksHtml) {
    const e = new Error('domeggook_openapi_getItemList_failed');
    e.details = [{ url: url.toString(), status: r.status, body: (r.text || '').slice(0, 500) }];
    throw e;
  }

  if (String(om).toLowerCase() === 'json') {
    const j = JSON.parse(r.text);
    if (j?.errors) {
      const e = new Error('domeggook_openapi_getItemList_error');
      e.details = [{ url: url.toString(), status: r.status, body: JSON.stringify(j.errors).slice(0, 500) }];
      throw e;
    }
    return { ok: true, url: url.toString(), raw: j };
  }

  // xml
  return { ok: true, url: url.toString(), rawText: r.text };
}

// Domeggook OpenAPI: Item view (details)
// Ref: https://openapi.domeggook.com/main/reference/detail?api_no=73&scope_code=SCP_OPEN
// mode=getItemView, ver (latest seems 4.5), aid(API Key), no(itemNo), om
export async function domeggookOpenApiGetItemView({
  apiKey = '',
  itemNo,
  ver = '4.5',
  om = 'json',
  multiple = false,
}) {
  const key = assertKey(apiKey);
  const no = String(itemNo || '').trim();
  if (!no) throw new Error('missing_itemNo');

  const url = toUrl('https://domeggook.com/ssl/api/', {
    ver,
    mode: 'getItemView',
    aid: key,
    no,
    om,
    multiple: multiple ? 'true' : undefined,
  });

  const r = await fetchText(url);
  if (!r.ok) {
    const e = new Error('domeggook_openapi_getItemView_failed');
    e.details = [{ url: url.toString(), status: r.status, body: (r.text || '').slice(0, 500) }];
    throw e;
  }

  if (String(om).toLowerCase() === 'json') {
    const j = JSON.parse(r.text);
    return { ok: true, url: url.toString(), raw: j };
  }
  return { ok: true, url: url.toString(), rawText: r.text };
}
