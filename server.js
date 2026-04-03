// server.js (ESM)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runUploadFromUrl } from "./src/pipeline/runUploadFromUrl.js";
import { previewUploadFromUrl } from "./src/pipeline/previewUploadFromUrl.js";
import { evaluateQcGate } from "./src/pipeline/qcGate.js";
import { parseProductFromDomaeqq } from "./src/sources/domaeqq/parseProductFromDomaeqq.js";
import { classifyUrl } from "./src/utils/urlFilter.js";
import { computePrice } from "./src/utils/price.js";
import { extractImageUrls } from "./src/utils/contentImages.js";
import { resolveDisplayCategoryCode } from "./src/utils/categoryMap.js";
import {
  suggestTitlesHybrid,
  extractKeywordCandidates,
  pickProductHead,
} from "./src/utils/titleSuggest.js";
import {
  initDb,
  createUser,
  verifyUser,
  createSession,
  destroySession,
  getUserBySession,
  updateSettings,
  findDuplicateUpload,
  recordUploadedProduct,
  listUploadedProducts,
  listUsersWithSettings,
  getUploadedProductById,
  getUploadedProductBySourceUrl,
  getUploadedProductBySellerProductId,
  updateUploadedProductById,
  createMarketingLink,
  listMarketingLinks,
  listMarketingClicksBySlug,
  getMarketingLinkBySlug,
  recordMarketingClick,
} from "./src/server/storage_sqlite.js";
import { exportOrdersToDomeme } from "./src/pipeline/exportOrdersToDomeme.js";
import { uploadVendorPurchaseExcel } from "./src/pipeline/uploadVendorPurchaseExcel.js";
import { createDomeggookOrderForCoupangOrder } from "./src/pipeline/createDomeggookOrder.js";
import {
  listOrders,
  getOrderById,
  mergeOrderDataById,
  refreshShippingStatusesFromCoupang,
  upsertCoupangOrderSheet,
} from "./src/server/orders_sqlite.js";
import { runtimeState } from "./src/server/runtime_state.js";
import {
  DOMEME_STORAGE_STATE_PATH,
  DOMEGGOOK_STORAGE_STATE_PATH,
} from "./src/config/paths.js";
import { spawn } from "node:child_process";
import { getSellerProduct } from "./src/coupang/api/getSellerProduct.js";
import { getSellerProductHistories } from "./src/coupang/api/getSellerProductHistories.js";
import { acknowledgeOrderSheets } from "./src/coupang/api/acknowledgeOrderSheets.js";
import { getOrderSheetByShipmentBoxId } from "./src/coupang/api/getOrderSheetByShipmentBoxId.js";
import { uploadOrderInvoices } from "./src/coupang/api/uploadOrderInvoices.js";
import { deleteSellerProduct } from "./src/coupang/api/deleteSellerProduct.js";
import { parseCoupangJson } from "./src/coupang/parseJson.js";
import {
  listRecommendations,
  listSavedRecommendations,
  saveRecommendationForUser,
  removeSavedRecommendationForUser,
  refreshRecommendationsForUser,
} from "./src/server/recommendations.js";
import {
  domeggookPrivateApiGetOrderList,
  domeggookPrivateApiGetOrderView,
  domeggookPrivateApiGetMyAsset,
  domeggookPrivateApiLogin,
  normalizeDomeggookPrivateAsset,
  normalizeDomeggookPrivateOrderList,
  normalizeDomeggookPrivateOrderView,
  resolveDomeggookPrivateCredentials,
} from "./src/utils/domeggook_private_api.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
const PUBLIC_DIR = path.join(process.cwd(), "public");
const PUBLIC_APP_DIR = path.join(PUBLIC_DIR, "app");
const OUT_DIR = path.join(process.cwd(), "out");

// ✅ DB 초기화
await initDb();

// ✅ out 폴더(이미지 파일) 정적 서빙
app.use(
  "/couplus-out",
  express.static(OUT_DIR),
);
app.use("/tmp", express.static(OUT_DIR)); // /tmp/tmp_main.jpg 같은 형태로도 접근 가능
app.use(
  "/app",
  (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    next();
  },
  express.static(PUBLIC_APP_DIR),
);
app.use(express.static(PUBLIC_DIR));

const PORT = Number(process.env.PORT || 3000);

const TOKENS_PATH =
  process.env.FRIEND_TOKENS_PATH ||
  path.join(process.cwd(), "friend_tokens.json");

const SERVER_STARTED_AT = new Date().toISOString();
const PACKAGE_JSON_PATH = path.join(process.cwd(), "package.json");
const GIT_DIR = path.join(process.cwd(), ".git");
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];
const DATA_DIR = (() => {
  const override = String(process.env.COUPLEPHANT_DATA_DIR || "").trim();
  return override ? path.resolve(override) : path.join(process.cwd(), "data");
})();
const UPLOAD_HISTORY_PATH = path.join(DATA_DIR, "upload_history.json");
const UPLOAD_HISTORY_LIMIT = 200;
const ECON_AUTH_PATH = path.join(DATA_DIR, 'econ_auth.json');
const ECON_PROGRESS_PATH = path.join(DATA_DIR, 'econ_progress.json');
const INSTAGRAM_UPLOADS_DIR = path.join(DATA_DIR, "instagram_uploads");

fs.mkdirSync(INSTAGRAM_UPLOADS_DIR, { recursive: true });

function getUserPurchaseLogs(userId, limit = 20) {
  const key = String(userId || "").trim();
  if (!key) return [];
  const logs = runtimeState.purchaseLogs.get(key) || [];
  return Array.isArray(logs) ? logs.slice(0, Math.max(1, Number(limit) || 20)) : [];
}

function appendUserPurchaseLog(userId, entry = {}) {
  const key = String(userId || "").trim();
  if (!key) return;
  const prev = getUserPurchaseLogs(key, 50);
  const next = [
    {
      at: new Date().toISOString(),
      ...entry,
    },
    ...prev,
  ].slice(0, 50);
  runtimeState.purchaseLogs.set(key, next);
}

function findLatestPurchaseLogByOrderId(userId, orderId) {
  const target = String(orderId || "").trim();
  if (!target) return null;
  const logs = getUserPurchaseLogs(userId, 50);
  return (
    logs.find((row) => String(row?.orderId || "").trim() === target) || null
  );
}

function buildPayUrlsFromLogs(logs = []) {
  const out = {};
  let index = 0;
  for (const row of logs) {
    const payUrl = String(row?.payUrl || "").trim();
    if (!payUrl) continue;
    index += 1;
    const vendor = String(row?.vendor || "vendor").trim() || "vendor";
    const at = String(row?.at || "").trim();
    const label = `${index}. ${vendor}${at ? ` · ${at.slice(0, 16).replace("T", " ")}` : ""}`;
    out[label] = payUrl;
  }
  return out;
}

function resolveStorageStatePath(settings = {}, vendor = "") {
  const v = String(vendor || "").trim().toLowerCase();
  if (v === "domeme") {
    return String(settings.domemeStorageStatePath || DOMEME_STORAGE_STATE_PATH || "").trim();
  }
  if (v === "domeggook") {
    return String(settings.domeggookStorageStatePath || DOMEGGOOK_STORAGE_STATE_PATH || "").trim();
  }
  return "";
}

app.use(
  "/instagram_uploads",
  express.static(INSTAGRAM_UPLOADS_DIR, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  }),
);

function isHttpUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

function log(...args) {
  console.log("[server]", new Date().toISOString(), ...args);
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    ),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getForwardedClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const candidate = forwarded || String(req.ip || "").trim();
  if (!candidate) return "127.0.0.1";
  if (candidate === "::1") return "127.0.0.1";
  if (candidate.startsWith("::ffff:")) return candidate.slice(7).trim() || "127.0.0.1";
  return candidate;
}

function withTimeout(promise, ms, label = "timeout") {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1000, Number(ms) || 1000));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function enrichPreviewForClient(previewRaw, settings = {}) {
  if (!previewRaw || typeof previewRaw !== "object") return previewRaw;
  const preview = JSON.parse(JSON.stringify(previewRaw));
  const draft = preview?.draft && typeof preview.draft === "object" ? preview.draft : {};
  const inspect = preview?.preview && typeof preview.preview === "object" ? preview.preview : {};

  const detailImages = Array.isArray(inspect.contentImagesFiltered)
    ? inspect.contentImagesFiltered.filter((u) => isHttpUrl(u))
    : [];
  const images = uniqueStrings([draft.imageUrl, ...detailImages]);
  const options = Array.isArray(draft.options) ? draft.options : [];
  const minimumOrderQtyRaw =
    inspect?.minimumOrderQty ??
    inspect?.purchaseConstraints?.minimumOrderQty ??
    draft?.purchaseConstraints?.minimumOrderQty;
  const minimumOrderQty =
    Number.isFinite(Number(minimumOrderQtyRaw)) && Number(minimumOrderQtyRaw) > 0
      ? Number(minimumOrderQtyRaw)
      : 1;
  const sourcePrice = Number(draft.price);
  const finalPrice = computePrice(draft.price, {
    rate: settings.marginRate,
    add: settings.marginAdd,
    min: settings.priceMin,
    roundUnit: settings.roundUnit,
  });

  preview.computed = {
    ...(preview?.computed && typeof preview.computed === "object" ? preview.computed : {}),
    sourcePrice: Number.isFinite(sourcePrice) ? sourcePrice : draft.price ?? null,
    finalPrice: Number.isFinite(Number(finalPrice)) ? Number(finalPrice) : finalPrice ?? null,
    images,
    optionsCount: options.length,
    minimumOrderQty,
    purchaseConstraints: {
      minimumOrderQty,
    },
  };

  const overrideCategoryCode = toPositiveIntOrNull(settings?.categoryOverrideCode);
  const resolvedCategoryCode = overrideCategoryCode || resolveDisplayCategoryCode({
    title: draft.title,
    categoryText: draft.categoryText,
    fallback: 0,
  });
  preview.category = {
    usedCode: Number.isFinite(Number(resolvedCategoryCode)) && Number(resolvedCategoryCode) > 0
      ? String(Math.floor(Number(resolvedCategoryCode)))
      : "",
    requestedCode: overrideCategoryCode ? String(overrideCategoryCode) : "",
    source: overrideCategoryCode ? "override" : "rule",
  };

  if (!Array.isArray(preview.options) || preview.options.length === 0) {
    preview.options = options;
  }

  if (!preview.url) {
    preview.url = String(preview.sourceUrl || draft.sourceUrl || inspect.sourceUrl || "").trim();
  }

  const hasSuggestions =
    preview?.titleSuggestions &&
    Array.isArray(preview.titleSuggestions.suggestions) &&
    preview.titleSuggestions.suggestions.length > 0;

  if (!hasSuggestions) {
    const baseTitle = String(draft.title || "").trim();
    if (baseTitle) {
      try {
        const suggested = await suggestTitlesHybrid({
          title: baseTitle,
          maxLen: 15,
          useNaver: false,
        });
        if (
          suggested?.ok &&
          Array.isArray(suggested.suggestions) &&
          suggested.suggestions.length > 0
        ) {
          preview.titleSuggestions = suggested;
        }
      } catch {
        // ignore suggestion failures and fallback below
      }
      if (
        !preview?.titleSuggestions ||
        !Array.isArray(preview.titleSuggestions.suggestions) ||
        preview.titleSuggestions.suggestions.length === 0
      ) {
        preview.titleSuggestions = {
          ok: true,
          source: "fallback",
          suggestions: [{ title: baseTitle.slice(0, 15), keywords: [], score: 0 }],
        };
      }
    }
  }

  return preview;
}

function loadUploadHistory() {
  try {
    if (!fs.existsSync(UPLOAD_HISTORY_PATH)) return [];
    const raw = fs.readFileSync(UPLOAD_HISTORY_PATH, "utf-8");
    const json = JSON.parse(raw || "[]");
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

function saveUploadHistory(list) {
  try {
    const dir = path.dirname(UPLOAD_HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UPLOAD_HISTORY_PATH, JSON.stringify(list, null, 2));
  } catch {}
}

function appendUploadHistory(entry) {
  const list = loadUploadHistory();
  list.unshift(entry);
  if (list.length > UPLOAD_HISTORY_LIMIT) list.length = UPLOAD_HISTORY_LIMIT;
  saveUploadHistory(list);
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  } catch {}
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256');
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function createEconToken() {
  return crypto.randomBytes(24).toString('hex');
}

const econSessions = new Map();

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf-8");
    const json = JSON.parse(raw);
    return String(json.version || "").trim();
  } catch {
    return "";
  }
}

function readGitInfo() {
  try {
    const headPath = path.join(GIT_DIR, "HEAD");
    if (!fs.existsSync(headPath)) return {};
    const head = fs.readFileSync(headPath, "utf-8").trim();
    let sha = "";
    if (head.startsWith("ref:")) {
      const ref = head.replace("ref:", "").trim();
      const refPath = path.join(GIT_DIR, ref);
      if (fs.existsSync(refPath)) {
        sha = fs.readFileSync(refPath, "utf-8").trim();
      }
    } else {
      sha = head;
    }

    let codeUpdatedAt = "";
    const logPath = path.join(GIT_DIR, "logs", "HEAD");
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      const last = lines[lines.length - 1] || "";
      const parts = last.split(" ");
      const ts = Number(parts[parts.length - 2]);
      if (Number.isFinite(ts)) {
        codeUpdatedAt = new Date(ts * 1000).toISOString();
      }
    }

    return {
      gitSha: sha ? sha.slice(0, 8) : "",
      codeUpdatedAt,
    };
  } catch {
    return {};
  }
}

async function getPublicIp() {
  for (const url of IP_CHECK_URLS) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text && text.length < 80) return text;
    } catch {}
  }
  return "";
}

function readTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return [];
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeTokens(arr) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(arr, null, 2), "utf-8");
}

function upsertToken({ kakao_user_id, refresh_token, scope }) {
  const list = readTokens();
  const idx = list.findIndex(
    (x) => String(x.kakao_user_id) === String(kakao_user_id),
  );
  const row = {
    kakao_user_id,
    refresh_token,
    scope: scope || "",
    saved_at: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  writeTokens(list);
  return row;
}

function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

let uploadInProgress = false;

function getSessionToken(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(/session=([^;]+)/);
  return m ? m[1] : null;
}

async function authRequired(req, res, next) {
  const token = getSessionToken(req);
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.user = user;
  next();
}

// ✅ 외부에서 연결 확인용
app.get("/health", (req, res) => res.type("text").send("OK"));
app.get("/api/version", (req, res) => {
  const version = readPackageVersion();
  const git = readGitInfo();
  return res.json({
    ok: true,
    version,
    gitSha: git.gitSha || "",
    codeUpdatedAt: git.codeUpdatedAt || "",
    serverStartedAt: SERVER_STARTED_AT,
    now: new Date().toISOString(),
  });
});

app.get("/api/ip", async (req, res) => {
  const ip = await getPublicIp().catch(() => "");
  return res.json({ ok: true, ip: ip || "" });
});

// ✅ 계정: 회원가입
app.post("/api/signup", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "").trim();
    if (!email || !password) return res.status(400).json({ ok: false, error: "missing fields" });
    const user = await createUser({ email, password });
    const token = await createSession(user.id);
    res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ ok: true, user });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 계정: 로그인
app.post("/api/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  if (!email || !password) return res.status(400).json({ ok: false, error: "missing fields" });
  const user = await verifyUser({ email, password });
  if (!user) return res.status(401).json({ ok: false, error: "invalid credentials" });
  const token = await createSession(user.id);
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; SameSite=Lax`);
  return res.json({ ok: true, user });
});

// ✅ 계정: 로그아웃
app.post("/api/logout", async (req, res) => {
  const token = getSessionToken(req);
  if (token) await destroySession(token);
  res.setHeader("Set-Cookie", "session=; Max-Age=0; Path=/; SameSite=Lax");
  return res.json({ ok: true });
});

// ✅ 계정: 내 정보
app.get("/api/me", authRequired, (req, res) => {
  const email = req.user.email || "";
  return res.json({ ok: true, user: { id: req.user.id, email } });
});

// ✅ 설정: 조회/저장
app.get("/api/settings", authRequired, (req, res) => {
  return res.json({ ok: true, settings: req.user.settings || {} });
});

app.post("/api/settings", authRequired, async (req, res) => {
  try {
    const next = req.body || {};
    const saved = await updateSettings(req.user.id, next);
    return res.json({ ok: true, settings: saved });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- Econ auth/progress APIs for /econ web app ---
function getEconBearerToken(req) {
  const h = String(req.headers?.authorization || '').trim();
  if (!h.toLowerCase().startsWith('bearer ')) return '';
  return h.slice(7).trim();
}

function getEconSession(req) {
  const token = getEconBearerToken(req);
  if (!token) return null;
  return econSessions.get(token) || null;
}

app.post('/auth/signup', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '').trim();
    if (!email || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!email.includes('@')) return res.status(400).json({ ok: false, error: 'invalid_email' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'password_too_short' });

    const users = readJsonFileSafe(ECON_AUTH_PATH, { users: [] });
    const list = Array.isArray(users.users) ? users.users : [];
    if (list.some((u) => String(u.email || '').toLowerCase() === email)) {
      return res.status(409).json({ ok: false, error: 'email_exists' });
    }

    const id = crypto.randomUUID();
    const hp = hashPassword(password);
    list.push({ id, email, salt: hp.salt, hash: hp.hash, createdAt: new Date().toISOString() });
    writeJsonFileSafe(ECON_AUTH_PATH, { users: list });

    const token = createEconToken();
    econSessions.set(token, { userId: id, email });
    return res.json({ ok: true, token, user: { id, email } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '').trim();
    if (!email || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const users = readJsonFileSafe(ECON_AUTH_PATH, { users: [] });
    const list = Array.isArray(users.users) ? users.users : [];
    const user = list.find((u) => String(u.email || '').toLowerCase() === email);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid_credentials' });

    const hp = hashPassword(password, user.salt);
    if (hp.hash !== user.hash) return res.status(401).json({ ok: false, error: 'invalid_credentials' });

    const token = createEconToken();
    econSessions.set(token, { userId: user.id, email: user.email });
    return res.json({ ok: true, token, user: { id: user.id, email: user.email } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/progress', async (req, res) => {
  const session = getEconSession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const db = readJsonFileSafe(ECON_PROGRESS_PATH, { progressByUser: {} });
  const progressByUser = db.progressByUser && typeof db.progressByUser === 'object' ? db.progressByUser : {};
  return res.json({ ok: true, progress: progressByUser[session.userId] || null });
});

app.put('/progress', async (req, res) => {
  const session = getEconSession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const payload = req.body?.progress;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid_progress' });
  }

  const db = readJsonFileSafe(ECON_PROGRESS_PATH, { progressByUser: {} });
  const progressByUser = db.progressByUser && typeof db.progressByUser === 'object' ? db.progressByUser : {};
  progressByUser[session.userId] = payload;
  writeJsonFileSafe(ECON_PROGRESS_PATH, { progressByUser });
  return res.json({ ok: true });
});

app.delete('/auth/account', async (req, res) => {
  try {
    const session = getEconSession(req);
    if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const users = readJsonFileSafe(ECON_AUTH_PATH, { users: [] });
    const list = Array.isArray(users.users) ? users.users : [];
    const filtered = list.filter((u) => String(u.id || '') !== String(session.userId));
    writeJsonFileSafe(ECON_AUTH_PATH, { users: filtered });

    const db = readJsonFileSafe(ECON_PROGRESS_PATH, { progressByUser: {} });
    const progressByUser = db.progressByUser && typeof db.progressByUser === 'object' ? db.progressByUser : {};
    if (Object.prototype.hasOwnProperty.call(progressByUser, session.userId)) {
      delete progressByUser[session.userId];
      writeJsonFileSafe(ECON_PROGRESS_PATH, { progressByUser });
    }

    for (const [token, s] of econSessions.entries()) {
      if (String(s?.userId || '') === String(session.userId)) {
        econSessions.delete(token);
      }
    }

    return res.json({ ok: true, deleted: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// image proxy for Flutter web (avoid hotlink/CORS issues)
app.get('/api/image-proxy', async (req, res) => {
  try {
    const raw = String(req.query?.url || '').trim();
    const download = String(req.query?.download || '').trim() === '1';
    const rawFilename = String(req.query?.filename || '').trim();
    if (!isHttpUrl(raw)) {
      return res.status(400).json({ ok: false, error: 'invalid_url' });
    }

    const u = new URL(raw);
    const referer = `${u.protocol}//${u.host}`;
    const upstream = await fetch(raw, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Referer: referer,
      },
    });

    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: 'upstream_failed', status: upstream.status });
    }

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (download) {
      const filename = rawFilename
        .replace(/[^\w.\-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120) || 'image.bin';
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    const ab = await upstream.arrayBuffer();
    return res.status(200).send(Buffer.from(ab));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- Backward-compatible endpoints for Flutter /app runtime ---
const legacyJobs = new Map();
const recommendationRunByUser = new Map();
const uploadBulkRunByUser = new Map();

function initLegacyJob(kind, seedProgress = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    kind,
    status: "running",
    createdAt: now,
    updatedAt: now,
    progress: {
      stage: "queued",
      ...seedProgress,
    },
  };
  legacyJobs.set(id, job);
  return job;
}

function patchLegacyJob(job, patch = {}) {
  if (!job || typeof job !== "object") return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  legacyJobs.set(job.id, job);
}

function compactLegacyJob(job) {
  if (!job || typeof job !== "object") return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress && typeof job.progress === "object" ? job.progress : {},
    errorMessage: job.errorMessage || null,
    stopRequested: Boolean(job.stopRequested),
  };
}

function normalizeRecommendationJobProgressPercent(progress = {}, fallbackTarget = 80) {
  const stage = String(progress?.stage || "").trim().toLowerCase();
  if (!stage) return null;

  const toInt = (v, d = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.floor(n);
  };
  const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));

  if (stage === "queued") return 1;
  if (stage === "start") return 3;
  if (stage === "refresh_start") return 8;
  if (stage === "done" || stage === "done_empty") return 100;
  if (stage === "source_switch_playwright" || stage === "relax_exclude") return 46;
  if (stage === "rescue_playwright" || stage === "fill_rescue_playwright") return 72;
  if (stage === "rescue_review_mode" || stage === "fill_rescue_review_mode") return 84;
  if (stage === "rate_limited") return 40;

  if (stage === "collect") {
    const keywordIndex = toInt(progress?.keywordIndex, 0);
    const keywordTotal = toInt(progress?.keywordTotal, 0);
    if (keywordTotal > 0) {
      const ratio = clamp(Math.round((keywordIndex / keywordTotal) * 100), 0, 100) / 100;
      return clamp(Math.round(10 + ratio * 35), 10, 45);
    }
    return 24;
  }

  if (stage === "validate") {
    const target = Math.max(1, toInt(progress?.target ?? progress?.targetCount, fallbackTarget));
    const kept = Math.max(0, toInt(progress?.kept, 0));
    const validated = Math.max(0, toInt(progress?.validated, 0));
    const keepRatio = target > 0 ? Math.min(1, kept / target) : 0;
    const validateRatio = Math.min(1, validated / Math.max(6, target * 2));
    const ratio = Math.max(keepRatio, validateRatio);
    return clamp(Math.round(45 + ratio * 50), 45, 95);
  }

  return null;
}

function normalizeUploadBulkJobProgressPercent(progress = {}) {
  const stage = String(progress?.stage || "").trim().toLowerCase();
  if (!stage) return null;

  const toInt = (v, d = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.floor(n);
  };
  const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));

  if (stage === "queued") return 1;
  if (stage === "start") return 3;
  if (stage === "stopping") return 99;
  if (stage === "done" || stage === "stopped") return 100;

  if (stage === "uploading") {
    const total = Math.max(1, toInt(progress?.total || 0, 1));
    const done = Math.max(0, toInt(progress?.doneCount || 0));
    const ratio = Math.min(1, done / total);
    return clamp(Math.round(8 + ratio * 90), 8, 98);
  }

  return null;
}

const RECOMMENDATION_KEYWORD_POOLS = Object.freeze({
  carStorage: [
    "차량용 수납함",
    "차량 틈새 수납",
    "차량 시트백 수납",
    "차량 트렁크 정리함",
    "차량 트렁크 정리망",
    "차량 도어포켓 정리",
    "차량 콘솔 정리",
    "차량 컵홀더 수납",
    "차량 컵홀더 트레이",
    "차량 선바이저 포켓",
    "차량 헤드레스트 훅",
    "차량 우산 거치대",
  ],
  carMount: [
    "차량 휴대폰 거치대",
    "차량 송풍구 거치대",
    "차량 대시보드 거치대",
    "차량 룸미러 거치대",
    "차량 태블릿 거치대",
    "차량 헤드레스트 거치대",
    "차량 마그네틱 거치대",
    "차량 컵홀더 거치대",
    "차량 스마트폰 클립",
    "차량 내비 거치대",
  ],
  carCable: [
    "차량 케이블 정리",
    "차량 선정리 클립",
    "차량 케이블 클립",
    "차량 선고정 홀더",
    "차량 충전선 고정",
    "차량 케이블 타이",
    "차량 USB 정리 케이스",
    "차량 콘솔 케이블 홀더",
    "차량 충전 케이블 홀더",
    "차량 데스크 케이블 홀더",
  ],
  petWalk: [
    "강아지 하네스",
    "강아지 리드줄",
    "강아지 산책줄",
    "강아지 목줄",
    "반려동물 배변봉투",
    "반려동물 배변백 홀더",
    "반려동물 휴대 물병",
    "반려동물 이동가방",
    "반려동물 카시트",
    "강아지 산책 파우치",
  ],
  petGroom: [
    "펫 브러쉬",
    "고양이 빗",
    "반려동물 목욕 브러쉬",
    "반려동물 털제거 롤러",
    "반려동물 발 세정 컵",
    "반려동물 발수건",
    "반려동물 발톱 정리",
    "강아지 목욕 장갑",
    "고양이 털관리 브러쉬",
    "반려동물 털빗",
  ],
  petToy: [
    "강아지 장난감",
    "강아지 노즈워크 장난감",
    "고양이 장난감",
    "고양이 낚싯대 장난감",
    "고양이 스크래쳐",
    "반려동물 공 장난감",
    "반려동물 터그 장난감",
    "반려동물 씹는 장난감",
    "고양이 터널 장난감",
    "반려동물 장난감 보관함",
  ],
  kitchenStorage: [
    "싱크대 정리 선반",
    "주방 서랍 정리",
    "냉장고 정리 트레이",
    "냉장고 수납 박스",
    "주방 양념 정리대",
    "주방 싱크대 수납",
    "주방 수세미 거치대",
    "주방 행주 걸이",
    "주방 다용도 걸이",
    "주방 도어 포켓 정리",
  ],
  bathroomStorage: [
    "욕실 수납 선반",
    "욕실 칫솔 꽂이",
    "욕실 샤워 선반",
    "욕실 코너 선반",
    "욕실 드라이기 거치대",
    "욕실 비누 받침",
    "욕실 타월 걸이",
    "욕실 흡착 수납",
    "욕실 세면대 정리",
    "욕실 다용도 후크",
  ],
  laundryStorage: [
    "세탁실 정리함",
    "세탁기 틈새 수납",
    "세제 정리함",
    "빨래바구니",
    "빨래망 보관함",
    "세탁실 선반",
    "건조기 선반",
    "세탁소품 정리",
    "다리미판 거치대",
    "세탁실 다용도 걸이",
  ],
  closetStorage: [
    "옷장 수납함",
    "압축 수납팩",
    "서랍 칸막이",
    "서랍 정리 트레이",
    "옷걸이 정리",
    "이불 수납 가방",
    "패딩 압축팩",
    "신발장 정리대",
    "악세사리 정리함",
    "모자 정리 걸이",
  ],
  entrywayStorage: [
    "현관 우산꽂이",
    "현관 정리 선반",
    "신발장 정리대",
    "신발 정리함",
    "현관 키 정리함",
    "현관 도어 후크",
    "슬리퍼 정리대",
    "현관 마스크 보관함",
    "현관 소품 트레이",
    "현관 수납 박스",
  ],
  livingStorage: [
    "거실 리모컨 정리함",
    "거실 소파 틈새 수납",
    "거실 다용도 바구니",
    "테이블 정리 트레이",
    "티비 주변 정리함",
    "거실 멀티탭 정리",
    "거실 수납 바구니",
    "소파 팔걸이 정리",
    "리빙박스 수납",
    "거실 케이블 정리",
  ],
  cleaningTools: [
    "청소도구 거치대",
    "밀대 걸이",
    "빗자루 정리대",
    "청소포 보관함",
    "테이프 클리너 보관",
    "먼지떨이 정리",
    "청소솔 보관함",
    "다용도 브러쉬 세트",
    "걸레 정리함",
    "청소용 장갑 보관",
  ],
  deskCable: [
    "멀티탭 정리함",
    "전선 정리함",
    "데스크 케이블 홀더",
    "케이블 클립",
    "USB 수납 케이스",
    "충전 케이블 정리",
    "모니터 케이블 정리",
    "책상 선정리",
    "데스크 선반 정리",
    "케이블 타이",
  ],
  deskStorage: [
    "책상 수납 정리",
    "모니터 받침대 수납",
    "노트북 거치대",
    "데스크 오거나이저",
    "펜꽂이 정리함",
    "문서 정리 트레이",
    "키보드 수납 받침",
    "마우스패드 정리",
    "책상 서랍함",
    "데스크 소품 정리",
  ],
  travelPouch: [
    "여행용 파우치 세트",
    "캐리어 정리 파우치",
    "압축 파우치",
    "세면도구 파우치",
    "의류 정리 파우치",
    "여권 지갑 파우치",
    "케이블 파우치",
    "신발 파우치",
    "여행용 수납백",
    "캐리어 소분 파우치",
  ],
  campingStorage: [
    "캠핑 수납 박스",
    "캠핑 랜턴 걸이",
    "차박 수납함",
    "캠핑 조리도구 정리",
    "캠핑 테이블 정리망",
    "캠핑 행잉 오거나이저",
    "캠핑 멀티 파우치",
    "아웃도어 수납 가방",
    "캠핑 장비 정리함",
    "차박 트렁크 정리",
  ],
  shortformWinners: [
    "차량 틈새 수납",
    "차량 컵홀더 트레이",
    "펫 브러쉬",
    "반려동물 발 세정 컵",
    "냉장고 정리 트레이",
    "싱크대 정리 선반",
    "욕실 코너 선반",
    "세탁기 틈새 수납",
    "서랍 칸막이",
    "압축 수납팩",
    "청소도구 거치대",
    "밀대 걸이",
    "멀티탭 정리함",
    "데스크 케이블 홀더",
    "캐리어 정리 파우치",
  ],
  trendLivingNow: [
    "봄맞이 정리함",
    "원룸 틈새 수납",
    "신학기 책상 정리",
    "데스크 오거나이저",
    "냉장고 자석 선반",
    "싱크대 슬라이드 선반",
    "세탁기 틈새 선반",
    "욕실 틈새 수납",
    "현관 자석 선반",
    "현관 신발 정리",
  ],
  trendOutingNow: [
    "피크닉 보냉백",
    "차량 트렁크 정리",
    "차량 컵홀더 트레이",
    "차량 뒷좌석 테이블",
    "반려동물 산책 파우치",
    "반려동물 발 세정 컵",
    "캠핑 행잉 오거나이저",
    "차박 수납함",
    "캐리어 정리 파우치",
    "아웃도어 수납 가방",
  ],
});

function mergeRecommendationKeywords(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    const list = Array.isArray(group) ? group : [];
    for (const raw of list) {
      const keyword = String(raw || "").trim();
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      out.push(keyword);
    }
  }
  return out;
}

const RECOMMENDATION_CATEGORY_PRESETS = Object.freeze([
  {
    key: "all",
    label: "전체 (기본)",
    description: "기본 키워드셋 전체 사용",
    keywords: [],
  },
  {
    key: "shortform_winners",
    label: "인스타 숏폼 반응형",
    description: "전후 비교/실사용 시연이 쉬운 생활템",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.shortformWinners),
  },
  {
    key: "trend_now",
    label: "네이버·쿠팡 시즌 키워드",
    description: "봄정리/신학기/나들이 시즌형 생활템",
    keywords: mergeRecommendationKeywords(
      RECOMMENDATION_KEYWORD_POOLS.trendLivingNow,
      RECOMMENDATION_KEYWORD_POOLS.trendOutingNow,
      RECOMMENDATION_KEYWORD_POOLS.shortformWinners,
    ),
  },
  {
    key: "spring_reset",
    label: "봄정리·신학기",
    description: "원룸/책상/냉장고/세탁실 리셋형",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.trendLivingNow),
  },
  {
    key: "outing_ready",
    label: "나들이·차량·반려외출",
    description: "피크닉/차량 수납/반려 외출 준비형",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.trendOutingNow),
  },
  {
    key: "car",
    label: "차량용 전체",
    description: "차량 수납/거치/선정리 통합",
    keywords: mergeRecommendationKeywords(
      RECOMMENDATION_KEYWORD_POOLS.carStorage,
      RECOMMENDATION_KEYWORD_POOLS.carMount,
      RECOMMENDATION_KEYWORD_POOLS.carCable,
    ),
  },
  {
    key: "car_storage",
    label: "차량 수납",
    description: "트렁크/시트백/콘솔 정리",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.carStorage),
  },
  {
    key: "car_mount",
    label: "차량 거치",
    description: "휴대폰/태블릿 거치 위주",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.carMount),
  },
  {
    key: "car_cable",
    label: "차량 케이블 정리",
    description: "충전선/선고정/클립 위주",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.carCable),
  },
  {
    key: "pet",
    label: "반려동물 전체",
    description: "산책/그루밍/놀이 통합",
    keywords: mergeRecommendationKeywords(
      RECOMMENDATION_KEYWORD_POOLS.petWalk,
      RECOMMENDATION_KEYWORD_POOLS.petGroom,
      RECOMMENDATION_KEYWORD_POOLS.petToy,
    ),
  },
  {
    key: "pet_walk",
    label: "반려동물 산책",
    description: "하네스/리드줄/배변용품",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.petWalk),
  },
  {
    key: "pet_groom",
    label: "반려동물 그루밍",
    description: "브러쉬/털관리/목욕보조",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.petGroom),
  },
  {
    key: "pet_toy",
    label: "반려동물 장난감",
    description: "강아지/고양이 놀이용품",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.petToy),
  },
  {
    key: "home",
    label: "생활/수납 전체",
    description: "주방/욕실/세탁/옷장/현관/거실/청소",
    keywords: mergeRecommendationKeywords(
      RECOMMENDATION_KEYWORD_POOLS.kitchenStorage,
      RECOMMENDATION_KEYWORD_POOLS.bathroomStorage,
      RECOMMENDATION_KEYWORD_POOLS.laundryStorage,
      RECOMMENDATION_KEYWORD_POOLS.closetStorage,
      RECOMMENDATION_KEYWORD_POOLS.entrywayStorage,
      RECOMMENDATION_KEYWORD_POOLS.livingStorage,
      RECOMMENDATION_KEYWORD_POOLS.cleaningTools,
    ),
  },
  {
    key: "kitchen_storage",
    label: "주방 수납",
    description: "싱크대/냉장고/서랍 정리",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.kitchenStorage),
  },
  {
    key: "bathroom_storage",
    label: "욕실 수납",
    description: "욕실 선반/칫솔꽂이/타월걸이",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.bathroomStorage),
  },
  {
    key: "laundry_storage",
    label: "세탁실 정리",
    description: "세제/빨래/틈새수납",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.laundryStorage),
  },
  {
    key: "closet_storage",
    label: "옷장/서랍 정리",
    description: "압축팩/칸막이/보관함",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.closetStorage),
  },
  {
    key: "entryway_storage",
    label: "현관/신발장 정리",
    description: "우산꽂이/신발수납/도어후크",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.entrywayStorage),
  },
  {
    key: "living_storage",
    label: "거실 정리",
    description: "리모컨/소파/테이블 수납",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.livingStorage),
  },
  {
    key: "cleaning_tools",
    label: "청소도구 정리",
    description: "밀대/빗자루/브러쉬 거치",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.cleaningTools),
  },
  {
    key: "desk",
    label: "데스크/사무 전체",
    description: "케이블/책상수납 통합",
    keywords: mergeRecommendationKeywords(
      RECOMMENDATION_KEYWORD_POOLS.deskCable,
      RECOMMENDATION_KEYWORD_POOLS.deskStorage,
    ),
  },
  {
    key: "desk_cable",
    label: "데스크 케이블 정리",
    description: "멀티탭/전선/케이블클립",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.deskCable),
  },
  {
    key: "desk_storage",
    label: "책상 수납",
    description: "모니터받침/서랍/문서정리",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.deskStorage),
  },
  {
    key: "outdoor",
    label: "여행/캠핑 전체",
    description: "여행파우치/차박/캠핑수납 통합",
    keywords: mergeRecommendationKeywords(
      RECOMMENDATION_KEYWORD_POOLS.travelPouch,
      RECOMMENDATION_KEYWORD_POOLS.campingStorage,
    ),
  },
  {
    key: "travel_pouch",
    label: "여행 파우치",
    description: "캐리어/소분/압축 파우치",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.travelPouch),
  },
  {
    key: "camping_storage",
    label: "캠핑/차박 수납",
    description: "캠핑박스/행잉/트렁크 정리",
    keywords: mergeRecommendationKeywords(RECOMMENDATION_KEYWORD_POOLS.campingStorage),
  },
]);

const RECOMMENDATION_CATEGORY_PRESET_MAP = new Map(
  RECOMMENDATION_CATEGORY_PRESETS.map((row) => [row.key, row]),
);

function normalizeRecommendationCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function getRecommendationCategoryPreset(rawKey) {
  const key = normalizeRecommendationCategoryKey(rawKey);
  if (key && RECOMMENDATION_CATEGORY_PRESET_MAP.has(key)) {
    return RECOMMENDATION_CATEGORY_PRESET_MAP.get(key);
  }
  return RECOMMENDATION_CATEGORY_PRESET_MAP.get("all");
}

function listRecommendationCategoryPresets() {
  return RECOMMENDATION_CATEGORY_PRESETS.map((row) => ({
    key: row.key,
    label: row.label,
    description: row.description,
    keywords: [...row.keywords],
  }));
}

function parseRecommendationRunRequest(req) {
  const userSettings = req?.user?.settings || {};
  const categoryPreset = getRecommendationCategoryPreset(
    req.body?.categoryKey ?? req.body?.recommendationCategory,
  );
  const inputKeywords = normalizeStringList(req.body?.keywords, 30);
  const categoryKeywords = normalizeStringList(categoryPreset?.keywords || [], 30);
  const keywords =
    inputKeywords.length > 0
      ? inputKeywords
      : (categoryPreset?.key === "all" ? [] : categoryKeywords);
  const targetCount = Math.max(50, Math.min(100, Number(req.body?.targetCount || 80) || 80));
  const cooldownDays = Math.max(
    1,
    Math.min(60, Number(req.body?.cooldownDays || userSettings?.recommendationCooldownDays || 7) || 7),
  );
  const strictMode = parseBooleanFlag(
    req.body?.strictMode ?? req.body?.strict,
    false,
  );
  return {
    keywords,
    targetCount,
    cooldownDays,
    strictMode,
    categoryKey: categoryPreset?.key || "all",
    categoryLabel: categoryPreset?.label || "전체 (기본)",
    keywordSource:
      inputKeywords.length > 0
        ? "custom"
        : (categoryPreset?.key === "all" ? "default" : "category"),
  };
}

function buildRecommendationRunSettings(baseSettings = {}, { strictMode = false, targetCount = 80 } = {}) {
  const base =
    baseSettings && typeof baseSettings === "object" ? { ...baseSettings } : {};
  const resolvedStrictMode = parseBooleanFlag(strictMode, false);
  const resolvedTarget = Math.max(50, Math.min(100, Number(targetCount || 80) || 80));
  const runtimeFloorMs =
    resolvedTarget >= 90 ? 720_000 :
    resolvedTarget >= 80 ? 600_000 :
    resolvedTarget >= 70 ? 510_000 :
    420_000;
  const playwrightRetryBudgetFloor =
    resolvedTarget >= 90 ? 60 :
    resolvedTarget >= 80 ? 48 :
    resolvedTarget >= 70 ? 36 :
    24;
  const normalizedRuntimeMs = Number(base.recommendationMaxRuntimeMs);
  const normalizedRetryBudget = Number(base.recommendationPreviewPlaywrightRetryBudget);
  const mergedRuntimeMs = Number.isFinite(normalizedRuntimeMs)
    ? Math.max(runtimeFloorMs, Math.floor(normalizedRuntimeMs))
    : runtimeFloorMs;
  const mergedRetryBudget = Number.isFinite(normalizedRetryBudget)
    ? Math.max(playwrightRetryBudgetFloor, Math.floor(normalizedRetryBudget))
    : playwrightRetryBudgetFloor;
  const normalizedOpenApiTimeoutMs = Number(base.recommendationPreviewOpenApiTimeoutMs);
  const openApiTimeoutDefaultMs = resolvedTarget >= 80 ? 2600 : 3200;
  const mergedOpenApiTimeoutMs = Number.isFinite(normalizedOpenApiTimeoutMs)
    ? Math.max(1500, Math.min(9000, Math.floor(normalizedOpenApiTimeoutMs)))
    : openApiTimeoutDefaultMs;

  const baseOverrides = {
    recommendationDisablePreviewTimeout: false,
    recommendationDisablePreviewPlaywrightRetryBudget: false,
    recommendationDisablePreviewPlaywrightBudget: false,
    recommendationPreviewPlaywrightRetryBudget: mergedRetryBudget,
    recommendationPreviewOpenApiTimeoutMs: mergedOpenApiTimeoutMs,
    recommendationMaxRuntimeMs: mergedRuntimeMs,
  };

  if (resolvedStrictMode) {
    return {
      ...base,
      ...baseOverrides,
      recommendationStrictMode: true,
    };
  }

  return {
    ...base,
    ...baseOverrides,
    recommendationStrictMode: false,
    recommendationStrictImageMatch: false,
    recommendationPreviewStrictImageMatch: false,
    recommendationAllowQuickFallback: true,
    recommendationAllowRelaxedExclusion: true,
    recommendationAllowReviewModeRescue: true,
  };
}

function getRunningRecommendationJobForUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const jobId = recommendationRunByUser.get(uid);
  if (!jobId) return null;
  const job = legacyJobs.get(jobId);
  if (!job) {
    recommendationRunByUser.delete(uid);
    return null;
  }
  const status = String(job.status || "").toLowerCase();
  if (status === "running" || status === "queued") return job;
  recommendationRunByUser.delete(uid);
  return null;
}

function getRunningUploadBulkJobForUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const jobId = uploadBulkRunByUser.get(uid);
  if (!jobId) return null;
  const job = legacyJobs.get(jobId);
  if (!job) {
    uploadBulkRunByUser.delete(uid);
    return null;
  }
  const status = String(job.status || "").toLowerCase();
  if (status === "running" || status === "queued") return job;
  uploadBulkRunByUser.delete(uid);
  return null;
}

function normalizeBulkUploadJobRow({ url = "", outcome = null, error = "" } = {}) {
  const summarizeDetail = (detail = null) => {
    if (!detail || typeof detail !== "object") return null;
    const message = pickFirstNonEmpty(detail.message);
    const responseCode = pickFirstNonEmpty(detail.responseCode, detail.code);
    let firstErrorItem = "";
    const errorItems = Array.isArray(detail.errorItems) ? detail.errorItems : [];
    if (errorItems.length > 0) {
      const first = errorItems[0];
      if (first && typeof first === "object") {
        firstErrorItem = pickFirstNonEmpty(
          first.message,
          first.reason,
          first.fieldName,
          first.name,
          first.code,
        );
      } else {
        firstErrorItem = String(first || "").trim();
      }
    }
    const parts = [];
    if (message) parts.push(message);
    if (firstErrorItem) parts.push(firstErrorItem);
    if (!message && responseCode) parts.push(`code=${responseCode}`);
    const joined = parts.join(" / ").trim();
    if (!joined) return null;
    return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
  };

  const followUp =
    outcome?.result?.followUp && typeof outcome.result.followUp === "object"
      ? outcome.result.followUp
      : {};
  const productId = pickFirstNonEmpty(followUp.productId);
  const productUrl = pickFirstNonEmpty(
    followUp.productUrl,
    buildCoupangProductUrl(productId),
  );
  const hasOutcome = outcome && typeof outcome === "object";
  const skipped = hasOutcome ? Boolean(outcome?.skipped) : false;
  const ok = hasOutcome ? Boolean(outcome?.ok) : false;
  const rowError = String(error || outcome?.error || outcome?.result?.error || "").trim();
  const rowErrorDetail =
    summarizeDetail(outcome?.detail) || summarizeDetail(outcome?.result?.detail) || null;

  return {
    url,
    ok,
    skipped,
    skipReason: normalizeSkipReason(outcome),
    error: rowError || null,
    errorDetail: rowErrorDetail,
    sellerProductId: hasOutcome ? resolveOutcomeSellerProductId(outcome) : null,
    productId: productId || null,
    productUrl: productUrl || null,
    statusName: pickFirstNonEmpty(followUp.statusName) || null,
  };
}

function summarizeBulkUploadRows(items = [], force = false) {
  const rows = Array.isArray(items) ? items : [];
  return {
    total: rows.length,
    uploaded: rows.filter((x) => x?.ok === true && x?.skipped !== true).length,
    skipped: rows.filter((x) => x?.skipped === true).length,
    failed: rows.filter((x) => x?.ok !== true && x?.skipped !== true).length,
    force: Boolean(force),
  };
}

function startUploadBulkJob({
  user = null,
  urls = [],
  force = false,
  overridesByUrl = {},
} = {}) {
  const uid = String(user?.id || "").trim();
  if (!uid) throw new Error("user_id_required");

  const running = getRunningUploadBulkJobForUser(uid);
  if (running) {
    return { job: running, reused: true };
  }

  const total = Array.isArray(urls) ? urls.length : 0;
  const job = initLegacyJob("upload_bulk", {
    stage: "queued",
    total,
    doneCount: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    percent: 1,
  });
  job.items = [];
  job.stopRequested = false;
  uploadBulkRunByUser.set(uid, job.id);

  (async () => {
    try {
      patchLegacyJob(job, {
        status: "running",
        progress: {
          stage: "start",
          total,
          doneCount: 0,
          uploaded: 0,
          skipped: 0,
          failed: 0,
          percent: 3,
        },
      });

      const rows = [];
      await withUploadLock(async () => {
        for (const [idx, url] of urls.entries()) {
          const index = idx + 1;
          if (job.stopRequested) break;

          const prevSummary = summarizeBulkUploadRows(rows, force);
          const runningProgress = {
            stage: "uploading",
            total,
            index,
            currentUrl: url,
            doneCount: rows.length,
            uploaded: prevSummary.uploaded,
            skipped: prevSummary.skipped,
            failed: prevSummary.failed,
          };
          const runningPercent = normalizeUploadBulkJobProgressPercent(runningProgress);
          if (Number.isFinite(Number(runningPercent))) {
            runningProgress.percent = Number(runningPercent);
          }
          patchLegacyJob(job, {
            status: "running",
            progress: runningProgress,
            items: rows.slice(-120),
          });

          let row = null;
          try {
            const o = overridesByUrl?.[url];
            const overrides = {
              titleOverride: o?.titleOverride,
              seedTitle: o?.seedTitle,
              seedPrice: o?.seedPrice,
              seedImageUrl: o?.seedImageUrl,
              keyword: o?.keyword,
              searchTags: Array.isArray(o?.searchTags) ? o.searchTags : undefined,
              imagesOverride: Array.isArray(o?.imagesOverride) ? o.imagesOverride : undefined,
              categoryOverrideCode: o?.categoryOverrideCode,
            };
            const outcome = await executeUploadForUrl({ url, user, force, overrides });
            appendUploadHistoryFromOutcome(url, outcome);
            row = normalizeBulkUploadJobRow({ url, outcome });
          } catch (oneErr) {
            const oneErrorText = String(oneErr?.message || oneErr || "bulk_item_failed");
            appendUploadHistory({
              at: new Date().toISOString(),
              url,
              ok: false,
              skipped: false,
              skipReason: "",
              payloadOnly: false,
              title: "",
              finalPrice: null,
              optionsCount: 0,
              sellerProductId: "",
              createStatus: null,
              error: oneErrorText,
            });
            row = normalizeBulkUploadJobRow({
              url,
              error: oneErrorText,
            });
          }

          rows.push(row);
          const summary = summarizeBulkUploadRows(rows, force);
          const nextProgress = {
            stage: "uploading",
            total,
            index,
            currentUrl: url,
            doneCount: rows.length,
            uploaded: summary.uploaded,
            skipped: summary.skipped,
            failed: summary.failed,
          };
          const nextPercent = normalizeUploadBulkJobProgressPercent(nextProgress);
          if (Number.isFinite(Number(nextPercent))) {
            nextProgress.percent = Number(nextPercent);
          }
          patchLegacyJob(job, {
            status: "running",
            progress: nextProgress,
            summary,
            items: rows.slice(-120),
          });
        }
      });

      const items = rows;
      const summary = summarizeBulkUploadRows(items, force);
      const stopped = Boolean(job.stopRequested);
      const finalProgress = {
        stage: stopped ? "stopped" : "done",
        total,
        doneCount: rows.length,
        uploaded: summary.uploaded,
        skipped: summary.skipped,
        failed: summary.failed,
        percent: 100,
      };
      patchLegacyJob(job, {
        status: stopped ? "stopped" : "success",
        progress: finalProgress,
        summary,
        result: { summary, items },
      });
    } catch (e) {
      patchLegacyJob(job, {
        status: "failed",
        errorMessage: String(e?.message || e),
        error: String(e?.stack || e?.message || e),
      });
    } finally {
      if (uploadBulkRunByUser.get(uid) === job.id) {
        uploadBulkRunByUser.delete(uid);
      }
    }
  })();

  return { job, reused: false };
}

function startRecommendationRefreshJob({
  userId,
  settings = {},
  keywords = [],
  targetCount = 80,
  cooldownDays = 7,
  kind = "recommendations_fill",
} = {}) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("user_id_required");

  const running = getRunningRecommendationJobForUser(uid);
  if (running) {
    return { job: running, reused: true };
  }

  const job = initLegacyJob(kind, {
    stage: "queued",
    targetCount,
    cooldownDays,
    percent: 1,
  });
  job.items = [];
  job.stopRequested = false;
  recommendationRunByUser.set(uid, job.id);

  (async () => {
    try {
      patchLegacyJob(job, {
        status: "running",
        progress: {
          stage: "start",
          targetCount,
          cooldownDays,
          keywordsCount: Array.isArray(keywords) ? keywords.length : 0,
          policy: {
            strictMode: parseBooleanFlag(settings?.recommendationStrictMode, false),
            allowQuickFallback: parseBooleanFlag(
              settings?.recommendationAllowQuickFallback,
              false,
            ),
            allowRelaxedExclusion: parseBooleanFlag(
              settings?.recommendationAllowRelaxedExclusion,
              false,
            ),
          },
          percent: 3,
        },
      });

      const fill = await refreshRecommendationsForUser({
        userId: uid,
        settings,
        keywords,
        targetCount,
        cooldownDays,
        shouldStop: () => Boolean(job.stopRequested),
        onProgress: (progress) => {
          const nextProgress = {
            stage: String(progress?.stage || "running"),
            ...progress,
          };
          const normalizedPercent = normalizeRecommendationJobProgressPercent(nextProgress, targetCount);
          if (Number.isFinite(Number(normalizedPercent))) {
            nextProgress.percent = Number(normalizedPercent);
          }

          let nextItems = Array.isArray(job.items) ? [...job.items] : [];
          const latestItem = progress?.latestItem && typeof progress.latestItem === "object"
            ? progress.latestItem
            : null;
          if (latestItem) {
            const sourceUrl = String(latestItem?.sourceUrl || "").trim();
            if (sourceUrl) {
              const idx = nextItems.findIndex(
                (it) => String(it?.sourceUrl || "").trim() === sourceUrl,
              );
              const normalizedItem = {
                ...latestItem,
                sourceUrl,
              };
              if (idx >= 0) {
                nextItems[idx] = { ...nextItems[idx], ...normalizedItem };
              } else {
                nextItems.push(normalizedItem);
              }
              const keep = Math.max(40, Math.min(200, Number(targetCount) || 80));
              if (nextItems.length > keep) {
                nextItems = nextItems.slice(nextItems.length - keep);
              }
            }
          }

          patchLegacyJob(job, {
            status: "running",
            progress: nextProgress,
            items: nextItems,
          });
        },
      });

      const items = await listRecommendations(uid, {
        limit: Math.max(40, targetCount),
      });
      const finalCount = Number(fill?.count || items.length) || items.length;
      const removedCount = Number(fill?.removedCount || 0) || 0;
      const diagnostics =
        fill?.diagnostics && typeof fill.diagnostics === "object"
          ? fill.diagnostics
          : {};
      const hint = String(diagnostics?.hint || "").trim();
      const validated = Number(diagnostics?.validated || 0) || 0;
      const qcRejected = Number(diagnostics?.qcRejected || 0) || 0;
      const scoredCandidates =
        Number(diagnostics?.scoredCandidates || 0) || 0;
      const progressStage = finalCount > 0 ? "done" : "done_empty";
      const wasStopped = Boolean(fill?.stopped || job.stopRequested);
      const finalHint = wasStopped
        ? (hint || "사용자 요청으로 중단되었습니다.")
        : hint;

      patchLegacyJob(job, {
        status: wasStopped ? "stopped" : "success",
        progress: {
          stage: wasStopped ? "stopped" : progressStage,
          count: finalCount,
          removedCount,
          targetCount,
          cooldownDays,
          hint: finalHint,
          validated,
          qcRejected,
          scoredCandidates,
          percent: 100,
          stopRequested: wasStopped,
        },
        fill,
        items,
        result: { fill, items },
      });
    } catch (e) {
      patchLegacyJob(job, {
        status: "failed",
        errorMessage: String(e?.message || e),
        error: String(e?.stack || e?.message || e),
      });
    } finally {
      if (recommendationRunByUser.get(uid) === job.id) {
        recommendationRunByUser.delete(uid);
      }
    }
  })();

  return { job, reused: false };
}

app.get('/api/dashboard', authRequired, async (_req, res) => {
  const uploadHistory = loadUploadHistory().slice(0, 20);
  const settings = _req.user?.settings || {};
  const sessionStatus = {
    domeggook: { valid: fs.existsSync(resolveStorageStatePath(settings, "domeggook")) },
    domeme: { valid: fs.existsSync(resolveStorageStatePath(settings, "domeme")) },
  };
  const purchaseLogs = getUserPurchaseLogs(_req.user?.id, 20);
  return res.json({
    ok: true,
    auth: { authenticated: true },
    sessions: sessionStatus,
    sessionStatus,
    recentUploads: uploadHistory,
    purchaseLogs,
    payUrls: buildPayUrlsFromLogs(purchaseLogs),
  });
});

app.get('/api/presets', authRequired, async (_req, res) => {
  return res.json({ ok: true, presets: [] });
});

app.post('/api/presets', authRequired, async (_req, res) => {
  return res.json({ ok: false, error: 'preset_not_supported_in_this_runtime' });
});

app.post('/api/jobs/start', authRequired, async (req, res) => {
  try {
    const kind = String(req.body?.kind || '').trim();
    const url = String(req.body?.url || '').trim();
    const force = parseForceFlag(req.body?.force);
    const id = crypto.randomUUID();

    if (!url) return res.status(400).json({ ok: false, error: 'url_required' });

    if (kind === 'preview') {
      const previewRaw = await previewUploadFromUrl(url, req.user.settings || {});
      const preview = await enrichPreviewForClient(previewRaw, req.user.settings || {});
      const job = { id, kind, status: 'done', preview, result: preview };
      legacyJobs.set(id, job);
      return res.json({ ok: true, job });
    }

    if (kind === 'upload') {
      const outcome = await executeUploadForUrl({
        url,
        user: req.user,
        force,
        overrides: {
          titleOverride: req.body?.titleOverride,
          seedTitle: req.body?.seedTitle,
          seedPrice: req.body?.seedPrice,
          seedImageUrl: req.body?.seedImageUrl,
          keyword: req.body?.keyword,
          searchTags: Array.isArray(req.body?.searchTags) ? req.body.searchTags : undefined,
          imagesOverride: Array.isArray(req.body?.imagesOverride) ? req.body.imagesOverride : undefined,
          categoryOverrideCode: req.body?.categoryOverrideCode,
        },
      });
      const job = {
        id,
        kind,
        status: outcome?.ok ? 'done' : 'failed',
        outcome,
        result: outcome?.result || null,
        error: outcome?.error || null,
      };
      legacyJobs.set(id, job);
      return res.json({ ok: true, job });
    }

    return res.status(400).json({ ok: false, error: 'unsupported_kind' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/jobs/:id', authRequired, async (req, res) => {
  const id = String(req.params?.id || '').trim();
  const job = legacyJobs.get(id);
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
  return res.json({ ok: true, job });
});

app.post('/api/jobs/:id/stop', authRequired, async (req, res) => {
  const id = String(req.params?.id || '').trim();
  const job = legacyJobs.get(id);
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });

  const status = String(job.status || '').toLowerCase();
  if (status !== 'running' && status !== 'queued') {
    return res.json({ ok: true, stopping: false, alreadyFinished: true, job });
  }

  const prevProgress = job.progress && typeof job.progress === 'object'
    ? job.progress
    : {};
  const prevPercent = Number(prevProgress?.percent);
  const nextPercent = Number.isFinite(prevPercent)
    ? Math.max(1, Math.min(99, Math.floor(prevPercent)))
    : 1;

  patchLegacyJob(job, {
    stopRequested: true,
    progress: {
      ...prevProgress,
      stage: 'stopping',
      percent: nextPercent,
      stopRequested: true,
    },
  });

  return res.json({ ok: true, stopping: true, job });
});


function toPositiveIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeStringList(values = [], max = 50) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => String(v || "").trim())
    .filter((v, idx, arr) => v.length > 0 && arr.indexOf(v) === idx)
    .slice(0, max);
}

function safeJsonParse(raw, fallback = null) {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

const COUPANG_IMAGE_BASE_URL = "https://image.coupangcdn.com/image";

function normalizeImageUrlForClient(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  if (s.startsWith("vendor_inventory/")) return `${COUPANG_IMAGE_BASE_URL}/${s}`;
  if (s.startsWith("/vendor_inventory/")) return `${COUPANG_IMAGE_BASE_URL}${s}`;
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, "https://");
  return s;
}

function normalizeImageListForClient(values = [], max = 50) {
  return normalizeStringList(values, max)
    .map((x) => normalizeImageUrlForClient(x))
    .filter(Boolean);
}

function buildCoupangProductUrl(productIdRaw) {
  const productId = String(productIdRaw || "").trim();
  if (!productId) return "";
  return `https://www.coupang.com/vp/products/${productId}`;
}

function isApprovedStatus(statusName) {
  const s = String(statusName || "").trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes("approved") ||
    s.includes("승인완료") ||
    s.includes("판매중") ||
    s.includes("active")
  );
}

function isDraftStatusName(statusName) {
  const s = String(statusName || "").trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes("임시저장") ||
    s.includes("draft") ||
    s.includes("temporary save") ||
    s.includes("temp_save")
  );
}

function isPendingApprovalStatusName(statusName) {
  const s = String(statusName || "").trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes("승인대기") ||
    s.includes("심사중") ||
    s.includes("검수중") ||
    s.includes("approval pending") ||
    s.includes("pending approval") ||
    s.includes("under review")
  );
}

function isDeletedStatusName(statusName) {
  const s = String(statusName || "").trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes("삭제") ||
    s.includes("판매중지") ||
    s.includes("판매 종료") ||
    s.includes("판매종료") ||
    s.includes("노출중지") ||
    s.includes("중지") ||
    s.includes("종료") ||
    s.includes("deleted") ||
    s.includes("discontinued") ||
    s.includes("closed") ||
    s.includes("stopped")
  );
}

function extractDetailHtmlFromSellerData(data) {
  const d = data && typeof data === "object" ? data : {};
  const items = Array.isArray(d.items) ? d.items : [];
  const item0 = items[0] || {};
  const direct =
    item0.content ||
    item0.contentText ||
    item0.contentHtml ||
    d.content ||
    d.contentText ||
    d.contentHtml ||
    "";
  if (String(direct || "").trim()) return String(direct);
  const contentBlocks = Array.isArray(item0.contents) ? item0.contents : [];
  const merged = contentBlocks
    .flatMap((block) => (Array.isArray(block?.contentDetails) ? block.contentDetails : []))
    .map((detail) => String(detail?.content || "").trim())
    .filter(Boolean)
    .join("\n");
  return merged;
}

function extractMainImageFromSellerData(data) {
  const d = data && typeof data === "object" ? data : {};
  const items = Array.isArray(d.items) ? d.items : [];
  const item0 = items[0] || {};
  const images = Array.isArray(item0.images) ? item0.images : [];
  const firstImage = images[0] || {};
  const raw = pickFirstNonEmpty(
    firstImage.cdnPath,
    firstImage.vendorPath,
    firstImage.imageUrl,
    firstImage.path,
    d.mainImageUrl,
    d.imageUrl,
  );
  return normalizeImageUrlForClient(raw);
}

function extractProductIdFromHistoryItems(historyItems = []) {
  const rows = Array.isArray(historyItems) ? historyItems : [];
  for (const row of rows) {
    const pid = pickFirstNonEmpty(
      row?.productId,
      row?.displayProductId,
      row?.targetProductId,
      row?.item?.productId,
      row?.item?.displayProductId,
      row?.after?.productId,
      row?.after?.displayProductId,
      row?.before?.productId,
      row?.before?.displayProductId,
    );
    if (pid) return pid;

    const text = JSON.stringify(row || {});
    const m = text.match(/\/vp\/products\/(\d+)/i);
    if (m?.[1]) return String(m[1]).trim();
  }
  return "";
}

function extractProductUrlFromHistoryItems(historyItems = []) {
  const rows = Array.isArray(historyItems) ? historyItems : [];
  for (const row of rows) {
    const url = pickFirstNonEmpty(
      row?.productUrl,
      row?.displayProductUrl,
      row?.url,
      row?.targetUrl,
      row?.after?.productUrl,
      row?.after?.displayProductUrl,
      row?.item?.productUrl,
    );
    if (url) return String(url).trim();
    const text = JSON.stringify(row || {});
    const m = text.match(/https?:\/\/www\.coupang\.com\/vp\/products\/\d+[^\s"]*/i);
    if (m?.[0]) return String(m[0]).trim();
  }
  return "";
}

function extractSellerStatusSnapshot({
  sellerProductId,
  responseBody,
  historiesBody = null,
  httpStatus = null,
}) {
  const bodyObj = safeJsonParse(responseBody, {});
  const data = bodyObj?.data || bodyObj || {};
  const statusName = pickFirstNonEmpty(
    data?.statusName,
    data?.status?.statusName,
    data?.status,
  );
  const productIdRaw = data?.productId ?? data?.displayProductId ?? data?.displayProductCode ?? null;
  const vendorItemIdRaw = data?.vendorItemId ?? data?.itemId ?? null;
  const productIdFromBody = productIdRaw == null ? "" : String(productIdRaw).trim();
  const vendorItemId = vendorItemIdRaw == null ? null : String(vendorItemIdRaw).trim() || null;
  const approved = isApprovedStatus(statusName);
  const draftSaved = isDraftStatusName(statusName);
  const pendingApproval = !approved && isPendingApprovalStatusName(statusName);
  const deleted = isDeletedStatusName(statusName);
  const title = pickFirstNonEmpty(
    data?.displayProductName,
    data?.sellerProductName,
    data?.name,
    data?.items?.[0]?.itemName,
  );
  const mainImageUrl = extractMainImageFromSellerData(data) || null;
  const detailHtml = extractDetailHtmlFromSellerData(data);
  const detailImages = normalizeImageListForClient(extractImageUrls(detailHtml), 200);
  const salePrice = extractSellerSalePriceFromSellerData(data);
  const categoryCode = toPositiveIntOrNull(
    data?.displayCategoryCode ??
      data?.displayCategoryId ??
      data?.categoryCode ??
      data?.displayCategory ??
      data?.items?.[0]?.displayCategoryCode ??
      data?.items?.[0]?.displayCategoryId ??
      data?.items?.[0]?.categoryCode,
  );

  const histObj = safeJsonParse(historiesBody, {});
  const historyItems = Array.isArray(histObj?.data)
    ? histObj.data
    : Array.isArray(histObj)
      ? histObj
      : [];
  const lastHistory = historyItems[0] || null;
  const historyProductId = extractProductIdFromHistoryItems(historyItems);
  const productId = pickFirstNonEmpty(productIdFromBody, historyProductId) || null;
  const historyProductUrl = extractProductUrlFromHistoryItems(historyItems);
  const productUrl = pickFirstNonEmpty(
    data?.productUrl,
    data?.displayProductUrl,
    historyProductUrl,
    buildCoupangProductUrl(productId),
  );

  return {
    ok: true,
    sellerProductId: String(sellerProductId || "").trim(),
    httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
    statusName: statusName || null,
    approved,
    draftSaved,
    pendingApproval,
    deleted,
    productId,
    vendorItemId,
    title: title || null,
    salePrice,
    mainImageUrl,
    detailImages,
    categoryCode,
    productUrl: productUrl || null,
    detailLength: String(detailHtml || "").trim().length,
    detailEmpty: !String(detailHtml || "").trim(),
    lastHistory,
    checkedAt: new Date().toISOString(),
  };
}

function inferCatalogStatus(currentStatus, snapshot = null, fallback = "confirmed") {
  const current = String(currentStatus || "").trim();
  if (!snapshot || snapshot.ok !== true) {
    if (current) return current;
    return fallback;
  }
  if (current === "deleted_local") return current;
  if (snapshot.deleted) return "deleted_remote";
  if (snapshot.draftSaved) return "draft_saved";
  if (snapshot.pendingApproval) return "pending_approval";
  if (snapshot.detailEmpty) return "deployed_invalid";
  if (snapshot.approved && !String(snapshot.productId || "").trim()) return "deployed_invalid";
  if (snapshot.approved) return "deployed";
  if (current === "uploaded") return current;
  return fallback || "confirmed";
}

function inferCatalogStatusForSync(currentStatus, snapshot = null, fallback = "confirmed") {
  // Sync should reflect real remote lifecycle status.
  return inferCatalogStatus(currentStatus, snapshot, fallback);
}

function extractPositivePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function extractSellerSalePriceFromSellerData(data = {}) {
  const directCandidates = [
    data?.salePrice,
    data?.sale_price,
    data?.discountPrice,
    data?.discount_price,
    data?.sellingPrice,
    data?.selling_price,
    data?.price,
    data?.displayPrice,
    data?.display_price,
    data?.saleAmount,
    data?.sale_amount,
    data?.items?.[0]?.salePrice,
    data?.items?.[0]?.sale_price,
    data?.items?.[0]?.sellingPrice,
    data?.items?.[0]?.selling_price,
    data?.items?.[0]?.price,
    data?.items?.[0]?.displayPrice,
    data?.items?.[0]?.display_price,
    data?.items?.[0]?.originalPrice,
  ]
    .map(extractPositivePrice)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (directCandidates.length > 0) {
    return Math.min(...directCandidates);
  }

  const itemCandidates = (Array.isArray(data?.items) ? data.items : [])
    .flatMap((item) => [
      item?.salePrice,
      item?.sale_price,
      item?.sellingPrice,
      item?.selling_price,
      item?.price,
      item?.displayPrice,
      item?.display_price,
      item?.originalPrice,
    ])
    .map(extractPositivePrice)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (itemCandidates.length > 0) {
    return Math.min(...itemCandidates);
  }

  return null;
}

function isDomeggookSourceUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return u.hostname.toLowerCase().includes("domeggook.com");
  } catch {
    return false;
  }
}

function normalizeCatalogProduct(row) {
  const meta = row?.meta && typeof row.meta === "object" ? row.meta : {};
  const detailImagesRaw = normalizeImageListForClient(
    Array.isArray(meta.detailImages) ? meta.detailImages : [],
    100,
  );
  const followUpRaw = meta.followUp && typeof meta.followUp === "object" ? meta.followUp : {};
  const followUp = { ...followUpRaw };
  const followUpProductId = pickFirstNonEmpty(followUp.productId);
  const followUpProductUrl = pickFirstNonEmpty(
    followUp.productUrl,
    buildCoupangProductUrl(followUpProductId),
  );
  followUp.mainImageUrl = normalizeImageUrlForClient(followUp.mainImageUrl);
  followUp.detailImages = normalizeImageListForClient(
    Array.isArray(followUp.detailImages) ? followUp.detailImages : [],
    200,
  );
  if (followUpProductId) followUp.productId = followUpProductId;
  if (followUpProductUrl) followUp.productUrl = followUpProductUrl;
  const mainImageUrl = normalizeImageUrlForClient(pickFirstNonEmpty(
    meta.mainImageUrl,
    followUp.mainImageUrl,
    row?.imageUrl,
    detailImagesRaw[0] || "",
  ));
  const detailImages = detailImagesRaw.length > 0
    ? detailImagesRaw
    : (mainImageUrl ? [mainImageUrl] : []);
  const productId = pickFirstNonEmpty(
    meta.productId,
    followUp.productId,
  );
  const productUrl = pickFirstNonEmpty(
    meta.productUrl,
    followUp.productUrl,
    buildCoupangProductUrl(productId),
  );
  const validation = meta.validation && typeof meta.validation === "object" ? meta.validation : {};
  const priceAudit = meta.priceAudit && typeof meta.priceAudit === "object" ? meta.priceAudit : {};
  const sourceUrl = pickFirstNonEmpty(row?.sourceUrl, meta.sourceUrl);
  return {
    id: String(row?.id ?? ""),
    sourceUrl,
    confirmedTitle: pickFirstNonEmpty(meta.confirmedTitle, row?.title),
    mainImageUrl,
    detailImages,
    presetId: meta.presetId == null ? null : String(meta.presetId || "").trim() || null,
    categoryOverride: toPositiveIntOrNull(meta.categoryOverride),
    sellerProductId: row?.sellerProductId == null ? null : String(row.sellerProductId || "").trim() || null,
    productId: productId || null,
    productUrl: productUrl || null,
    status: String(row?.status || "confirmed"),
    remoteStatusName: pickFirstNonEmpty(followUp.statusName) || null,
    followUp,
    validation,
    priceAudit: Object.keys(priceAudit).length > 0 ? priceAudit : null,
    lastSyncedAt: String(meta.lastSyncedAt || "").trim() || null,
    deployedAt: String(meta.deployedAt || "").trim() || null,
    createdAt: row?.createdAt || null,
  };
}

function applyLiveSnapshotToMeta(meta, live, { fallbackTitle = "", fallbackImageUrl = "" } = {}) {
  const nextMeta = meta && typeof meta === "object" ? { ...meta } : {};
  if (!live || live.ok !== true) return nextMeta;

  const liveProductId = pickFirstNonEmpty(live.productId);
  const liveProductUrl = pickFirstNonEmpty(
    live.productUrl,
    buildCoupangProductUrl(liveProductId),
  );
  const normalizedLive = {
    ...live,
    productId: liveProductId || null,
    productUrl: liveProductUrl || null,
    mainImageUrl: normalizeImageUrlForClient(live.mainImageUrl),
    detailImages: normalizeImageListForClient(
      Array.isArray(live.detailImages) ? live.detailImages : [],
      200,
    ),
  };

  nextMeta.followUp = normalizedLive;
  nextMeta.mainImageUrl = normalizeImageUrlForClient(
    pickFirstNonEmpty(nextMeta.mainImageUrl, normalizedLive.mainImageUrl, fallbackImageUrl),
  );
  nextMeta.confirmedTitle = pickFirstNonEmpty(nextMeta.confirmedTitle, normalizedLive.title, fallbackTitle);
  if (liveProductId) nextMeta.productId = liveProductId;
  if (liveProductUrl) nextMeta.productUrl = liveProductUrl;

  const liveDetailImages = normalizeImageListForClient(normalizedLive.detailImages, 200);
  if (liveDetailImages.length > 0) {
    nextMeta.detailImages = liveDetailImages;
  } else if (
    (!Array.isArray(nextMeta.detailImages) || nextMeta.detailImages.length === 0) &&
    String(nextMeta.mainImageUrl || "").trim()
  ) {
    nextMeta.detailImages = [String(nextMeta.mainImageUrl).trim()];
  }

  const liveCategoryCode = toPositiveIntOrNull(live.categoryCode);
  if (liveCategoryCode && !toPositiveIntOrNull(nextMeta.categoryOverride)) {
    nextMeta.categoryOverride = liveCategoryCode;
  }

  const validationErrors = [];
  if (live.detailEmpty) validationErrors.push("detail_empty");
  if (!String(liveProductId || "").trim()) validationErrors.push("product_id_missing");
  nextMeta.validation = {
    ok: validationErrors.length === 0,
    checkedAt: new Date().toISOString(),
    errors: validationErrors,
  };
  nextMeta.remoteDeleted = false;
  return nextMeta;
}

function parseSellerProductIdFromUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return "";
  const customMatch = url.match(/^coupang:\/\/seller-product\/(\d+)/i);
  if (customMatch?.[1]) return customMatch[1];
  const webMatch = url.match(/\/vp\/products\/(\d+)/i);
  if (webMatch?.[1]) return webMatch[1];
  return "";
}

function resolveCatalogSellerProductId(row) {
  const meta = row?.meta && typeof row.meta === "object" ? row.meta : {};
  return pickFirstNonEmpty(
    row?.sellerProductId,
    meta?.sellerProductId,
    meta?.followUp?.sellerProductId,
    parseSellerProductIdFromUrl(row?.sourceUrl),
    parseSellerProductIdFromUrl(meta?.sourceUrl),
    parseSellerProductIdFromUrl(meta?.followUp?.productUrl),
  );
}

function getCatalogEventsFromMeta(meta, limit = 200) {
  if (!meta || typeof meta !== "object") return [];
  const events = Array.isArray(meta.events) ? meta.events : [];
  return events.slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
}

async function appendCatalogEvent({ userId, catalogId, type, severity = "info", message = "", data = null }) {
  const row = await getUploadedProductById(userId, catalogId);
  if (!row) return null;
  const meta = row.meta && typeof row.meta === "object" ? { ...row.meta } : {};
  const events = Array.isArray(meta.events) ? [...meta.events] : [];
  events.unshift({
    id: crypto.randomUUID(),
    type: String(type || "INFO").trim() || "INFO",
    severity: String(severity || "info").trim() || "info",
    message: String(message || "").trim(),
    data: data && typeof data === "object" ? data : {},
    createdAt: new Date().toISOString(),
  });
  if (events.length > 500) events.length = 500;
  meta.events = events;
  return updateUploadedProductById({
    userId,
    id: row.id,
    patch: { metaReplace: meta },
  });
}

function bodyLooksNotFoundError(bodyObj) {
  const merged = JSON.stringify(bodyObj || {}).toLowerCase();
  if (!merged || merged === '{}') return false;
  return (
    merged.includes('not_found') ||
    merged.includes('not found') ||
    merged.includes('존재하지') ||
    merged.includes('없는 상품') ||
    merged.includes('유효하지 않은') ||
    merged.includes('sellerproductid')
  );
}

function getCoupangAuth(settings = {}) {
  const accessKey = String(settings?.coupangAccessKey || "").trim();
  const secretKey = String(settings?.coupangSecretKey || "").trim();
  if (!accessKey || !secretKey) return null;
  return { accessKey, secretKey };
}

async function fetchSellerStatusLive({ sellerProductId, settings, includeHistory = true }) {
  const spid = String(sellerProductId || "").trim();
  if (!spid) {
    return { ok: false, error: "seller_product_id_required" };
  }
  const auth = getCoupangAuth(settings);
  if (!auth) {
    return { ok: false, error: "coupang_keys_missing" };
  }

  const productRes = await getSellerProduct({
    sellerProductId: spid,
    accessKey: auth.accessKey,
    secretKey: auth.secretKey,
  });
  const productBodyObj = safeJsonParse(productRes?.body, {});
  if (!productRes || Number(productRes.status) >= 400) {
    return {
      ok: false,
      error: "coupang_status_fetch_failed",
      httpStatus: Number(productRes?.status || 0) || null,
      detail: productBodyObj,
    };
  }

  if (!productBodyObj?.data && bodyLooksNotFoundError(productBodyObj)) {
    return {
      ok: false,
      error: "remote_not_found",
      httpStatus: Number(productRes?.status || 0) || null,
      detail: productBodyObj,
    };
  }

  let historiesBody = null;
  if (includeHistory) {
    try {
      const histRes = await getSellerProductHistories({
        sellerProductId: spid,
        accessKey: auth.accessKey,
        secretKey: auth.secretKey,
      });
      if (histRes && Number(histRes.status) < 500) {
        historiesBody = histRes.body;
      }
    } catch {}
  }

  const snapshot = extractSellerStatusSnapshot({
    sellerProductId: spid,
    responseBody: productBodyObj,
    historiesBody,
    httpStatus: productRes.status,
  });
  return snapshot;
}

function buildPriceAuditRecord({
  sourceUrl,
  sellerProductId,
  sourcePrice = null,
  expectedFinalPrice = null,
  liveSalePrice = null,
  supplierItemNo = null,
  flagged = false,
  reason = "",
  liveStatusName = null,
  supplierTitle = "",
  note = "",
} = {}) {
  const source = extractPositivePrice(sourcePrice);
  const expected = extractPositivePrice(expectedFinalPrice);
  const current = extractPositivePrice(liveSalePrice);
  const ratioToSource =
    Number.isFinite(source) && source > 0 && Number.isFinite(current) && current > 0
      ? Number((current / source).toFixed(4))
      : null;
  const ratioToExpected =
    Number.isFinite(expected) && expected > 0 && Number.isFinite(current) && current > 0
      ? Number((current / expected).toFixed(4))
      : null;
  return {
    checkedAt: new Date().toISOString(),
    flagged: Boolean(flagged),
    reason: String(reason || "").trim() || null,
    sourceUrl: String(sourceUrl || "").trim() || null,
    sellerProductId: String(sellerProductId || "").trim() || null,
    sourcePrice: source ?? null,
    expectedFinalPrice: expected ?? null,
    liveSalePrice: current ?? null,
    ratioToSource,
    ratioToExpected,
    supplierItemNo: String(supplierItemNo || "").trim() || null,
    liveStatusName: String(liveStatusName || "").trim() || null,
    supplierTitle: String(supplierTitle || "").trim() || null,
    note: String(note || "").trim() || null,
  };
}

async function auditCatalogPriceOne({ user, row }) {
  const sourceUrl = pickFirstNonEmpty(row?.sourceUrl, row?.meta?.sourceUrl);
  const sellerProductId = resolveCatalogSellerProductId(row);
  if (!sourceUrl) {
    return buildPriceAuditRecord({
      sourceUrl,
      sellerProductId,
      flagged: false,
      reason: "missing_source_url",
      note: "원본 공급처 URL이 없어 검사를 건너뛰었습니다.",
    });
  }
  if (!isDomeggookSourceUrl(sourceUrl)) {
    return buildPriceAuditRecord({
      sourceUrl,
      sellerProductId,
      flagged: false,
      reason: "unsupported_source",
      note: "도매꾹 원본만 자동 가격 재검증합니다.",
    });
  }

  const supplierDraft = await withTimeout(
    parseProductFromDomaeqq(sourceUrl, {
      mode: "full",
      previewPlaywrightFast: false,
    }),
    20_000,
    "price_audit_supplier_timeout",
  );
  const sourcePrice = extractPositivePrice(supplierDraft?.price);
  const expectedFinalPrice =
    sourcePrice == null
      ? null
      : extractPositivePrice(
          computePrice(sourcePrice, {
            rate: user?.settings?.marginRate,
            add: user?.settings?.marginAdd,
            min: user?.settings?.priceMin,
            roundUnit: user?.settings?.roundUnit,
          }),
        );

  let live = null;
  if (sellerProductId) {
    try {
      live = await withTimeout(
        fetchSellerStatusLive({
          sellerProductId,
          settings: user?.settings || {},
          includeHistory: false,
        }),
        10_000,
        "price_audit_live_timeout",
      );
    } catch {}
  }

  const currentMeta = row?.meta && typeof row.meta === "object" ? row.meta : {};
  const currentFollowUp =
    currentMeta.followUp && typeof currentMeta.followUp === "object"
      ? currentMeta.followUp
      : {};
  const liveSalePrice = extractPositivePrice(
    live?.salePrice ?? currentFollowUp?.salePrice,
  );

  if (!sourcePrice) {
    return buildPriceAuditRecord({
      sourceUrl,
      sellerProductId,
      liveSalePrice,
      expectedFinalPrice,
      supplierItemNo: supplierDraft?.sourcePurchase?.itemNo,
      supplierTitle: supplierDraft?.title,
      liveStatusName: live?.statusName,
      flagged: false,
      reason: "source_price_missing",
      note: "공급가를 재확인하지 못했습니다.",
    });
  }

  if (!liveSalePrice) {
    return buildPriceAuditRecord({
      sourceUrl,
      sellerProductId,
      sourcePrice,
      expectedFinalPrice,
      supplierItemNo: supplierDraft?.sourcePurchase?.itemNo,
      supplierTitle: supplierDraft?.title,
      liveStatusName: live?.statusName,
      flagged: false,
      reason: "live_price_missing",
      note: "현재 쿠팡 판매가를 읽지 못했습니다.",
    });
  }

  const gapToSource = sourcePrice - liveSalePrice;
  const gapToExpected =
    Number.isFinite(Number(expectedFinalPrice)) && expectedFinalPrice != null
      ? Number(expectedFinalPrice) - liveSalePrice
      : null;
  const ratioToSource = liveSalePrice / sourcePrice;
  const ratioToExpected =
    Number.isFinite(Number(expectedFinalPrice)) && Number(expectedFinalPrice) > 0
      ? liveSalePrice / Number(expectedFinalPrice)
      : null;
  const severeLow = ratioToSource <= 0.5;
  const suspiciousGap = gapToSource >= 5000 && ratioToSource <= 0.8;
  const suspiciousExpectedGap =
    Number.isFinite(Number(gapToExpected)) &&
    Number(gapToExpected) >= 5000 &&
    Number.isFinite(Number(ratioToExpected)) &&
    Number(ratioToExpected) <= 0.6;
  const flagged = Boolean(severeLow || suspiciousGap || suspiciousExpectedGap);

  let reason = "ok";
  if (severeLow) reason = "far_below_source_price";
  else if (suspiciousGap) reason = "below_source_price";
  else if (suspiciousExpectedGap) reason = "far_below_expected_price";

  return buildPriceAuditRecord({
    sourceUrl,
    sellerProductId,
    sourcePrice,
    expectedFinalPrice,
    liveSalePrice,
    supplierItemNo: supplierDraft?.sourcePurchase?.itemNo,
    supplierTitle: supplierDraft?.title,
    liveStatusName: live?.statusName,
    flagged,
    reason,
    note: flagged
      ? "공급가 재검증 결과 현재 쿠팡 판매가가 비정상적으로 낮습니다."
      : "공급가 대비 현재 판매가가 정상 범위입니다.",
  });
}

async function persistCatalogPriceAudit({ userId, row, audit }) {
  const nextMeta = row?.meta && typeof row.meta === "object" ? { ...row.meta } : {};
  nextMeta.priceAudit = audit;
  const prevValidation =
    nextMeta.validation && typeof nextMeta.validation === "object"
      ? { ...nextMeta.validation }
      : {};
  const nextErrors = Array.isArray(prevValidation.errors)
    ? prevValidation.errors
        .map((x) => String(x || "").trim())
        .filter((x) => x && x !== "price_too_low_suspected")
    : [];
  if (audit?.flagged) nextErrors.push("price_too_low_suspected");
  nextMeta.validation = {
    ...prevValidation,
    checkedAt: String(audit?.checkedAt || new Date().toISOString()),
    ok: nextErrors.length === 0,
    errors: uniqueStrings(nextErrors),
  };
  return updateUploadedProductById({
    userId,
    id: row.id,
    patch: { metaReplace: nextMeta },
  });
}

function isRemoteDeleted(live = null) {
  if (!live) return false;
  if (live.ok && isDeletedStatusName(live?.statusName)) return true;
  if (live.ok) return false;
  const status = Number(live?.httpStatus || 0);
  if (status === 404) return true;
  const merged = [live?.error, JSON.stringify(live?.detail || {})]
    .map((x) => String(x || '').toLowerCase())
    .join(' ');
  return (
    merged.includes('not_found') ||
    merged.includes('not found') ||
    merged.includes('존재하지') ||
    merged.includes('없는 상품') ||
    merged.includes('sellerproductid')
  );
}

async function upsertCatalogProductFromPayload({ userId, payload = {}, defaultStatus = "confirmed" }) {
  const sourceUrlInput = String(payload.sourceUrl || payload.url || "").trim();
  const sellerProductIdInput = String(payload.sellerProductId || "").trim();
  const sourceUrl = sourceUrlInput || (sellerProductIdInput ? `coupang://seller-product/${sellerProductIdInput}` : "");
  if (!sourceUrl) throw new Error("missing sourceUrl");

  const confirmedTitle = String(payload.confirmedTitle || payload.title || "").trim();
  const mainImageUrl = normalizeImageUrlForClient(String(payload.mainImageUrl || "").trim());
  const detailImages = normalizeImageListForClient(payload.detailImages, 200);
  const productId = String(payload.productId || "").trim();
  const productUrl = String(payload.productUrl || "").trim();
  const categoryOverride = toPositiveIntOrNull(payload.categoryOverride);
  const presetIdRaw = String(payload.presetId || "").trim();
  const presetId = presetIdRaw || null;

  const existingBySource = await getUploadedProductBySourceUrl(userId, sourceUrl);
  const existingBySpid =
    !existingBySource && sellerProductIdInput
      ? await getUploadedProductBySellerProductId(userId, sellerProductIdInput)
      : null;
  const existing = existingBySource || existingBySpid || null;

  const prevMeta = existing?.meta && typeof existing.meta === "object" ? existing.meta : {};
  const mergedMeta = {
    ...prevMeta,
    confirmedTitle: confirmedTitle || pickFirstNonEmpty(prevMeta.confirmedTitle, existing?.title),
    mainImageUrl: mainImageUrl || normalizeImageUrlForClient(pickFirstNonEmpty(prevMeta.mainImageUrl, existing?.imageUrl)),
    detailImages: detailImages.length > 0 ? detailImages : normalizeImageListForClient(prevMeta.detailImages || [], 200),
    productId: productId || pickFirstNonEmpty(prevMeta.productId),
    productUrl: productUrl || pickFirstNonEmpty(prevMeta.productUrl, buildCoupangProductUrl(productId || prevMeta.productId)),
    presetId,
    categoryOverride,
  };

  if (existing) {
    const updated = await updateUploadedProductById({
      userId,
      id: existing.id,
      patch: {
        sourceUrl,
        title: mergedMeta.confirmedTitle || existing.title || "상품",
        imageUrl: mergedMeta.mainImageUrl || existing.imageUrl || "",
        sellerProductId:
          sellerProductIdInput ||
          String(existing.sellerProductId || "").trim() ||
          null,
        status: String(payload.status || existing.status || defaultStatus),
        metaReplace: mergedMeta,
      },
    });
    return updated;
  }

  await recordUploadedProduct({
    userId,
    sourceUrl,
    title: mergedMeta.confirmedTitle || "상품",
    imageUrl: mergedMeta.mainImageUrl || "",
    imageFingerprint: String(payload.imageFingerprint || "").trim(),
    sellerProductId: sellerProductIdInput || null,
    status: String(payload.status || defaultStatus),
    meta: mergedMeta,
  });

  return (
    (await getUploadedProductBySourceUrl(userId, sourceUrl)) ||
    (sellerProductIdInput
      ? await getUploadedProductBySellerProductId(userId, sellerProductIdInput)
      : null)
  );
}

app.get("/api/catalog", authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 100) || 100));
    const offset = Math.max(0, Number(req.query?.offset || 0) || 0);
    const q = String(req.query?.q || "").trim();
    const status = String(req.query?.status || "").trim();

    const listed = await listUploadedProducts({
      userId: req.user.id,
      q,
      status,
      limit,
      offset,
    });
    let products = (listed.items || []).map(normalizeCatalogProduct);
    if (!status) {
      const hiddenStatuses = new Set(["deleted_remote", "deleted_local"]);
      products = products.filter((p) => !hiddenStatuses.has(String(p?.status || "").trim()));
    }
    return res.json({
      ok: true,
      products,
      total: products.length,
      limit: listed.limit ?? limit,
      offset: listed.offset ?? offset,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/price-audit/scan", authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids)
      ? b.ids.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const limit = Math.max(1, Math.min(200, Number(b.limit || ids.length || 50) || 50));

    const rows = [];
    if (ids.length > 0) {
      for (const id of ids.slice(0, limit)) {
        const row = await getUploadedProductById(req.user.id, id);
        if (row) rows.push(row);
      }
    } else {
      const listed = await listUploadedProducts({
        userId: req.user.id,
        q: "",
        status: "",
        limit,
        offset: 0,
      });
      rows.push(
        ...((listed.items || []).filter((row) => {
          const status = String(row?.status || "").trim();
          return status !== "deleted_local" && status !== "deleted_remote";
        })),
      );
    }

    const findings = [];
    let flaggedCount = 0;
    let skippedCount = 0;
    for (const row of rows) {
      try {
        const audit = await auditCatalogPriceOne({ user: req.user, row });
        const updated = await persistCatalogPriceAudit({
          userId: req.user.id,
          row,
          audit,
        });
        if (audit?.flagged) flaggedCount += 1;
        if (String(audit?.reason || "").trim() === "unsupported_source") skippedCount += 1;
        findings.push({
          id: String(row?.id || ""),
          flagged: Boolean(audit?.flagged),
          audit,
          product: normalizeCatalogProduct(updated || row),
        });
      } catch (e) {
        skippedCount += 1;
        const audit = buildPriceAuditRecord({
          sourceUrl: pickFirstNonEmpty(row?.sourceUrl, row?.meta?.sourceUrl),
          sellerProductId: resolveCatalogSellerProductId(row),
          flagged: false,
          reason: "audit_failed",
          note: String(e?.message || e),
        });
        const updated = await persistCatalogPriceAudit({
          userId: req.user.id,
          row,
          audit,
        });
        findings.push({
          id: String(row?.id || ""),
          flagged: false,
          audit,
          product: normalizeCatalogProduct(updated || row),
        });
      }
    }

    return res.json({
      ok: true,
      scanned: findings.length,
      flagged: flaggedCount,
      skipped: skippedCount,
      items: findings,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/import", authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const sellerProductId = String(b.sellerProductId || "").trim();
    if (!sellerProductId) {
      return res.status(400).json({ ok: false, error: "sellerProductId required" });
    }

    const live = await fetchSellerStatusLive({
      sellerProductId,
      settings: req.user.settings || {},
      includeHistory: true,
    });
    const remoteDeleted = isRemoteDeleted(live);

    const sourceUrl = String(b.sourceUrl || "").trim() || `coupang://seller-product/${sellerProductId}`;
    const product = await upsertCatalogProductFromPayload({
      userId: req.user.id,
      payload: {
        sourceUrl,
        sellerProductId,
        confirmedTitle: String(b.confirmedTitle || live.title || "").trim(),
        mainImageUrl: String(b.mainImageUrl || live.mainImageUrl || "").trim(),
        detailImages: Array.isArray(b.detailImages) ? b.detailImages : [],
        status: remoteDeleted ? "deleted_remote" : inferCatalogStatus("confirmed", live, "confirmed"),
      },
      defaultStatus: "confirmed",
    });
    if (!product) return res.status(500).json({ ok: false, error: "catalog_import_failed" });

    const currentMeta = product.meta && typeof product.meta === "object" ? { ...product.meta } : {};
    if (live?.ok) {
      currentMeta.followUp = live;
      currentMeta.lastSyncedAt = new Date().toISOString();
      if (live.detailEmpty) {
        currentMeta.validation = {
          ok: false,
          checkedAt: new Date().toISOString(),
          errors: ["detail_empty"],
        };
      }
    }

    const saved = await updateUploadedProductById({
      userId: req.user.id,
      id: product.id,
      patch: {
        status: remoteDeleted ? "deleted_remote" : inferCatalogStatus(product.status, live, "confirmed"),
        metaReplace: currentMeta,
      },
    });
    const normalized = normalizeCatalogProduct(saved || product);
    await appendCatalogEvent({
      userId: req.user.id,
      catalogId: normalized.id,
      type: "CATALOG_IMPORT",
      severity: live?.ok ? "info" : "warn",
      message: live?.ok ? "쿠팡 상품을 카탈로그로 가져왔습니다." : "카탈로그로 가져왔지만 상태 조회는 실패했습니다.",
      data: { sellerProductId, live },
    });
    return res.json({ ok: true, product: normalized, status: live });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/confirm", authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const sourceUrl = String(b.sourceUrl || b.url || "").trim();
    if (!sourceUrl) return res.status(400).json({ ok: false, error: "missing url" });

    const confirmDetailImages = normalizeStringList(
      Array.isArray(b.detailImages) ? b.detailImages : [],
      200,
    );
    const confirmMainImageUrl = String(b.mainImageUrl || "").trim();
    if (confirmDetailImages.length === 0 && confirmMainImageUrl) {
      confirmDetailImages.push(confirmMainImageUrl);
    }

    const row = await upsertCatalogProductFromPayload({
      userId: req.user.id,
      payload: {
        sourceUrl,
        confirmedTitle: String(b.confirmedTitle || b.title || "").trim(),
        mainImageUrl: confirmMainImageUrl,
        detailImages: confirmDetailImages,
        presetId: b.presetId,
        categoryOverride: b.categoryOverride,
        status: "confirmed",
      },
      defaultStatus: "confirmed",
    });
    if (!row) return res.status(500).json({ ok: false, error: "confirm_failed" });

    await appendCatalogEvent({
      userId: req.user.id,
      catalogId: row.id,
      type: "CATALOG_CONFIRMED",
      severity: "info",
      message: "미리보기 확정이 저장되었습니다.",
      data: {
        sourceUrl,
        confirmedTitle: String(b.confirmedTitle || b.title || "").trim(),
      },
    });

    return res.json({ ok: true, product: normalizeCatalogProduct(row) });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/catalog/:id/events", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    const row = await getUploadedProductById(req.user.id, id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200) || 200));
    return res.json({ ok: true, events: getCatalogEventsFromMeta(row.meta, limit) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/catalog/:id", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    const row = await getUploadedProductById(req.user.id, id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, product: normalizeCatalogProduct(row) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/:id/archive", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    const row = await getUploadedProductById(req.user.id, id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const updated = await updateUploadedProductById({
      userId: req.user.id,
      id: row.id,
      patch: { status: "deleted_local" },
    });
    if (!updated) return res.status(404).json({ ok: false, error: "not_found" });

    await appendCatalogEvent({
      userId: req.user.id,
      catalogId: updated.id,
      type: "CATALOG_ARCHIVED",
      severity: "info",
      message: "상품을 목록에서 숨겼습니다.",
      data: { previousStatus: row.status || null },
    });

    return res.json({ ok: true, product: normalizeCatalogProduct(updated) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/:id/delete-remote", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    const row = await getUploadedProductById(req.user.id, id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const sellerProductId = resolveCatalogSellerProductId(row);
    if (!sellerProductId) {
      return res.status(400).json({ ok: false, error: "sellerProductId_missing" });
    }
    const auth = getCoupangAuth(req.user.settings || {});
    if (!auth) {
      return res.status(400).json({ ok: false, error: "coupang_keys_missing" });
    }

    const remote = await deleteSellerProduct({
      sellerProductId,
      accessKey: auth.accessKey,
      secretKey: auth.secretKey,
    });
    const detail = safeJsonParse(remote?.body, {});
    const alreadyGone =
      Number(remote?.status || 0) === 404 || bodyLooksNotFoundError(detail);
    if ((!remote || Number(remote.status) >= 400) && !alreadyGone) {
      return res.status(400).json({
        ok: false,
        error: "remote_delete_failed",
        httpStatus: Number(remote?.status || 0) || null,
        detail,
      });
    }

    const nowIso = new Date().toISOString();
    const nextMeta = row.meta && typeof row.meta === "object" ? { ...row.meta } : {};
    nextMeta.remoteDeleted = true;
    nextMeta.remoteDeletedAt = nowIso;
    nextMeta.lastRemoteDelete = {
      checkedAt: nowIso,
      sellerProductId,
      httpStatus: Number(remote?.status || 0) || null,
      alreadyGone,
    };
    const prevValidation =
      nextMeta.validation && typeof nextMeta.validation === "object"
        ? { ...nextMeta.validation }
        : {};
    const nextErrors = Array.isArray(prevValidation.errors)
      ? prevValidation.errors
          .map((x) => String(x || "").trim())
          .filter((x) => x && x !== "remote_deleted")
      : [];
    nextErrors.push("remote_deleted");
    nextMeta.validation = {
      ...prevValidation,
      ok: false,
      checkedAt: nowIso,
      errors: uniqueStrings(nextErrors),
    };

    const updated = await updateUploadedProductById({
      userId: req.user.id,
      id: row.id,
      patch: {
        sellerProductId,
        status: "deleted_remote",
        metaReplace: nextMeta,
      },
    });

    await appendCatalogEvent({
      userId: req.user.id,
      catalogId: row.id,
      type: "CATALOG_REMOTE_DELETE",
      severity: "warn",
      message: alreadyGone
        ? "쿠팡에서 이미 삭제된 상품으로 처리했습니다."
        : "쿠팡 상품 삭제를 요청했습니다.",
      data: {
        sellerProductId,
        httpStatus: Number(remote?.status || 0) || null,
        alreadyGone,
      },
    });

    return res.json({
      ok: true,
      deleted: true,
      result: {
        sellerProductId,
        httpStatus: Number(remote?.status || 0) || null,
        alreadyGone,
      },
      product: normalizeCatalogProduct(updated || row),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/:id", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    const current = await getUploadedProductById(req.user.id, id);
    if (!current) return res.status(404).json({ ok: false, error: "not_found" });

    const b = req.body || {};
    const nextMeta = current.meta && typeof current.meta === "object" ? { ...current.meta } : {};

    if (b.confirmedTitle != null) {
      nextMeta.confirmedTitle = String(b.confirmedTitle || "").trim();
    }
    if (b.mainImageUrl != null) {
      nextMeta.mainImageUrl = String(b.mainImageUrl || "").trim();
    }
    if (Array.isArray(b.detailImages)) {
      nextMeta.detailImages = normalizeStringList(b.detailImages, 200);
    }
    if (Object.prototype.hasOwnProperty.call(b, "presetId")) {
      const preset = String(b.presetId || "").trim();
      nextMeta.presetId = preset || null;
    }
    if (Object.prototype.hasOwnProperty.call(b, "categoryOverride")) {
      nextMeta.categoryOverride = toPositiveIntOrNull(b.categoryOverride);
    }
    if (b.followUp && typeof b.followUp === "object") {
      nextMeta.followUp = b.followUp;
    }
    if (b.validation && typeof b.validation === "object") {
      nextMeta.validation = b.validation;
    }

    const updated = await updateUploadedProductById({
      userId: req.user.id,
      id,
      patch: {
        sourceUrl:
          b.sourceUrl != null
            ? String(b.sourceUrl || "").trim()
            : current.sourceUrl,
        title: pickFirstNonEmpty(nextMeta.confirmedTitle, current.title),
        imageUrl: pickFirstNonEmpty(nextMeta.mainImageUrl, current.imageUrl),
        sellerProductId:
          b.sellerProductId != null
            ? String(b.sellerProductId || "").trim() || null
            : current.sellerProductId,
        status:
          b.status != null
            ? String(b.status || "").trim() || current.status
            : current.status,
        metaReplace: nextMeta,
      },
    });
    if (!updated) return res.status(404).json({ ok: false, error: "not_found" });

    await appendCatalogEvent({
      userId: req.user.id,
      catalogId: updated.id,
      type: "CATALOG_UPDATED",
      severity: "info",
      message: "상품 편집 내용을 저장했습니다.",
      data: {
        hasTitle: Boolean(nextMeta.confirmedTitle),
        detailImages: Array.isArray(nextMeta.detailImages) ? nextMeta.detailImages.length : 0,
      },
    });

    return res.json({ ok: true, product: normalizeCatalogProduct(updated) });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/:id/sync", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    let row = await getUploadedProductById(req.user.id, id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const spid = resolveCatalogSellerProductId(row);
    if (!spid) {
      await appendCatalogEvent({
        userId: req.user.id,
        catalogId: row.id,
        type: "STATUS_SYNC_SKIPPED",
        severity: "warn",
        message: "동기화를 건너뜀: sellerProductId가 없습니다.",
        data: { reason: "sellerProductId_missing" },
      });
      return res.json({
        ok: true,
        skipped: true,
        reason: "sellerProductId_missing",
        product: normalizeCatalogProduct(row),
      });
    }

    if (!String(row.sellerProductId || "").trim()) {
      const patched = await updateUploadedProductById({
        userId: req.user.id,
        id: row.id,
        patch: { sellerProductId: spid },
      });
      if (patched) row = patched;
    }

    const live = await fetchSellerStatusLive({
      sellerProductId: spid,
      settings: req.user.settings || {},
      includeHistory: true,
    });

    const nextMeta = row.meta && typeof row.meta === "object" ? { ...row.meta } : {};
    const nowIso = new Date().toISOString();
    nextMeta.lastSyncedAt = nowIso;
    const remoteDeleted = isRemoteDeleted(live);
    if (live?.ok) {
      Object.assign(
        nextMeta,
        applyLiveSnapshotToMeta(nextMeta, live, {
          fallbackTitle: row.title,
          fallbackImageUrl: row.imageUrl,
        }),
      );
      if (nextMeta.validation && typeof nextMeta.validation === "object") {
        nextMeta.validation.checkedAt = nowIso;
      }
    } else {
      nextMeta.lastRemoteError = live;
      if (remoteDeleted) {
        nextMeta.remoteDeleted = true;
        nextMeta.remoteDeletedAt = nowIso;
        nextMeta.validation = {
          ok: false,
          checkedAt: nowIso,
          errors: ["remote_deleted"],
        };
      }
    }

    const updated = await updateUploadedProductById({
      userId: req.user.id,
      id: row.id,
      patch: {
        status: remoteDeleted ? "deleted_remote" : inferCatalogStatusForSync(row.status, live, "confirmed"),
        title: pickFirstNonEmpty(nextMeta.confirmedTitle, row.title),
        imageUrl: pickFirstNonEmpty(nextMeta.mainImageUrl, row.imageUrl),
        metaReplace: nextMeta,
      },
    });

    await appendCatalogEvent({
      userId: req.user.id,
      catalogId: row.id,
      type: "STATUS_SYNC",
      severity: live?.ok ? "info" : remoteDeleted ? "warn" : "error",
      message: live?.ok
        ? `상태 동기화 완료: ${live.statusName || "-"}`
        : remoteDeleted
          ? "Wing에서 삭제된 상품으로 확인되어 목록에서 숨김 처리했습니다."
          : `상태 동기화 실패: ${live?.error || "unknown"}`,
      data: { sellerProductId: spid, live, remoteDeleted },
    });

    return res.json({
      ok: true,
      status: live,
      product: normalizeCatalogProduct(updated || row),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/catalog/:id/deploy", authRequired, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    const row = await getUploadedProductById(req.user.id, id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const sourceUrl = String(row.sourceUrl || "").trim();
    if (!sourceUrl) {
      return res.status(400).json({ ok: false, error: "sourceUrl missing" });
    }

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      kind: "catalog_deploy",
      catalogId: String(row.id),
      status: "running",
      createdAt: new Date().toISOString(),
      result: null,
      errorCode: null,
      errorMessage: null,
    };
    legacyJobs.set(jobId, job);
    res.json({ ok: true, job });

    setTimeout(async () => {
      try {
        const latest = await getUploadedProductById(req.user.id, row.id);
        if (!latest) throw new Error("not_found");
        const meta = latest.meta && typeof latest.meta === "object" ? { ...latest.meta } : {};
        const confirmedTitle = String(meta.confirmedTitle || "").trim();
        const overrides = {
          titleOverride: confirmedTitle || undefined,
          seedTitle: confirmedTitle || undefined,
          imagesOverride: Array.isArray(meta.detailImages)
            ? normalizeStringList(meta.detailImages, 200)
            : undefined,
          categoryOverrideCode: toPositiveIntOrNull(meta.categoryOverride),
        };

        const outcome = await executeUploadForUrl({
          url: sourceUrl,
          user: req.user,
          force: true,
          overrides,
        });

        const uploadResult = outcome?.result || buildSkippedResult(outcome);
        const skipReason = normalizeSkipReason(outcome);
        const skippedAsDuplicate =
          Boolean(outcome?.skipped) &&
          (skipReason === "duplicate_url" ||
            skipReason === "duplicate_title" ||
            skipReason === "duplicate_fingerprint");
        const deploySuccess = Boolean(outcome?.ok) || skippedAsDuplicate;
        const sellerProductId = resolveOutcomeSellerProductId(outcome);
        let live = null;
        if (sellerProductId) {
          live = await fetchSellerStatusLive({
            sellerProductId,
            settings: req.user.settings || {},
            includeHistory: true,
          });
        }

        const validation =
          live && live.ok
            ? {
                ok: !live.detailEmpty,
                checkedAt: new Date().toISOString(),
                errors: live.detailEmpty ? ["detail_empty"] : [],
              }
            : meta.validation && typeof meta.validation === "object"
              ? meta.validation
              : {};

        const uploadPreview = uploadResult?.preview && typeof uploadResult.preview === "object"
          ? uploadResult.preview
          : {};
        const outcomePreview = outcome?.preview && typeof outcome.preview === "object"
          ? outcome.preview
          : {};

        const deployedDetailImages = uniqueStrings([
          ...(Array.isArray(uploadPreview?.contentImagesFiltered) ? uploadPreview.contentImagesFiltered : []),
          ...(Array.isArray(outcomePreview?.contentImagesFiltered) ? outcomePreview.contentImagesFiltered : []),
        ]).slice(0, 200);
        const liveDetailImages = normalizeStringList(
          Array.isArray(live?.detailImages) ? live.detailImages : [],
          200,
        );

        const usedCategoryCode =
          toPositiveIntOrNull(uploadResult?.category?.used) ||
          toPositiveIntOrNull(uploadResult?.category?.requested) ||
          toPositiveIntOrNull(meta?.categoryOverride) ||
          toPositiveIntOrNull(live?.categoryCode);

        const nextMeta = {
          ...meta,
          followUp: live && live.ok ? live : uploadResult?.followUp || meta.followUp || {},
          validation,
          mainImageUrl: pickFirstNonEmpty(
            uploadResult?.draft?.imageUrl,
            uploadPreview?.mainImageUrl,
            outcomePreview?.mainImageUrl,
            meta.mainImageUrl,
            latest.imageUrl,
          ),
          detailImages:
            liveDetailImages.length > 0
              ? liveDetailImages
              : (deployedDetailImages.length > 0
                  ? deployedDetailImages
                  : normalizeStringList(
                      Array.isArray(meta.detailImages) ? meta.detailImages : [],
                      200,
                    )),
          categoryOverride: usedCategoryCode,
          deployedAt: new Date().toISOString(),
          lastDeployResult: {
            ok: Boolean(outcome?.ok),
            skipped: Boolean(outcome?.skipped),
            skipReason,
            deploySuccess,
            error: outcome?.error || null,
            at: new Date().toISOString(),
          },
        };

        const updated = await updateUploadedProductById({
          userId: req.user.id,
          id: latest.id,
          patch: {
            title: pickFirstNonEmpty(uploadResult?.draft?.title, nextMeta.confirmedTitle, latest.title),
            imageUrl: pickFirstNonEmpty(uploadResult?.draft?.imageUrl, nextMeta.mainImageUrl, latest.imageUrl),
            imageFingerprint: pickFirstNonEmpty(
              outcome?.preview?.imageFingerprint,
              latest.imageFingerprint,
            ),
            sellerProductId: sellerProductId || latest.sellerProductId || null,
            status: !deploySuccess
              ? "deploy_failed"
              : inferCatalogStatus(latest.status, live, "confirmed"),
            metaReplace: nextMeta,
          },
        });

        await appendCatalogEvent({
          userId: req.user.id,
          catalogId: latest.id,
          type: deploySuccess ? "DEPLOY_SUCCESS" : "DEPLOY_FAILED",
          severity: deploySuccess ? "info" : "error",
          message: deploySuccess
            ? `업로드 완료${sellerProductId ? ` (SPID ${sellerProductId})` : ""}`
            : `업로드 실패: ${outcome?.error || skipReason || "upload_failed"}`,
          data: {
            sellerProductId,
            skipReason,
            live,
          },
        });

        const finished = {
          ...job,
          status: deploySuccess ? "success" : "failed",
          errorCode: deploySuccess ? null : String(outcome?.error || skipReason || "upload_failed"),
          errorMessage: deploySuccess ? null : "업로드에 실패했습니다.",
          result: {
            result: uploadResult,
            outcome,
            product: normalizeCatalogProduct(updated || latest),
          },
        };
        legacyJobs.set(jobId, finished);
      } catch (e) {
        legacyJobs.set(jobId, {
          ...job,
          status: "failed",
          errorCode: "catalog_deploy_exception",
          errorMessage: String(e?.message || e),
          result: {
            result: {
              ok: false,
              error: "catalog_deploy_exception",
              detail: String(e?.message || e),
            },
          },
        });
      }
    }, 0);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function syncUploadedProductStatusOne({
  userId,
  userSettings = {},
  sellerProductId,
  includeHistory = true,
} = {}) {
  const spid = String(sellerProductId || "").trim();
  if (!spid) {
    return {
      sellerProductId: "",
      ok: false,
      status: null,
      statusName: null,
      approved: false,
      productId: null,
      remoteDeleted: false,
      error: "sellerProductId_required",
      linkedId: null,
      updated: false,
    };
  }

  const live = await fetchSellerStatusLive({
    sellerProductId: spid,
    settings: userSettings || {},
    includeHistory,
  });

  const linked = await getUploadedProductBySellerProductId(userId, spid);
  const remoteDeleted = isRemoteDeleted(live);
  let updated = null;
  if (linked) {
    const nextMeta = linked.meta && typeof linked.meta === "object" ? { ...linked.meta } : {};
    const nowIso = new Date().toISOString();
    nextMeta.lastSyncedAt = nowIso;
    if (live?.ok) {
      Object.assign(
        nextMeta,
        applyLiveSnapshotToMeta(nextMeta, live, {
          fallbackTitle: linked.title,
          fallbackImageUrl: linked.imageUrl,
        }),
      );
      if (nextMeta.validation && typeof nextMeta.validation === "object") {
        nextMeta.validation.checkedAt = nowIso;
      }
    } else {
      nextMeta.lastRemoteError = live;
      if (remoteDeleted) {
        nextMeta.remoteDeleted = true;
        nextMeta.remoteDeletedAt = nowIso;
        nextMeta.validation = {
          ok: false,
          checkedAt: nowIso,
          errors: ["remote_deleted"],
        };
      }
    }
    updated = await updateUploadedProductById({
      userId,
      id: linked.id,
      patch: {
        status: remoteDeleted ? "deleted_remote" : inferCatalogStatusForSync(linked.status, live, "confirmed"),
        title: pickFirstNonEmpty(nextMeta.confirmedTitle, live?.title, linked.title),
        imageUrl: pickFirstNonEmpty(nextMeta.mainImageUrl, live?.mainImageUrl, linked.imageUrl),
        metaReplace: nextMeta,
      },
    });
  }

  return {
    sellerProductId: spid,
    ok: Boolean(live?.ok),
    status: live,
    statusName: live?.statusName || null,
    approved: Boolean(live?.approved),
    productId: live?.productId || null,
    remoteDeleted,
    error: live?.ok ? null : live?.error || "status_fetch_failed",
    linkedId: linked?.id ? String(linked.id) : null,
    updated: Boolean(updated),
  };
}

app.get("/api/products/status/:sellerProductId", authRequired, async (req, res) => {
  try {
    const sellerProductId = String(req.params?.sellerProductId || "").trim();
    if (!sellerProductId) {
      return res.status(400).json({ ok: false, error: "sellerProductId required" });
    }
    const synced = await syncUploadedProductStatusOne({
      userId: req.user.id,
      userSettings: req.user.settings || {},
      sellerProductId,
      includeHistory: true,
    });

    return res.json({
      ok: Boolean(synced?.ok),
      status: synced?.status || null,
      sellerProductId: synced?.sellerProductId || sellerProductId,
      remoteDeleted: Boolean(synced?.remoteDeleted),
      error: synced?.error || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/products/status/refresh", authRequired, async (req, res) => {
  try {
    const sellerProductIds = normalizeStringList(req.body?.sellerProductIds, 100);
    let targets = sellerProductIds;
    if (targets.length === 0) {
      const listed = await listUploadedProducts({
        userId: req.user.id,
        q: "",
        status: "",
        limit: 200,
        offset: 0,
      });
      targets = normalizeStringList(
        (listed.items || []).map((row) => row?.sellerProductId),
        100,
      );
    }

    const results = [];
    for (const sellerProductId of targets) {
      try {
        const synced = await syncUploadedProductStatusOne({
          userId: req.user.id,
          userSettings: req.user.settings || {},
          sellerProductId,
          includeHistory: true,
        });
        results.push({
          sellerProductId: synced?.sellerProductId || sellerProductId,
          ok: Boolean(synced?.ok),
          statusName: synced?.statusName || null,
          approved: Boolean(synced?.approved),
          productId: synced?.productId || null,
          remoteDeleted: Boolean(synced?.remoteDeleted),
          error: synced?.error || null,
        });
      } catch (oneErr) {
        results.push({
          sellerProductId,
          ok: false,
          statusName: null,
          approved: false,
          productId: null,
          remoteDeleted: false,
          error: String(oneErr?.message || oneErr || "status_refresh_failed"),
        });
      }
    }

    return res.json({
      ok: true,
      total: targets.length,
      success: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

function parseForceFlag(value) {
  if (value === true || value === 1) return true;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

function parseBooleanFlag(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const asInt = Math.floor(n);
  if (asInt < min) return min;
  if (asInt > max) return max;
  return asInt;
}

function normalizeKeywordInput(value) {
  if (Array.isArray(value)) return normalizeStringList(value, 30);
  const text = String(value || "").trim();
  if (!text) return [];
  return text
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function resolveRecommendationAutoRunOptions(input = {}, userSettings = {}) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    targetCount: clampInt(
      raw.targetCount ?? userSettings.recommendationDailyAutoTargetCount,
      1,
      100,
      80,
    ),
    cooldownDays: clampInt(
      raw.cooldownDays ??
        userSettings.recommendationDailyAutoCooldownDays ??
        userSettings.recommendationCooldownDays,
      1,
      60,
      7,
    ),
    uploadLimit: clampInt(
      raw.limit ?? raw.uploadLimit ?? userSettings.recommendationDailyAutoUploadLimit,
      1,
      30,
      3,
    ),
    onlyEligible: parseBooleanFlag(
      raw.onlyEligible ?? userSettings.recommendationDailyAutoOnlyEligible,
      true,
    ),
    force: parseForceFlag(raw.force ?? userSettings.recommendationDailyAutoForce),
    keywords: normalizeKeywordInput(raw.keywords ?? userSettings.recommendationDailyAutoKeywords),
  };
}

function buildAutoRecommendationSettings(baseSettings = {}) {
  const base = buildRecommendationRunSettings(
    baseSettings && typeof baseSettings === "object" ? baseSettings : {},
    { strictMode: false },
  );
  return {
    ...base,
    // Auto mode should stay bounded even if test-mode relax flags are enabled in UI.
    recommendationDisablePreviewTimeout: false,
    recommendationDisablePreviewPlaywrightRetryBudget: false,
    recommendationDisablePreviewPlaywrightBudget: false,
    recommendationPreviewPlaywrightRetryBudget: clampInt(
      base.recommendationPreviewPlaywrightRetryBudget,
      1,
      12,
      4,
    ),
    recommendationPreviewOpenApiTimeoutMs: clampInt(
      base.recommendationPreviewOpenApiTimeoutMs,
      1800,
      9000,
      4500,
    ),
    recommendationPreviewPlaywrightTimeoutMs: clampInt(
      base.recommendationPreviewPlaywrightTimeoutMs,
      12000,
      30000,
      14000,
    ),
  };
}

const recommendationDailyAutoRunState = {
  running: false,
  lastRunAt: "",
  lastRunDateKey: "",
  lastError: "",
  lastResults: [],
};

const recommendationDailyAutoSchedulerState = {
  enabled: false,
  hour: 9,
  minute: 0,
  intervalMs: 60_000,
  startedAt: "",
};

const catalogAutoSyncState = {
  enabled: false,
  running: false,
  intervalMs: 15 * 60_000,
  limitPerUser: 200,
  includeHistory: false,
  pauseWhenUpload: true,
  startedAt: "",
  lastRunAt: "",
  lastError: "",
  lastStats: null,
};

async function runRecommendationAutoRunForUser({
  user,
  options = {},
  reason = "manual",
} = {}) {
  const userId = String(user?.id || "").trim();
  if (!userId) {
    return { ok: false, error: "missing_user_id", reason };
  }

  const userSettings = user?.settings || {};
  const runOptions = resolveRecommendationAutoRunOptions(options, userSettings);
  const runSettings = buildAutoRecommendationSettings(userSettings);
  const runUser = { ...user, settings: runSettings };

  const fill = await refreshRecommendationsForUser({
    userId,
    settings: runSettings,
    keywords: runOptions.keywords,
    targetCount: runOptions.targetCount,
    cooldownDays: runOptions.cooldownDays,
  });

  const recoItems = await listRecommendations(userId, {
    limit: Math.max(50, runOptions.uploadLimit * 4),
  });
  const candidates = recoItems
    .filter((it) => {
      const url = String(it?.sourceUrl || "").trim();
      if (!url) return false;
      if (!runOptions.onlyEligible) return true;
      return Boolean(it?.qc?.eligibleUpload);
    })
    .slice(0, runOptions.uploadLimit);

  const uploadRows = [];
  let uploadLockSkipped = false;
  if (candidates.length > 0) {
    try {
      await withUploadLock(async () => {
        for (const cand of candidates) {
          const overrides = resolveRecommendationUploadOverrides(cand);
          const outcome = await executeUploadForUrl({
            url: cand.sourceUrl,
            user: runUser,
            force: runOptions.force,
            overrides,
          });
          appendUploadHistoryFromOutcome(cand.sourceUrl, outcome);
          uploadRows.push({
            recommendationId: cand.id || null,
            title: cand.title || "",
            seoTitle: cand.seoTitle || cand.title || "",
            url: cand.sourceUrl,
            categoryOverrideCode: overrides.categoryOverrideCode || null,
            ok: Boolean(outcome?.ok),
            skipped: Boolean(outcome?.skipped),
            skipReason: normalizeSkipReason(outcome),
            error: outcome?.error || null,
            sellerProductId: resolveOutcomeSellerProductId(outcome),
          });
        }
      });
    } catch (e) {
      if (String(e?.code || "").toLowerCase() === "upload_in_progress") {
        uploadLockSkipped = true;
      } else {
        throw e;
      }
    }
  }

  const uploadSummary = {
    requested: runOptions.uploadLimit,
    candidates: candidates.length,
    uploaded: uploadRows.filter((x) => x.ok && !x.skipped).length,
    skipped: uploadRows.filter((x) => x.skipped).length,
    failed: uploadRows.filter((x) => !x.ok && !x.skipped).length,
    lockSkipped: uploadLockSkipped,
    onlyEligible: runOptions.onlyEligible,
    force: runOptions.force,
  };

  return {
    ok: true,
    reason,
    userId,
    userEmail: String(user?.email || "").trim(),
    options: runOptions,
    fill,
    upload: uploadSummary,
    items: uploadRows,
  };
}

async function runRecommendationDailyAutoRunOnce({ reason = "scheduler" } = {}) {
  if (recommendationDailyAutoRunState.running) {
    return { ok: false, skipped: true, reason: "already_running" };
  }
  recommendationDailyAutoRunState.running = true;
  recommendationDailyAutoRunState.lastError = "";

  try {
    const users = await listUsersWithSettings({ limit: 1000 });
    const enabledUsers = users.filter((u) =>
      parseBooleanFlag(u?.settings?.recommendationDailyAutoEnabled, false),
    );

    const results = [];
    for (const user of enabledUsers) {
      try {
        const result = await runRecommendationAutoRunForUser({ user, reason });
        results.push(result);
      } catch (e) {
        results.push({
          ok: false,
          reason,
          userId: String(user?.id || "").trim(),
          userEmail: String(user?.email || "").trim(),
          error: String(e?.message || e),
        });
      }
    }

    const now = new Date();
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    recommendationDailyAutoRunState.lastRunAt = now.toISOString();
    recommendationDailyAutoRunState.lastRunDateKey = dateKey;
    recommendationDailyAutoRunState.lastResults = results.slice(0, 50);

    return {
      ok: true,
      reason,
      ranAt: recommendationDailyAutoRunState.lastRunAt,
      dateKey,
      totalUsers: users.length,
      enabledUsers: enabledUsers.length,
      results,
    };
  } catch (e) {
    recommendationDailyAutoRunState.lastError = String(e?.message || e);
    return {
      ok: false,
      reason,
      error: recommendationDailyAutoRunState.lastError,
    };
  } finally {
    recommendationDailyAutoRunState.running = false;
  }
}

function startRecommendationDailyAutoRunLoop({
  hour = 9,
  minute = 0,
  intervalMs = 60_000,
} = {}) {
  const runHour = clampInt(hour, 0, 23, 9);
  const runMinute = clampInt(minute, 0, 59, 0);
  const tickIntervalMs = clampInt(intervalMs, 10_000, 600_000, 60_000);

  const tick = async () => {
    try {
      const now = new Date();
      if (now.getHours() !== runHour || now.getMinutes() !== runMinute) return;
      const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (recommendationDailyAutoRunState.lastRunDateKey === dateKey) return;

      const run = await runRecommendationDailyAutoRunOnce({ reason: "scheduler" });
      if (!run?.ok) {
        log("[reco-auto] daily run failed", run);
      } else {
        const uploaded = (Array.isArray(run.results) ? run.results : []).reduce(
          (acc, row) => acc + Number(row?.upload?.uploaded || 0),
          0,
        );
        log(
          `[reco-auto] daily run done users=${run.enabledUsers}/${run.totalUsers} uploaded=${uploaded}`,
        );
      }
    } catch (e) {
      log("[reco-auto] scheduler tick error", String(e?.message || e));
    }
  };

  const t = setInterval(tick, tickIntervalMs);
  t.unref?.();
  return { timer: t, hour: runHour, minute: runMinute, intervalMs: tickIntervalMs };
}

async function runCatalogAutoSyncOnce({ reason = "scheduler" } = {}) {
  if (catalogAutoSyncState.running) {
    return { ok: false, skipped: true, reason: "already_running" };
  }
  if (catalogAutoSyncState.pauseWhenUpload && uploadInProgress) {
    return { ok: false, skipped: true, reason: "upload_in_progress" };
  }

  catalogAutoSyncState.running = true;
  catalogAutoSyncState.lastError = "";
  try {
    const users = await listUsersWithSettings({ limit: 1000 });
    const enabledUsers = users.filter((u) =>
      parseBooleanFlag(u?.settings?.catalogAutoSyncEnabled, true),
    );

    const skipStatuses = new Set(["deleted_local", "deleted_remote"]);
    const perUser = [];
    let totalTargets = 0;
    let totalSuccess = 0;
    let totalFailed = 0;

    for (const user of enabledUsers) {
      const listed = await listUploadedProducts({
        userId: user.id,
        q: "",
        status: "",
        limit: Math.max(1, Math.min(500, Number(catalogAutoSyncState.limitPerUser) || 200)),
        offset: 0,
      });

      const targets = [];
      const seenSpid = new Set();
      for (const row of listed.items || []) {
        const status = String(row?.status || "").trim().toLowerCase();
        if (skipStatuses.has(status)) continue;
        const spid = String(row?.sellerProductId || "").trim();
        if (!spid) continue;
        if (seenSpid.has(spid)) continue;
        seenSpid.add(spid);
        targets.push(spid);
      }

      let success = 0;
      let failed = 0;
      for (const sellerProductId of targets) {
        try {
          const synced = await syncUploadedProductStatusOne({
            userId: user.id,
            userSettings: user.settings || {},
            sellerProductId,
            includeHistory: Boolean(catalogAutoSyncState.includeHistory),
          });
          if (synced?.ok) success += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }

      totalTargets += targets.length;
      totalSuccess += success;
      totalFailed += failed;
      perUser.push({
        userId: String(user?.id || "").trim(),
        userEmail: String(user?.email || "").trim(),
        targets: targets.length,
        success,
        failed,
      });
    }

    const ranAt = new Date().toISOString();
    const summary = {
      reason,
      ranAt,
      totalUsers: users.length,
      enabledUsers: enabledUsers.length,
      targets: totalTargets,
      success: totalSuccess,
      failed: totalFailed,
      users: perUser.slice(0, 200),
    };
    catalogAutoSyncState.lastRunAt = ranAt;
    catalogAutoSyncState.lastStats = summary;
    return { ok: true, ...summary };
  } catch (e) {
    catalogAutoSyncState.lastError = String(e?.message || e);
    return {
      ok: false,
      reason,
      error: catalogAutoSyncState.lastError,
    };
  } finally {
    catalogAutoSyncState.running = false;
  }
}

function startCatalogAutoSyncLoop({
  intervalMs = 15 * 60_000,
  initialDelayMs = 20_000,
} = {}) {
  const tickIntervalMs = clampInt(intervalMs, 60_000, 3_600_000, 15 * 60_000);
  const firstDelayMs = clampInt(initialDelayMs, 1_000, 300_000, 20_000);

  const tick = async () => {
    try {
      const run = await runCatalogAutoSyncOnce({ reason: "scheduler" });
      if (run?.ok) {
        log(
          `[catalog-auto-sync] run done users=${run.enabledUsers}/${run.totalUsers} targets=${run.targets} success=${run.success} failed=${run.failed}`,
        );
      } else if (!run?.skipped) {
        log("[catalog-auto-sync] run failed", run);
      }
    } catch (e) {
      log("[catalog-auto-sync] tick error", String(e?.message || e));
    }
  };

  const t = setInterval(tick, tickIntervalMs);
  t.unref?.();

  const first = setTimeout(() => {
    tick().catch(() => {});
  }, firstDelayMs);
  first.unref?.();

  return { timer: t, intervalMs: tickIntervalMs, initialDelayMs: firstDelayMs };
}

function parseBulkUrls(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeSkipReason(result) {
  const raw = String(result?.skipReason || result?.reason || result?.error || "").trim();
  if (!raw) return null;
  if (raw === "duplicate_url") return "duplicate_url";
  if (raw === "duplicate_title") return "duplicate_title";
  if (raw === "duplicate_fingerprint") return "duplicate_fingerprint";
  if (raw === "qc_gate_failed") return "qc_gate_failed";
  return raw;
}

function resolveRecommendationUploadOverrides(item = {}) {
  const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};
  const seo = payload?.seo && typeof payload.seo === "object" ? payload.seo : {};
  const category = payload?.category && typeof payload.category === "object" ? payload.category : {};
  const keyword = pickFirstNonEmpty(item?.keyword, seo?.keyword);
  const searchTags = normalizeStringList(
    [
      ...(Array.isArray(item?.searchTags) ? item.searchTags : []),
      ...(Array.isArray(seo?.searchTags) ? seo.searchTags : []),
    ],
    20,
  )
    .map((x) => x.slice(0, 20).trim())
    .filter(Boolean)
    .slice(0, 10);

  const titleOverrideRaw = pickFirstNonEmpty(item?.seoTitle, seo?.title, item?.title);
  const titleOverride = String(titleOverrideRaw || "").trim();
  const categoryOverrideCode = toPositiveIntOrNull(item?.categoryCode ?? category?.code);

  const overrides = {};
  if (titleOverride) {
    overrides.titleOverride = titleOverride;
    overrides.seedTitle = titleOverride;
  }
  if (keyword) overrides.keyword = keyword;
  if (searchTags.length > 0) overrides.searchTags = searchTags;
  if (categoryOverrideCode) overrides.categoryOverrideCode = categoryOverrideCode;
  return overrides;
}

function resolveOutcomeSellerProductId(outcome) {
  const fromCreate = outcome?.result?.create?.sellerProductId;
  if (fromCreate != null && String(fromCreate).trim()) return String(fromCreate).trim();

  const dup = outcome?.duplicate || outcome?.result?.duplicate;
  const fromDuplicate = dup?.sellerProductId ?? dup?.seller_product_id;
  if (fromDuplicate != null && String(fromDuplicate).trim()) return String(fromDuplicate).trim();

  return null;
}

function buildSkippedResult(outcome) {
  const skipReason = normalizeSkipReason(outcome);
  return {
    ok: false,
    skipped: true,
    skipReason,
    reason: skipReason,
    error: skipReason,
    detail: outcome?.detail || null,
    duplicate: outcome?.duplicate || null,
    create: {
      status: null,
      body: null,
      sellerProductId: resolveOutcomeSellerProductId(outcome),
    },
    followUp: {
      statusName: null,
    },
  };
}

function appendUploadHistoryFromOutcome(url, outcome) {
  const result = outcome?.result || null;
  appendUploadHistory({
    at: new Date().toISOString(),
    url,
    ok: Boolean(outcome?.ok),
    skipped: Boolean(outcome?.skipped),
    skipReason: normalizeSkipReason(outcome),
    payloadOnly: Boolean(result?.payloadOnly),
    title: result?.draft?.title || outcome?.preview?.title || "",
    finalPrice: result?.finalPrice ?? null,
    optionsCount: Array.isArray(result?.optionsUsed) ? result.optionsUsed.length : 0,
    sellerProductId: resolveOutcomeSellerProductId(outcome),
    createStatus: result?.create?.status ?? null,
    error: result?.error || outcome?.error || null,
  });
}

function applyPreviewOverrides(preview, overrides = {}) {
  const out = preview ? JSON.parse(JSON.stringify(preview)) : preview;
  if (!out || !out.draft) return out;

  const titleOverride = String(overrides.titleOverride || '').trim();
  if (titleOverride) {
    out.draft.title = titleOverride;
  }

  if (Array.isArray(overrides.imagesOverride) && overrides.imagesOverride.length > 0) {
    if (!out.preview) out.preview = {};
    out.preview.contentImagesFiltered = overrides.imagesOverride.map((x) => String(x || '').trim()).filter(Boolean);
    out.preview.imageCountFiltered = out.preview.contentImagesFiltered.length;
  }

  return out;
}

async function executeUploadForUrl({ url, user, force = false, overrides = {} }) {
  const c = classifyUrl(url);
  if (!c.ok) {
    return { ok: false, skipped: true, skipReason: c.reason, reason: c.reason, url: c.url };
  }

  const baseSettings = user?.settings || {};
  const settings = {
    ...baseSettings,
    ...(String(overrides?.titleOverride || '').trim()
      ? { titleOverride: String(overrides.titleOverride).trim() }
      : {}),
    ...(String(overrides?.seedTitle || overrides?.titleOverride || '').trim()
      ? { seedTitle: String(overrides.seedTitle || overrides.titleOverride).trim() }
      : {}),
    ...(Number.isFinite(Number(overrides?.seedPrice)) && Number(overrides.seedPrice) > 0
      ? { seedPrice: Number(overrides.seedPrice) }
      : {}),
    ...(String(overrides?.seedImageUrl || '').trim()
      ? { seedImageUrl: String(overrides.seedImageUrl).trim() }
      : {}),
    ...(String(overrides?.keyword || '').trim()
      ? { keyword: String(overrides.keyword).trim() }
      : {}),
    ...(Array.isArray(overrides?.searchTags) && overrides.searchTags.length > 0
      ? { searchTags: normalizeStringList(overrides.searchTags, 20) }
      : {}),
    ...(Number.isFinite(Number(overrides?.categoryOverrideCode))
      ? { categoryOverrideCode: Number(overrides.categoryOverrideCode) }
      : {}),
  };

  const previewRaw = await previewUploadFromUrl(c.url, settings);
  const preview = applyPreviewOverrides(previewRaw, overrides);
  if (!preview?.ok) {
    const reason = String(preview?.reason || preview?.error || "preview_failed");
    return {
      ok: false,
      skipped: true,
      skipReason: reason,
      reason,
      error: reason,
      url: c.url,
    };
  }

  const qc = evaluateQcGate(preview.preview || {}, settings);
  if (!qc.ok) {
    return {
      ok: false,
      skipped: true,
      skipReason: "qc_gate_failed",
      error: "qc_gate_failed",
      detail: { reasons: qc.reasons, metrics: qc.metrics },
      preview: preview.preview,
      url: c.url,
    };
  }

  const imageFingerprint = String(preview?.preview?.imageFingerprint || "").trim();
  const draftTitle = String(preview?.draft?.title || "").trim();

  if (!force) {
    const duplicate = await findDuplicateUpload({
      userId: user?.id,
      sourceUrl: c.url,
      title: draftTitle,
      imageFingerprint,
    });
    if (duplicate?.duplicate) {
      const dupRow = duplicate?.row && typeof duplicate.row === "object" ? duplicate.row : null;
      const dupSpid = String(dupRow?.sellerProductId || "").trim();
      let allowFreshUpload = false;
      if (dupSpid) {
        try {
          const live = await fetchSellerStatusLive({
            sellerProductId: dupSpid,
            settings: settings || {},
            includeHistory: true,
          });
          allowFreshUpload = isRemoteDeleted(live);
          if (allowFreshUpload) {
            // Duplicate row points to a remotely deleted product.
            // Mark local row as deleted and continue to upload a fresh product.
            try {
              if (dupRow?.id != null && String(user?.id || "").trim()) {
                const nextMeta = dupRow?.meta && typeof dupRow.meta === "object" ? { ...dupRow.meta } : {};
                nextMeta.remoteDeleted = true;
                nextMeta.remoteDeletedAt = new Date().toISOString();
                nextMeta.lastRemoteError = live;
                await updateUploadedProductById({
                  userId: user.id,
                  id: dupRow.id,
                  patch: {
                    status: "deleted_remote",
                    metaReplace: nextMeta,
                  },
                });
              }
            } catch {}
          }
        } catch {
          allowFreshUpload = false;
        }
      }

      if (!allowFreshUpload) {
        return {
          ok: true,
          skipped: true,
          skipReason: duplicate.reason,
          reason: duplicate.reason,
          duplicate: duplicate.row,
          preview: preview.preview,
          url: c.url,
        };
      }
    }
  }

  const result = await runUploadFromUrl(c.url, settings, { preview });
  if (!result?.ok) {
    const skipReason = normalizeSkipReason(result);
    return {
      ok: false,
      skipped: Boolean(result?.skipped),
      skipReason,
      error: result?.error || skipReason || "upload_failed",
      detail: result?.detail || null,
      result,
      preview: preview.preview,
      url: c.url,
    };
  }

  if (!result.payloadOnly) {
    const createdSellerProductId = String(result?.create?.sellerProductId || "").trim() || null;
    const fallbackTitle = String(result?.draft?.title || draftTitle || "").trim();
    const fallbackImageUrl = normalizeImageUrlForClient(
      pickFirstNonEmpty(result?.draft?.imageUrl, preview?.draft?.imageUrl),
    );
    const previewDetailImages = normalizeImageListForClient(
      uniqueStrings([
        ...(Array.isArray(result?.preview?.contentImagesFiltered) ? result.preview.contentImagesFiltered : []),
        ...(Array.isArray(preview?.preview?.contentImagesFiltered) ? preview.preview.contentImagesFiltered : []),
      ]),
      200,
    );
    const seededDetailImages = previewDetailImages.length > 0
      ? previewDetailImages
      : normalizeImageListForClient(
          fallbackImageUrl ? [fallbackImageUrl] : [],
          200,
        );

    const followUpMeta =
      result?.followUp && typeof result.followUp === "object"
        ? JSON.parse(JSON.stringify(result.followUp))
        : {};
    if (createdSellerProductId && !String(followUpMeta?.sellerProductId || "").trim()) {
      followUpMeta.sellerProductId = createdSellerProductId;
    }
    followUpMeta.mainImageUrl = normalizeImageUrlForClient(followUpMeta.mainImageUrl);
    followUpMeta.detailImages = normalizeImageListForClient(
      Array.isArray(followUpMeta.detailImages) ? followUpMeta.detailImages : [],
      200,
    );
    const followUpProductId = pickFirstNonEmpty(followUpMeta.productId);
    const followUpProductUrl = pickFirstNonEmpty(
      followUpMeta.productUrl,
      buildCoupangProductUrl(followUpProductId),
    );
    if (followUpProductId) followUpMeta.productId = followUpProductId;
    if (followUpProductUrl) followUpMeta.productUrl = followUpProductUrl;

    const nextMeta = {
      skipReason: null,
      createStatus: result?.create?.status ?? null,
      confirmedTitle: fallbackTitle,
      mainImageUrl: fallbackImageUrl,
      detailImages: seededDetailImages,
      followUp: followUpMeta,
      categoryOverride:
        toPositiveIntOrNull(result?.category?.used) ||
        toPositiveIntOrNull(result?.category?.requested) ||
        null,
    };
    if (result?.sourcePurchase && typeof result.sourcePurchase === "object") {
      nextMeta.sourcePurchase = JSON.parse(JSON.stringify(result.sourcePurchase));
    }
    if (followUpProductId) nextMeta.productId = followUpProductId;
    if (followUpProductUrl) nextMeta.productUrl = followUpProductUrl;

    let nextStatus = "uploaded";
    if (createdSellerProductId) {
      try {
        const live = await fetchSellerStatusLive({
          sellerProductId: createdSellerProductId,
          settings: settings || {},
          includeHistory: false,
        });
        if (live?.ok) {
          Object.assign(
            nextMeta,
            applyLiveSnapshotToMeta(nextMeta, live, {
              fallbackTitle,
              fallbackImageUrl,
            }),
          );
          nextMeta.lastSyncedAt = new Date().toISOString();
          nextStatus = inferCatalogStatus("uploaded", live, "uploaded");
          if (nextStatus === "deployed") nextMeta.deployedAt = new Date().toISOString();
        } else if (live) {
          nextMeta.lastRemoteError = live;
        }
      } catch {}
    }

    await recordUploadedProduct({
      userId: user?.id,
      sourceUrl: c.url,
      title: fallbackTitle,
      imageUrl: fallbackImageUrl,
      imageFingerprint,
      sellerProductId: createdSellerProductId,
      status: nextStatus,
      meta: nextMeta,
    });
  }

  return {
    ok: true,
    skipped: Boolean(result?.skipped),
    result,
    preview: preview.preview,
    url: c.url,
  };
}

async function withUploadLock(handler) {
  if (uploadInProgress) {
    const err = new Error("upload in progress");
    err.code = "upload_in_progress";
    throw err;
  }
  uploadInProgress = true;
  try {
    return await handler();
  } finally {
    uploadInProgress = false;
  }
}

async function runUploadLocked(handler, res) {
  try {
    return await withUploadLock(handler);
  } catch (e) {
    if (String(e?.code || "").toLowerCase() === "upload_in_progress") {
      return res.status(409).json({ ok: false, error: "upload in progress" });
    }
    throw e;
  }
}

// ✅ 업로드 미리보기 + QC
app.post("/api/upload/preview", authRequired, async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });
    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    const previewRaw = await previewUploadFromUrl(c.url, req.user.settings || {});
    const preview = await enrichPreviewForClient(previewRaw, req.user.settings || {});
    if (!preview?.ok) {
      return res.status(400).json({ ok: false, error: preview?.reason || preview?.error || "preview_failed" });
    }

    const qc = evaluateQcGate(preview.preview || {}, req.user.settings || {});
    const duplicate = await findDuplicateUpload({
      userId: req.user.id,
      sourceUrl: c.url,
      title: preview?.draft?.title || "",
      imageFingerprint: preview?.preview?.imageFingerprint || "",
    });

    return res.json({
      ok: true,
      preview,
      qc,
      duplicate,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 단건 업로드 실행
async function handleSingleUpload(req, res) {
  return runUploadLocked(async () => {
    try {
      const url = String(req.body?.url || "").trim();
      if (!url) return res.status(400).json({ ok: false, error: "missing url" });
      const force = parseForceFlag(req.body?.force ?? req.query?.force);
      const overrides = {
        titleOverride: req.body?.titleOverride,
        seedTitle: req.body?.seedTitle,
        seedPrice: req.body?.seedPrice,
        seedImageUrl: req.body?.seedImageUrl,
        keyword: req.body?.keyword,
        searchTags: Array.isArray(req.body?.searchTags) ? req.body.searchTags : undefined,
        imagesOverride: Array.isArray(req.body?.imagesOverride) ? req.body.imagesOverride : undefined,
        categoryOverrideCode: req.body?.categoryOverrideCode,
      };

      const outcome = await executeUploadForUrl({ url, user: req.user, force, overrides });
      appendUploadHistoryFromOutcome(url, outcome);

      if (!outcome.ok && !outcome.skipped) {
        return res.status(400).json({ ok: false, error: outcome.error || "upload_failed", outcome });
      }

      if (outcome.skipped) {
        const result = buildSkippedResult(outcome);
        return res.json({
          ok: true,
          skipped: true,
          skipReason: normalizeSkipReason(outcome),
          result,
          outcome,
        });
      }

      return res.json({ ok: true, result: outcome.result, outcome });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }, res);
}

// ✅ 업로드 API (기존 호환)
app.post("/api/upload", authRequired, handleSingleUpload);

// ✅ 업로드 실행 API
app.post("/api/upload/execute", authRequired, handleSingleUpload);

// ✅ bulk 업로드 비동기 시작 (Cloudflare timeout 회피)
app.post("/api/upload/bulk/start", authRequired, async (req, res) => {
  try {
    const urls = parseBulkUrls(req.body?.urls || req.body?.text || "");
    if (urls.length === 0) {
      return res.status(400).json({ ok: false, error: "missing urls" });
    }
    if (urls.length > 100) {
      return res.status(400).json({ ok: false, error: "too_many_urls(max:100)" });
    }

    const force = parseForceFlag(req.body?.force ?? req.query?.force);
    const overridesByUrlRaw =
      req.body?.overridesByUrl && typeof req.body.overridesByUrl === "object"
        ? req.body.overridesByUrl
        : {};

    const running = getRunningUploadBulkJobForUser(req.user?.id);
    if (running) {
      return res.json({
        ok: true,
        reused: true,
        job: compactLegacyJob(running),
      });
    }

    // Preserve existing upload lock semantics (single upload pipeline at a time).
    // If another upload is already running, fail fast with 409.
    if (uploadInProgress) {
      return res.status(409).json({ ok: false, error: "upload in progress" });
    }

    const started = startUploadBulkJob({
      user: req.user,
      urls,
      force,
      overridesByUrl: overridesByUrlRaw,
    });
    return res.json({
      ok: true,
      reused: Boolean(started?.reused),
      job: compactLegacyJob(started?.job),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ bulk 업로드 실행
app.post("/api/upload/bulk", authRequired, async (req, res) => {
  return runUploadLocked(async () => {
    try {
      const urls = parseBulkUrls(req.body?.urls || req.body?.text || "");
      if (urls.length === 0) {
        return res.status(400).json({ ok: false, error: "missing urls" });
      }
      if (urls.length > 100) {
        return res.status(400).json({ ok: false, error: "too_many_urls(max:100)" });
      }

      const force = parseForceFlag(req.body?.force ?? req.query?.force);
      const overridesByUrlRaw =
        req.body?.overridesByUrl && typeof req.body.overridesByUrl === "object"
          ? req.body.overridesByUrl
          : {};
      const items = [];

      for (const url of urls) {
        try {
          const o = overridesByUrlRaw?.[url];
          const overrides = {
            titleOverride: o?.titleOverride,
            seedTitle: o?.seedTitle,
            seedPrice: o?.seedPrice,
            seedImageUrl: o?.seedImageUrl,
            keyword: o?.keyword,
            searchTags: Array.isArray(o?.searchTags) ? o.searchTags : undefined,
            imagesOverride: Array.isArray(o?.imagesOverride) ? o.imagesOverride : undefined,
            categoryOverrideCode: o?.categoryOverrideCode,
          };
          const outcome = await executeUploadForUrl({ url, user: req.user, force, overrides });
          appendUploadHistoryFromOutcome(url, outcome);
          items.push(normalizeBulkUploadJobRow({ url, outcome }));
        } catch (oneErr) {
          const oneErrorText = String(oneErr?.message || oneErr || "bulk_item_failed");
          appendUploadHistory({
            at: new Date().toISOString(),
            url,
            ok: false,
            skipped: false,
            skipReason: "",
            payloadOnly: false,
            title: "",
            finalPrice: null,
            optionsCount: 0,
            sellerProductId: "",
            createStatus: null,
            error: oneErrorText,
          });
          items.push(normalizeBulkUploadJobRow({ url, error: oneErrorText }));
        }
      }

      const summary = summarizeBulkUploadRows(items, force);

      return res.json({ ok: true, summary, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }, res);
});

app.get("/api/recommendations/categories", authRequired, async (_req, res) => {
  return res.json({
    ok: true,
    categories: listRecommendationCategoryPresets(),
  });
});

app.get("/api/recommendations", authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 40) || 40));
    const items = await listRecommendations(req.user.id, { limit });
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/recommendations/saved", authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200) || 200));
    const items = await listSavedRecommendations(req.user.id, { limit });
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/saved", authRequired, async (req, res) => {
  try {
    const item = req.body?.item && typeof req.body.item === "object" ? req.body.item : req.body || {};
    const saved = await saveRecommendationForUser({
      userId: req.user.id,
      item,
    });
    if (!saved?.ok) return res.status(400).json({ ok: false, error: saved?.error || "save_failed" });
    return res.json({ ok: true, saved });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/recommendations/saved", authRequired, async (req, res) => {
  try {
    const sourceUrl = String(req.query?.sourceUrl || "").trim();
    const removed = await removeSavedRecommendationForUser({
      userId: req.user.id,
      sourceUrl,
    });
    if (!removed?.ok) return res.status(400).json({ ok: false, error: removed?.error || "remove_failed" });
    return res.json({ ok: true, removed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/fill/start", authRequired, async (req, res) => {
  try {
    const params = parseRecommendationRunRequest(req);
    const runSettings = buildRecommendationRunSettings(
      req.user.settings || {},
      { strictMode: params.strictMode, targetCount: params.targetCount },
    );
    const started = startRecommendationRefreshJob({
      userId: req.user.id,
      settings: runSettings,
      keywords: params.keywords,
      targetCount: params.targetCount,
      cooldownDays: params.cooldownDays,
      kind: "recommendations_fill",
    });

    return res.json({
      ok: true,
      reused: Boolean(started.reused),
      request: {
        categoryKey: params.categoryKey,
        categoryLabel: params.categoryLabel,
        keywordSource: params.keywordSource,
        keywordsCount: params.keywords.length,
      },
      job: compactLegacyJob(started.job),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/fill", authRequired, async (req, res) => {
  try {
    const params = parseRecommendationRunRequest(req);
    const runSettings = buildRecommendationRunSettings(
      req.user.settings || {},
      { strictMode: params.strictMode, targetCount: params.targetCount },
    );
    // Product decision: "fill" is now replace-mode.
    const fill = await refreshRecommendationsForUser({
      userId: req.user.id,
      settings: runSettings,
      keywords: params.keywords,
      targetCount: params.targetCount,
      cooldownDays: params.cooldownDays,
    });

    const items = await listRecommendations(req.user.id, {
      limit: Math.max(40, params.targetCount),
    });

    return res.json({
      ok: true,
      fill,
      request: {
        categoryKey: params.categoryKey,
        categoryLabel: params.categoryLabel,
        keywordSource: params.keywordSource,
        keywordsCount: params.keywords.length,
      },
      items,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/refresh", authRequired, async (req, res) => {
  try {
    const params = parseRecommendationRunRequest(req);
    const runSettings = buildRecommendationRunSettings(
      req.user.settings || {},
      { strictMode: params.strictMode, targetCount: params.targetCount },
    );
    const started = startRecommendationRefreshJob({
      userId: req.user.id,
      settings: runSettings,
      keywords: params.keywords,
      targetCount: params.targetCount,
      cooldownDays: params.cooldownDays,
      kind: "recommendations_refresh",
    });

    const items = await listRecommendations(req.user.id, {
      limit: Math.max(40, params.targetCount),
    });

    const job = started.job;
    const status = String(job?.status || "").toLowerCase();
    const finished = status === "success" || status === "done";
    const fillResult = job?.result?.fill && typeof job.result.fill === "object"
      ? job.result.fill
      : {};
    const resultItems = Array.isArray(job?.result?.items) ? job.result.items : [];
    const refresh = finished
      ? fillResult
      : {
          pending: true,
          jobId: job?.id || null,
          reused: Boolean(started.reused),
          targetCount: params.targetCount,
          cooldownDays: params.cooldownDays,
          count: items.length,
          removedCount: 0,
        };

    return res.json({
      ok: true,
      pending: !finished,
      reused: Boolean(started.reused),
      request: {
        categoryKey: params.categoryKey,
        categoryLabel: params.categoryLabel,
        keywordSource: params.keywordSource,
        keywordsCount: params.keywords.length,
      },
      job: compactLegacyJob(job),
      refresh,
      items: finished && resultItems.length > 0 ? resultItems : items,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/auto-upload", authRequired, async (req, res) => {
  return runUploadLocked(async () => {
    try {
      const limit = Math.max(1, Math.min(30, Number(req.body?.limit || 5) || 5));
      const force = parseForceFlag(req.body?.force ?? req.query?.force);
      const onlyEligibleRaw = String(req.body?.onlyEligible ?? "1").trim().toLowerCase();
      const onlyEligible = !(onlyEligibleRaw === "0" || onlyEligibleRaw === "false" || onlyEligibleRaw === "no");
      const requestedSourceUrls = normalizeStringList(req.body?.sourceUrls, 200);

      const recoItems = await listRecommendations(req.user.id, {
        limit: Math.max(limit, 50, requestedSourceUrls.length),
      });
      const savedItems =
        requestedSourceUrls.length > 0
          ? await listSavedRecommendations(req.user.id, {
              limit: Math.max(limit, 50, requestedSourceUrls.length),
            })
          : [];
      const candidatePoolBySourceUrl = new Map(
        [...recoItems, ...savedItems].map((row) => [String(row?.sourceUrl || "").trim(), row]),
      );
      const orderedRecoItems = [];
      const orderedSeen = new Set();
      if (requestedSourceUrls.length > 0) {
        for (const rawUrl of requestedSourceUrls) {
          const sourceUrl = String(rawUrl || "").trim();
          if (!sourceUrl || orderedSeen.has(sourceUrl)) continue;
          orderedSeen.add(sourceUrl);
          const row = candidatePoolBySourceUrl.get(sourceUrl);
          if (row) orderedRecoItems.push(row);
        }
      }
      for (const row of recoItems) {
        const sourceUrl = String(row?.sourceUrl || "").trim();
        if (!sourceUrl || orderedSeen.has(sourceUrl)) continue;
        orderedSeen.add(sourceUrl);
        orderedRecoItems.push(row);
      }

      const candidates = orderedRecoItems
        .filter((it) => {
          const url = String(it?.sourceUrl || "").trim();
          if (!url) return false;
          if (!onlyEligible) return true;
          return Boolean(it?.qc?.eligibleUpload);
        })
        .slice(0, limit);

      const items = [];
      for (const cand of candidates) {
        const overrides = resolveRecommendationUploadOverrides(cand);
        const outcome = await executeUploadForUrl({
          url: cand.sourceUrl,
          user: req.user,
          force,
          overrides,
        });
        appendUploadHistoryFromOutcome(cand.sourceUrl, outcome);

        items.push({
          recommendationId: cand.id || null,
          title: cand.title || "",
          seoTitle: cand.seoTitle || cand.title || "",
          url: cand.sourceUrl,
          categoryOverrideCode: overrides.categoryOverrideCode || null,
          ok: Boolean(outcome?.ok),
          skipped: Boolean(outcome?.skipped),
          skipReason: normalizeSkipReason(outcome),
          error: outcome?.error || null,
          sellerProductId: resolveOutcomeSellerProductId(outcome),
        });
      }

      const summary = {
        requested: limit,
        candidates: candidates.length,
        uploaded: items.filter((x) => x.ok && !x.skipped).length,
        skipped: items.filter((x) => x.skipped).length,
        failed: items.filter((x) => !x.ok && !x.skipped).length,
        onlyEligible,
        force,
        sourceOrderApplied: requestedSourceUrls.length > 0,
      };

      return res.json({ ok: true, summary, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }, res);
});

app.post("/api/recommendations/auto-run", authRequired, async (req, res) => {
  try {
    const result = await runRecommendationAutoRunForUser({
      user: req.user,
      options: req.body || {},
      reason: "api_manual",
    });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/recommendations/auto-run/status", authRequired, async (req, res) => {
  const userSettings = req.user?.settings || {};
  const userOptions = resolveRecommendationAutoRunOptions({}, userSettings);
  return res.json({
    ok: true,
    state: recommendationDailyAutoRunState,
    scheduler: recommendationDailyAutoSchedulerState,
    user: {
      id: String(req.user?.id || ""),
      email: String(req.user?.email || ""),
      enabled: parseBooleanFlag(userSettings.recommendationDailyAutoEnabled, false),
      options: userOptions,
    },
    serverNow: new Date().toISOString(),
  });
});

function getCoupangCredentials(settings = {}) {
  const accessKey = String(settings?.coupangAccessKey || "").trim();
  const secretKey = String(settings?.coupangSecretKey || "").trim();
  const vendorId = String(settings?.coupangVendorId || "").trim();
  return { accessKey, secretKey, vendorId };
}

function validateCoupangCredentials(settings = {}) {
  const { accessKey, secretKey, vendorId } = getCoupangCredentials(settings);
  const missing = [];
  if (!accessKey) missing.push("쿠팡 Access Key");
  if (!secretKey) missing.push("쿠팡 Secret Key");
  if (!vendorId) missing.push("쿠팡 Vendor ID");
  return { accessKey, secretKey, vendorId, missing };
}

function normalizeIdList(raw) {
  const src = Array.isArray(raw) ? raw : [raw];
  return src
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
}

function normalizeOrderStatusList(raw, fallback = ["ACCEPT"]) {
  const src = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
  const out = src
    .map((x) => String(x || "").trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(out.length > 0 ? out : fallback));
}

function parseCoupangBody(raw) {
  try {
    return typeof raw === "string" ? parseCoupangJson(raw) : raw;
  } catch {
    return null;
  }
}

function isCoupangSuccessCode(code) {
  return code === 200 || code === "200" || code === "SUCCESS";
}

function normalizeInvoiceItems(raw, defaultDeliveryCompanyCode = "") {
  const items = Array.isArray(raw) ? raw : [];
  const fallbackCompany = String(defaultDeliveryCompanyCode || "").trim();
  return items
    .map((entry) => {
      const dto = entry && typeof entry === "object" ? entry : {};
      return {
        shipmentBoxId: String(dto.shipmentBoxId ?? "").trim(),
        orderId: String(dto.orderId ?? "").trim(),
        vendorItemId: String(dto.vendorItemId ?? "").trim(),
        deliveryCompanyCode: String(dto.deliveryCompanyCode ?? fallbackCompany).trim(),
        invoiceNumber: String(dto.invoiceNumber ?? "").trim(),
        splitShipping: dto.splitShipping === true,
        preSplitShipped: dto.preSplitShipped === true,
        estimatedShippingDate: String(dto.estimatedShippingDate ?? "").trim(),
      };
    })
    .filter((x) => x.shipmentBoxId && x.orderId && x.vendorItemId && x.deliveryCompanyCode && x.invoiceNumber);
}

async function syncShipmentBoxesFromCoupang({ userId, settings = {}, shipmentBoxIds = [], statusFallback = "" }) {
  const ids = normalizeIdList(shipmentBoxIds);
  if (ids.length === 0) return { ok: true, synced: 0, items: [] };

  const { accessKey, secretKey, vendorId, missing } = validateCoupangCredentials(settings);
  if (missing.length > 0) {
    return { ok: false, reason: "missing_keys", missing };
  }

  const items = [];
  let synced = 0;
  for (const shipmentBoxId of ids) {
    const res = await getOrderSheetByShipmentBoxId({
      vendorId,
      shipmentBoxId,
      accessKey,
      secretKey,
    });
    const body = parseCoupangBody(res.body);
    const ok = res.status === 200 && body && isCoupangSuccessCode(body?.code);
    if (!ok) {
      items.push({
        shipmentBoxId,
        ok: false,
        status: res.status,
        error: body?.message || "coupang_sheet_fetch_failed",
      });
      continue;
    }
    const data = Array.isArray(body?.data) ? body.data : [];
    const sheet = data[0] && typeof data[0] === "object" ? data[0] : null;
    if (!sheet) {
      items.push({
        shipmentBoxId,
        ok: false,
        status: res.status,
        error: "sheet_not_found",
      });
      continue;
    }
    const upsert = await upsertCoupangOrderSheet({
      userId,
      sheet,
      statusOverride: String(sheet?.status || statusFallback || "").trim(),
    });
    synced += Number(upsert?.upserted || 0);
    items.push({
      shipmentBoxId,
      ok: true,
      status: String(sheet?.status || statusFallback || "").trim(),
      upserted: Number(upsert?.upserted || 0),
    });
  }

  return { ok: true, synced, items };
}

// ✅ 주문 엑셀 생성
app.get("/api/orders", authRequired, async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const orders = await listOrders(req.user.id, limit);
    return res.json({ ok: true, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/orders/shipping/refresh", authRequired, async (req, res) => {
  try {
    const dateFrom = String(req.body?.dateFrom || "").trim();
    const dateTo = String(req.body?.dateTo || "").trim();
    const statuses = normalizeOrderStatusList(
      req.body?.statuses ?? req.body?.status,
      ["ACCEPT", "INSTRUCT", "READY", "DELIVERING", "DONE"],
    );
    const status = statuses[0] || "ACCEPT";
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ ok: false, error: "missing dates" });
    }

    const result = await refreshShippingStatusesFromCoupang({
      userId: req.user.id,
      settings: req.user.settings || {},
      dateFrom,
      dateTo,
      status,
      statuses,
    });

    if (!result?.ok) {
      const code = result?.reason === "missing_keys" || result?.reason === "missing_dates" ? 400 : 502;
      return res.status(code).json({ ok: false, error: String(result?.reason || "shipping_refresh_failed"), result });
    }

    return res.json({
      ok: true,
      result: {
        ...result,
        scanned: result.scannedSheets ?? 0,
        updated: result.processed ?? 0,
        statuses,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/orders/coupang/acknowledge", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const { accessKey, secretKey, vendorId, missing } = validateCoupangCredentials(settings);
    if (missing.length > 0) {
      return res.status(400).json({ ok: false, error: "missing_keys", missing });
    }

    const shipmentBoxIds = normalizeIdList(req.body?.shipmentBoxIds?.length ? req.body?.shipmentBoxIds : req.body?.shipmentBoxId);
    if (shipmentBoxIds.length === 0) {
      return res.status(400).json({ ok: false, error: "missing_shipment_box_ids" });
    }
    if (shipmentBoxIds.length > 50) {
      return res.status(400).json({ ok: false, error: "too_many_shipment_box_ids" });
    }

    const ackRes = await acknowledgeOrderSheets({
      vendorId,
      shipmentBoxIds,
      accessKey,
      secretKey,
    });
    const body = parseCoupangBody(ackRes.body);
    const ok = ackRes.status === 200 && body && isCoupangSuccessCode(body?.code);
    if (!ok) {
      return res.status(ackRes.status || 502).json({
        ok: false,
        error: "coupang_acknowledge_failed",
        status: ackRes.status,
        body,
      });
    }

    const responseList = Array.isArray(body?.data?.responseList) ? body.data.responseList : [];
    const successfulIds = responseList
      .filter((x) => x?.succeed === true)
      .map((x) => String(x?.shipmentBoxId ?? "").trim())
      .filter(Boolean);
    const sync = await syncShipmentBoxesFromCoupang({
      userId: req.user.id,
      settings,
      shipmentBoxIds: successfulIds,
      statusFallback: "INSTRUCT",
    });

    return res.json({
      ok: true,
      result: {
        responseCode: body?.data?.responseCode ?? null,
        responseMessage: body?.data?.responseMessage ?? body?.message ?? "",
        responseList,
        synced: Number(sync?.synced || 0),
        syncItems: Array.isArray(sync?.items) ? sync.items : [],
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/orders/coupang/invoices", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const { accessKey, secretKey, vendorId, missing } = validateCoupangCredentials(settings);
    if (missing.length > 0) {
      return res.status(400).json({ ok: false, error: "missing_keys", missing });
    }

    const items = normalizeInvoiceItems(
      req.body?.items,
      String(settings.coupangDeliveryCompanyCode || "").trim(),
    );
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: "missing_invoice_items" });
    }

    const uploadRes = await uploadOrderInvoices({
      vendorId,
      items,
      accessKey,
      secretKey,
    });
    const body = parseCoupangBody(uploadRes.body);
    const ok = uploadRes.status === 200 && body && isCoupangSuccessCode(body?.code);
    if (!ok) {
      return res.status(uploadRes.status || 502).json({
        ok: false,
        error: "coupang_invoice_upload_failed",
        status: uploadRes.status,
        body,
      });
    }

    const responseList = Array.isArray(body?.data?.responseList) ? body.data.responseList : [];
    const successfulIds = responseList
      .filter((x) => x?.succeed === true)
      .map((x) => String(x?.shipmentBoxId ?? "").trim())
      .filter(Boolean);
    const sync = await syncShipmentBoxesFromCoupang({
      userId: req.user.id,
      settings,
      shipmentBoxIds: successfulIds,
      statusFallback: "DELIVERING",
    });

    return res.json({
      ok: true,
      result: {
        responseCode: body?.data?.responseCode ?? null,
        responseMessage: body?.data?.responseMessage ?? body?.message ?? "",
        responseList,
        synced: Number(sync?.synced || 0),
        syncItems: Array.isArray(sync?.items) ? sync.items : [],
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/orders/export", authRequired, async (req, res) => {
  try {
    const dateFrom = String(req.body?.dateFrom || "").trim();
    const dateTo = String(req.body?.dateTo || "").trim();
    const vendor = String(req.body?.vendor || "domeggook").trim().toLowerCase() || "domeggook";
    const statuses = normalizeOrderStatusList(
      req.body?.statuses ?? req.body?.status,
      ["ACCEPT", "INSTRUCT", "READY"],
    );
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ ok: false, error: "missing dates" });
    }
    const result = await exportOrdersToDomeme({
      userId: req.user.id,
      dateFrom,
      dateTo,
      status: statuses[0] || "ACCEPT",
      statuses,
      vendor,
      settings: req.user.settings || {},
      allowEnvFallback: false,
    });
    const filePath = String(result?.filePath || "").trim();
    const fileName = filePath ? path.basename(filePath) : "";
    const downloadPath = fileName ? `/couplus-out/order_exports/${encodeURIComponent(fileName)}` : "";
    const base = getRequestBaseUrl(req);
    return res.json({
      ok: true,
      result: {
        ...result,
        vendor,
        statuses,
        fileName,
        downloadPath,
        downloadUrl: downloadPath ? (base ? `${base}${downloadPath}` : downloadPath) : "",
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ SKU 매핑 불러오기
app.get("/api/sku-map", authRequired, (req, res) => {
  try {
    const mapPath = path.join(process.cwd(), "data", "sku_map.json");
    if (!fs.existsSync(mapPath)) return res.json({ ok: true, map: {} });
    const map = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    return res.json({ ok: true, map });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ SKU 매핑 저장
app.post("/api/sku-map", authRequired, (req, res) => {
  try {
    const mapPath = path.join(process.cwd(), "data", "sku_map.json");
    const map = req.body?.map || {};
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf-8");
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 매핑 누락 목록
app.get("/api/orders/missing", authRequired, (req, res) => {
  try {
    const missingPath = path.join(process.cwd(), "out", "order_exports", "missing_sku_map.json");
    if (!fs.existsSync(missingPath)) return res.json({ ok: true, missing: [] });
    const missing = JSON.parse(fs.readFileSync(missingPath, "utf-8"));
    return res.json({ ok: true, missing });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매매 엑셀 업로드
app.post("/api/orders/upload", authRequired, async (req, res) => {
  try {
    const filePath = String(req.body?.filePath || "").trim();
    const vendor = String(req.body?.vendor || "domeme").trim().toLowerCase() || "domeme";
    if (!filePath) return res.status(400).json({ ok: false, error: "missing filePath" });
    const settings = req.user.settings || {};
    let result;

    if (vendor === "domeme" || vendor === "domeggook") {
      result = await uploadVendorPurchaseExcel({
        vendor,
        filePath,
        settings,
        storageStateDefaultPath: resolveStorageStatePath(settings, vendor),
      });
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_vendor" });
    }

    appendUserPurchaseLog(req.user.id, {
      type: "upload",
      vendor,
      ok: result?.ok === true,
      error: result?.ok === true ? undefined : String(result?.error || "upload_failed"),
      filePath,
      payUrl: result?.payUrl || "",
      warning: result?.warning || "",
    });

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/upload/history", authRequired, (req, res) => {
  return res.json({ ok: true, history: loadUploadHistory() });
});

function getRequestBaseUrl(req) {
  const protoRaw = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const hostRaw = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  const proto = protoRaw === "http" ? "http" : "https";
  if (!hostRaw) return "";
  return `${proto}://${hostRaw}`;
}

function buildTrackingUrl(req, slug) {
  const safeSlug = String(slug || "").trim();
  if (!safeSlug) return "";
  const pathOnly = `/go/m/${encodeURIComponent(safeSlug)}`;
  const base = getRequestBaseUrl(req);
  return base ? `${base}${pathOnly}` : pathOnly;
}

function normalizeKeywordTokens(raw, max = 6) {
  const words = String(raw || "")
    .replace(/[^0-9A-Za-z가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
  return Array.from(new Set(words)).slice(0, Math.max(1, Math.min(12, Number(max) || 6)));
}

function toHashtagToken(raw) {
  const cleaned = String(raw || "")
    .replace(/[^0-9A-Za-z가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.replace(/\s+/g, "");
}

function buildHashtags({ title = "", keyword = "", extra = [] } = {}) {
  const head = [
    "쿠팡추천",
    "오늘의특가",
    "생활템",
    "가성비템",
    ...normalizeKeywordTokens(keyword, 4),
    ...normalizeKeywordTokens(title, 6),
    ...(Array.isArray(extra) ? extra : []),
  ];
  const tags = [];
  const seen = new Set();
  for (const raw of head) {
    const token = toHashtagToken(raw);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(`#${token}`);
    if (tags.length >= 12) break;
  }
  return tags;
}

function pushUniqueText(list, raw, { keySet = null, max = 6 } = {}) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  if (!value) return;
  const key = value.toLowerCase();
  if (keySet) {
    if (keySet.has(key)) return;
    keySet.add(key);
  } else if (list.some((x) => String(x || "").toLowerCase() === key)) {
    return;
  }
  if (list.length < Math.max(1, Number(max) || 6)) list.push(value);
}

function extractProductFeatureHints(item = {}) {
  const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};
  const seo = payload?.seo && typeof payload.seo === "object" ? payload.seo : {};
  const title = String(item?.title || item?.seoTitle || "").trim();
  const keyword = String(item?.keyword || "").trim();
  const category = String(item?.category || item?.categoryLabel || "").trim();
  const searchTags = Array.isArray(seo?.searchTags) ? seo.searchTags : [];
  const combined = [title, keyword, category, ...searchTags].join(" ").replace(/\s+/g, " ").trim();
  const lowered = combined.toLowerCase();
  const out = [];
  const seen = new Set();

  const head = pickProductHead(title || keyword || category);
  if (head) pushUniqueText(out, `${head} 타입`, { keySet: seen, max: 5 });

  const specMatches = Array.from(
    new Set(
      (combined.match(/\d+\s*(?:단|칸|개입?|개|세트|종|cm|mm|ml|l|리터|kg|g)/gi) || [])
        .map((x) => x.replace(/\s+/g, "").trim())
        .filter(Boolean),
    ),
  );
  for (const raw of specMatches.slice(0, 3)) {
    const suffix = /(단|칸)$/i.test(raw) ? "구조" : "규격";
    pushUniqueText(out, `${raw} ${suffix}`, { keySet: seen, max: 5 });
  }

  const featurePatterns = [
    [/조립식/i, "조립식 구조"],
    [/접이식/i, "접이식 사용"],
    [/다용도/i, "다용도 활용"],
    [/(수납|정리)/i, "수납/정리 용도"],
    [/슬림/i, "슬림한 공간 활용"],
    [/이동식/i, "이동 가능한 구조"],
    [/서랍/i, "서랍형 구성"],
    [/선반/i, "선반형 구성"],
    [/바구니/i, "바구니형 수납"],
    [/행거/i, "행거형 구성"],
    [/트롤리/i, "트롤리형 이동"],
    [/(원목|우드)/i, "우드 톤 마감"],
    [/(스틸|철제|메탈|금속)/i, "금속 프레임"],
    [/(pp|abs|플라스틱)/i, "가벼운 플라스틱 소재"],
    [/메쉬/i, "메쉬 디테일"],
    [/투명/i, "투명한 소재감"],
    [/무타공/i, "무타공 설치"],
    [/높이조절/i, "높이 조절 가능"],
    [/회전/i, "회전형 사용"],
    [/차량용/i, "차량 공간용"],
    [/주방/i, "주방 공간용"],
    [/욕실/i, "욕실 공간용"],
    [/베란다/i, "베란다 공간용"],
  ];
  for (const [pattern, label] of featurePatterns) {
    if (pattern.test(lowered)) pushUniqueText(out, label, { keySet: seen, max: 5 });
  }

  for (const token of extractKeywordCandidates(title).slice(0, 6)) {
    if (token.length < 2 || /\d/.test(token)) continue;
    if (/(시스맥스|마이룸|쿠팡|추천|특가|정품|국산|브랜드)/i.test(token)) continue;
    if (/(선반|정리함|수납함|트롤리|행거|바구니|서랍|랙|케이스)/.test(token)) {
      pushUniqueText(out, `${token} 중심`, { keySet: seen, max: 5 });
    }
  }

  return out.slice(0, 5);
}

function buildReferenceImageGuide() {
  return [
    "메인 이미지와 글씨 없는 디테일 상품컷을 reference로 넣을 수 있습니다.",
    "상세페이지 전체 캡처, 가격/규격표, 글씨 많은 콜라주 이미지는 넣지 않습니다.",
    "정면 1장, 사선 1장, 디테일 1장처럼 깔끔한 상품 사진 1~4장을 고릅니다.",
    "얼굴 보이는 사람 컷은 제외하고, 손만 나온 사용컷은 필요하면 reference로 허용합니다.",
  ];
}

function buildReelsPack({
  item = {},
  trackedUrl = "",
  brand = "쿠팡코끼리",
  tone = "실용적",
} = {}) {
  const title = String(item?.title || item?.seoTitle || "").trim();
  const keyword = String(item?.keyword || "").trim();
  const price = Number(item?.finalPrice);
  const sourcePrice = Number(item?.sourcePrice);
  const margin = Number(item?.marginRate);
  const priceText = Number.isFinite(price) ? `${Math.round(price).toLocaleString("ko-KR")}원` : "가격 확인";
  const sourcePriceText = Number.isFinite(sourcePrice)
    ? `${Math.round(sourcePrice).toLocaleString("ko-KR")}원`
    : "";
  const marginText = Number.isFinite(margin) ? `${Math.round(margin * 100)}%` : "";
  const shortTitle = title.length > 38 ? `${title.slice(0, 38)}…` : title;
  const landingUrl = String(trackedUrl || item?.targetUrl || item?.productUrl || "").trim();
  const ctaUrlText = landingUrl || "프로필 링크";
  const reelCtaText = "프로필 링크에서 확인";
  const commentKeyword = "링크";
  const commentCtaText = `구매 링크가 필요하면 댓글에 "${commentKeyword}" 남겨주세요.`;
  const profileGuideText = "자세한 정보는 프로필 링크에서 확인해보세요.";
  const productFeatureHints = extractProductFeatureHints(item);
  const referenceImageGuide = buildReferenceImageGuide();
  const bgmSearchKeywords = [
    "cozy home instrumental",
    "clean room vlog",
    "soft lofi home",
    "warm daily acoustic",
    "calm lifestyle background",
  ];
  const bgmGuideText =
    "인스타 업로드 직전 음악 라이브러리에서 잔잔한 instrumental 위주로 고르세요. 너무 센 유행곡보다 설명을 방해하지 않는 홈/브이로그 계열이 더 안정적입니다. 나중에 광고 집행이나 부스트까지 생각하면 일반 인기곡보다 권한이 명확한 음원을 우선 보세요.";
  const hashtags = buildHashtags({ title, keyword, extra: [String(item?.category || "").trim()] });

  const hooks = [
    `${keyword || "생활 정리"} 고민, 10초 안에 끝`,
    "이 조합 하나면 정리 끝",
    `실사용 후 가장 만족한 ${keyword || "생활템"}`,
  ];

  const storyboards = [
    [
      "0-2초: 문제 제기 (어지러운 상태/불편한 장면)",
      `2-7초: 제품 등장 + 핵심 포인트 2개 (${shortTitle || keyword || "추천 상품"})`,
      "7-13초: 사용 장면 전/후 비교 + 핵심 효용 강조",
      `13-18초: CTA (${reelCtaText})`,
    ],
    [
      "0-3초: 후킹 문구 + 제품 클로즈업",
      "3-9초: 사용 방법 3스텝",
      "9-14초: 디테일 포인트와 사용성 강조",
      `14-20초: CTA + 신뢰 문구 (${brand}, ${reelCtaText})`,
    ],
    [
      "0-2초: 타겟 상황(산책/정리/차량/주방 등) 공감 문구",
      "2-8초: 불편 해결 시연",
      "8-14초: 디테일 컷(재질/크기/수납력)",
      `14-20초: CTA (${reelCtaText})`,
    ],
  ];

  const captions = [
    `${shortTitle}\n\n${keyword ? `${keyword} 찾는 분들` : "실사용 중심"}에게 맞춘 추천템입니다.\n${profileGuideText}\n${commentCtaText}`,
    `요즘 반응 좋은 ${keyword || "생활템"}.\n핵심만 짧게 보여드렸어요.\n${profileGuideText}\n${commentCtaText}`,
    `광고보다 실사용 중심으로 편집했습니다.\n${shortTitle}\n${profileGuideText}\n${commentCtaText}`,
  ];

  const instagramPostText = [
    hooks[0],
    "",
    shortTitle || keyword || "추천 상품",
    keyword ? `${keyword} 찾는 분들께 먼저 보여드리고 싶은 생활템입니다.` : "실사용 중심으로 보기 좋은 생활템입니다.",
    profileGuideText,
    commentCtaText,
    "",
    hashtags.join(" "),
  ].join("\n");

  const pinnedComment = landingUrl
    ? `요청 주신 구매 링크입니다 👇\n${landingUrl}`
    : `구매 링크는 프로필 링크에서 확인해 주세요.`;
  const commentReplyTemplate = landingUrl
    ? `링크 보내드려요 👇\n${landingUrl}\n궁금한 점 있으면 답글 남겨주세요.`
    : `링크는 프로필 링크에서 확인해 주세요.`;
  const dmReplyTemplate = landingUrl
    ? `${shortTitle || keyword || "추천 상품"}\n요청하신 링크 보내드려요 👇\n${landingUrl}\n필요한 정보 더 있으면 편하게 답장 주세요.`
    : `${shortTitle || keyword || "추천 상품"}\n구매 링크는 프로필 링크에서 확인해 주세요.`;
  const manychatPublicReplies = [
    "링크 DM으로 보내드렸어요. 메시지함 확인해 주세요.",
    "요청하신 링크 DM으로 전달드렸어요. 확인 부탁드려요.",
    "구매 링크 DM으로 보내드렸습니다. 궁금한 점 있으면 답글 남겨주세요.",
  ];
  const manychatOpeningDm = landingUrl
    ? `${shortTitle || keyword || "추천 상품"}\n요청하신 구매 링크 보내드려요 👇\n${landingUrl}`
    : `${shortTitle || keyword || "추천 상품"}\n구매 링크는 프로필 링크에서 확인해 주세요.`;
  const manychatButtonLabel = landingUrl ? "구매 링크 보기" : "프로필 링크 보기";
  const manychatButtonUrl = landingUrl;
  const manychatSetupGuide = [
    "Manychat > Automation > New Automation > Start From Scratch로 새 자동화를 만듭니다.",
    "Trigger는 Instagram > User comments on your Post or Reel을 선택합니다.",
    "대상은 Specific post or reel 또는 Next post or reel로 잡습니다.",
    `Keyword는 "${commentKeyword}" 하나로 먼저 시작하고, 필요하면 제외 키워드만 추가합니다.`,
    `Public Reply는 아래 문구 2~3개를 넣어 랜덤 회전시킵니다: ${manychatPublicReplies.join(" / ")}`,
    "첫 메시지 노드는 Instagram Send Message로 추가하고, Send as a Private Reply로 설정합니다.",
    `Private Reply 본문은 아래 DM 템플릿을 쓰고, 버튼은 "${manychatButtonLabel}" / URL은 추적 링크로 연결합니다.`,
    "링크 버튼만 누르면 Manychat 연락처 opt-in이 열리지 않을 수 있으니, 나중에 후속 자동화를 원하면 Quick Reply 버전도 같이 테스트합니다.",
    "Free 플랜은 live automation 4개, active contacts 25개까지라 첫 단계는 상품별 1개 자동화만 운영하는 편이 안전합니다.",
  ];

  const soraVideoPrompts = hooks.map((hook, idx) => {
    const scenes = storyboards[idx] || [];
    return [
      "Create a photorealistic vertical 9:16 social commerce video for Instagram Reels, 20 seconds total.",
      `Tone: ${tone}. Product: ${shortTitle || keyword || "추천 상품"}.`,
      "Use the uploaded reference product images as the exact source of truth.",
      "Match the real product design, color, material, proportions, and component count exactly.",
      "Do not invent new colors, accessories, labels, extra shelves, or exaggerated product features.",
      "Clean detail photos are allowed, but avoid text-heavy screenshots, spec tables, and infographic layouts as references.",
      "Do not show human faces or presenter shots. Hands or partial arms are allowed only when they look natural and are used to demonstrate the product.",
      productFeatureHints.length > 0
        ? `If clearly visible, preserve these product traits: ${productFeatureHints.join(", ")}.`
        : "Preserve only the product traits that are clearly visible in the uploaded photos.",
      `Storyboard: ${scenes.join(" | ")}`,
      "Keep the scenes realistic, commercially usable, and easy to edit into an actual product reel.",
      "Use clean cuts, realistic home lighting, stable camera movement, natural ad-style compositions, and clear product close-ups.",
      "Do not render any text, subtitles, captions, logos, URLs, QR codes, browser UI, or shopping-app screenshots inside the video.",
      `Use "${hook}" only as creative intent for the opening mood, not as on-screen text.`,
      "Generate the video completely silent. Do not add music, vocals, ambience, beats, or sound effects.",
      "The call to action will be added later inside Instagram, so do not bake CTA text into the video.",
      "Avoid fake discounts, impossible physics, warped geometry, flickering details, deformed hands, and surreal transitions.",
    ].join(" ");
  });

  return {
    title,
    keyword,
    hooks,
    storyboards,
    captions,
    hashtags,
    instagramPostText,
    commentKeyword,
    commentCtaText,
    pinnedComment,
    commentReplyTemplate,
    dmReplyTemplate,
    manychatTriggerKeyword: commentKeyword,
    manychatPublicReplies,
    manychatOpeningDm,
    manychatButtonLabel,
    manychatButtonUrl,
    manychatSetupGuide,
    productFeatureHints,
    referenceImageGuide,
    bgmSearchKeywords,
    bgmGuideText,
    soraVideoPrompts,
    grokVideoPrompts: soraVideoPrompts,
    thumbnailTexts: [hooks[0], hooks[1], `${keyword || "추천템"} 실사용 후기`],
  };
}

const INSTAGRAM_GRAPH_VERSION =
  String(process.env.INSTAGRAM_GRAPH_VERSION || "v22.0").trim() || "v22.0";

function instagramReelsFormatSpec() {
  return {
    platform: "instagram_reels",
    ratio: "9:16",
    resolution: "1080x1920",
    durationSec: { min: 15, recommended: 20, max: 30 },
    fps: 30,
    video: {
      codec: "H.264",
      container: "MP4",
      audio: "AAC",
      maxFileMB: 100,
    },
    creative: {
      hookSec: "0-2",
      problemSec: "2-6",
      solutionSec: "6-14",
      ctaSec: "14-20",
    },
    copy: {
      overlayMaxChars: 24,
      captionMaxChars: 2200,
      hashtagRecommendedCount: 8,
    },
    caution: [
      "과장/허위 표현 금지",
      "의학적/효능 단정 표현 금지",
      "저작권 없는 음원/이미지만 사용",
    ],
  };
}

async function instagramGraphGet(pathname, { accessToken, params = {} } = {}) {
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("instagram_access_token_missing");
  const pathPart = String(pathname || "").replace(/^\/+/, "").trim();
  if (!pathPart) throw new Error("instagram_path_missing");

  const u = new URL(`https://graph.facebook.com/${INSTAGRAM_GRAPH_VERSION}/${pathPart}`);
  u.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params || {})) {
    const value = String(v ?? "").trim();
    if (!value) continue;
    u.searchParams.set(k, value);
  }

  const r = await fetch(u.toString(), { method: "GET" });
  const raw = await r.text();
  const parsed = safeJsonParse(raw, null);
  const graphError = parsed && typeof parsed === "object" ? parsed.error : null;

  if (!r.ok || graphError) {
    const msg = String(graphError?.message || raw || `instagram_graph_http_${r.status}`).trim();
    const err = new Error(msg || "instagram_graph_error");
    err.status = r.status;
    err.body = parsed || raw;
    throw err;
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function instagramGraphPost(pathname, { accessToken, params = {} } = {}) {
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("instagram_access_token_missing");
  const pathPart = String(pathname || "").replace(/^\/+/, "").trim();
  if (!pathPart) throw new Error("instagram_path_missing");

  const u = new URL(`https://graph.facebook.com/${INSTAGRAM_GRAPH_VERSION}/${pathPart}`);
  const body = new URLSearchParams();
  body.set("access_token", token);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    const value = typeof v === "boolean" ? (v ? "true" : "false") : String(v).trim();
    if (!value) continue;
    body.set(k, value);
  }

  const r = await fetch(u.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const raw = await r.text();
  const parsed = safeJsonParse(raw, null);
  const graphError = parsed && typeof parsed === "object" ? parsed.error : null;
  if (!r.ok || graphError) {
    const msg = String(graphError?.message || raw || `instagram_graph_http_${r.status}`).trim();
    const err = new Error(msg || "instagram_graph_error");
    err.status = r.status;
    err.body = parsed || raw;
    throw err;
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function sanitizeUploadedFileName(raw, fallbackExt = ".mp4") {
  const base = String(raw || "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  const ext = path.extname(base || "").toLowerCase();
  const safeExt = ext || fallbackExt;
  const stem = (base ? base.slice(0, safeExt ? -safeExt.length : undefined) : "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "reel";
  return `${stem}${safeExt}`;
}

function inferVideoExt(rawName = "", contentType = "") {
  const ext = path.extname(String(rawName || "").trim()).toLowerCase();
  if (ext === ".mp4" || ext === ".mov" || ext === ".m4v") return ext;
  const type = String(contentType || "").toLowerCase();
  if (type.includes("quicktime")) return ".mov";
  if (type.includes("mp4")) return ".mp4";
  return ".mp4";
}

async function waitForInstagramMediaReady(creationId, { accessToken, timeoutMs = 180000, pollMs = 3000 } = {}) {
  const id = String(creationId || "").trim();
  if (!id) throw new Error("instagram_creation_id_missing");
  const deadline = Date.now() + Math.max(15000, Number(timeoutMs) || 180000);
  let last = {};
  while (Date.now() < deadline) {
    last = await instagramGraphGet(id, {
      accessToken,
      params: {
        fields: "id,status,status_code,error_message",
      },
    });
    const statusCode = String(last?.status_code || last?.status || "").trim().toUpperCase();
    if (statusCode === "FINISHED" || statusCode === "PUBLISHED") {
      return last;
    }
    if (statusCode === "ERROR" || statusCode === "FAILED" || statusCode === "EXPIRED") {
      const msg = String(last?.error_message || last?.status || last?.status_code || "instagram_media_failed").trim();
      const err = new Error(msg || "instagram_media_failed");
      err.body = last;
      throw err;
    }
    await sleep(pollMs);
  }
  const err = new Error("instagram_media_timeout");
  err.body = last;
  throw err;
}

app.post(
  "/api/instagram/reels/upload",
  authRequired,
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "120mb" }),
  async (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!rawBody || rawBody.length === 0) {
        return res.status(400).json({ ok: false, error: "empty_file" });
      }
      const rawFilename = String(req.query?.filename || req.headers["x-filename"] || "").trim();
      const contentType = String(req.headers["content-type"] || "video/mp4").trim() || "video/mp4";
      const ext = inferVideoExt(rawFilename, contentType);
      const safeName = sanitizeUploadedFileName(rawFilename, ext);
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const random = crypto.randomBytes(4).toString("hex");
      const fileName = `${stamp}_${random}_${safeName}`;
      const absPath = path.join(INSTAGRAM_UPLOADS_DIR, fileName);
      fs.writeFileSync(absPath, rawBody);

      const base = getRequestBaseUrl(req);
      const publicPath = `/instagram_uploads/${encodeURIComponent(fileName)}`;
      return res.json({
        ok: true,
        file: {
          fileName,
          contentType,
          sizeBytes: rawBody.length,
          publicPath,
          publicUrl: base ? `${base}${publicPath}` : publicPath,
        },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  },
);

app.post("/api/instagram/reels/publish", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const igUserId = String(settings.instagramIgUserId || "").trim();
    const accessToken = String(settings.instagramAccessToken || "").trim();
    if (!igUserId || !accessToken) {
      return res.status(400).json({ ok: false, error: "instagram_not_configured" });
    }

    const videoUrl = String(req.body?.videoUrl || "").trim();
    const caption = String(req.body?.caption || "").trim();
    const shareToFeed = parseBooleanFlag(req.body?.shareToFeed, true);
    const thumbOffset = req.body?.thumbOffset == null ? null : Number(req.body?.thumbOffset);

    if (!isHttpUrl(videoUrl)) {
      return res.status(400).json({ ok: false, error: "invalid_video_url" });
    }

    const creation = await instagramGraphPost(`${igUserId}/media`, {
      accessToken,
      params: {
        media_type: "REELS",
        video_url: videoUrl,
        caption,
        share_to_feed: shareToFeed,
        ...(Number.isFinite(thumbOffset) ? { thumb_offset: String(Math.max(0, Math.round(thumbOffset))) } : {}),
      },
    });
    const creationId = String(creation?.id || "").trim();
    if (!creationId) {
      return res.status(500).json({ ok: false, error: "instagram_creation_id_missing", creation });
    }

    const ready = await waitForInstagramMediaReady(creationId, {
      accessToken,
      timeoutMs: Number(req.body?.timeoutMs || 180000),
      pollMs: Number(req.body?.pollMs || 3000),
    });

    const published = await instagramGraphPost(`${igUserId}/media_publish`, {
      accessToken,
      params: {
        creation_id: creationId,
      },
    });
    const mediaId = String(published?.id || "").trim();

    let media = {};
    if (mediaId) {
      try {
        media = await instagramGraphGet(mediaId, {
          accessToken,
          params: {
            fields: "id,media_product_type,media_type,permalink,shortcode,timestamp",
          },
        });
      } catch (_) {}
    }

    return res.json({
      ok: true,
      graphVersion: INSTAGRAM_GRAPH_VERSION,
      creationId,
      mediaId,
      ready,
      media,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      details: e?.body || null,
    });
  }
});

app.post("/api/marketing/links", authRequired, async (req, res) => {
  try {
    const targetUrl = String(req.body?.targetUrl || "").trim();
    if (!isHttpUrl(targetUrl)) {
      return res.status(400).json({ ok: false, error: "invalid_target_url" });
    }
    const link = await createMarketingLink({
      userId: req.user.id,
      slug: String(req.body?.slug || "").trim(),
      targetUrl,
      sourceUrl: String(req.body?.sourceUrl || "").trim(),
      title: String(req.body?.title || "").trim(),
      platform: String(req.body?.platform || "instagram").trim().toLowerCase(),
      campaign: String(req.body?.campaign || "").trim(),
      content: String(req.body?.content || "").trim(),
      term: String(req.body?.term || "").trim(),
      extra: req.body?.extra && typeof req.body.extra === "object" ? req.body.extra : {},
    });
    return res.json({
      ok: true,
      link: {
        ...link,
        trackingPath: `/go/m/${encodeURIComponent(String(link?.slug || ""))}`,
        trackingUrl: buildTrackingUrl(req, link?.slug),
      },
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const status = msg === "slug_already_exists" || msg === "invalid_target_url" ? 400 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
});

app.get("/api/marketing/links", authRequired, async (req, res) => {
  try {
    const result = await listMarketingLinks({
      userId: req.user.id,
      q: String(req.query?.q || "").trim(),
      platform: String(req.query?.platform || "").trim(),
      campaign: String(req.query?.campaign || "").trim(),
      limit: Number(req.query?.limit || 100),
      offset: Number(req.query?.offset || 0),
    });
    const items = (result.items || []).map((row) => ({
      ...row,
      trackingPath: `/go/m/${encodeURIComponent(String(row?.slug || ""))}`,
      trackingUrl: buildTrackingUrl(req, row?.slug),
    }));
    return res.json({ ok: true, ...result, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/marketing/links/:slug/clicks", authRequired, async (req, res) => {
  try {
    const slug = String(req.params?.slug || "").trim();
    const result = await listMarketingClicksBySlug({
      userId: req.user.id,
      slug,
      limit: Number(req.query?.limit || 200),
      offset: Number(req.query?.offset || 0),
    });
    return res.json({ ok: true, slug, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/instagram/reels/format", authRequired, async (_req, res) => {
  return res.json({
    ok: true,
    format: instagramReelsFormatSpec(),
    graphVersion: INSTAGRAM_GRAPH_VERSION,
  });
});

app.get("/api/instagram/connection/status", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const igUserId = String(settings.instagramIgUserId || "").trim();
    const accessToken = String(settings.instagramAccessToken || "").trim();
    const pageId = String(settings.instagramPageId || "").trim();

    if (!igUserId || !accessToken) {
      return res.json({
        ok: true,
        connected: false,
        reason: "missing_settings",
        igUserId,
        pageId,
        hasAccessToken: Boolean(accessToken),
        graphVersion: INSTAGRAM_GRAPH_VERSION,
      });
    }

    const profile = await instagramGraphGet(igUserId, {
      accessToken,
      params: {
        fields: "id,username,account_type,media_count,followers_count",
      },
    });

    let page = null;
    if (pageId) {
      try {
        const pageInfo = await instagramGraphGet(pageId, {
          accessToken,
          params: {
            fields: "id,name,instagram_business_account",
          },
        });
        page = {
          id: String(pageInfo?.id || pageId),
          name: String(pageInfo?.name || "").trim(),
          instagramBusinessAccountId: String(
            pageInfo?.instagram_business_account?.id || "",
          ).trim(),
        };
      } catch (e) {
        page = {
          id: pageId,
          name: "",
          error: String(e?.message || e),
        };
      }
    }

    return res.json({
      ok: true,
      connected: true,
      graphVersion: INSTAGRAM_GRAPH_VERSION,
      profile: {
        id: String(profile?.id || igUserId),
        username: String(profile?.username || "").trim(),
        accountType: String(profile?.account_type || "").trim(),
        mediaCount: Number(profile?.media_count || 0) || 0,
        followersCount: Number(profile?.followers_count || 0) || 0,
      },
      page,
    });
  } catch (e) {
    return res.json({
      ok: true,
      connected: false,
      reason: "graph_error",
      error: String(e?.message || e),
      graphVersion: INSTAGRAM_GRAPH_VERSION,
    });
  }
});

app.post("/api/marketing/reels/pack", authRequired, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const safeItems = items
      .filter((x) => x && typeof x === "object")
      .slice(0, 30)
      .map((x) => ({ ...x }));
    const brand = String(req.body?.brand || "쿠팡코끼리").trim() || "쿠팡코끼리";
    const tone = String(req.body?.tone || "실용적").trim() || "실용적";
    const platform = String(req.body?.platform || "instagram").trim().toLowerCase() || "instagram";
    const campaign = String(req.body?.campaign || "").trim();
    const autoCreateLinks = parseBooleanFlag(req.body?.autoCreateLinks, true);

    const out = [];
    for (let i = 0; i < safeItems.length; i += 1) {
      const item = safeItems[i];
      const targetUrl = pickFirstNonEmpty(item?.targetUrl, item?.productUrl, item?.coupangUrl);
      let tracked = "";
      let link = null;
      if (autoCreateLinks && isHttpUrl(targetUrl)) {
        link = await createMarketingLink({
          userId: req.user.id,
          targetUrl,
          sourceUrl: String(item?.sourceUrl || "").trim(),
          title: String(item?.title || item?.seoTitle || "").trim(),
          platform,
          campaign: campaign || String(item?.campaign || "").trim(),
          content: String(item?.content || `v${i + 1}`).trim(),
          term: String(item?.keyword || "").trim(),
          extra: {
            category: String(item?.category || item?.categoryLabel || "").trim(),
          },
        });
        tracked = buildTrackingUrl(req, link?.slug);
      }
      const pack = buildReelsPack({
        item: {
          ...item,
          targetUrl,
        },
        trackedUrl: tracked || targetUrl,
        brand,
        tone,
      });
      out.push({
        index: i + 1,
        item: {
          title: String(item?.title || item?.seoTitle || "").trim(),
          keyword: String(item?.keyword || "").trim(),
          sourceUrl: String(item?.sourceUrl || "").trim(),
          targetUrl: targetUrl || "",
        },
        tracking: link
          ? {
              slug: link.slug,
              trackingPath: `/go/m/${encodeURIComponent(String(link.slug || ""))}`,
              trackingUrl: tracked,
            }
          : {
              slug: "",
              trackingPath: "",
              trackingUrl: isHttpUrl(targetUrl) ? targetUrl : "",
            },
        pack,
      });
    }

    return res.json({
      ok: true,
      platform,
      brand,
      tone,
      count: out.length,
      items: out,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매매 세션 생성 시작 (네이버 로그인)
app.post("/api/domeme/session/start", authRequired, (req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "save_domeme_session.js");
    const child = spawn("node", [scriptPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매매 세션 상태 확인
app.get("/api/domeme/session/status", authRequired, (req, res) => {
  try {
    const filePath = resolveStorageStatePath(req.user?.settings || {}, "domeme");
    if (!fs.existsSync(filePath)) return res.json({ ok: true, exists: false, filePath });
    const stat = fs.statSync(filePath);
    return res.json({
      ok: true,
      exists: true,
      filePath,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/domeggook/private/login-test", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const creds = resolveDomeggookPrivateCredentials(settings);
    if (!creds.apiKey || !creds.memberId || !creds.password) {
      return res.status(400).json({
        ok: false,
        error: "missing_domeggook_private_credentials",
      });
    }

    const profile = await domeggookPrivateApiLogin({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      password: creds.password,
      ip: getForwardedClientIp(req),
      userAgent: String(req.headers["user-agent"] || "Couplus/1.0"),
    });

    return res.json({
      ok: true,
      connected: true,
      profile: {
        id: String(profile?.id || creds.memberId),
        grade: String(profile?.grade || "").trim(),
        affid: String(profile?.affid || "").trim(),
        loginKeepTime: Number(profile?.loginKeepTime || 0) || 0,
        sIdRenewDate: Number(profile?.sIdRenewDate || 0) || 0,
        hasSession: String(profile?.sId || "").trim().length > 0,
      },
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      connected: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
    });
  }
});

app.get("/api/domeggook/private/orders", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const creds = resolveDomeggookPrivateCredentials(settings);
    if (!creds.apiKey || !creds.memberId || !creds.password) {
      return res.status(400).json({
        ok: false,
        error: "missing_domeggook_private_credentials",
      });
    }

    const profile = await domeggookPrivateApiLogin({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      password: creds.password,
      ip: getForwardedClientIp(req),
      userAgent: String(req.headers["user-agent"] || "Couplus/1.0"),
    });

    const raw = await domeggookPrivateApiGetOrderList({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      sessionId: String(profile?.sId || "").trim(),
      day: req.query?.day,
      page: req.query?.pg,
      pageSize: req.query?.ic,
      status: req.query?.st,
      orderNo: req.query?.no,
      itemNo: req.query?.itemNo,
    });
    const normalized = normalizeDomeggookPrivateOrderList(raw);

    return res.json({
      ok: true,
      connected: true,
      profile: {
        id: String(profile?.id || creds.memberId),
        grade: String(profile?.grade || "").trim(),
      },
      header: normalized.header,
      items: normalized.items,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      connected: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
    });
  }
});

app.get("/api/domeggook/private/asset", authRequired, async (req, res) => {
  try {
    const settings = req.user?.settings || {};
    const creds = resolveDomeggookPrivateCredentials(settings);
    if (!creds.apiKey || !creds.memberId || !creds.password) {
      return res.status(400).json({
        ok: false,
        error: "missing_domeggook_private_credentials",
      });
    }

    const profile = await domeggookPrivateApiLogin({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      password: creds.password,
      ip: getForwardedClientIp(req),
      userAgent: String(req.headers["user-agent"] || "Couplus/1.0"),
    });

    const raw = await domeggookPrivateApiGetMyAsset({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      sessionId: String(profile?.sId || "").trim(),
    });
    const asset = normalizeDomeggookPrivateAsset(raw);

    return res.json({
      ok: true,
      connected: true,
      asset,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      connected: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
    });
  }
});

app.post("/api/orders/domeggook/preflight", authRequired, async (req, res) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_order_id" });
    }
    const orderRecord = await getOrderById(req.user.id, Math.floor(orderId));
    if (!orderRecord) {
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }
    const result = await createDomeggookOrderForCoupangOrder({
      userId: req.user.id,
      settings: req.user?.settings || {},
      orderRecord,
      receipt: req.body?.receipt,
      dryRun: true,
      includeAssetCheck: true,
    });
    if (!result?.ok) {
      return res
        .status(400)
        .json({ ok: false, error: result?.error || "domeggook_preflight_failed", result });
    }
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
    });
  }
});

app.post("/api/orders/domeggook/create", authRequired, async (req, res) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_order_id" });
    }
    const orderRecord = await getOrderById(req.user.id, Math.floor(orderId));
    if (!orderRecord) {
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }
    const result = await createDomeggookOrderForCoupangOrder({
      userId: req.user.id,
      settings: req.user?.settings || {},
      orderRecord,
      receipt: req.body?.receipt,
      dryRun: req.body?.dryRun === true || String(req.body?.dryRun || "") === "1",
    });
    if (!result?.ok) {
      return res.status(400).json({ ok: false, error: result?.error || "domeggook_order_create_failed", result });
    }
    appendUserPurchaseLog(req.user.id, {
      vendor: "domeggook_private",
      orderId: orderId,
      orderNo:
        (Array.isArray(result?.orderCreate?.orders) && result.orderCreate.orders[0]?.orderNo) || "",
      itemNo: result?.mapping?.itemNo || "",
      payUrl: "",
      dryRun: result?.dryRun === true,
    });
    const createdOrderNo =
      (Array.isArray(result?.orderCreate?.orders) && result.orderCreate.orders[0]?.orderNo) || "";
    if (createdOrderNo) {
      await mergeOrderDataById(req.user.id, orderId, {
        supplier: {
          ...(orderRecord?.order?.supplier && typeof orderRecord.order.supplier === "object"
              ? orderRecord.order.supplier
              : {}),
          domeggook: {
            ...((orderRecord?.order?.supplier?.domeggook &&
                    typeof orderRecord.order.supplier.domeggook === "object")
                ? orderRecord.order.supplier.domeggook
                : {}),
            orderNo: String(createdOrderNo).trim(),
            itemNo: String(result?.mapping?.itemNo || "").trim(),
            optionCode: String(result?.mapping?.optionCode || "").trim(),
            shippingMethodCode: String(result?.mapping?.shippingMethodCode || "").trim(),
            createdAt: new Date().toISOString(),
          },
        },
      });
    }
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
    });
  }
});

app.post("/api/orders/domeggook/sync-invoice", authRequired, async (req, res) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_order_id" });
    }
    const orderRecord = await getOrderById(req.user.id, Math.floor(orderId));
    if (!orderRecord) {
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }

    const settings = req.user?.settings || {};
    const creds = resolveDomeggookPrivateCredentials(settings);
    if (!creds.apiKey || !creds.memberId || !creds.password) {
      return res.status(400).json({
        ok: false,
        error: "missing_domeggook_private_credentials",
      });
    }

    const orderRaw =
      orderRecord?.order && typeof orderRecord.order === "object"
        ? orderRecord.order
        : {};
    const supplierInfo =
      orderRaw?.supplier && typeof orderRaw.supplier === "object"
        ? orderRaw.supplier
        : {};
    const domeggookInfo =
      supplierInfo?.domeggook && typeof supplierInfo.domeggook === "object"
        ? supplierInfo.domeggook
        : {};
    const fallbackLog = findLatestPurchaseLogByOrderId(req.user.id, orderId);
    const domeggookOrderNo = String(
      domeggookInfo?.orderNo || fallbackLog?.orderNo || "",
    ).trim();
    if (!domeggookOrderNo) {
      return res.status(400).json({
        ok: false,
        error: "missing_domeggook_order_no",
      });
    }

    const profile = await domeggookPrivateApiLogin({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      password: creds.password,
      ip: getForwardedClientIp(req),
      userAgent: String(req.headers["user-agent"] || "Couplus/1.0"),
    });
    const rawView = await domeggookPrivateApiGetOrderView({
      apiKey: creds.apiKey,
      memberId: creds.memberId,
      sessionId: String(profile?.sId || "").trim(),
      orderNo: domeggookOrderNo,
    });
    const normalizedView = normalizeDomeggookPrivateOrderView(rawView);
    const invoiceNumber = String(normalizedView?.delivery?.code || "").trim();
    if (!invoiceNumber) {
      return res.status(400).json({
        ok: false,
        error: "invoice_not_ready",
        result: {
          domeggookOrderNo,
          orderView: normalizedView,
        },
      });
    }

    const { accessKey, secretKey, vendorId, missing } = validateCoupangCredentials(settings);
    if (missing.length > 0) {
      return res.status(400).json({ ok: false, error: "missing_keys", missing });
    }

    const sheet =
      orderRaw?.sheet && typeof orderRaw.sheet === "object" ? orderRaw.sheet : {};
    const item =
      orderRaw?.item && typeof orderRaw.item === "object" ? orderRaw.item : {};
    const shipmentBoxId = String(sheet?.shipmentBoxId || orderRecord.externalId || "").trim();
    const coupangOrderId = String(sheet?.orderId || "").trim();
    const vendorItemId = String(item?.vendorItemId || orderRecord.externalSubId || "").trim();
    const deliveryCompanyCode = String(
      req.body?.deliveryCompanyCode || settings?.coupangDeliveryCompanyCode || "",
    ).trim();
    if (!shipmentBoxId || !coupangOrderId || !vendorItemId) {
      return res.status(400).json({ ok: false, error: "missing_coupang_order_keys" });
    }
    if (!deliveryCompanyCode) {
      return res.status(400).json({
        ok: false,
        error: "missing_coupang_delivery_company_code",
        result: {
          domeggookOrderNo,
          orderView: normalizedView,
        },
      });
    }

    const uploadRes = await uploadOrderInvoices({
      vendorId,
      items: [
        {
          shipmentBoxId,
          orderId: coupangOrderId,
          vendorItemId,
          deliveryCompanyCode,
          invoiceNumber,
        },
      ],
      accessKey,
      secretKey,
    });
    const body = parseCoupangBody(uploadRes.body);
    const ok = uploadRes.status === 200 && body && isCoupangSuccessCode(body?.code);
    if (!ok) {
      return res.status(uploadRes.status || 502).json({
        ok: false,
        error: "coupang_invoice_upload_failed",
        result: {
          domeggookOrderNo,
          orderView: normalizedView,
          invoiceNumber,
          deliveryCompanyCode,
          body,
        },
      });
    }

    const responseList = Array.isArray(body?.data?.responseList) ? body.data.responseList : [];
    const successfulIds = responseList
      .filter((x) => x?.succeed === true)
      .map((x) => String(x?.shipmentBoxId ?? "").trim())
      .filter(Boolean);
    const sync = await syncShipmentBoxesFromCoupang({
      userId: req.user.id,
      settings,
      shipmentBoxIds: successfulIds,
      statusFallback: "DELIVERING",
    });

    await mergeOrderDataById(req.user.id, orderId, {
      supplier: {
        ...(supplierInfo && typeof supplierInfo === "object" ? supplierInfo : {}),
        domeggook: {
          ...(domeggookInfo && typeof domeggookInfo === "object" ? domeggookInfo : {}),
          orderNo: domeggookOrderNo,
          invoiceNumber,
          deliveryCompanyCode,
          deliveryCompany: String(normalizedView?.delivery?.company || "").trim(),
          deliveryCompanyName: String(normalizedView?.delivery?.companyName || "").trim(),
          invoiceSyncedAt: new Date().toISOString(),
        },
      },
    });

    return res.json({
      ok: true,
      result: {
        domeggookOrderNo,
        orderView: normalizedView,
        invoiceNumber,
        deliveryCompanyCode,
        responseList,
        synced: Number(sync?.synced || 0),
        syncItems: Array.isArray(sync?.items) ? sync.items : [],
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      details: String(e?.details || "").trim(),
    });
  }
});

// ✅ /go/m/:slug -> 302 redirect + click tracking
app.get("/go/m/:slug", async (req, res) => {
  try {
    const slug = String(req.params?.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).type("text").send("missing slug");

    const link = await getMarketingLinkBySlug(slug);
    if (!link?.targetUrl || !isHttpUrl(link.targetUrl)) {
      return res.status(404).type("text").send("link not found");
    }

    const ip =
      String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim() || String(req.ip || "").trim();

    recordMarketingClick({
      slug,
      referer: String(req.headers.referer || req.headers.referrer || "").trim(),
      userAgent: String(req.headers["user-agent"] || "").trim(),
      ip,
      query: req.query || {},
    }).catch((e) => {
      log("[go/m] click tracking failed", slug, String(e?.message || e));
    });

    return res.redirect(302, link.targetUrl);
  } catch (e) {
    log("[go/m] error", e?.message);
    return res.status(500).type("text").send("go marketing error");
  }
});

// ✅ /go?u=<encoded_url> -> 302 redirect
app.get("/go", (req, res) => {
  try {
    const u = String(req.query.u || "").trim();
    if (!u) return res.status(400).type("text").send("missing u");

    // u는 encodeURIComponent 된 URL이 들어오므로 decode
    const decoded = decodeURIComponent(u);

    // 안전검증: http/https만 허용
    if (!/^https?:\/\//i.test(decoded)) {
      return res.status(400).type("text").send("invalid url");
    }

    // (선택) 로그: 클릭 추적
    log("[go] redirect", decoded);

    // 302로 외부 기사로 이동
    return res.redirect(302, decoded);
  } catch (e) {
    log("[go] error", e?.message);
    return res.status(500).type("text").send("go error");
  }
});

/**
 * ✅ 1) 인가 시작
 * - 여기서는 "무조건" 카카오 authorize로 보냄
 */
app.get("/auth/kakao", (req, res) => {
  const client_id = mustEnv("KAKAO_REST_KEY");
  const redirect_uri = mustEnv("KAKAO_REDIRECT_URI");
  const scope = (process.env.KAKAO_SCOPE || "friends,talk_message").trim();

  // state는 CSRF 방지용 + 디버그용(없어도 되지만 있으면 좋음)
  const state = Math.random().toString(36).slice(2);

  const authUrl =
    "https://kauth.kakao.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}`;

  log("[auth] start", { scope, redirect_uri });
  return res.redirect(authUrl);
});

/**
 * ✅ 2) 콜백
 * - 절대 다시 /auth/kakao로 redirect 하지 말 것(무한루프 원인 1순위)
 * - 성공/실패든 "항상 HTML 응답으로 종료"
 */
app.get("/auth/kakao/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const err = String(req.query.error || "");
  const errDesc = String(req.query.error_description || "");
  const scope = (process.env.KAKAO_SCOPE || "friends,talk_message").trim();

  log("[auth] callback hit", {
    hasCode: !!code,
    error: err || null,
  });

  if (err) {
    return res
      .status(400)
      .type("html")
      .send(
        `<h3>카카오 동의 실패</h3><pre>${escapeHtml(
          err + " " + errDesc,
        )}</pre><p>창을 닫아도 됩니다.</p>`,
      );
  }

  if (!code) {
    return res
      .status(400)
      .type("html")
      .send(`<h3>콜백에 code가 없습니다</h3><p>창을 닫아도 됩니다.</p>`);
  }

  try {
    const client_id = mustEnv("KAKAO_REST_KEY");
    const redirect_uri = mustEnv("KAKAO_REDIRECT_URI");
    const client_secret = (process.env.KAKAO_CLIENT_SECRET || "").trim();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      redirect_uri,
      code,
    });
    if (client_secret) body.append("client_secret", client_secret);

    // 1) 토큰 발급
    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      log("[auth] token fail", tokenJson);
      return res
        .status(500)
        .type("html")
        .send(
          `<h3>토큰 교환 실패</h3><pre>${escapeHtml(
            JSON.stringify(tokenJson, null, 2),
          )}</pre><p>창을 닫아도 됩니다.</p>`,
        );
    }

    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;

    // 2) 사용자 정보 조회(카카오 사용자 ID 확보)
    const meRes = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meJson = await meRes.json().catch(() => ({}));

    if (!meRes.ok || !meJson.id) {
      log("[auth] me fail", meJson);
      return res
        .status(500)
        .type("html")
        .send(
          `<h3>사용자 정보 조회 실패</h3><pre>${escapeHtml(
            JSON.stringify(meJson, null, 2),
          )}</pre><p>창을 닫아도 됩니다.</p>`,
        );
    }

    const saved = upsertToken({
      kakao_user_id: meJson.id,
      refresh_token: refreshToken,
      scope, // ✅ 여기서는 "요청 scope"를 저장(실제 승인 scope는 별도 검증 가능)
    });

    log("[auth] saved", saved);

    // ✅ 여기서 끝! (무한루프 방지 핵심)
    return res
      .status(200)
      .type("html")
      .send(
        `<h3>✅ 경제 코끼리 연결 완료</h3>
         <p>이제 창을 닫아도 됩니다.</p>
         <p><small>user_id: ${escapeHtml(String(meJson.id))}</small></p>`,
      );
  } catch (e) {
    log("[auth] callback exception", e?.message);
    return res
      .status(500)
      .type("html")
      .send(
        `<h3>서버 오류</h3><pre>${escapeHtml(
          String(e?.message || e),
        )}</pre><p>창을 닫아도 됩니다.</p>`,
      );
  }
});

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(PORT, "127.0.0.1", () => {
  log(`server running: http://localhost:${PORT}`);
  log(`authorize start: http://localhost:${PORT}/auth/kakao`);

  const dailyAutoEnabled = parseBooleanFlag(
    process.env.RECOMMENDATION_DAILY_AUTO_ENABLED,
    false,
  );
  const hour = clampInt(process.env.RECOMMENDATION_DAILY_AUTO_HOUR, 0, 23, 9);
  const minute = clampInt(
    process.env.RECOMMENDATION_DAILY_AUTO_MINUTE,
    0,
    59,
    0,
  );
  const intervalMs = clampInt(
    process.env.RECOMMENDATION_DAILY_AUTO_INTERVAL_MS,
    10_000,
    600_000,
    60_000,
  );
  recommendationDailyAutoSchedulerState.enabled = dailyAutoEnabled;
  recommendationDailyAutoSchedulerState.hour = hour;
  recommendationDailyAutoSchedulerState.minute = minute;
  recommendationDailyAutoSchedulerState.intervalMs = intervalMs;
  recommendationDailyAutoSchedulerState.startedAt = new Date().toISOString();

  if (dailyAutoEnabled) {
    const started = startRecommendationDailyAutoRunLoop({
      hour,
      minute,
      intervalMs,
    });
    log(
      `[reco-auto] scheduler enabled at ${String(started.hour).padStart(2, "0")}:${String(started.minute).padStart(2, "0")} interval=${started.intervalMs}ms`,
    );
  } else {
    log("[reco-auto] scheduler disabled (RECOMMENDATION_DAILY_AUTO_ENABLED!=1)");
  }

  const catalogAutoSyncEnabled = parseBooleanFlag(
    process.env.CATALOG_AUTO_SYNC_ENABLED,
    true,
  );
  const catalogAutoSyncIntervalMs = clampInt(
    process.env.CATALOG_AUTO_SYNC_INTERVAL_MS,
    60_000,
    3_600_000,
    15 * 60_000,
  );
  const catalogAutoSyncInitialDelayMs = clampInt(
    process.env.CATALOG_AUTO_SYNC_INITIAL_DELAY_MS,
    1_000,
    300_000,
    20_000,
  );
  const catalogAutoSyncLimitPerUser = clampInt(
    process.env.CATALOG_AUTO_SYNC_LIMIT_PER_USER,
    10,
    500,
    200,
  );
  const catalogAutoSyncIncludeHistory = parseBooleanFlag(
    process.env.CATALOG_AUTO_SYNC_INCLUDE_HISTORY,
    false,
  );
  const catalogAutoSyncPauseWhenUpload = parseBooleanFlag(
    process.env.CATALOG_AUTO_SYNC_PAUSE_WHEN_UPLOAD,
    true,
  );
  catalogAutoSyncState.enabled = catalogAutoSyncEnabled;
  catalogAutoSyncState.intervalMs = catalogAutoSyncIntervalMs;
  catalogAutoSyncState.limitPerUser = catalogAutoSyncLimitPerUser;
  catalogAutoSyncState.includeHistory = catalogAutoSyncIncludeHistory;
  catalogAutoSyncState.pauseWhenUpload = catalogAutoSyncPauseWhenUpload;
  catalogAutoSyncState.startedAt = new Date().toISOString();

  if (catalogAutoSyncEnabled) {
    const started = startCatalogAutoSyncLoop({
      intervalMs: catalogAutoSyncIntervalMs,
      initialDelayMs: catalogAutoSyncInitialDelayMs,
    });
    log(
      `[catalog-auto-sync] scheduler enabled interval=${started.intervalMs}ms initialDelay=${started.initialDelayMs}ms limit=${catalogAutoSyncLimitPerUser} includeHistory=${catalogAutoSyncIncludeHistory ? "1" : "0"}`,
    );
  } else {
    log("[catalog-auto-sync] scheduler disabled (CATALOG_AUTO_SYNC_ENABLED=0)");
  }
});
