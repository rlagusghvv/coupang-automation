import "dotenv/config";

/**
 * NOTE:
 * Do NOT throw at import-time.
 * This repo can run the web UI/server without Coupang credentials.
 * We validate credentials only when an API action that needs them is invoked.
 */
function getEnv(name, fallback = "") {
  const v = process.env[name];
  return (v == null ? fallback : String(v)).trim();
}

export function assertNonEmpty(label, value) {
  return String(value || "").trim().length > 0;
}

export const COUPANG_ACCESS_KEY = getEnv("COUPANG_ACCESS_KEY");
export const COUPANG_SECRET_KEY = getEnv("COUPANG_SECRET_KEY");
export const COUPANG_VENDOR_ID = getEnv("COUPANG_VENDOR_ID");
export const COUPANG_VENDOR_USER_ID = getEnv("COUPANG_VENDOR_USER_ID");
export const COUPANG_DELIVERY_COMPANY_CODE = getEnv("COUPANG_DELIVERY_COMPANY_CODE");

export const IMAGE_PROXY_BASE = getEnv(
  "IMAGE_PROXY_BASE",
  "https://coupang-automation.pages.dev",
);
