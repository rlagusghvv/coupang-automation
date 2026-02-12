import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function openDb() {
  ensureDir();
  const db = new sqlite3.Database(DB_PATH);
  try { db.configure('busyTimeout', 5000); } catch {}
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); } catch {}
  return db;
}

export function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

export function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}
