import { buildAuthorization, buildAuthorizationWithKeys } from "./sign.js";

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

  const res = await fetch(url, {
    method,
    headers: baseHeaders,
    body: body
      ? isFormData || isBinary
        ? body
        : JSON.stringify(body)
      : undefined,
  });

  const text = await res.text();

  return {
    status: res.status,
    body: text,
  };
}
