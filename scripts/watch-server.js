import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESTART_CMD = path.join(ROOT_DIR, "scripts", "server-bg.sh");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "out",
  "logs",
  "data",
]);

const IGNORE_FILES = new Set([
  ".server.pid",
  ".watcher.pid",
  ".DS_Store",
]);

let pending = null;
let lastRestart = 0;

function shouldIgnore(filePath) {
  const rel = path.relative(ROOT_DIR, filePath);
  if (!rel || rel.startsWith("..")) return true;
  const parts = rel.split(path.sep);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  const base = path.basename(rel);
  if (IGNORE_FILES.has(base)) return true;
  if (base.endsWith(".log")) return true;
  return false;
}

function scheduleRestart(reason) {
  const now = Date.now();
  if (now - lastRestart < 1500) return;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    lastRestart = Date.now();
    const child = spawn(RESTART_CMD, ["restart"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }, 700);
}

function watchRoot() {
  try {
    fs.watch(
      ROOT_DIR,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(ROOT_DIR, filename);
        if (shouldIgnore(fullPath)) return;
        scheduleRestart(`${eventType}:${filename}`);
      },
    );
  } catch {
    // no-op
  }
}

watchRoot();

// keep process alive
setInterval(() => {}, 1000 * 60);
