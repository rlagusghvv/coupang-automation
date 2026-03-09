#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  return String(process.argv[idx + 1] || "").trim();
}

function getFlag(name, fallback = false) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const v = String(process.argv[idx + 1] || "1").trim().toLowerCase();
  if (!v) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return true;
}

function ensureArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.items)) return raw.items;
  return [];
}

async function main() {
  const base = getArg("base", process.env.COUPLEPHANT_BASE_URL || "http://127.0.0.1:3000");
  const session = getArg("session", process.env.COUPLEPHANT_SESSION || "");
  const itemsPath = getArg("items", "");
  const outPathRaw = getArg("out", "");
  const campaign = getArg("campaign", `instagram_reels_${new Date().toISOString().slice(0, 10)}`);
  const brand = getArg("brand", "쿠팡코끼리");
  const tone = getArg("tone", "실용적");
  const autoCreateLinks = getFlag("auto-links", true);

  if (!itemsPath) {
    throw new Error("missing --items <json_path>");
  }
  if (!session) {
    throw new Error("missing session token: pass --session or COUPLEPHANT_SESSION");
  }

  const itemsRaw = JSON.parse(fs.readFileSync(path.resolve(itemsPath), "utf-8"));
  const items = ensureArray(itemsRaw)
    .filter((x) => x && typeof x === "object")
    .slice(0, 30);

  if (items.length === 0) {
    throw new Error("items is empty");
  }

  const payload = {
    platform: "instagram",
    campaign,
    brand,
    tone,
    autoCreateLinks,
    items,
  };

  const url = `${base.replace(/\/$/, "")}/api/marketing/reels/pack`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `session=${session}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok !== true) {
    throw new Error(`reels_pack_failed status=${res.status} error=${json?.error || "unknown"}`);
  }

  const outDir = path.join(process.cwd(), "out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath =
    outPathRaw.trim() ||
    path.join(outDir, `instagram_reels_pack_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(json, null, 2), "utf-8");

  console.log("[reels-pack] ok");
  console.log("count:", json.count);
  console.log("out:", path.resolve(outPath));
}

main().catch((e) => {
  console.error("[reels-pack] failed:", String(e?.message || e));
  process.exit(1);
});

