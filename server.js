// server.js (ESM)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { runUploadFromUrl } from "./src/server/externalAdapters.js";
import { DOMEGGOOK_OPENAPI_KEY } from "./src/config/env.js";
import { previewUploadFromUrl } from "./src/pipeline/previewUploadFromUrl.js";
import { classifyUrl } from "./src/utils/urlFilter.js";
import {
  initDb,
  createUser,
  verifyUser,
  createSession,
  destroySession,
  getUserBySession,
  updateSettings,
  addPreviewHistory,
  listPreviewHistory,
  getUploadedProductByUrl,
  upsertUploadedProduct,
  upsertPushSubscription,
  deletePushSubscription,
  listPushSubscriptions,
  upsertApnsToken,
  deleteApnsToken,
  listApnsTokens,
  createJob,
  updateJob,
  getJob,
  upsertCatalogProduct,
  listCatalogProducts,
  getCatalogProductById,
  updateCatalogProduct,
  deleteCatalogProduct,
  listCatalogEvents,
  listUsersForSync,
  getActiveJobByKind,
} from "./src/server/storage_sqlite.js";
import {
  listPresets,
  getPreset,
  upsertPreset,
  deletePreset,
} from "./src/server/presets_sqlite.js";
import {
  listThemes,
  getTheme,
  createTheme,
  updateTheme as updateThemeRow,
  deleteTheme as deleteThemeRow,
} from "./src/server/themes.js";
import { addOrder, clearOrders, listOrders, refreshShippingStatusesFromCoupang } from "./src/server/orders_sqlite.js";
import { exportOrdersToDomeme } from "./src/pipeline/exportOrdersToDomeme.js";
import { uploadDomemeExcel } from "./src/pipeline/uploadDomemeExcel.js";
import { exportPaidOrdersToVendors } from "./src/pipeline/exportPaidOrdersToVendor.js";
import { uploadVendorPurchaseExcel } from "./src/pipeline/uploadVendorPurchaseExcel.js";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import webpush from "web-push";
import apn from "apn";
import { newSessionFlag, touchFlag } from "./src/server/session_control.js";
import {
  DOMEME_STORAGE_STATE_PATH,
  DOMEGGOOK_STORAGE_STATE_PATH,
} from "./src/config/paths.js";
import { getSellerProduct } from "./src/server/externalAdapters.js";
import { runtimeState } from "./src/server/runtime_state.js";
import { syncOneCatalogProduct, syncAllCatalogProducts, startCatalogSyncLoop } from "./src/server/catalogSync.js";
import {
  listRecommendations,
  generateRecommendationsForUser,
  fillRecommendationsForUser,
  startRecommendationLoop,
  defaultKeywordSet,
} from "./src/server/recommendations.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// ✅ DB 초기화
await initDb();

// ✅ out 폴더(이미지 파일) 정적 서빙
// 쿠팡이 접근 가능한 공개 URL(imageProxyBase/localImageBaseUrl)의 /couplus-out/<file> 로 매핑된다.
// Cache-bust path handler: /couplus-out/_cb/<ts>/<file>
// Important: Coupang often probes with HEAD before GET.
function handleCouplusOutCb(req, res) {
  try {
    const file = String(req.params.file || '').replace(/^[\\/]+/, '');
    const p = path.join(process.cwd(), 'out', file);

    // Prevent caching (especially negative caching) on any edge.
    res.setHeader('Cache-Control', 'no-store');

    // Existence check: avoid delayed file-write race turning into cached 404.
    if (!fs.existsSync(p)) return res.status(404).type('text').send('Not Found');

    // HEAD: only headers
    if (req.method === 'HEAD') return res.status(200).end();

    return res.sendFile(p);
  } catch {
    return res.status(404).type('text').send('Not Found');
  }
}
app.get('/couplus-out/_cb/:ts/:file', handleCouplusOutCb);
app.head('/couplus-out/_cb/:ts/:file', handleCouplusOutCb);

app.use(
  "/couplus-out",
  express.static(path.join(process.cwd(), "out"), {
    setHeaders(res) {
      // Prevent caching (especially 404) on the Cloudflare tunnel edge.
      // Coupang validates that image URLs are reachable; cached 404s cause image_host_unreachable.
      res.setHeader("Cache-Control", "no-store");
    },
  }),
);
// 레거시 경로도 유지
app.use(
  "/tmp",
  express.static(path.join(process.cwd(), "out"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  }),
); // /tmp/tmp_main.jpg 같은 형태로도 접근 가능
app.use(express.static(path.join(process.cwd(), "public")));

// Flutter Web app (served from public/app)
app.get('/app/*', (req, res, next) => {
  try {
    const p = path.join(process.cwd(), 'public', 'app', 'index.html');
    return res.sendFile(p);
  } catch {
    return next();
  }
});

const PORT = Number(process.env.PORT || 3000);

// (kakao oauth removed)

const SERVER_STARTED_AT = new Date().toISOString();
const PACKAGE_JSON_PATH = path.join(process.cwd(), "package.json");
const GIT_DIR = path.join(process.cwd(), ".git");
const IP_CHECK_URLS = ["https://ifconfig.me/ip", "https://api.ipify.org"];
const UPLOAD_HISTORY_PATH = path.join(process.cwd(), "data", "upload_history.json");
const UPLOAD_HISTORY_LIMIT = 200;

// Web Push (PWA)
const PUSH_VAPID_PATH = path.join(process.cwd(), "data", "push_vapid.json");
function loadOrCreateVapidKeys() {
  try {
    if (fs.existsSync(PUSH_VAPID_PATH)) {
      const raw = fs.readFileSync(PUSH_VAPID_PATH, "utf-8");
      const json = JSON.parse(raw || "{}");
      if (json?.publicKey && json?.privateKey) return json;
    }
  } catch {}

  const keys = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(path.dirname(PUSH_VAPID_PATH), { recursive: true });
    fs.writeFileSync(PUSH_VAPID_PATH, JSON.stringify(keys, null, 2));
  } catch {}
  return keys;
}

const VAPID = loadOrCreateVapidKeys();
webpush.setVapidDetails("mailto:admin@couplus.local", VAPID.publicKey, VAPID.privateKey);

// Web Push (PWA)
async function sendWebPushToUser(userId, payload) {
  try {
    const subs = await listPushSubscriptions(userId);
    if (!subs || subs.length === 0) return;
    const msg = JSON.stringify(payload || {});
    for (const sub of subs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await webpush.sendNotification(sub, msg, {
          TTL: 60 * 60,
          urgency: "normal",
        });
      } catch (e) {
        // Remove dead subscriptions
        const code = e?.statusCode || e?.status || null;
        if (code === 404 || code === 410) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await deletePushSubscription({ userId, endpoint: sub?.endpoint });
          } catch {}
        }
      }
    }
  } catch {}
}

// Native APNs (TestFlight app)
const APNS_KEY_ID = String(process.env.APNS_KEY_ID || "").trim();
const APNS_TEAM_ID = String(process.env.APNS_TEAM_ID || "").trim();
const APNS_BUNDLE_ID = String(process.env.APNS_BUNDLE_ID || "com.hyunho.coupelephant.app").trim();
const APNS_P8_PATH = String(process.env.APNS_P8_PATH || path.join(process.cwd(), "data", "apns_auth_key.p8")).trim();

let apnProvider = null;
function getApnProvider() {
  if (apnProvider) return apnProvider;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_P8_PATH) return null;
  if (!fs.existsSync(APNS_P8_PATH)) return null;
  apnProvider = new apn.Provider({
    token: {
      key: fs.readFileSync(APNS_P8_PATH),
      keyId: APNS_KEY_ID,
      teamId: APNS_TEAM_ID,
    },
    production: true, // TestFlight uses production APNs
  });
  return apnProvider;
}

async function sendApnsToUser(userId, payload) {
  const provider = getApnProvider();
  if (!provider) return;
  const tokens = await listApnsTokens(userId);
  if (!tokens || tokens.length === 0) return;

  const note = new apn.Notification();
  note.topic = APNS_BUNDLE_ID;
  note.alert = {
    title: String(payload?.title || "Couplus"),
    body: String(payload?.body || "작업이 완료되었습니다."),
  };
  note.sound = "default";
  note.payload = payload || {};

  try {
    const result = await provider.send(note, tokens);
    // Clean up invalid tokens
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    for (const f of failed) {
      const t = String(f?.device || "");
      const status = f?.status;
      const reason = f?.response?.reason || "";
      if (!t) continue;
      if (status === 410 || reason === "Unregistered" || reason === "BadDeviceToken") {
        try {
          // eslint-disable-next-line no-await-in-loop
          await deleteApnsToken({ userId, deviceToken: t });
        } catch {}
      }
    }
  } catch {}
}

// Unified notify
async function notifyUser(userId, payload) {
  // Best-effort parallel
  await Promise.all([
    sendWebPushToUser(userId, payload),
    sendApnsToUser(userId, payload),
  ]).catch(() => {});
}

function log(...args) {
  console.log("[server]", new Date().toISOString(), ...args);
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

// (kakao oauth removed)

function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`ENV ${name} is missing`);
  return v;
}

let uploadInProgress = false;

const PURCHASE_LOG_LIMIT = 200;
function appendPurchaseLog(userId, entry) {
  try {
    const key = String(userId);
    const list = runtimeState.purchaseLogs.get(key) || [];
    list.unshift({
      at: new Date().toISOString(),
      ...entry,
    });
    if (list.length > PURCHASE_LOG_LIMIT) list.length = PURCHASE_LOG_LIMIT;
    runtimeState.purchaseLogs.set(key, list);
  } catch {}
}

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

// ✅ Public notice (no auth): used by Web banner overlay
app.get("/api/public/notice", (req, res) => {
  const serviceName = String(process.env.SERVICE_NAME || "쿠팡코끼리");
  const priceKrw = Number(process.env.SUBSCRIPTION_PRICE_KRW || 50000);
  const tossPayUrl = String(process.env.TOSS_PAY_URL || "").trim();
  const kakaoPayUrl = String(process.env.KAKAOPAY_PAY_URL || "").trim();
  const supportTelegramUrl = String(process.env.SUPPORT_TELEGRAM_URL || "").trim();

  return res.json({
    ok: true,
    serviceName,
    priceKrw: Number.isFinite(priceKrw) ? priceKrw : 50000,
    pay: {
      toss: tossPayUrl || null,
      kakaoPay: kakaoPayUrl || null,
    },
    support: {
      telegram: supportTelegramUrl || null,
    },
  });
});

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

// Image proxy (for CDNs that require referer/UA or block direct loading)
app.get('/api/image-proxy', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url.startsWith('http')) return res.status(400).send('bad_url');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);

    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://domeggook.com',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    clearTimeout(t);

    if (!r.ok) {
      return res.status(502).send('fetch_failed');
    }

    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // stream (node-fetch v3 uses Web ReadableStream)
    if (r.body) {
      const nodeStream = Readable.fromWeb(r.body);
      nodeStream.pipe(res);
      return;
    }

    const buf = Buffer.from(await r.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    console.error('[image-proxy] error', e);
    return res.status(500).send('proxy_error');
  }
});

// ✅ 모바일/대시보드용: 세션상태 + 최근 히스토리 + 최근 구매로그 + payUrl 요약
app.get("/api/dashboard", async (req, res) => {
  try {
    const token = getSessionToken(req);
    const user = token ? await getUserBySession(token) : null;

    const limitPreview = Math.max(1, Math.min(200, Number(req.query.previewLimit || 20) || 20));
    const limitPurchase = Math.max(1, Math.min(200, Number(req.query.purchaseLimit || 50) || 50));

    const domeme = (() => {
      try {
        const filePath = DOMEME_STORAGE_STATE_PATH;
        if (!fs.existsSync(filePath)) return { ok: true, exists: false, valid: false };
        const stat = fs.statSync(filePath);
        return { ok: true, exists: true, valid: true, updatedAt: new Date(stat.mtimeMs).toISOString() };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    })();

    const domeggook = (() => {
      try {
        const filePath = DOMEGGOOK_STORAGE_STATE_PATH;
        if (!fs.existsSync(filePath)) return { ok: true, exists: false, valid: false };
        const stat = fs.statSync(filePath);
        return { ok: true, exists: true, valid: true, updatedAt: new Date(stat.mtimeMs).toISOString() };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    })();

    let previewHistory = [];
    let purchaseLogs = [];
    let payUrls = {};

    if (user) {
      // preview history (sqlite)
      try {
        previewHistory = await listPreviewHistory(user.id, limitPreview);
      } catch {
        previewHistory = [];
      }

      // purchase logs (runtime memory)
      try {
        const list = runtimeState.purchaseLogs.get(String(user.id)) || [];
        purchaseLogs = list.slice(0, limitPurchase);

        // latest payUrls by vendor
        for (const it of purchaseLogs) {
          const vendor = String(it?.vendor || "").trim();
          const url = String(it?.payUrl || "").trim();
          if (!vendor || !url) continue;
          if (!payUrls[vendor]) payUrls[vendor] = url;
        }
      } catch {
        purchaseLogs = [];
        payUrls = {};
      }
    }

    return res.json({
      ok: true,
      auth: {
        authenticated: Boolean(user),
        user: user ? { id: user.id, email: user.email || "" } : null,
      },
      sessionStatus: { domeme, domeggook },
      previewHistory,
      purchaseLogs,
      payUrls,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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

// ✅ Presets: list/create/update/delete/apply
app.get("/api/presets", authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100) || 100));
    const presets = await listPresets(req.user.id, limit);
    return res.json({ ok: true, presets });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/presets/:id", authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const preset = await getPreset(req.user.id, id);
    if (!preset) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, preset });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/presets", authRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const settings = (req.body?.settings && typeof req.body.settings === "object") ? req.body.settings : {};
    const preset = await upsertPreset({ userId: req.user.id, name, settings });
    return res.json({ ok: true, preset });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/presets/:id", authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const settings = (req.body?.settings && typeof req.body.settings === "object") ? req.body.settings : {};
    // upsert by name (unique per user). id is returned but name conflict can update existing.
    const preset = await upsertPreset({ userId: req.user.id, id, name, settings });
    return res.json({ ok: true, preset });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/presets/:id", authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    await deletePreset(req.user.id, id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/presets/:id/apply", authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const preset = await getPreset(req.user.id, id);
    if (!preset) return res.status(404).json({ ok: false, error: "not_found" });

    const saved = await updateSettings(req.user.id, preset.settings || {});
    return res.json({ ok: true, settings: saved, appliedPreset: { id: preset.id, name: preset.name } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ Catalog Products (B-style): CRUD + confirm + deploy
app.get('/api/catalog', authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();
    const products = await listCatalogProducts(req.user.id, { limit, status, q });
    return res.json({ ok: true, products });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/catalog/:id', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const product = await getCatalogProductById(req.user.id, id);
    if (!product) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, product });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/catalog', authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const product = await upsertCatalogProduct({
      userId: req.user.id,
      sourceUrl: String(b.sourceUrl || b.url || '').trim(),
      confirmedTitle: String(b.confirmedTitle || '').trim(),
      mainImageUrl: String(b.mainImageUrl || '').trim(),
      detailImages: Array.isArray(b.detailImages) ? b.detailImages : [],
      presetId: String(b.presetId || '').trim() || null,
      categoryOverride: b.categoryOverride ?? null,
      status: String(b.status || 'draft'),
    });
    return res.json({ ok: true, product });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put('/api/catalog/:id', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const product = await updateCatalogProduct(req.user.id, id, patch);
    if (!product) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, product });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/catalog/:id', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    await deleteCatalogProduct(req.user.id, id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Confirm (upsert by sourceUrl). Used by Preview -> Confirm.
app.post('/api/catalog/confirm', authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const url = String(b.sourceUrl || b.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'missing url' });

    const product = await upsertCatalogProduct({
      userId: req.user.id,
      sourceUrl: url,
      confirmedTitle: String(b.confirmedTitle || b.title || '').trim(),
      mainImageUrl: String(b.mainImageUrl || '').trim(),
      detailImages: Array.isArray(b.detailImages) ? b.detailImages : [],
      presetId: String(b.presetId || '').trim() || null,
      categoryOverride: b.categoryOverride ?? null,
      status: 'confirmed',
    });

    return res.json({ ok: true, product });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// Deploy: starts an upload job using catalog snapshot
app.post('/api/catalog/:id/deploy', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const product = await getCatalogProductById(req.user.id, id);
    if (!product) return res.status(404).json({ ok: false, error: 'not_found' });

    const job = await createJob({ userId: req.user.id, kind: 'upload', inputUrl: product.sourceUrl, force: '0', catalogId: product.id });

    setTimeout(async () => {
      try {
        await updateJob({ id: job.id, patch: { status: 'running' } });

        let presetSettings = {};
        if (product.presetId) {
          try {
            const p = await getPreset(req.user.id, product.presetId);
            if (p?.settings && typeof p.settings === 'object') presetSettings = p.settings;
          } catch {}
        }

        const settingsSnapshot = {
          ...(req.user.settings || {}),
          ...(presetSettings || {}),
          ...(product.confirmedTitle ? { titleOverride: product.confirmedTitle } : {}),
          ...(Array.isArray(product.detailImages) && product.detailImages.length > 0 ? { imagesOverride: product.detailImages } : {}),
          ...(product.categoryOverride != null ? { displayCategoryCode: Number(product.categoryOverride) } : {}),
        };

        try {
          await updateJob({ id: job.id, patch: { resultJson: { progress: { stage: 'upload', url: product.sourceUrl } } } });
        } catch {}

        const result = await runUploadFromUrl(product.sourceUrl, { ...settingsSnapshot, force: false });
        const ok = Boolean(result?.ok);

        // post-upload validation
        let validation = { ok: true, checkedAt: new Date().toISOString(), errors: [] };
        try {
          const sellerProductId = result?.create?.sellerProductId || null;
          const expectedCat = product.categoryOverride != null ? Number(product.categoryOverride) : null;
          if (sellerProductId) {
            const accessKey = String(settingsSnapshot.coupangAccessKey || '').trim();
            const secretKey = String(settingsSnapshot.coupangSecretKey || '').trim();
            if (accessKey && secretKey) {
              const r = await getSellerProduct({ sellerProductId, accessKey, secretKey });
              let obj = null;
              try { obj = typeof r?.body === 'string' ? JSON.parse(r.body) : r?.body; } catch {}
              const data = obj?.data || obj || null;
              const displayCategoryCode = data?.displayCategoryCode ?? data?.displayCategoryId ?? null;
              const items = Array.isArray(data?.items) ? data.items : [];
              const item0 = items?.[0] || {};
              const content =
                item0?.content ||
                item0?.contentText ||
                item0?.contentHtml ||
                // Coupang API often returns detail under items[0].contents[].contentDetails[].content
                (Array.isArray(item0?.contents)
                  ? item0.contents
                      .flatMap((c) => (Array.isArray(c?.contentDetails) ? c.contentDetails : []))
                      .map((d) => d?.content || '')
                      .join('\n')
                  : '');
              if (!content || String(content).trim().length < 20) {
                validation.ok = false;
                validation.errors.push('detail_empty');
              }
              if (expectedCat != null && displayCategoryCode != null && Number(displayCategoryCode) !== Number(expectedCat)) {
                validation.ok = false;
                validation.errors.push('category_mismatch');
                validation.expectedCategory = expectedCat;
                validation.actualCategory = Number(displayCategoryCode);
              }
            }
          }
        } catch (e) {
          validation.ok = false;
          validation.errors.push('validation_exception');
          validation.error = String(e?.message || e);
        }

        await updateJob({
          id: job.id,
          patch: {
            status: ok ? 'success' : 'failed',
            errorCode: ok ? null : String(result?.error || 'upload_failed'),
            errorMessage: ok ? null : '업로드에 실패했습니다.',
            resultJson: { result, validation },
          },
        });

        const sellerProductId = result?.create?.sellerProductId ?? null;
        await updateCatalogProduct(req.user.id, product.id, {
          sellerProductId: sellerProductId ? String(sellerProductId) : null,
          status: ok ? (validation.ok ? 'deployed' : 'deployed_invalid') : 'deploy_failed',
          deployedAt: ok ? new Date().toISOString() : null,
          validation,
        });

        await notifyUser(req.user.id, {
          title: ok ? (validation.ok ? '업로드 완료' : '업로드 완료(검증 실패)') : '업로드 실패',
          body: (ok ? '업로드' : '업로드 실패') + ': ' + String(result?.draft?.title || product.confirmedTitle || '상품').slice(0, 40),
          tag: 'catalog-deploy',
          url: '/',
          sellerProductId,
        });
      } catch (e) {
        try {
          await updateJob({
            id: job.id,
            patch: {
              status: 'failed',
              errorCode: 'job_exception',
              errorMessage: '작업 처리 중 오류가 발생했습니다.',
            },
          });
        } catch {}
      }
    }, 0);

    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Catalog: 운영 동기화(가격/재고 등) 훅
app.post('/api/catalog/:id/sync', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const r = await syncOneCatalogProduct({ userId: req.user.id, catalogId: id, userSettings: req.user.settings || {} });
    return res.json({ ok: true, result: r });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/catalog/sync/run', authRequired, async (req, res) => {
  try {
    const r = await syncAllCatalogProducts({ userId: req.user.id, userSettings: req.user.settings || {}, limit: 200 });
    return res.json({ ok: true, result: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/catalog/:id/events', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
    const events = await listCatalogEvents(req.user.id, id, { limit });
    return res.json({ ok: true, events });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Themes (keyword presets)
app.get('/api/themes', authRequired, async (req, res) => {
  try {
    const themes = await listThemes(req.user.id);
    return res.json({ ok: true, themes });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/themes', authRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const keywordsRaw = req.body?.keywords;
    const keywords = Array.isArray(keywordsRaw) ? keywordsRaw : [];
    const theme = await createTheme(req.user.id, { name, keywords });
    return res.json({ ok: true, theme });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put('/api/themes/:id', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const patch = {
      name: req.body?.name,
      keywords: req.body?.keywords,
    };
    const theme = await updateThemeRow(req.user.id, id, patch);
    return res.json({ ok: true, theme });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/themes/:id', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const result = await deleteThemeRow(req.user.id, id);
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// Recommendations
app.get('/api/recommendations', authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
    const tier = String(req.query.tier || '').trim().toUpperCase();
    const eligibleOnly = String(req.query.eligibleOnly || '').trim() === '1';

    let items = await listRecommendations(req.user.id, { limit });
    if (tier) items = items.filter((it) => String(it?.qc?.tier || '').toUpperCase() === tier);
    if (eligibleOnly) items = items.filter((it) => Boolean(it?.qc?.eligibleUpload));

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Legacy: full regenerate (may be rate-limited). Keep for debugging.
app.post('/api/recommendations/run', authRequired, async (req, res) => {
  try {
    const topN = Math.max(1, Math.min(50, Number(req.body?.topN || 20) || 20));

    let keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : defaultKeywordSet();
    const themeId = String(req.body?.themeId || '').trim();
    if (themeId) {
      const theme = await getTheme(req.user.id, themeId);
      if (!theme) return res.status(404).json({ ok: false, error: 'theme_not_found' });
      if (Array.isArray(theme.keywords) && theme.keywords.length > 0) keywords = theme.keywords;
    }

    const active = await getActiveJobByKind(req.user.id, 'recommendations', ['queued', 'running']);
    if (active) {
      const ageMs = Date.now() - Date.parse(active.createdAt || '');
      if (Number.isFinite(ageMs) && ageMs < 20 * 60_000) {
        return res.json({ ok: true, job: active, deduped: true });
      }
    }

    const job = await createJob({ userId: req.user.id, kind: 'recommendations', inputUrl: '', force: '0', catalogId: null });

    setTimeout(async () => {
      try {
        await updateJob({ id: job.id, patch: { status: 'running' } });
        const progress = { stage: 'start', candidates: 0, validated: 0, kept: 0, target: topN };
        const lastPush = { t: 0 };

        const r = await generateRecommendationsForUser({
          userId: req.user.id,
          settings: req.user.settings || {},
          keywords,
          topN,
          onProgress: (p) => {
            Object.assign(progress, p || {});
            const now = Date.now();
            if (now - lastPush.t > 1500) {
              lastPush.t = now;
              updateJob({ id: job.id, patch: { resultJson: { progress } } }).catch(() => {});
            }
          },
        });
        await updateJob({ id: job.id, patch: { status: 'success', resultJson: { result: r, progress } } });
      } catch (e) {
        try {
          await updateJob({
            id: job.id,
            patch: {
              status: 'failed',
              errorCode: 'recommendations_failed',
              errorMessage: String(e?.message || e),
            },
          });
        } catch {}
      }
    }, 0);

    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// New: fill cache (append-only upsert) — safer under 429.
app.post('/api/recommendations/fill', authRequired, async (req, res) => {
  try {
    const targetCount = Math.max(1, Math.min(60, Number(req.body?.targetCount || 20) || 20));

    let keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : defaultKeywordSet();
    const themeId = String(req.body?.themeId || '').trim();
    if (themeId) {
      const theme = await getTheme(req.user.id, themeId);
      if (!theme) return res.status(404).json({ ok: false, error: 'theme_not_found' });
      if (Array.isArray(theme.keywords) && theme.keywords.length > 0) keywords = theme.keywords;
    }

    const active = await getActiveJobByKind(req.user.id, 'recommendations_fill', ['queued', 'running']);
    if (active) {
      const ageMs = Date.now() - Date.parse(active.createdAt || '');
      if (Number.isFinite(ageMs) && ageMs < 20 * 60_000) {
        return res.json({ ok: true, job: active, deduped: true });
      }
    }

    const job = await createJob({ userId: req.user.id, kind: 'recommendations_fill', inputUrl: '', force: '0', catalogId: null });

    setTimeout(async () => {
      try {
        await updateJob({ id: job.id, patch: { status: 'running' } });

        const progress = { stage: 'start', candidates: 0, validated: 0, kept: 0, target: targetCount, keyword: '' };
        const lastPush = { t: 0 };

        let tries = 0;
        let last = null;
        while (tries < 6) {
          tries += 1;
          last = await fillRecommendationsForUser({
            userId: req.user.id,
            settings: req.user.settings || {},
            keywords,
            targetCount,
            maxAddPerRun: 6,
            onProgress: (p) => {
              Object.assign(progress, p || {});
              const now = Date.now();
              if (now - lastPush.t > 1500) {
                lastPush.t = now;
                updateJob({ id: job.id, patch: { resultJson: { progress } } }).catch(() => {});
              }
            },
          });

          progress.kept = Number(last?.count) || progress.kept;
          progress.keyword = String(last?.keyword || progress.keyword);

          if ((Number(last?.count) || 0) >= targetCount) break;
          if ((Number(last?.inserted) || 0) <= 0) break;

          await new Promise((r) => setTimeout(r, 1500));
        }

        await updateJob({ id: job.id, patch: { status: 'success', resultJson: { result: last || { ok: true }, progress } } });
      } catch (e) {
        try {
          await updateJob({
            id: job.id,
            patch: {
              status: 'failed',
              errorCode: 'recommendations_fill_failed',
              errorMessage: String(e?.message || e),
            },
          });
        } catch {}
      }
    }, 0);

    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// Bulk upload from recommendations (theme + A-tier only)
let bulkUploadInProgress = false;
app.post('/api/recommendations/bulk-upload', authRequired, async (req, res) => {
  try {
    const themeId = String(req.body?.themeId || '').trim();
    if (!themeId) return res.status(400).json({ ok: false, error: 'missing themeId' });

    const theme = await getTheme(req.user.id, themeId);
    if (!theme) return res.status(404).json({ ok: false, error: 'theme_not_found' });

    const lim = Math.max(1, Math.min(50, Number(req.body?.limit || 10) || 10));
    const dryRun = String(req.body?.dryRun || '').trim() === '1';
    const force = String(req.body?.force || '').trim() === '1';

    if (uploadInProgress || bulkUploadInProgress) {
      return res.status(409).json({ ok: false, error: 'upload in progress' });
    }

    // ensure coupang keys exist (same as /api/upload-from-url)
    const settings = req.user.settings || {};
    const missing = [];
    if (!String(settings.coupangAccessKey || '').trim()) missing.push('coupangAccessKey');
    if (!String(settings.coupangSecretKey || '').trim()) missing.push('coupangSecretKey');
    if (!String(settings.coupangVendorId || '').trim()) missing.push('coupangVendorId');
    if (!String(settings.coupangVendorUserId || '').trim()) missing.push('coupangVendorUserId');
    if (!String(settings.coupangDeliveryCompanyCode || '').trim()) missing.push('coupangDeliveryCompanyCode');
    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'missing_coupang_keys',
        missing,
        hint: '설정 탭에서 쿠팡 키/벤더 정보를 저장하세요.',
      });
    }

    const job = await createJob({ userId: req.user.id, kind: 'bulk_upload_recommendations', inputUrl: `theme:${theme.id}`, force: force ? '1' : '0', catalogId: null });

    setTimeout(async () => {
      bulkUploadInProgress = true;
      try {
        await updateJob({ id: job.id, patch: { status: 'running' } });

        const all = await listRecommendations(req.user.id, { limit: 200 });
        const themeKeywords = new Set((theme.keywords || []).map((k) => String(k || '').trim()).filter(Boolean));

        const eligible = all
          .filter((r) => (themeKeywords.size === 0 ? true : themeKeywords.has(String(r.keyword || '').trim())))
          .filter((r) => Boolean(r?.qc?.eligibleUpload)); // A-tier default (detail images >= 3)

        const queue = eligible.slice(0, lim);

        const progress = {
          stage: dryRun ? 'dry_run' : 'upload',
          themeId: theme.id,
          themeName: theme.name,
          total: queue.length,
          uploaded: 0,
          skipped: 0,
          failed: 0,
          lastUrl: '',
        };

        const results = [];

        for (const rec of queue) {
          progress.lastUrl = rec.sourceUrl;
          await updateJob({ id: job.id, patch: { resultJson: { progress, results: results.slice(-5) } } }).catch(() => {});

          // Dedupe unless force
          const existing = await getUploadedProductByUrl(req.user.id, rec.sourceUrl);
          if (!force && existing?.seller_product_id) {
            progress.skipped += 1;
            results.push({ url: rec.sourceUrl, ok: true, skipped: true, reason: 'duplicate_product', sellerProductId: existing.seller_product_id });
            continue;
          }

          if (dryRun) {
            progress.skipped += 1;
            results.push({ url: rec.sourceUrl, ok: true, skipped: true, reason: 'dry_run' });
            continue;
          }

          // serialize with existing upload lock
          uploadInProgress = true;
          const effectiveSettings = { ...settings };
          // Theme guardrails: keep category stable for now to reduce create/approval failures.
          if (theme.id === 'starter-toilet-pad') {
            // 배변패드 테마는 카테고리 변동(예: 65905)되면 옵션/단위 검증이 빡세져서 실패가 많이 남.
            // 운영 안정성 우선: 65906으로 고정하고 자동분류는 끔.
            effectiveSettings.categoryOverrideCode = 65906;
            effectiveSettings.autoCategoryMatch = '0';
            effectiveSettings.autoCategoryPredict = '0';
          }
          const r = await runUploadFromUrl(rec.sourceUrl, effectiveSettings).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          uploadInProgress = false;

          const ok = Boolean(r?.ok);
          if (ok) progress.uploaded += 1;
          else progress.failed += 1;

          // Store upload record for dedupe (only when created)
          try {
            const sellerProductId = r?.create?.sellerProductId ?? null;
            if (sellerProductId) {
              await upsertUploadedProduct({
                userId: req.user.id,
                sourceUrl: rec.sourceUrl,
                sellerProductId,
                title: r?.draft?.title || rec.title || '',
                finalPrice: r?.finalPrice ?? rec.finalPrice ?? null,
              });
            }
          } catch {}

          results.push({ url: rec.sourceUrl, ok, sellerProductId: r?.create?.sellerProductId ?? null, error: r?.error || r?.create?.error || null });
          await new Promise((rr) => setTimeout(rr, 700));
        }

        await updateJob({ id: job.id, patch: { status: 'success', resultJson: { progress, results } } });
      } catch (e) {
        try {
          await updateJob({
            id: job.id,
            patch: {
              status: 'failed',
              errorCode: 'bulk_upload_failed',
              errorMessage: String(e?.message || e),
            },
          });
        } catch {}
      } finally {
        uploadInProgress = false;
        bulkUploadInProgress = false;
      }
    }, 0);

    return res.json({ ok: true, job });
  } catch (e) {
    bulkUploadInProgress = false;
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ PWA Push: VAPID public key
app.get("/api/push/public-key", authRequired, (req, res) => {
  return res.json({ ok: true, publicKey: VAPID.publicKey });
});

// ✅ PWA Push: subscribe/unsubscribe
app.post("/api/push/subscribe", authRequired, async (req, res) => {
  try {
    const subscription = req.body?.subscription || null;
    await upsertPushSubscription({ userId: req.user.id, subscription });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/push/unsubscribe", authRequired, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || "").trim();
    if (!endpoint) return res.status(400).json({ ok: false, error: "missing endpoint" });
    await deletePushSubscription({ userId: req.user.id, endpoint });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ Native APNs: register/unregister device token
app.post("/api/apns/register", authRequired, async (req, res) => {
  try {
    const deviceToken = String(req.body?.deviceToken || "").trim();
    if (!deviceToken) return res.status(400).json({ ok: false, error: "missing deviceToken" });
    await upsertApnsToken({ userId: req.user.id, deviceToken });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/apns/unregister", authRequired, async (req, res) => {
  try {
    const deviceToken = String(req.body?.deviceToken || "").trim();
    if (!deviceToken) return res.status(400).json({ ok: false, error: "missing deviceToken" });
    await deleteApnsToken({ userId: req.user.id, deviceToken });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ Jobs: start + status
app.post("/api/jobs/start", authRequired, async (req, res) => {
  try {
    const kind = String(req.body?.kind || "").trim();
    const url = String(req.body?.url || "").trim();
    const force = String(req.body?.force || "0").trim() === "1" ? "1" : "0";
    const titleOverride = String(req.body?.titleOverride || "").trim();
    const catalogId = String(req.body?.catalogId || "").trim();
    const imagesOverrideRaw = req.body?.imagesOverride;
    const imagesOverride = Array.isArray(imagesOverrideRaw)
      ? imagesOverrideRaw.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 50)
      : [];

    const presetId = String(req.body?.presetId || "").trim();
    const settingsOverride = (req.body?.settingsOverride && typeof req.body.settingsOverride === "object")
      ? req.body.settingsOverride
      : null;
    if (!kind || (kind !== "preview" && kind !== "upload")) {
      return res.status(400).json({ ok: false, error: "invalid_kind" });
    }
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    // Dedupe for upload jobs (unless force)
    if (kind === "upload" && force !== "1") {
      const existing = await getUploadedProductByUrl(req.user.id, c.url);
      if (existing?.seller_product_id) {
        const pid = String(existing.seller_product_id);
        return res.status(409).json({
          ok: false,
          error: "duplicate_product",
          existing: {
            sourceUrl: existing.source_url,
            title: existing.title,
            finalPrice: existing.final_price,
            sellerProductId: pid,
            productUrl: `https://www.coupang.com/vp/products/${pid}`,
            createdAt: existing.created_at,
          },
        });
      }
    }

    const userId = req.user.id;

    let presetSettings = {};
    if (presetId) {
      try {
        const p = await getPreset(req.user.id, presetId);
        if (p?.settings && typeof p.settings === "object") presetSettings = p.settings;
      } catch {}
    }

    const settingsSnapshot = {
      ...(req.user.settings || {}),
      ...(presetSettings || {}),
      ...(settingsOverride || {}),
      ...(titleOverride ? { titleOverride } : {}),
      ...(imagesOverride.length > 0 ? { imagesOverride } : {}),
    };

    const job = await createJob({ userId, kind, inputUrl: c.url, force, catalogId: catalogId || null });

    // Run in background
    setTimeout(async () => {
      try {
        await updateJob({ id: job.id, patch: { status: "running", resultJson: { progress: { stage: "start", kind } } } });

        if (kind === "preview") {
          try {
            await updateJob({ id: job.id, patch: { resultJson: { progress: { stage: "preview", url: c.url } } } });
          } catch {}
          const preview = await previewUploadFromUrl(c.url, settingsSnapshot);
          if (!preview.ok) {
            await updateJob({
              id: job.id,
              patch: {
                status: "failed",
                errorCode: "preview_failed",
                errorMessage: "미리보기에 실패했습니다.",
                resultJson: { preview },
              },
            });
            await notifyUser(userId, {
              title: "미리보기 실패",
              body: `미리보기 실패: ${String(preview?.draft?.title || "상품").slice(0, 40)}`,
              tag: "job-preview",
              url: "/",
            });
            return;
          }

          await updateJob({ id: job.id, patch: { status: "success", resultJson: { preview } } });
          await notifyUser(userId, {
            title: "미리보기 완료",
            body: `미리보기 완료: ${String(preview?.draft?.title || "상품").slice(0, 40)}`,
            tag: "job-preview",
            url: "/",
          });
          return;
        }

        // upload
        try {
          await updateJob({ id: job.id, patch: { resultJson: { progress: { stage: 'upload', url: c.url } } } });
        } catch {}

        const result = await runUploadFromUrl(c.url, { ...settingsSnapshot, force });
        const ok = Boolean(result?.ok);
        await updateJob({
          id: job.id,
          patch: {
            status: ok ? "success" : "failed",
            errorCode: ok ? null : String(result?.error || "upload_failed"),
            errorMessage: ok ? null : "업로드에 실패했습니다.",
            resultJson: { result, progress: { stage: ok ? "done" : "failed" } },
          },
        });

        // If upload succeeded, also upsert into "내 상품" catalog.
        if (ok) {
          try {
            const confirmedTitle = String(settingsSnapshot?.titleOverride || result?.draft?.title || "").trim();
            const mainImageUrl = String(result?.draft?.imageUrl || "").trim();
            const detailImages = Array.isArray(settingsSnapshot?.imagesOverride) ? settingsSnapshot.imagesOverride : [];

            const p = await upsertCatalogProduct({
              userId,
              sourceUrl: c.url,
              confirmedTitle,
              mainImageUrl,
              detailImages,
              presetId: presetId || null,
              categoryOverride: settingsSnapshot?.displayCategoryCode ?? null,
              status: 'deployed',
            });

            if (p?.id) {
              const prevValidation = (p.validation && typeof p.validation === 'object') ? p.validation : {};
              await updateCatalogProduct(userId, p.id, {
                sellerProductId: result?.create?.sellerProductId || null,
                deployedAt: new Date().toISOString(),
                validation: {
                  ...prevValidation,
                  lastUpload: {
                    at: new Date().toISOString(),
                    finalPrice: result?.finalPrice ?? null,
                    category: result?.category ?? null,
                    payloadCheck: result?.payloadCheck ?? null,
                  },
                },
              });
            }
          } catch {}
        }

        await notifyUser(userId, {
          title: ok ? "업로드 완료" : "업로드 실패",
          body: `${ok ? "업로드 완료" : "업로드 실패"}: ${String(result?.draft?.title || "상품").slice(0, 40)}`,
          tag: "job-upload",
          url: "/",
          sellerProductId: result?.create?.sellerProductId || null,
        });
      } catch {
        try {
          await updateJob({
            id: job.id,
            patch: {
              status: "failed",
              errorCode: "job_exception",
              errorMessage: "작업 처리 중 오류가 발생했습니다.",
            },
          });
        } catch {}
      }
    }, 0);

    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/jobs/:id", authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const job = await getJob(req.user.id, id);
    if (!job) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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

// ✅ 업로드 Preview API (쿠팡 키 없어도 동작)
app.post("/api/upload/preview", authRequired, async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    const presetId = String(req.body?.presetId || "").trim();
    const settingsOverride = (req.body?.settingsOverride && typeof req.body.settingsOverride === "object")
      ? req.body.settingsOverride
      : null;

    let presetSettings = {};
    if (presetId) {
      try {
        const p = await getPreset(req.user.id, presetId);
        if (p?.settings && typeof p.settings === "object") presetSettings = p.settings;
      } catch {}
    }

    const effectiveSettings = {
      ...(req.user.settings || {}),
      ...(presetSettings || {}),
      ...(settingsOverride || {}),
    };

    const preview = await previewUploadFromUrl(c.url, effectiveSettings);
    if (!preview.ok) {
      // push (best-effort)
      setTimeout(() => {
        notifyUser(req.user.id, {
          title: "미리보기 실패",
          body: `미리보기 실패: ${(preview?.draft?.title || "").slice(0, 40)}`,
          tag: "preview",
          url: "/",
        });
      }, 0);
      return res.status(400).json({ ok: false, preview });
    }

    // Store preview history in sqlite
    try {
      await addPreviewHistory({
        userId: req.user.id,
        url: preview.url,
        title: preview.draft?.title || "",
        sourcePrice: preview.draft?.price ?? null,
        finalPrice: preview.computed?.finalPrice ?? null,
        imageUrl: preview.draft?.imageUrl || "",
        images: preview.computed?.images || [],
        options: preview.options || [],
        retentionDays: 7,
        maxRows: 30,
      });
    } catch {}

    // push (best-effort)
    setTimeout(() => {
      notifyUser(req.user.id, {
        title: "미리보기 완료",
        body: `미리보기 완료: ${String(preview?.draft?.title || "상품").slice(0, 40)}`,
        tag: "preview",
        url: "/",
      });
    }, 0);

    return res.json({ ok: true, preview });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/upload/preview/history", authRequired, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const history = await listPreviewHistory(req.user.id, limit);
    return res.json({ ok: true, history });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Orders (MVP scaffold)
app.get("/api/orders", authRequired, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);

    // Demo mode: return deterministic orders without needing real Coupang data.
    if (String(process.env.CE_DEMO_MODE || '').trim() === '1') {
      const now = new Date().toISOString();
      const orders = Array.from({ length: Math.max(1, Math.min(30, limit || 10)) }).map((_, i) => ({
        id: `demo-${i + 1}`,
        at: now,
        source: 'coupang',
        status: i % 3 === 0 ? 'ACCEPT' : (i % 3 === 1 ? 'INSTRUCT' : 'DELIVERING'),
        externalId: `demo-sheet-${Math.floor(i / 2) + 1}`,
        externalSubId: String(i + 1),
        order: {
          sheet: {
            orderId: `demo-order-${Math.floor(i / 2) + 1}`,
            receiver: {
              name: '홍길동',
              postCode: '06236',
              addr1: '서울 강남구 테헤란로 123',
              addr2: '101동 1001호',
              receiverNumber: '010-1234-5678',
            },
          },
          item: {
            vendorItemName: `데모 상품 ${i + 1}`,
            sellerProductName: `데모 상품 ${i + 1}`,
            shippingCount: (i % 4) + 1,
          },
        },
      }));

      return res.json({ ok: true, demoMode: true, orders });
    }

    const orders = await listOrders(req.user.id, limit);
    return res.json({ ok: true, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Shipping status refresh (MVP stub)
app.post('/api/orders/shipping/refresh', authRequired, async (req, res) => {
  try {
    const dateFrom = String(req.body?.dateFrom || '').trim();
    const dateTo = String(req.body?.dateTo || '').trim();
    const status = String(req.body?.status || 'ACCEPT').trim();

    // Demo mode: pretend refresh succeeded.
    if (String(process.env.CE_DEMO_MODE || '').trim() === '1') {
      return res.json({
        ok: true,
        demoMode: true,
        result: {
          ok: true,
          mode: 'demo',
          dateFrom,
          dateTo,
          status,
          scannedSheets: 12,
          processed: 24,
          at: new Date().toISOString(),
        },
      });
    }

    log(`[orders.refresh] user=${req.user.id} dateFrom=${dateFrom} dateTo=${dateTo} status=${status}`);

    const result = await refreshShippingStatusesFromCoupang({
      userId: req.user.id,
      settings: req.user.settings || {},
      dateFrom,
      dateTo,
      status,
    });

    log(`[orders.refresh] user=${req.user.id} ok=${Boolean(result?.ok)} result=${JSON.stringify(result).slice(0, 2000)}`);

    if (!result?.ok) {
      // Friendly errors for the app
      if (result?.reason === 'missing_keys') {
        return res.status(400).json({
          ok: false,
          error: '쿠팡 키가 필요해요. 더보기 탭에서 쿠팡 Access Key / Secret Key / Vendor ID를 먼저 넣어주세요.',
          details: result,
        });
      }
      if (result?.reason === 'missing_dates') {
        return res.status(400).json({
          ok: false,
          error: '날짜를 먼저 적어주세요. (예: 2026-02-08)',
          details: result,
        });
      }
      return res.status(400).json({
        ok: false,
        error: '쿠팡에서 주문을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.',
        details: result,
      });
    }

    return res.json({ ok: true, result });
  } catch (e) {
    log(`[orders.refresh] user=${req.user.id} exception=${String(e?.message || e)}`);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- MVP: seeded orders -> vendor purchase upload flow ----
app.post("/api/purchase/draft", authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.body?.limit || 200) || 200));
    const orders = await listOrders(req.user.id, limit);
    const paid = orders.filter((o) => String(o.status || "") === "paid");

    const draft = await exportPaidOrdersToVendors({ orders: paid, vendors: ["domeme", "domeggook"] });

    const draftsByVendor = {};
    for (const r of draft.results || []) {
      if (r?.vendor) draftsByVendor[r.vendor] = r;
    }

    runtimeState.purchaseDrafts.set(String(req.user.id), {
      createdAt: Date.now(),
      drafts: draftsByVendor,
    });

    for (const r of draft.results || []) {
      appendPurchaseLog(req.user.id, {
        type: "draft",
        vendor: r?.vendor || "",
        ok: Boolean(r?.ok),
        error: r?.error || "",
        filePath: r?.filePath || "",
      });
    }

    return res.json({ ok: true, draft: { ...draft, paidOrderCount: paid.length } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/purchase/upload", authRequired, async (req, res) => {
  try {
    const vendors = Array.isArray(req.body?.vendors) && req.body.vendors.length
      ? req.body.vendors
      : ["domeme", "domeggook"];

    const cached = runtimeState.purchaseDrafts.get(String(req.user.id)) || null;
    let drafts = cached?.drafts || null;

    // If no cached drafts, auto-draft from latest paid orders.
    if (!drafts) {
      const orders = await listOrders(req.user.id, 200);
      const paid = orders.filter((o) => String(o.status || "") === "paid");
      const draft = await exportPaidOrdersToVendors({ orders: paid, vendors });
      drafts = {};
      for (const r of draft.results || []) {
        if (r?.vendor) drafts[r.vendor] = r;
      }
      runtimeState.purchaseDrafts.set(String(req.user.id), {
        createdAt: Date.now(),
        drafts,
      });
    }

    const results = [];
    for (const v of vendors) {
      const d = drafts?.[v] || null;
      const filePath = String(req.body?.filePaths?.[v] || d?.filePath || "").trim();
      if (!filePath) {
        results.push({ ok: false, vendor: v, error: "missing_filePath" });
        appendPurchaseLog(req.user.id, {
          type: "upload",
          vendor: v,
          ok: false,
          error: "missing_filePath",
          filePath: "",
        });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const r = await uploadVendorPurchaseExcel({
        vendor: v,
        filePath,
        settings: req.user.settings || {},
        storageStateDefaultPath: v === "domeme" ? DOMEME_STORAGE_STATE_PATH : DOMEGGOOK_STORAGE_STATE_PATH,
      });
      results.push(r);
      appendPurchaseLog(req.user.id, {
        type: "upload",
        vendor: v,
        ok: Boolean(r?.ok),
        error: r?.error || "",
        filePath,
        payUrl: r?.payUrl || "",
      });
    }

    return res.json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/purchase/logs", authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
    const list = runtimeState.purchaseLogs.get(String(req.user.id)) || [];
    return res.json({ ok: true, logs: list.slice(0, limit) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Dev-only: seed dummy paid orders (domeme + domeggook)
app.post("/api/dev/orders/seed", authRequired, async (req, res) => {
  try {
    const enabled =
      String(process.env.COUPLUS_DEV || "").trim() === "1" ||
      String(req.query.dev || "").trim() === "1";
    if (!enabled) {
      return res.status(403).json({ ok: false, error: "dev_disabled" });
    }

    await clearOrders(req.user.id);

    const now = new Date().toISOString();

    await addOrder({
      userId: req.user.id,
      source: "domeme",
      status: "paid",
      order: {
        kind: "mock",
        paidAt: now,
        marketplace: "coupang",
        note: "mock paid order (domeme)",
        items: [
          {
            source: "domeme",
            sourceUrl: "https://domeme.domeggook.com/s/9541992",
            title: "[MOCK] 도매매 테스트 상품",
            qty: 1,
          },
        ],
      },
    });

    await addOrder({
      userId: req.user.id,
      source: "domeggook",
      status: "paid",
      order: {
        kind: "mock",
        paidAt: now,
        marketplace: "coupang",
        note: "mock paid order (domeggook)",
        items: [
          {
            source: "domeggook",
            sourceUrl: "https://domeggook.com/49643476",
            title: "[MOCK] 도매꾹 테스트 상품 (SbaLg3)",
            qty: 8,
          },
        ],
      },
    });

    const orders = await listOrders(req.user.id, 50);
    return res.json({ ok: true, seeded: orders.length, orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 업로드 Execute API (쿠팡 키 필요) - MVP stub
app.post("/api/upload/execute", authRequired, async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const settings = req.user.settings || {};
    const missing = [];
    if (!String(settings.coupangAccessKey || "").trim()) missing.push("coupangAccessKey");
    if (!String(settings.coupangSecretKey || "").trim()) missing.push("coupangSecretKey");
    if (!String(settings.coupangVendorId || "").trim()) missing.push("coupangVendorId");
    if (!String(settings.coupangVendorUserId || "").trim()) missing.push("coupangVendorUserId");
    if (!String(settings.coupangDeliveryCompanyCode || "").trim()) missing.push("coupangDeliveryCompanyCode");

    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "missing_coupang_keys",
        missing,
        hint: "설정 탭에서 쿠팡 키/벤더 정보를 저장하세요.",
      });
    }

    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    const force = String(req.body?.force || "").trim() === "1";

    // Dedupe: block duplicate uploads of the same source URL (unless force=1)
    const existing = await getUploadedProductByUrl(req.user.id, c.url);
    if (!force && existing?.seller_product_id) {
      const pid = String(existing.seller_product_id);
      return res.status(409).json({
        ok: false,
        error: "duplicate_product",
        existing: {
          sourceUrl: existing.source_url,
          title: existing.title,
          finalPrice: existing.final_price,
          sellerProductId: pid,
          productUrl: `https://www.coupang.com/vp/products/${pid}`,
          createdAt: existing.created_at,
        },
      });
    }

    // NOTE: For now we simply reuse the existing pipeline.
    if (uploadInProgress) {
      return res.status(409).json({ ok: false, error: "upload in progress" });
    }
    uploadInProgress = true;

    const result = await runUploadFromUrl(c.url, settings);

    // Store upload record for dedupe (only when created)
    try {
      const sellerProductId = result?.create?.sellerProductId ?? null;
      if (sellerProductId) {
        await upsertUploadedProduct({
          userId: req.user.id,
          sourceUrl: c.url,
          sellerProductId,
          title: result?.draft?.title || "",
          finalPrice: result?.finalPrice ?? null,
        });
      }
    } catch {}

    appendUploadHistory({
      at: new Date().toISOString(),
      url: c.url,
      ok: Boolean(result?.ok),
      payloadOnly: Boolean(result?.payloadOnly),
      title: result?.draft?.title || "",
      finalPrice: result?.finalPrice ?? null,
      optionsCount: Array.isArray(result?.optionsUsed) ? result.optionsUsed.length : 0,
      sellerProductId: result?.create?.sellerProductId ?? null,
      createStatus: result?.create?.status ?? null,
      error: result?.error || null,
    });
    uploadInProgress = false;

    // IMPORTANT: the client UI uses top-level ok to show "업로드 성공".
    // If the pipeline failed (e.g. image_host_unreachable), propagate it.
    const ok = Boolean(result?.ok);

    // push (best-effort)
    setTimeout(() => {
      const title = String(result?.draft?.title || "상품");
      const sellerProductId = result?.create?.sellerProductId || null;
      const body = ok
        ? `업로드 완료: ${title.slice(0, 40)}`
        : `업로드 실패: ${title.slice(0, 40)}`;
      notifyUser(req.user.id, {
        title: ok ? "업로드 완료" : "업로드 실패",
        body,
        tag: "upload",
        url: "/",
        sellerProductId,
      });
    }, 0);

    return res.status(ok ? 200 : 400).json({ ok, result });
  } catch (e) {
    uploadInProgress = false;
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 업로드 API (legacy)
app.post("/api/upload", authRequired, async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    const force = String(req.body?.force || "").trim() === "1";

    // Dedupe: block duplicate uploads of the same source URL (unless force=1)
    const existing = await getUploadedProductByUrl(req.user.id, c.url);
    if (!force && existing?.seller_product_id) {
      const pid = String(existing.seller_product_id);
      return res.status(409).json({
        ok: false,
        error: "duplicate_product",
        existing: {
          sourceUrl: existing.source_url,
          title: existing.title,
          finalPrice: existing.final_price,
          sellerProductId: pid,
          productUrl: `https://www.coupang.com/vp/products/${pid}`,
          createdAt: existing.created_at,
        },
      });
    }

    if (uploadInProgress) {
      return res.status(409).json({ ok: false, error: "upload in progress" });
    }
    uploadInProgress = true;

    const result = await runUploadFromUrl(c.url, req.user.settings || {});

    // Store upload record for dedupe (only when created)
    try {
      const sellerProductId = result?.create?.sellerProductId ?? null;
      if (sellerProductId) {
        await upsertUploadedProduct({
          userId: req.user.id,
          sourceUrl: c.url,
          sellerProductId,
          title: result?.draft?.title || "",
          finalPrice: result?.finalPrice ?? null,
        });
      }
    } catch {}

    appendUploadHistory({
      at: new Date().toISOString(),
      url: c.url,
      ok: Boolean(result?.ok),
      payloadOnly: Boolean(result?.payloadOnly),
      title: result?.draft?.title || "",
      finalPrice: result?.finalPrice ?? null,
      optionsCount: Array.isArray(result?.optionsUsed) ? result.optionsUsed.length : 0,
      sellerProductId: result?.create?.sellerProductId ?? null,
      createStatus: result?.create?.status ?? null,
      error: result?.error || null,
    });
    uploadInProgress = false;

    const ok = Boolean(result?.ok);

    // push (best-effort)
    setTimeout(() => {
      const title = String(result?.draft?.title || "상품");
      const sellerProductId = result?.create?.sellerProductId || null;
      const body = ok
        ? `업로드 완료: ${title.slice(0, 40)}`
        : `업로드 실패: ${title.slice(0, 40)}`;
      notifyUser(req.user.id, {
        title: ok ? "업로드 완료" : "업로드 실패",
        body,
        tag: "upload",
        url: "/",
        sellerProductId,
      });
    }, 0);

    return res.status(ok ? 200 : 400).json({ ok, result });
  } catch (e) {
    uploadInProgress = false;
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 주문 엑셀 생성
app.post("/api/orders/export", authRequired, async (req, res) => {
  try {
    const dateFrom = String(req.body?.dateFrom || "").trim();
    const dateTo = String(req.body?.dateTo || "").trim();
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ ok: false, error: "missing dates" });
    }
    const result = await exportOrdersToDomeme({
      dateFrom,
      dateTo,
      status: "ACCEPT",
      settings: req.user.settings || {},
    });
    return res.json({ ok: true, result });
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
    if (!filePath) return res.status(400).json({ ok: false, error: "missing filePath" });
    const result = await uploadDomemeExcel({ filePath, settings: req.user.settings || {} });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/upload/history", authRequired, (req, res) => {
  return res.json({ ok: true, history: loadUploadHistory() });
});

// ✅ 도매매 세션 생성 시작 (네이버 로그인)
app.post("/api/domeme/session/start", authRequired, (req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "save_domeme_session.js");
    const logPath = path.join(process.cwd(), "data", "session_start.log");
    const out = fs.openSync(logPath, "a");

    const { id, flagPath } = newSessionFlag("domeme");
    const key = `${req.user.id}:domeme`;

    const child = spawn("node", [scriptPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        COUPLUS_SESSION_FLAG_PATH: flagPath,
        COUPLUS_SESSION_WAIT_MS: String(process.env.COUPLUS_SESSION_WAIT_MS || "600000"),
      },
    });

    runtimeState.sessionRuns.set(key, {
      id,
      flagPath,
      pid: child.pid,
      startedAt: Date.now(),
    });

    child.unref();
    return res.json({ ok: true, sessionId: id, pid: child.pid, logPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/domeme/session/save", authRequired, (req, res) => {
  try {
    const key = `${req.user.id}:domeme`;
    const run = runtimeState.sessionRuns.get(key);
    if (!run?.flagPath) return res.status(400).json({ ok: false, error: "no_active_session" });
    touchFlag(run.flagPath);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매매 세션 상태 확인
app.get("/api/domeme/session/status", (req, res) => {
  try {
    const filePath = DOMEME_STORAGE_STATE_PATH;
    if (!fs.existsSync(filePath)) return res.json({ ok: true, exists: false, valid: false, filePath });
    const stat = fs.statSync(filePath);
    return res.json({
      ok: true,
      exists: true,
      valid: true,
      filePath,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매꾹 세션 생성 시작 (네이버 로그인)
app.post("/api/domeggook/session/start", authRequired, (req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "save_domeggook_login_state.js");
    const logPath = path.join(process.cwd(), "data", "session_start.log");
    const out = fs.openSync(logPath, "a");

    const { id, flagPath } = newSessionFlag("domeggook");
    const key = `${req.user.id}:domeggook`;

    const child = spawn("node", [scriptPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        COUPLUS_SESSION_FLAG_PATH: flagPath,
        COUPLUS_SESSION_WAIT_MS: String(process.env.COUPLUS_SESSION_WAIT_MS || "600000"),
      },
    });

    runtimeState.sessionRuns.set(key, {
      id,
      flagPath,
      pid: child.pid,
      startedAt: Date.now(),
    });

    child.unref();
    return res.json({ ok: true, sessionId: id, pid: child.pid, logPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/domeggook/session/save", authRequired, (req, res) => {
  try {
    const key = `${req.user.id}:domeggook`;
    const run = runtimeState.sessionRuns.get(key);
    if (!run?.flagPath) return res.status(400).json({ ok: false, error: "no_active_session" });
    touchFlag(run.flagPath);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매꾹 세션 상태 확인
app.get("/api/domeggook/session/status", (req, res) => {
  try {
    const filePath = DOMEGGOOK_STORAGE_STATE_PATH;
    if (!fs.existsSync(filePath)) return res.json({ ok: true, exists: false, valid: false, filePath });
    const stat = fs.statSync(filePath);
    return res.json({
      ok: true,
      exists: true,
      valid: true,
      filePath,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
// kakao oauth removed: /auth/kakao

/**
 * ✅ 2) 콜백
 * - 절대 다시 /auth/kakao로 redirect 하지 말 것(무한루프 원인 1순위)
 * - 성공/실패든 "항상 HTML 응답으로 종료"
 */
// kakao oauth removed: /auth/kakao/callback

// kakao oauth removed

// Default to 0.0.0.0 so the UI is reachable over Tailscale.
// Override with HOST=127.0.0.1 if you explicitly want local-only.
const HOST = (process.env.HOST || "0.0.0.0").trim();

app.listen(PORT, HOST, async () => {
  const baseHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  log(`server running: http://${baseHost}:${PORT}`);
  log(`domeggook openapi key: ${DOMEGGOOK_OPENAPI_KEY ? 'present' : 'missing'}`);
  // kakao oauth removed
  log(`bind: ${HOST}:${PORT}`);

  // 운영 동기화 루프(옵션): CE_SYNC_INTERVAL_MIN 설정 시 주기 실행
  const intervalMin = Number(process.env.CE_SYNC_INTERVAL_MIN || 0);
  if (Number.isFinite(intervalMin) && intervalMin > 0) {
    const intervalMs = Math.max(60_000, intervalMin * 60_000);
    startCatalogSyncLoop({
      getUsers: async () => await listUsersForSync(),
      intervalMs,
    });
    log(`catalog sync loop enabled: every ${intervalMin} min`);
  }

  // Daily recommendations loop (09:00 Asia/Seoul; best-effort)
  startRecommendationLoop({
    getUsers: async () => await listUsersForSync(),
    hour: 9,
    minute: 0,
    intervalMs: 60_000,
  });
  log('recommendations loop enabled: daily 09:00');
});
