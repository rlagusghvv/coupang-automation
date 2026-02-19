import {
  buildAuthorization,
  buildAuthorizationWithKeys,
  buildAuthorizationWithKeysQ,
  buildAuthorizationWithKeysQAlways,
  buildAuthorizationWithKeysAlt,
  buildAuthorizationWithKeysAltAlways,
  buildAuthorizationWithKeysNoZ,
  buildAuthorizationWithKeys4NoZ,
} from "./sign.js";

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
  const primary =
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
    Authorization: primary.authorization,
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

  // Some endpoints reject our default signature with "HMAC format is invalid".
  // Retry with alternate signature variants.
  if (res.status === 401 && accessKey && secretKey && /HMAC format is invalid/i.test(text)) {
    const variants = [
      buildAuthorizationWithKeysQ({ method, path, query, accessKey, secretKey }),
      buildAuthorizationWithKeysQAlways({ method, path, query, accessKey, secretKey }),
      buildAuthorizationWithKeysAlt({ method, path, query, accessKey, secretKey }),
      buildAuthorizationWithKeysAltAlways({ method, path, query, accessKey, secretKey }),
      buildAuthorizationWithKeysNoZ({ method, path, query, accessKey, secretKey }),
      buildAuthorizationWithKeys4NoZ({ method, path, query, accessKey, secretKey }),
    ];

    for (const v of variants) {
      const retryHeaders = { ...baseHeaders, Authorization: v.authorization };
      const res2 = await fetch(url, {
        method,
        headers: retryHeaders,
        body: body
          ? isFormData || isBinary
            ? body
            : JSON.stringify(body)
          : undefined,
      });
      const text2 = await res2.text();
      if (!(res2.status === 401 && /HMAC format is invalid/i.test(text2))) {
        return { status: res2.status, body: text2 };
      }
    }

    // if all variants failed, fall through
  }

  return {
    status: res.status,
    body: text,
  };
}
