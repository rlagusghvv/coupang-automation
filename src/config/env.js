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

function getEnvAny(names, fallback = "") {
  for (const n of names || []) {
    const v = getEnv(String(n || ""));
    if (v) return v;
  }
  return String(fallback || "").trim();
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

// Domeggook OpenAPI (variable name may differ depending on docs/account)
export const DOMEGGOOK_OPENAPI_KEY = getEnvAny([
  "DOMEGGOOK_OPENAPI_KEY",
  "DOMEGGOOK_API_KEY",
  "DOMEGGOOK_KEY",
  "DOMEGGOOK_SERVICE_KEY",
  "DOMEGGOOK_CERT_KEY",
]);

export const DOMEGGOOK_PRIVATE_API_KEY = getEnvAny([
  "DOMEGGOOK_PRIVATE_API_KEY",
  "DOMEGGOOK_API_KEY_PRIVATE",
  "DOMEGGOOK_PRIVATE_KEY",
]);

export const DOMEGGOOK_PRIVATE_ID = getEnvAny([
  "DOMEGGOOK_PRIVATE_ID",
  "DOMEGGOOK_MEMBER_ID",
]);

export const DOMEGGOOK_PRIVATE_PW = getEnvAny([
  "DOMEGGOOK_PRIVATE_PW",
  "DOMEGGOOK_MEMBER_PW",
  "DOMEGGOOK_PASSWORD",
]);
