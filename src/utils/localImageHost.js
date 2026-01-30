import path from "node:path";

export function resolveLocalImageBase(settings = {}) {
  const fromSettings = (settings.localImageBaseUrl || "").trim();
  if (fromSettings) return normalizeBase(fromSettings);
  const fromProxyBase = (settings.imageProxyBase || "").trim();
  if (fromProxyBase) return normalizeBase(fromProxyBase);
  const fromEnv = (process.env.LOCAL_IMAGE_BASE || "").trim();
  if (fromEnv) return normalizeBase(fromEnv);
  return "http://localhost:3000/couplus-out";
}

function normalizeBase(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  if (raw.includes("/couplus-out")) return raw.replace(/\/+$/, "");
  return raw.replace(/\/+$/, "") + "/couplus-out";
}

export function ensureTrailingSlash(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

export function buildLocalImageUrl(baseUrl, fileName) {
  const base = ensureTrailingSlash(baseUrl);
  const safeName = String(fileName || "").replace(/^[\\/]+/, "");
  if (!base || !safeName) return "";
  return new URL(safeName, base).toString();
}

export function buildOutPath(outDir, fileName) {
  return path.join(outDir, fileName);
}
