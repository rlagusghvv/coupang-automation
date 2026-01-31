import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * Local state directory for this app (sessions, storageState files, etc.).
 * Keep it out of the repo so it survives upgrades and never gets committed.
 */
export const COUPLUS_HOME = (
  process.env.COUPLUS_HOME || path.join(os.homedir(), ".couplus")
).trim();

export function ensureDir(p) {
  if (!p) return;
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

export function statePath(fileName) {
  ensureDir(COUPLUS_HOME);
  return path.join(COUPLUS_HOME, fileName);
}

// Default storageState locations (overridable via env)
export const DOMEME_STORAGE_STATE_PATH = (
  process.env.DOMEME_STORAGE_STATE || statePath("storageState.domeme.json")
).trim();

export const DOMEGGOOK_STORAGE_STATE_PATH = (
  process.env.DOMEGGOOK_STORAGE_STATE || statePath("storageState.domeggook.json")
).trim();
