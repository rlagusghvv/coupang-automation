// Check Coupang automation DB for new failures and print a concise alert message.
// Designed for OpenClaw cron: if output is empty, cron should output nothing.
// State is kept in data/alert_state.json (NOT committed).

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';

const DB_PATH = path.join(process.cwd(), 'data', 'app.db');
const STATE_PATH = path.join(process.cwd(), 'data', 'alert_state.json');

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeState(obj) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
  } catch {}
}

const state = readState();
const lastTs = Number(state.lastFailureAtMs || 0);

const db = new sqlite3.Database(DB_PATH);
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, rows) => (e ? rej(e) : res(rows || []))));

// We currently log attempts in listing_attempts. If empty (older runs), fall back to jobs table.
let rows = [];
try {
  rows = await dbAll(
    `SELECT id, source_url, display_category_code, error_code, error_message, created_at
     FROM listing_attempts
     WHERE result_status='failed'
     ORDER BY id DESC
     LIMIT 20`,
  );
} catch {
  rows = [];
}

// Parse created_at ISO to ms.
const parsed = rows
  .map((r) => {
    const t = Date.parse(r.created_at || '') || 0;
    return { ...r, createdAtMs: t };
  })
  .filter((r) => r.createdAtMs > lastTs)
  .sort((a, b) => a.createdAtMs - b.createdAtMs);

if (!parsed.length) {
  db.close();
  process.exit(0);
}

const newest = parsed[parsed.length - 1];
state.lastFailureAtMs = newest.createdAtMs;
writeState(state);

db.close();

// Build a short alert summary.
const top = parsed.slice(-5);
const lines = [];
lines.push(`[알림] 쿠팡 업로드 실패 ${parsed.length}건 감지 (최근 5건만 표시)`);
for (const r of top) {
  const code = r.error_code || 'failed';
  const cat = r.display_category_code ? `cat=${r.display_category_code}` : 'cat=?';
  const msg = String(r.error_message || '').replace(/\s+/g, ' ').trim();
  lines.push(`- ${code} (${cat}) ${r.source_url}`);
  if (msg) lines.push(`  · ${msg.slice(0, 120)}`);
}

process.stdout.write(lines.join('\n'));
