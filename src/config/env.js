import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`ENV MISSING: ${name}`);
  }
  return v.trim();
}

export const COUPANG_ACCESS_KEY = required("COUPANG_ACCESS_KEY");
export const COUPANG_SECRET_KEY = required("COUPANG_SECRET_KEY");
export const COUPANG_VENDOR_ID = required("COUPANG_VENDOR_ID");
export const COUPANG_VENDOR_USER_ID = required("COUPANG_VENDOR_USER_ID");
export const COUPANG_DELIVERY_COMPANY_CODE = required("COUPANG_DELIVERY_COMPANY_CODE");

export const IMAGE_PROXY_BASE =
  (process.env.IMAGE_PROXY_BASE || "https://coupang-automation.pages.dev").trim();
