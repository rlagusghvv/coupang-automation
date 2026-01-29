import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

export function createUser({ email, password }) {
  const users = loadJson(USERS_FILE, []);
  if (users.find((u) => u.email === email)) {
    throw new Error("email already exists");
  }
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const row = { id, email, passwordHash, createdAt: new Date().toISOString(), settings: {} };
  users.push(row);
  saveJson(USERS_FILE, users);
  return { id, email };
}

export function verifyUser({ email, password }) {
  const users = loadJson(USERS_FILE, []);
  const user = users.find((u) => u.email === email);
  if (!user) return null;
  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return null;
  return { id: user.id, email: user.email };
}

export function createSession(userId) {
  const sessions = loadJson(SESSIONS_FILE, {});
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = { userId, createdAt: Date.now() };
  saveJson(SESSIONS_FILE, sessions);
  return token;
}

export function destroySession(token) {
  const sessions = loadJson(SESSIONS_FILE, {});
  delete sessions[token];
  saveJson(SESSIONS_FILE, sessions);
}

export function getUserBySession(token) {
  const sessions = loadJson(SESSIONS_FILE, {});
  const users = loadJson(USERS_FILE, []);
  const s = sessions[token];
  if (!s) return null;
  const u = users.find((x) => x.id === s.userId);
  if (!u) return null;
  return { id: u.id, email: u.email, settings: u.settings || {} };
}

export function updateSettings(userId, nextSettings) {
  const users = loadJson(USERS_FILE, []);
  const idx = users.findIndex((u) => u.id === userId);
  if (idx < 0) throw new Error("user not found");
  users[idx].settings = { ...(users[idx].settings || {}), ...nextSettings };
  saveJson(USERS_FILE, users);
  return users[idx].settings;
}
