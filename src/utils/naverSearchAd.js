import crypto from "node:crypto";
import { fetchWithRetry } from "../server/net_limit.js";

const BASE_URL = "https://api.searchad.naver.com";

function env(name, def = "") {
  return String(process.env[name] || def).trim();
}

function sign({ timestamp, method, uri, secretKey }) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac("sha256", secretKey).update(message).digest("base64");
}

export async function naverSearchAdRequest({
  method = "GET",
  path,
  query = "",
  body,
  apiKey,
  secretKey,
  customerId,
}) {
  const key = String(apiKey || env("NAVER_SEARCHAD_API_KEY")).trim();
  const secret = String(secretKey || env("NAVER_SEARCHAD_SECRET_KEY")).trim();
  const cid = String(customerId || env("NAVER_SEARCHAD_CUSTOMER_ID")).trim();

  if (!key || !secret || !cid) {
    return { ok: false, status: 400, error: "missing_naver_searchad_keys" };
  }

  const qs = String(query || "").replace(/^\?/, "");
  const uri = qs ? `${path}?${qs}` : path;
  const url = `${BASE_URL}${uri}`;
  const ts = Date.now().toString();

  const signature = sign({
    timestamp: ts,
    method: String(method || "GET").toUpperCase(),
    uri,
    secretKey: secret,
  });

  const headers = {
    "Content-Type": "application/json",
    "X-Timestamp": ts,
    "X-API-KEY": key,
    "X-Customer": cid,
    "X-Signature": signature,
  };

  try {
    const res = await fetchWithRetry(url, {
      method: String(method || "GET").toUpperCase(),
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      spacingMs: 350,
      retries: 3,
      retryOn: [429, 500, 502, 503, 504],
      baseDelayMs: 700,
      maxDelayMs: 9000,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `http_${res.status}`,
        body: json ?? text,
      };
    }

    return { ok: true, status: res.status, body: json ?? text };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: "network_error",
      message: String(e?.message || e),
    };
  }
}

export async function fetchKeywordTool({ hintKeywords = [], showDetail = 1 } = {}) {
  const list = Array.isArray(hintKeywords) ? hintKeywords : [hintKeywords];
  const cleaned = list
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 5);

  if (cleaned.length === 0) {
    return { ok: false, status: 400, error: "missing_keywords" };
  }

  const params = new URLSearchParams();
  params.set("hintKeywords", cleaned.join(","));
  params.set("showDetail", String(showDetail ? 1 : 0));

  return naverSearchAdRequest({
    method: "GET",
    path: "/keywordstool",
    query: params.toString(),
  });
}

export function normalizeMonthlyCount(v) {
  // Naver may return "< 10" etc.
  const s = String(v ?? "").trim();
  if (!s) return 0;
  if (s.startsWith("<")) return 0;
  const n = Number(s.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
