import crypto from 'node:crypto';

import { dbAll, dbRun, openDb } from './storage_sqlite_internal.js';

function nowIso() {
  return new Date().toISOString();
}

export const STARTER_THEMES = [
  {
    id: 'starter-toilet-pad',
    name: '배변패드',
    keywords: [
      '배변패드',
      '강아지 배변패드',
      '대형 배변패드',
      '배변패드 대용량',
      '흡수 패드',
      '애견 패드',
    ],
  },
  {
    id: 'starter-wet-wipes',
    name: '물티슈',
    keywords: [
      '물티슈',
      '휴대용 물티슈',
      '캡형 물티슈',
      '아기 물티슈',
      '손소독 물티슈',
    ],
  },
  {
    id: 'starter-kitchen-supplies',
    name: '주방소모품',
    keywords: [
      '수세미',
      '행주',
      '키친타올',
      '위생장갑',
      '지퍼백',
      '종이호일',
      '랩',
      '비닐장갑',
    ],
  },
];

async function ensureStarterThemes(db, userId) {
  const row = await dbAll(db, 'SELECT COUNT(*) AS c FROM themes WHERE user_id = ?', [userId]).then((r) => r?.[0] || null);
  const c = Number(row?.c) || 0;
  if (c > 0) return;

  const now = nowIso();
  for (const t of STARTER_THEMES) {
    await dbRun(
      db,
      'INSERT OR IGNORE INTO themes (id, user_id, name, keywords_json, created_at, updated_at, is_starter) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [t.id, userId, t.name, JSON.stringify(t.keywords || []), now, now],
    );
  }
}

export async function listThemes(userId) {
  const db = openDb();
  await ensureStarterThemes(db, userId);
  const rows = await dbAll(
    db,
    'SELECT id, name, keywords_json, is_starter, created_at, updated_at FROM themes WHERE user_id = ? ORDER BY is_starter DESC, created_at ASC',
    [userId],
  );
  db.close();

  return rows.map((r) => {
    let keywords = [];
    try { keywords = JSON.parse(r.keywords_json || '[]'); } catch {}
    return {
      id: r.id,
      name: r.name,
      keywords: Array.isArray(keywords) ? keywords.map((k) => String(k || '').trim()).filter(Boolean) : [],
      isStarter: Boolean(r.is_starter),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export async function getTheme(userId, themeId) {
  const id = String(themeId || '').trim();
  if (!id) return null;
  const db = openDb();
  await ensureStarterThemes(db, userId);
  const rows = await dbAll(db, 'SELECT id, name, keywords_json, is_starter, created_at, updated_at FROM themes WHERE user_id = ? AND id = ? LIMIT 1', [userId, id]);
  db.close();
  const r = rows?.[0] || null;
  if (!r) return null;
  let keywords = [];
  try { keywords = JSON.parse(r.keywords_json || '[]'); } catch {}
  return {
    id: r.id,
    name: r.name,
    keywords: Array.isArray(keywords) ? keywords.map((k) => String(k || '').trim()).filter(Boolean) : [],
    isStarter: Boolean(r.is_starter),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createTheme(userId, { name, keywords } = {}) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('missing name');
  const kw = Array.isArray(keywords) ? keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 50) : [];

  const db = openDb();
  await ensureStarterThemes(db, userId);
  const id = crypto.randomUUID();
  const now = nowIso();
  await dbRun(db, 'INSERT INTO themes (id, user_id, name, keywords_json, created_at, updated_at, is_starter) VALUES (?, ?, ?, ?, ?, ?, 0)', [
    id,
    userId,
    nm,
    JSON.stringify(kw),
    now,
    now,
  ]);
  db.close();
  return { id, name: nm, keywords: kw, isStarter: false, createdAt: now, updatedAt: now };
}

export async function updateTheme(userId, themeId, { name, keywords } = {}) {
  const id = String(themeId || '').trim();
  if (!id) throw new Error('missing themeId');

  const db = openDb();
  await ensureStarterThemes(db, userId);

  const rows = await dbAll(db, 'SELECT id, is_starter FROM themes WHERE user_id = ? AND id = ? LIMIT 1', [userId, id]);
  const existing = rows?.[0] || null;
  if (!existing) {
    db.close();
    throw new Error('theme not found');
  }
  if (Number(existing.is_starter) === 1) {
    db.close();
    throw new Error('starter theme cannot be edited');
  }

  const patch = {
    name: name == null ? null : String(name || '').trim(),
    keywords: Array.isArray(keywords) ? keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 50) : null,
  };

  const sets = [];
  const params = [];
  if (patch.name != null) {
    if (!patch.name) {
      db.close();
      throw new Error('missing name');
    }
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.keywords != null) {
    sets.push('keywords_json = ?');
    params.push(JSON.stringify(patch.keywords));
  }

  sets.push('updated_at = ?');
  params.push(nowIso());

  if (sets.length === 1) {
    db.close();
    return getTheme(userId, id);
  }

  params.push(userId, id);
  await dbRun(db, `UPDATE themes SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, params);
  db.close();
  return getTheme(userId, id);
}

export async function deleteTheme(userId, themeId) {
  const id = String(themeId || '').trim();
  if (!id) throw new Error('missing themeId');

  const db = openDb();
  await ensureStarterThemes(db, userId);

  const rows = await dbAll(db, 'SELECT id, is_starter FROM themes WHERE user_id = ? AND id = ? LIMIT 1', [userId, id]);
  const existing = rows?.[0] || null;
  if (!existing) {
    db.close();
    return { ok: true, deleted: 0 };
  }
  if (Number(existing.is_starter) === 1) {
    db.close();
    throw new Error('starter theme cannot be deleted');
  }

  const r = await dbRun(db, 'DELETE FROM themes WHERE user_id = ? AND id = ?', [userId, id]);
  db.close();
  return { ok: true, deleted: r?.changes || 0 };
}
