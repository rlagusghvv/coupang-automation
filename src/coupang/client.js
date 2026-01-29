import { buildAuthorization } from "./sign.js";

const BASE_URL = "https://api-gateway.coupang.com";

export async function coupangRequest({ method, path, query = "", body }) {
  const url = `${BASE_URL}${path}${query ? "?" + query : ""}`;
  const { authorization } = buildAuthorization({ method, path, query });

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: authorization,
      "X-Requested-By": "couplus-clone",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  return {
    status: res.status,
    body: text,
  };
}
