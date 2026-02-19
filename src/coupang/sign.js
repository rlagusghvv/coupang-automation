import crypto from "crypto";
import { signedDateUTC, signedDateUTC4, signedDateUTCNoZ, signedDateUTC4NoZ } from "./datetime.js";
import { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY } from "../config/env.js";

export function buildAuthorization({ method, path, query = "" }) {
  const signedDate = signedDateUTC();
  const message = `${signedDate}${method}${path}${query}`;

  const signature = crypto
    .createHmac("sha256", COUPANG_SECRET_KEY)
    .update(message)
    .digest("hex");

  return {
    authorization: `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${signedDate}, signature=${signature}`,
    signedDate,
  };
}

// 사용자별 키를 사용할 수 있도록 별도 함수 제공
function _build({ method, path, query = "", accessKey, secretKey, signedDate, includeQuestionMark = false, alwaysQuestionMark = false }) {
  const q = query
    ? includeQuestionMark
      ? `?${query}`
      : query
    : (alwaysQuestionMark ? "?" : "");
  const message = `${signedDate}${method}${path}${q}`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(message)
    .digest("hex");
  return {
    authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`,
    signedDate,
  };
}

// Default (legacy) signature used by existing working calls.
export function buildAuthorizationWithKeys({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTC() });
}

// Variant: some endpoints expect the query string to be prefixed with '?'
export function buildAuthorizationWithKeysQ({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTC(), includeQuestionMark: true });
}

// Variant: even without a query, some endpoints appear to require a trailing '?' in the signature string.
export function buildAuthorizationWithKeysQAlways({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTC(), includeQuestionMark: true, alwaysQuestionMark: true });
}

// Variant: YYYY signed-date + '?' query
export function buildAuthorizationWithKeysAlt({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTC4(), includeQuestionMark: true });
}

export function buildAuthorizationWithKeysAltAlways({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTC4(), includeQuestionMark: true, alwaysQuestionMark: true });
}

export function buildAuthorizationWithKeysNoZ({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTCNoZ(), includeQuestionMark: true, alwaysQuestionMark: true });
}

export function buildAuthorizationWithKeys4NoZ({ method, path, query = "", accessKey, secretKey }) {
  return _build({ method, path, query, accessKey, secretKey, signedDate: signedDateUTC4NoZ(), includeQuestionMark: true, alwaysQuestionMark: true });
}
