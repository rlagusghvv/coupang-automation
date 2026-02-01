import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function newSessionFlag(prefix) {
  ensureDir();
  const id = `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
  const flagPath = path.join(DATA_DIR, `session_save.${id}.flag`);
  try {
    fs.rmSync(flagPath, { force: true });
  } catch {}
  return { id, flagPath };
}

export function touchFlag(flagPath) {
  ensureDir();
  fs.writeFileSync(flagPath, String(Date.now()), "utf-8");
}
