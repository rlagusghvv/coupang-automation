import { buildAuthorization, buildAuthorizationWithKeys } from "./sign.js";
import { fetchWithRetry } from "../server/net_limit.js";

const BASE_URL = "https://api-gateway.coupang.com";

export async function coupangRequest({
  method,
  path,
  query = "",
  body,
  baseUrl,
  headers,
  accessKey,
  secretKey,
  retry,
}) {
  const base = baseUrl || BASE_URL;
  const safeBase = String(base).replace(/^http:\/\//i, "https://");
  const url = `${safeBase}${path}${query ? "?" + query : ""}`;
  const { authorization } =
    accessKey && secretKey
      ? buildAuthorizationWithKeys({ method, path, query, accessKey, secretKey })
      : buildAuthorization({ method, path, query });

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isBinary =
    body &&
    (body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body) ||
      (typeof Blob !== "undefined" && body instanceof Blob));

  const baseHeaders = {
    Authorization: authorization,
    "X-Requested-By": "couplus-clone",
    ...(headers || {}),
  };

  // For multipart FormData, DO NOT set Content-Type (fetch will set boundary)
  if (!isFormData && !isBinary) {
    baseHeaders["Content-Type"] = baseHeaders["Content-Type"] || "application/json;charset=UTF-8";
  }

  const fetchInit = {
    method,
    headers: baseHeaders,
    body: body
      ? isFormData || isBinary
        ? body
        : JSON.stringify(body)
      : undefined,
  };

  // Default: modest retry on 429/503 (Coupang occasionally rate-limits).
  // Callers can disable by passing retry: { retries: 0 }.
  const retryCfg = (retry && typeof retry === 'object') ? retry : { retries: 3, retryOn: [429, 503, 502, 504], baseDelayMs: 600, maxDelayMs: 8000 };

  const res = await fetchWithRetry(url, {
    ...fetchInit,
    retries: Number(retryCfg?.retries ?? 3),
    retryOn: Array.isArray(retryCfg?.retryOn) ? retryCfg.retryOn : [429, 503, 502, 504],
    baseDelayMs: Number(retryCfg?.baseDelayMs ?? 600),
    maxDelayMs: Number(retryCfg?.maxDelayMs ?? 8000),
    spacingMs: Number(retryCfg?.spacingMs ?? 0),
  });

  const text = await res.text();

  return {
    status: res.status,
    body: text,
  };
}
