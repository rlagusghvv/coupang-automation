import fetch from "node-fetch";
import {
  DOMEGGOOK_PRIVATE_API_KEY,
  DOMEGGOOK_PRIVATE_ID,
  DOMEGGOOK_PRIVATE_PW,
} from "../config/env.js";

const API_ENDPOINT = "https://domeggook.com/ssl/api/";

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function toUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    url.searchParams.set(key, text);
  }
  return url;
}

async function fetchText(url, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_500, Number(timeoutMs) || 30_000),
  );
  try {
    const response = await fetch(url.toString(), {
      method,
      body,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Couplus/1.0 (+https://app2.splui.com)",
        ...(body
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
            }
          : {}),
      },
    });
    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseResponse(text, label = "domeggook_private_api") {
  let json;
  try {
    json = JSON.parse(String(text || ""));
  } catch {
    const error = new Error(`${label}_invalid_json`);
    error.details = String(text || "").slice(0, 600);
    throw error;
  }
  if (json?.errors) {
    const error = new Error(String(json.errors?.dcode || json.errors?.code || `${label}_error`));
    error.details = String(
      json.errors?.dmessage || json.errors?.message || JSON.stringify(json.errors),
    ).slice(0, 600);
    error.raw = json;
    throw error;
  }
  return json?.domeggook || json;
}

export function resolveDomeggookPrivateCredentials(settings = {}) {
  return {
    apiKey: pickFirstNonEmpty(settings.domeggookPrivateApiKey, DOMEGGOOK_PRIVATE_API_KEY),
    memberId: pickFirstNonEmpty(settings.domeggookPrivateId, DOMEGGOOK_PRIVATE_ID),
    password: pickFirstNonEmpty(settings.domeggookPrivatePw, DOMEGGOOK_PRIVATE_PW),
  };
}

export async function domeggookPrivateApiLogin({
  apiKey,
  memberId,
  password,
  ip = "127.0.0.1",
  loginKeep = "off",
  userAgent = "Couplus/1.0",
  device = "Third Party",
  timeoutMs = 20_000,
} = {}) {
  const body = new URLSearchParams({
    ver: "4.1",
    mode: "setLogin",
    aid: String(apiKey || "").trim(),
    id: String(memberId || "").trim(),
    pw: String(password || "").trim(),
    om: "json",
    loginKeep: String(loginKeep || "off").trim() || "off",
    userAgent: String(userAgent || "Couplus/1.0").trim(),
    ip: String(ip || "127.0.0.1").trim() || "127.0.0.1",
    device: String(device || "Third Party").trim() || "Third Party",
  });
  const response = await fetchText(new URL(API_ENDPOINT), {
    method: "POST",
    body,
    timeoutMs,
  });
  if (!response.ok || /<html|<!doctype/i.test(response.text || "")) {
    const error = new Error("domeggook_private_login_failed");
    error.details = String(response.text || "").slice(0, 600);
    throw error;
  }
  return parseResponse(response.text, "domeggook_private_login");
}

export async function domeggookPrivateApiGetOrderList({
  apiKey,
  memberId,
  sessionId,
  day = 30,
  page = 1,
  pageSize = 20,
  orderFor = "buy",
  status,
  orderNo,
  itemNo,
  timeoutMs = 20_000,
} = {}) {
  const url = toUrl(API_ENDPOINT, {
    ver: "4.0",
    mode: "getOrderList",
    aid: String(apiKey || "").trim(),
    id: String(memberId || "").trim(),
    sId: String(sessionId || "").trim(),
    for: String(orderFor || "buy").trim() || "buy",
    om: "json",
    day: Math.max(1, Math.min(365, Number(day) || 30)),
    pg: Math.max(1, Number(page) || 1),
    ic: Math.max(1, Math.min(100, Number(pageSize) || 20)),
    st: String(status || "").trim() || undefined,
    no: String(orderNo || "").trim() || undefined,
    itemNo: String(itemNo || "").trim() || undefined,
  });
  const response = await fetchText(url, { timeoutMs });
  if (!response.ok || /<html|<!doctype/i.test(response.text || "")) {
    const error = new Error("domeggook_private_getOrderList_failed");
    error.details = String(response.text || "").slice(0, 600);
    throw error;
  }
  return parseResponse(response.text, "domeggook_private_getOrderList");
}

export async function domeggookPrivateApiCreateOrder({
  apiKey,
  memberId,
  sessionId,
  receipt = 0,
  itemEntries = {},
  deliinfo = "",
  alliance = "",
  timeoutMs = 30_000,
} = {}) {
  const body = new URLSearchParams({
    ver: "4.3",
    mode: "setOrder",
    aid: String(apiKey || "").trim(),
    id: String(memberId || "").trim(),
    sId: String(sessionId || "").trim(),
    receipt: String(Number(receipt) === 1 ? 1 : 0),
    ie: "utf-8",
    oe: "utf-8",
    om: "json",
    deliinfo: String(deliinfo || "").trim(),
  });
  const allianceText = String(alliance || "").trim();
  if (allianceText) body.set("alliance", allianceText);
  for (const [key, value] of Object.entries(itemEntries || {})) {
    const itemNo = String(key || "").trim();
    const itemValue = String(value || "").trim();
    if (!itemNo || !itemValue) continue;
    body.set(`item[${itemNo}]`, itemValue);
  }

  const response = await fetchText(new URL(API_ENDPOINT), {
    method: "POST",
    body,
    timeoutMs,
  });
  if (!response.ok || /<html|<!doctype/i.test(response.text || "")) {
    const error = new Error("domeggook_private_setOrder_failed");
    error.details = String(response.text || "").slice(0, 600);
    throw error;
  }
  return parseResponse(response.text, "domeggook_private_setOrder");
}

export function normalizeDomeggookPrivateOrderList(raw = {}) {
  const header = raw?.header && typeof raw.header === "object" ? raw.header : {};
  const sourceItems = Array.isArray(raw?.items)
    ? raw.items
    : raw?.items && typeof raw.items === "object"
      ? Object.values(raw.items)
      : [];
  const items = sourceItems
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      orderNo: String(row.orderNo || "").trim(),
      orderUid: String(row.orderUid || "").trim(),
      status: String(row.status || "").trim(),
      itemNo: String(row.itemNo || "").trim(),
      itemTitle: String(row.itemTitle || "").trim(),
      market: String(row.market || "").trim(),
      orderQty: Number(row.orderQty || 0) || 0,
      orderAmt: Number(row.orderAmt || 0) || 0,
      orderAmtPay: Number(row.orderAmtPay || 0) || 0,
      date: String(row.date || "").trim(),
    }));
  return {
    header: {
      numberOfItems: Number(header.numberOfItems || 0) || 0,
      currentPage: Number(header.currentPage || 0) || 0,
      firstItem: Number(header.firstItem || 0) || 0,
      lastItem: Number(header.lastItem || 0) || 0,
      itemsPerPage: Number(header.itemsPerPage || 0) || 0,
      numberOfPages: Number(header.numberOfPages || 0) || 0,
    },
    items,
    raw,
  };
}

export function normalizeDomeggookPrivateCreateOrder(raw = {}) {
  const sourceOrders = Array.isArray(raw?.order)
    ? raw.order
    : raw?.order && typeof raw.order === "object"
      ? [raw.order]
      : [];
  return {
    result: String(raw?.result || "").trim(),
    orders: sourceOrders
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        orderNo: String(row.orderNo || "").trim(),
        itemNo: String(row.itemNo || "").trim(),
        getName: String(row.getName || "").trim(),
      })),
    raw,
  };
}
