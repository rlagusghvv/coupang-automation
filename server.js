// server.js (ESM)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { runUploadFromUrl } from "./src/server/externalAdapters.js";
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
  listJobs,
  getNextQueuedJob,
  cancelQueuedJob,
  deleteJob,
  cleanupJobs,
  upsertCatalogProduct,
  listCatalogProducts,
  getCatalogProductById,
  updateCatalogProduct,
  deleteCatalogProduct,
  listCatalogEvents,
  listUsersForSync,
  listUsersWithPushTargets,
  getRecommendationsNotifyState,
  setRecommendationsLastNotifiedAt,
  clearRecommendationsForUser,
  getActiveJobByKind,
} from "./src/server/storage_sqlite.js";
import {
  listPresets,
  getPreset,
  upsertPreset,
  deletePreset,
} from "./src/server/presets_sqlite.js";
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
  countRecommendations,
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
app.use("/couplus-out", express.static(path.join(process.cwd(), "out")));
// 레거시 경로도 유지
app.use("/tmp", express.static(path.join(process.cwd(), "out"))); // /tmp/tmp_main.jpg 같은 형태로도 접근 가능
// Console (existing dashboard)
app.get('/console', (req, res) => {
  return res.sendFile(path.join(process.cwd(), 'public', 'console.html'));
});
app.get('/console/*', (req, res) => {
  return res.redirect('/console');
});

// Main app entry
// `https://app.splui.com/app/` is the public entrypoint.
// Proxy /app/* to the Next.js UI server (coupang-elephant) running locally.
// Keep the old Flutter bundle under `/legacy-app/`.
// This route must be defined BEFORE express.static.
const NEXT_UI_ORIGIN = String(process.env.NEXT_UI_ORIGIN || 'http://127.0.0.1:3333').trim();

async function proxyToNext(req, res) {
  try {
    // Proxy the request as-is to the Next.js UI server.
    // The Next app uses `/app` as its basePath, so we must keep the prefix.
    const orig = String(req.originalUrl || req.url || '/');
    const targetUrl = new URL(orig, NEXT_UI_ORIGIN);

    const hopByHop = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'transfer-encoding',
      'upgrade',
      'host'
    ]);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!k) continue;
      const key = String(k).toLowerCase();
      if (hopByHop.has(key)) continue;
      headers[key] = v;
    }
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';

    const method = (req.method || 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : req;

    const upstream = await fetch(targetUrl.toString(), {
      method,
      headers,
      body,
      redirect: 'manual'
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (hopByHop.has(String(key).toLowerCase())) return;
      res.setHeader(key, value);
    });

    if (upstream.body) {
      // Node's fetch() returns a WHATWG ReadableStream; convert to Node stream.
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch {
    res.status(502).send('UI proxy error');
  }
}

app.use('/app', proxyToNext);

// Legacy Flutter bundle
app.use('/legacy-app', express.static(path.join(process.cwd(), 'public', 'app')));

app.use(express.static(path.join(process.cwd(), "public")));

const PORT = Number(process.env.PORT || 3000);

const TOKENS_PATH =
  process.env.FRIEND_TOKENS_PATH ||
  path.join(process.cwd(), "friend_tokens.json");

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

// ---- Upload queue (per-user, sequential) ----
async function processUploadQueueForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;

  // simple per-user mutex
  if (runtimeState.uploadQueueLocks.get(uid)) return;
  runtimeState.uploadQueueLocks.set(uid, true);

  try {
    // Loop: run next queued upload until none left.
    for (;;) {
      // If there's a running upload, do nothing.
      const running = await listJobs(uid, { kind: 'upload', statuses: ['running'], limit: 1 });
      if (running && running.length > 0) return;

      const next = await getNextQueuedJob(uid, 'upload');
      if (!next) return;

      const settingsSnapshot = (next?.result?.request?.settingsSnapshot && typeof next.result.request.settingsSnapshot === 'object')
        ? next.result.request.settingsSnapshot
        : {};
      const presetId = String(next?.result?.request?.presetId || '').trim();

      await executeUploadJob({
        userId: uid,
        jobId: next.id,
        url: next.inputUrl,
        force: next.force,
        settingsSnapshot,
        presetId: presetId || null,
      });

      // continue to next item
    }
  } catch (e) {
    // do not crash server
  } finally {
    runtimeState.uploadQueueLocks.set(uid, false);
  }
}

function isRetriableUploadError(code) {
  const c = String(code || '').trim();
  if (!c) return false;
  if (c === 'coupang_rate_limited') return true;
  if (c === 'detail_images_unavailable') return false; // deterministic until config changes
  if (c.startsWith('coupang_create_http_429')) return true;
  if (c.startsWith('coupang_create_http_5')) return true;
  if (c === 'job_exception') return true;
  return false;
}

function computeBackoffMs(attempt) {
  const a = Math.max(1, Math.min(10, Number(attempt) || 1));
  // 10s, 20s, 40s, 80s, ... capped at 10 minutes
  const base = Math.min(10 * 60_000, 10_000 * (2 ** (a - 1)));
  const jitter = Math.floor(Math.random() * 1500);
  return base + jitter;
}

async function executeUploadJob({ userId, jobId, url, force, settingsSnapshot, presetId }) {
  const job = { id: String(jobId), kind: 'upload' };
  const inputUrl = String(url || '').trim();

  // Mark running
  await updateJob({
    id: job.id,
    patch: {
      status: 'running',
      resultJson: {
        request: {
          settingsSnapshot: settingsSnapshot || {},
          presetId: presetId || null,
        },
        progress: { stage: 'start', percent: 0, url: inputUrl },
      },
    },
  });

  const progressState = {
    request: {
      settingsSnapshot: settingsSnapshot || {},
      presetId: presetId || null,
    },
    progress: { stage: 'start', percent: 0, url: inputUrl },
  };

  const pushProgress = (p) => {
    try {
      if (!p || typeof p !== 'object') return;
      progressState.progress = { ...(progressState.progress || {}), ...p };
      updateJob({ id: job.id, patch: { resultJson: progressState } }).catch(() => {});
    } catch {}
  };

  try {
    pushProgress({ stage: 'upload', percent: 10, url: inputUrl });

    const result = await runUploadFromUrl(inputUrl, {
      ...(settingsSnapshot || {}),
      force,
      onProgress: pushProgress,
    });

    const ok = Boolean(result?.ok);

    // If retriable failure, re-queue with backoff (avoid immediate hammering)
    if (!ok && isRetriableUploadError(result?.error)) {
      const prevAttempt = Number(progressState?.request?.attempt || progressState?.result?.request?.attempt || 0);
      const attempt = prevAttempt + 1;
      const maxAttempts = 6;

      if (attempt <= maxAttempts) {
        const delayMs = computeBackoffMs(attempt);
        const retryAtMs = Date.now() + delayMs;

        progressState.request = { ...(progressState.request || {}), attempt, retryAtMs };
        progressState.result = result;
        progressState.progress = {
          stage: 'backoff',
          percent: Math.max(1, Number(progressState?.progress?.percent || 0)),
          url: inputUrl,
          retryInSec: Math.ceil(delayMs / 1000),
        };

        await updateJob({
          id: job.id,
          patch: {
            status: 'queued',
            errorCode: 'retry_scheduled',
            errorMessage: `레이트리밋/일시적 오류로 재시도 예약 (${attempt}/${maxAttempts})`,
            resultJson: progressState,
          },
        });

        setTimeout(() => processUploadQueueForUser(userId).catch(() => {}), Math.min(delayMs + 200, 10 * 60_000));
        return;
      }
    }

    // Save final job result
    progressState.result = result;
    progressState.progress = { stage: ok ? 'done' : 'failed', percent: ok ? 100 : (progressState?.progress?.percent ?? 0) };

    await updateJob({
      id: job.id,
      patch: {
        status: ok ? 'success' : 'failed',
        errorCode: ok ? null : String(result?.error || 'upload_failed'),
        errorMessage: ok ? null : '업로드에 실패했습니다.',
        resultJson: progressState,
      },
    });

    // If upload succeeded, also upsert into "내 상품" catalog + dedupe record.
    if (ok) {
      try {
        const confirmedTitle = String(settingsSnapshot?.titleOverride || result?.draft?.title || '').trim();

        const overrideImages = Array.isArray(settingsSnapshot?.imagesOverride)
          ? settingsSnapshot.imagesOverride
          : [];
        const detailImages = overrideImages.length > 0
          ? overrideImages
          : (Array.isArray(result?.detailImages)
            ? result.detailImages
            : (Array.isArray(result?.draft?.detailImages) ? result.draft.detailImages : []));

        const mainImageUrl = String(result?.draft?.imageUrl || (detailImages[0] || '')).trim();

        const p = await upsertCatalogProduct({
          userId,
          sourceUrl: inputUrl,
          confirmedTitle,
          mainImageUrl,
          detailImages,
          presetId: presetId || null,
          categoryOverride: settingsSnapshot?.displayCategoryCode ?? null,
          status: 'deployed',
        });

        if (p?.id) {
          const prevValidation = (p.validation && typeof p.validation === 'object') ? p.validation : {};
          const sellerProductId = result?.create?.sellerProductId || null;
          await updateCatalogProduct(userId, p.id, {
            sellerProductId,
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

          try {
            if (sellerProductId) {
              await upsertUploadedProduct({
                userId,
                sourceUrl: inputUrl,
                sellerProductId,
                title: confirmedTitle,
                finalPrice: result?.finalPrice ?? null,
              });
            }
          } catch {}
        }
      } catch {}
    }

    await notifyUser(userId, {
      title: ok ? '업로드 완료' : '업로드 실패',
      body: `${ok ? '업로드 완료' : '업로드 실패'}: ${String(result?.draft?.title || '상품').slice(0, 40)}`,
      tag: 'job-upload',
      url: '/',
      sellerProductId: result?.create?.sellerProductId || null,
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
  } finally {
    // Kick the next queued upload, if any.
    setTimeout(() => processUploadQueueForUser(userId).catch(() => {}), 50);
  }
}

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
        const filePath = user?.settings?.domemeStorageStatePath || '';
        if (!filePath || !fs.existsSync(filePath)) return { ok: true, exists: false, valid: false };
        const stat = fs.statSync(filePath);
        return { ok: true, exists: true, valid: true, updatedAt: new Date(stat.mtimeMs).toISOString(), path: filePath };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    })();

    const domeggook = (() => {
      try {
        const filePath = user?.settings?.domeggookStorageStatePath || '';
        if (!filePath || !fs.existsSync(filePath)) return { ok: true, exists: false, valid: false };
        const stat = fs.statSync(filePath);
        return { ok: true, exists: true, valid: true, updatedAt: new Date(stat.mtimeMs).toISOString(), path: filePath };
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

function vendorStateKey(vendor) {
  const v = String(vendor || '').trim();
  if (v === 'domeggook') return 'domeggookStorageStatePath';
  if (v === 'domeme') return 'domemeStorageStatePath';
  return '';
}

function defaultVendorStatePath({ userId, vendor }) {
  const uid = String(userId || '').trim() || 'unknown';
  const v = String(vendor || '').trim() || 'vendor';
  const dir = path.join(process.cwd(), 'data', 'vendor_sessions', uid);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `storageState.${v}.json`);
}

async function ensureVendorStatePathForUser(userId, settings, vendor) {
  const key = vendorStateKey(vendor);
  if (!key) return settings || {};
  const current = (settings && typeof settings === 'object') ? settings : {};
  const p = String(current[key] || '').trim();
  if (p) return current;

  const next = defaultVendorStatePath({ userId, vendor });

  // Migration: if legacy global storageState exists, copy it as a starting point.
  try {
    const legacy = vendor === 'domeme' ? DOMEME_STORAGE_STATE_PATH : DOMEGGOOK_STORAGE_STATE_PATH;
    if (legacy && fs.existsSync(legacy) && !fs.existsSync(next)) {
      const dir = path.dirname(next);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(legacy, next);
    }
  } catch {}

  try {
    return await updateSettings(userId, { [key]: next });
  } catch {
    return { ...current, [key]: next };
  }
}

// ✅ 설정: 조회/저장
app.get("/api/settings", authRequired, async (req, res) => {
  // Ensure per-user vendor session paths exist (multi-user safe default)
  let s = req.user.settings || {};
  s = await ensureVendorStatePathForUser(req.user.id, s, 'domeggook');
  s = await ensureVendorStatePathForUser(req.user.id, s, 'domeme');
  return res.json({ ok: true, settings: s });
});

// ✅ Vendor session: per-user status/reset (domeme | domeggook)
import { checkVendorSession, resetVendorSession } from "./src/server/vendorSession.js";

app.get('/api/vendor-session/:vendor/status', authRequired, async (req, res) => {
  try {
    const vendor = String(req.params.vendor || '').trim();
    const key = vendorStateKey(vendor);
    if (!key) return res.status(400).json({ ok: false, error: 'bad_vendor' });

    const s = await ensureVendorStatePathForUser(req.user.id, req.user.settings || {}, vendor);
    const p = String(s[key] || '').trim();

    // If user session file was reset but legacy global state exists, copy it back as a fallback.
    try {
      if (p && !fs.existsSync(p)) {
        const legacy = vendor === 'domeme' ? DOMEME_STORAGE_STATE_PATH : DOMEGGOOK_STORAGE_STATE_PATH;
        if (legacy && fs.existsSync(legacy)) {
          const dir = path.dirname(p);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(legacy, p);
        }
      }
    } catch {}

    const st = await checkVendorSession({ vendor, storageStatePath: p });
    return res.json({ ok: true, vendor, path: p, status: st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/vendor-session/:vendor/reset', authRequired, async (req, res) => {
  try {
    const vendor = String(req.params.vendor || '').trim();
    const key = vendorStateKey(vendor);
    if (!key) return res.status(400).json({ ok: false, error: 'bad_vendor' });

    const s = await ensureVendorStatePathForUser(req.user.id, req.user.settings || {}, vendor);
    const p = String(s[key] || '').trim();

    const r = resetVendorSession({ storageStatePath: p });
    return res.json({ ok: true, vendor, path: p, result: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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

// Refresh detail images from source URL (best-effort)
app.post('/api/catalog/:id/refresh-detail-images', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const product = await getCatalogProductById(req.user.id, id);
    if (!product) return res.status(404).json({ ok: false, error: 'not_found' });

    const settings = req.user.settings || {};
    const r = await runUploadFromUrl(product.sourceUrl, {
      ...settings,
      payloadOnly: '1',
      // keep extraction light
      maxContentImages: settings?.maxContentImages ?? 20,
    });

    const detailImages = Array.isArray(r?.detailImages)
      ? r.detailImages
      : (Array.isArray(r?.draft?.detailImages) ? r.draft.detailImages : []);

    const patch = {
      detailImages,
      mainImageUrl: String(product.mainImageUrl || (detailImages[0] || '')).trim(),
      lastSourceSnapshot: {
        at: new Date().toISOString(),
        ok: Boolean(r?.ok),
        detailImages: Array.isArray(detailImages) ? detailImages.slice(0, 50) : [],
      },
    };

    const next = await updateCatalogProduct(req.user.id, id, patch);
    return res.json({ ok: true, product: next, extracted: { count: detailImages.length } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
              // Coupang can be eventually-consistent right after create; retry a few times.
              let lastData = null;
              for (let attempt = 1; attempt <= 3; attempt += 1) {
                const r = await getSellerProduct({ sellerProductId, accessKey, secretKey });
                let obj = null;
                try { obj = typeof r?.body === 'string' ? JSON.parse(r.body) : r?.body; } catch {}
                const data = obj?.data || obj || null;
                lastData = data;

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

                if (content && String(content).trim().length >= 20) break;
                // wait then retry
                await new Promise((rr) => setTimeout(rr, 1500 * attempt));
              }

              const displayCategoryCode = lastData?.displayCategoryCode ?? lastData?.displayCategoryId ?? null;
              const items = Array.isArray(lastData?.items) ? lastData.items : [];
              const item0 = items?.[0] || {};
              const content =
                item0?.content ||
                item0?.contentText ||
                item0?.contentHtml ||
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

// Recommendations
app.get('/api/recommendations', authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
    const items = await listRecommendations(req.user.id, { limit });
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Status: active job + progress + current cache count
app.get('/api/recommendations/status', authRequired, async (req, res) => {
  try {
    const count = await countRecommendations(req.user.id);

    const activeFill = await getActiveJobByKind(req.user.id, 'recommendations_fill', ['queued', 'running']);
    const activeFull = await getActiveJobByKind(req.user.id, 'recommendations', ['queued', 'running']);

    const activeJob = activeFill || activeFull || null;
    // `getActiveJobByKind` maps DB result_json -> job.result
    const progress = activeJob?.result?.progress || activeJob?.resultJson?.progress || null;

    return res.json({ ok: true, activeJob, progress, count });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Legacy: full regenerate (may be rate-limited). Keep for debugging.
app.post('/api/recommendations/run', authRequired, async (req, res) => {
  try {
    const topN = Math.max(1, Math.min(50, Number(req.body?.topN || 20) || 20));
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : defaultKeywordSet();

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
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : defaultKeywordSet();
    const reset = req.body?.reset === true || String(req.body?.reset || '').trim() === '1';

    if (reset) {
      try { await clearRecommendationsForUser(req.user.id); } catch {}
    }

    // Deduping is useful for normal fills, but for reset runs we always start fresh.
    if (!reset) {
      const active = await getActiveJobByKind(req.user.id, 'recommendations_fill', ['queued', 'running']);
      if (active) {
        const ageMs = Date.now() - Date.parse(active.createdAt || '');
        if (Number.isFinite(ageMs) && ageMs < 20 * 60_000) {
          return res.json({ ok: true, job: active, deduped: true });
        }
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
        while (tries < 12) {
          tries += 1;
          last = await fillRecommendationsForUser({
            userId: req.user.id,
            settings: req.user.settings || {},
            keywords,
            targetCount,
            maxAddPerRun: reset ? 10 : 6,
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

          // Even if nothing was inserted for this keyword, try a few more keywords
          // (Domeggook search sometimes yields 0 useful candidates).
          await new Promise((r) => setTimeout(r, 900));
        }

        await updateJob({ id: job.id, patch: { status: 'success', resultJson: { result: last || { ok: true }, progress } } });

        // If new items were inserted, send a push notification (throttled)
        const inserted = Number(last?.inserted) || 0;
        if (inserted > 0) {
          const notifyCooldownMin = Number(process.env.CE_RECO_NOTIFY_COOLDOWN_MIN || 30);
          const notifyCooldownMs = Math.max(60_000, Math.floor(notifyCooldownMin * 60_000));
          try {
            const st = await getRecommendationsNotifyState(req.user.id);
            const lastAt = st?.lastNotifiedAt ? Date.parse(st.lastNotifiedAt) : 0;
            const now = Date.now();
            if (!Number.isFinite(lastAt) || now - lastAt >= notifyCooldownMs) {
              await notifyUser(req.user.id, {
                title: '추천 상품 업데이트',
                body: `추천 상품 ${inserted}개 추가됨 (${String(last?.keyword || '').trim() || '키워드'})`,
                kind: 'recommendations',
                inserted,
              });
              await setRecommendationsLastNotifiedAt(req.user.id, new Date().toISOString());
            }
          } catch {}
        }
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

    // Prevent concurrent *running* uploads (Coupang API is rate-limited).
    // We still allow multiple queued uploads so bulk enqueue works.
    if (kind === 'upload' && force !== '1') {
      const activeUpload = await getActiveJobByKind(req.user.id, 'upload', ['running']);
      if (activeUpload) {
        return res.status(409).json({
          ok: false,
          error: 'upload_in_progress',
          messageKo: '지금 다른 상품 업로드가 진행 중이에요. 완료 후 다시 시도해 주세요.',
          hint: '대량 업로드는 큐(대기열) 기능을 사용하면 순서대로 처리됩니다.',
          job: activeUpload,
        });
      }
    }

    // Dedupe for upload jobs (unless force)
    if (kind === "upload" && force !== "1") {
      const existing = await getUploadedProductByUrl(req.user.id, c.url);
      if (existing) {
        const pid = existing?.seller_product_id ? String(existing.seller_product_id) : '';
        const createdAtMs = existing?.created_at ? Date.parse(existing.created_at) : 0;
        const ageMs = createdAtMs ? (Date.now() - createdAtMs) : Number.POSITIVE_INFINITY;

        // If we already have a sellerProductId, it's definitely a duplicate.
        if (pid) {
          return res.status(409).json({
            ok: false,
            error: "duplicate_product",
            messageKo: '이미 업로드된 상품이에요. 중복 업로드를 막았습니다.',
            hint: '정말 다시 올려야 하면 "강제 업로드"(force) 옵션을 사용하세요.',
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

        // If there's a recent pending record (no pid yet), block to prevent stampede.
        if (Number.isFinite(ageMs) && ageMs < 20 * 60_000) {
          return res.status(409).json({
            ok: false,
            error: "upload_pending",
            messageKo: '방금 업로드 요청을 처리 중이에요. 잠시 후 다시 시도해 주세요.',
            hint: '같은 상품을 연속으로 누르면 중복 처리될 수 있어 잠깐 막아요.',
            existing: {
              sourceUrl: existing.source_url,
              title: existing.title,
              createdAt: existing.created_at,
            },
          });
        }
      }
    }

    const userId = req.user.id;

    // Create/refresh a pending dedupe record early to prevent duplicate stampede clicks.
    if (kind === 'upload' && force !== '1') {
      try {
        await upsertUploadedProduct({
          userId,
          sourceUrl: c.url,
          sellerProductId: null,
          title: '',
          finalPrice: null,
        });
      } catch {}
    }

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

            const overrideImages = Array.isArray(settingsSnapshot?.imagesOverride)
              ? settingsSnapshot.imagesOverride
              : [];
            const detailImages = overrideImages.length > 0
              ? overrideImages
              : (Array.isArray(result?.detailImages) ? result.detailImages : (Array.isArray(result?.draft?.detailImages) ? result.draft.detailImages : []));

            const mainImageUrl = String(result?.draft?.imageUrl || (detailImages[0] || "")).trim();

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
              const sellerProductId = result?.create?.sellerProductId || null;
              await updateCatalogProduct(userId, p.id, {
                sellerProductId,
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

              // Store upload record for dedupe (jobs/start path)
              try {
                if (sellerProductId) {
                  await upsertUploadedProduct({
                    userId,
                    sourceUrl: c.url,
                    sellerProductId,
                    title: confirmedTitle,
                    finalPrice: result?.finalPrice ?? null,
                  });
                }
              } catch {}
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

// ✅ Upload Queue: list/enqueue/cancel (per-user sequential uploads)
app.get('/api/upload-queue', authRequired, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));
    const items = await listJobs(req.user.id, { kind: 'upload', limit });
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- Status summary (for n8n / dashboard)
const STATUS_API_TOKEN = String(process.env.STATUS_API_TOKEN || '').trim();

function statusAuthorized(req) {
  if (!STATUS_API_TOKEN) return false;
  const h = String(req.headers['authorization'] || req.headers['Authorization'] || '').trim();
  const x = String(req.headers['x-api-key'] || req.headers['X-Api-Key'] || '').trim();
  const t = x || (h.match(/^Bearer\s+(.+)$/i)?.[1] || h);
  return t && t.trim() === STATUS_API_TOKEN;
}

app.get('/api/status/summary', async (req, res) => {
  try {
    if (!statusAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // For now: single-user dashboard (first user)
    const users = await listUsersForSync();
    const userId = users?.[0]?.id;
    if (!userId) return res.json({ ok: true, empty: true });

    const items = await listJobs(userId, { kind: 'upload', limit: 200 });
    const counts = { queued: 0, running: 0, backoff: 0, failed: 0, succeeded: 0, cancelled: 0, other: 0 };

    const now = Date.now();
    const failures = new Map();
    let lastSucceededAt = null;
    let lastFailedAt = null;

    for (const j of items) {
      const st = String(j.status || '');
      const stage = String(j.result?.progress?.stage || '');
      if (st === 'queued' && stage === 'backoff') counts.backoff++;
      else if (st in counts) counts[st]++;
      else counts.other++;

      if (st === 'succeeded') {
        if (!lastSucceededAt || String(j.updatedAt) > String(lastSucceededAt)) lastSucceededAt = j.updatedAt;
      }
      if (st === 'failed') {
        if (!lastFailedAt || String(j.updatedAt) > String(lastFailedAt)) lastFailedAt = j.updatedAt;
        const code = String(j.errorCode || j.result?.error || 'error_unknown');
        failures.set(code, (failures.get(code) || 0) + 1);
      }
    }

    const topFailures = [...failures.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({ code, count }));

    const textLines = [
      '📍 상태 대시보드',
      `- 업로드 큐: queued ${counts.queued} / running ${counts.running} / backoff ${counts.backoff} / failed ${counts.failed}`,
      lastSucceededAt ? `- 마지막 성공: ${lastSucceededAt}` : '- 마지막 성공: -',
      lastFailedAt ? `- 마지막 실패: ${lastFailedAt}` : '- 마지막 실패: -',
      topFailures.length ? `- 실패 TOP: ${topFailures.map((x) => `${x.code}(${x.count})`).join(', ')}` : '- 실패 TOP: -',
      `- 서버 시간: ${new Date(now).toISOString()}`,
    ];

    return res.json({
      ok: true,
      userId,
      counts,
      topFailures,
      lastSucceededAt,
      lastFailedAt,
      text: textLines.join('\n'),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/upload-queue/enqueue', authRequired, async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    const force = String(req.body?.force || '0').trim() === '1' ? '1' : '0';
    const presetId = String(req.body?.presetId || '').trim();
    const titleOverride = String(req.body?.titleOverride || '').trim();
    const imagesOverrideRaw = req.body?.imagesOverride;
    const imagesOverride = Array.isArray(imagesOverrideRaw)
      ? imagesOverrideRaw.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50)
      : [];

    if (!url) return res.status(400).json({ ok: false, error: 'missing url' });

    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    // Strong dedupe: if already uploaded and has sellerProductId.
    if (force !== '1') {
      const existing = await getUploadedProductByUrl(req.user.id, c.url);
      if (existing?.seller_product_id) {
        const pid = String(existing.seller_product_id);
        return res.status(409).json({
          ok: false,
          error: 'duplicate_product',
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

      // Soft dedupe: if already queued/running for same URL.
      const actives = await listJobs(req.user.id, { kind: 'upload', statuses: ['queued', 'running'], limit: 200 });
      const dup = actives.find((j) => String(j.inputUrl || '') === String(c.url));
      if (dup) return res.json({ ok: true, job: dup, deduped: true });
    }

    // Resolve preset settings now (store snapshot for worker).
    let presetSettings = {};
    if (presetId) {
      try {
        const p = await getPreset(req.user.id, presetId);
        if (p?.settings && typeof p.settings === 'object') presetSettings = p.settings;
      } catch {}
    }

    const settingsSnapshot = {
      ...(req.user.settings || {}),
      ...(presetSettings || {}),
      ...(titleOverride ? { titleOverride } : {}),
      ...(imagesOverride.length > 0 ? { imagesOverride } : {}),
    };

    // Create/refresh a pending dedupe record early to prevent stampede clicks.
    if (force !== '1') {
      try {
        await upsertUploadedProduct({
          userId: req.user.id,
          sourceUrl: c.url,
          sellerProductId: null,
          title: '',
          finalPrice: null,
        });
      } catch {}
    }

    const job = await createJob({
      userId: req.user.id,
      kind: 'upload',
      inputUrl: c.url,
      force,
      catalogId: null,
      initialResultJson: {
        request: {
          presetId: presetId || null,
          settingsSnapshot,
        },
        progress: { stage: 'queued', percent: 0, url: c.url },
      },
    });

    // Kick queue worker.
    setTimeout(() => processUploadQueueForUser(req.user.id).catch(() => {}), 50);

    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/upload-queue/:id/cancel', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const status = await cancelQueuedJob(req.user.id, id);
    if (!status) return res.status(404).json({ ok: false, error: 'not_found' });

    // If it was queued and got cancelled, kick worker to continue.
    setTimeout(() => processUploadQueueForUser(req.user.id).catch(() => {}), 50);

    return res.json({ ok: true, status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/upload-queue/:id/retry', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const prev = await getJob(req.user.id, id);
    if (!prev) return res.status(404).json({ ok: false, error: 'not_found' });

    if (['queued', 'running'].includes(String(prev.status || ''))) {
      return res.status(409).json({
        ok: false,
        error: 'active_job',
        messageKo: '이미 진행 중인 작업이라 재시도할 수 없어요.',
        hint: '작업이 끝난 뒤에 다시 시도(재시도) 버튼을 눌러주세요.',
      });
    }

    const url = String(prev.inputUrl || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'missing url' });

    const settingsSnapshot = (prev.result?.request?.settingsSnapshot && typeof prev.result.request.settingsSnapshot === 'object')
      ? prev.result.request.settingsSnapshot
      : (req.user.settings || {});

    const job = await createJob({
      userId: req.user.id,
      kind: 'upload',
      inputUrl: url,
      force: String(prev.force || '0') === '1' ? '1' : '0',
      catalogId: null,
      initialResultJson: {
        request: {
          presetId: prev.result?.request?.presetId || null,
          settingsSnapshot,
          retryOf: prev.id,
        },
        progress: { stage: 'queued', percent: 0, url },
      },
    });

    setTimeout(() => processUploadQueueForUser(req.user.id).catch(() => {}), 50);
    return res.json({ ok: true, job });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/upload-queue/:id/delete', authRequired, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const r = await deleteJob(req.user.id, id);
    if (!r.ok) {
      const code = r.error === 'not_found' ? 404 : 409;
      return res.status(code).json({ ok: false, error: r.error });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/upload-queue/cleanup', authRequired, async (req, res) => {
  try {
    const r = await cleanupJobs(req.user.id, { kind: 'upload' });
    return res.json(r);
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

// ✅ Coupang image upload probe (detect if account supports uploadMarketplaceImage endpoints)
import { uploadMarketplaceImage } from './src/coupang/api/uploadMarketplaceImage.js';

app.post('/api/coupang/image-upload/probe', authRequired, async (req, res) => {
  try {
    const s = req.user.settings || {};
    const accessKey = String(s.coupangAccessKey || '').trim();
    const secretKey = String(s.coupangSecretKey || '').trim();
    const vendorId = String(s.coupangVendorId || '').trim();

    if (!accessKey || !secretKey || !vendorId) {
      return res.status(400).json({ ok: false, error: 'missing_coupang_keys' });
    }

    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xv1cAAAAASUVORK5CYII=',
      'base64',
    );

    const r = await uploadMarketplaceImage({
      vendorId,
      buffer: png,
      fileName: 'probe.png',
      mimeType: 'image/png',
      accessKey,
      secretKey,
    });

    // Persist a recommendation into settings (best-effort)
    const supported = Boolean(r?.ok);
    try {
      await updateSettings(req.user.id, {
        useCoupangImageUpload: supported,
        __imageUploadProbe: {
          at: new Date().toISOString(),
          ok: supported,
          endpoint: r?.endpoint || null,
          status: r?.last?.status || null,
          error: r?.error || null,
        },
      });
    } catch {}

    return res.json({ ok: true, supported, result: r?.ok ? { endpoint: r.endpoint } : r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ Domeggook OpenAPI helpers (categories)
import { getCategoryList as dgGetCategoryList, isSearchableCategoryCode as dgIsSearchableCategoryCode } from './src/server/domeggook_openapi.js';

app.get('/api/domeggook/categories', authRequired, async (req, res) => {
  try {
    const key = String(req.user?.settings?.domeggookOpenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'missing_openapi_key' });

    const treeMode = String(req.query?.tree || '').trim() === '1';

    const r = await dgGetCategoryList({ aid: key, isReg: true });
    const all = (r?.categories || []).map((c) => ({
      code: String(c.code),
      name: String(c.name || ''),
      locked: String(c.locked || ''),
    }));

    if (!treeMode) {
      const list = all
        .filter((c) => dgIsSearchableCategoryCode(c?.code))
        .map((c) => ({ code: c.code, name: c.name, locked: c.locked }));
      return res.json({ ok: true, items: list });
    }

    // Build major->minor->leaf tree.
    const byCode = new Map(all.map((c) => [c.code, c]));

    const majorNodes = new Map();
    const ensureMajor = (majorCode) => {
      if (!majorNodes.has(majorCode)) {
        const major = byCode.get(majorCode) || { code: majorCode, name: majorCode, locked: '' };
        majorNodes.set(majorCode, { code: major.code, name: major.name, children: new Map() });
      }
      return majorNodes.get(majorCode);
    };

    const ensureMinor = (majorNode, minorCode) => {
      if (!majorNode.children.has(minorCode)) {
        const minor = byCode.get(minorCode) || { code: minorCode, name: minorCode, locked: '' };
        majorNode.children.set(minorCode, { code: minor.code, name: minor.name, children: [] });
      }
      return majorNode.children.get(minorCode);
    };

    for (const c of all) {
      if (!dgIsSearchableCategoryCode(c.code)) continue;
      const parts = c.code.split('_');
      const majorCode = `${parts[0]}_00_00_00_00`;
      const minorCode = `${parts[0]}_${parts[1]}_00_00_00`;

      const majorNode = ensureMajor(majorCode);
      const minorNode = ensureMinor(majorNode, minorCode);
      minorNode.children.push({ code: c.code, name: c.name, locked: c.locked });
    }

    const tree = Array.from(majorNodes.values())
      .map((m) => ({
        code: m.code,
        name: m.name,
        children: Array.from(m.children.values())
          .map((mi) => ({
            code: mi.code,
            name: mi.name,
            children: (mi.children || []).sort((a, b) => String(a.name).localeCompare(String(b.name))),
          }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return res.json({ ok: true, tree });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
        messageKo: '이미 업로드된 상품이에요. 중복 업로드를 막았습니다.',
        hint: '정말 다시 올려야 하면 "강제 업로드"(force) 옵션을 사용하세요.',
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
      return res.status(409).json({
        ok: false,
        error: "upload_in_progress",
        messageKo: '지금 다른 상품 업로드가 진행 중이에요. 완료 후 다시 시도해 주세요.',
        hint: '대량 업로드는 큐(대기열) 기능을 사용하면 순서대로 처리됩니다.',
      });
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
        messageKo: '이미 업로드된 상품이에요. 중복 업로드를 막았습니다.',
        hint: '정말 다시 올려야 하면 "강제 업로드"(force) 옵션을 사용하세요.',
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
      return res.status(409).json({
        ok: false,
        error: "upload_in_progress",
        messageKo: '지금 다른 상품 업로드가 진행 중이에요. 완료 후 다시 시도해 주세요.',
        hint: '대량 업로드는 큐(대기열) 기능을 사용하면 순서대로 처리됩니다.',
      });
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

// Default to 0.0.0.0 so the UI is reachable over Tailscale.
// Override with HOST=127.0.0.1 if you explicitly want local-only.
const HOST = (process.env.HOST || "0.0.0.0").trim();

const server = app.listen(PORT, HOST, async () => {
  const baseHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  log(`server running: http://${baseHost}:${PORT}`);
  log(`authorize start: http://${baseHost}:${PORT}/auth/kakao`);
  log(`bind: ${HOST}:${PORT}`);

  // Resume any queued uploads on boot (best-effort)
  try {
    const users = await listUsersForSync();
    for (const u of users) {
      const queued = await listJobs(u.id, { kind: 'upload', statuses: ['queued'], limit: 1 });
      if (queued && queued.length > 0) {
        processUploadQueueForUser(u.id).catch(() => {});
      }
    }
  } catch {}

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

  // Recommendations auto-fill loop + push notify (opt-out via settings.recommendationsAutoFill=false)
  const recoIntervalMin = Number(process.env.CE_RECO_FILL_INTERVAL_MIN || 10);
  const recoIntervalMs = Math.max(60_000, Math.floor(recoIntervalMin * 60_000));
  const notifyCooldownMin = Number(process.env.CE_RECO_NOTIFY_COOLDOWN_MIN || 30);
  const notifyCooldownMs = Math.max(60_000, Math.floor(notifyCooldownMin * 60_000));

  let recoRunning = false;
  const tickReco = async () => {
    if (recoRunning) return;
    recoRunning = true;
    try {
      const users = await listUsersWithPushTargets();
      for (const u of users) {
        const autoFill = u?.settings?.recommendationsAutoFill;
        if (autoFill === false) continue;

        const targetCount = Math.max(5, Math.min(60, Number(u?.settings?.recommendationsTargetCount || 20) || 20));
        try {
          const r = await fillRecommendationsForUser({
            userId: u.id,
            settings: u.settings || {},
            keywords: defaultKeywordSet(),
            targetCount,
            maxAddPerRun: 6,
          });

          const inserted = Number(r?.inserted) || 0;
          if (inserted > 0) {
            const st = await getRecommendationsNotifyState(u.id);
            const lastAt = st?.lastNotifiedAt ? Date.parse(st.lastNotifiedAt) : 0;
            const now = Date.now();
            if (!Number.isFinite(lastAt) || now - lastAt >= notifyCooldownMs) {
              await notifyUser(u.id, {
                title: '추천 상품 업데이트',
                body: `추천 상품 ${inserted}개 추가됨 (${String(r?.keyword || '').trim() || '키워드'})`,
                kind: 'recommendations',
                inserted,
              });
              await setRecommendationsLastNotifiedAt(u.id, new Date().toISOString());
            }
          }
        } catch {}

        // small spacing to avoid request bursts
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      log('reco auto-fill loop error', e?.message || e);
    } finally {
      recoRunning = false;
    }
  };

  setInterval(tickReco, recoIntervalMs).unref?.();
  // Kick once after boot
  setTimeout(tickReco, 10_000).unref?.();

  log(`recommendations auto-fill enabled: every ${recoIntervalMin} min (notify cooldown ${notifyCooldownMin} min)`);
});

// Prevent crash loops when the port is already in use (typically: a previous instance
// is already running, or the service was started manually and then launchd also started it).
server.on("error", async (err) => {
  const code = err?.code;
  if (code === "EADDRINUSE") {
    log(`[boot] PORT ${PORT} already in use on ${HOST}. Checking if an existing server is alive...`);
    try {
      // Use localhost to avoid DNS / IPv6 surprises.
      const url = `http://127.0.0.1:${PORT}/api/status/summary`;
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res?.ok) {
        log(`[boot] Existing server is responding on :${PORT}. Holding this process to avoid launchd restart loop.`);
        setInterval(() => {}, 60 * 60 * 1000).unref?.();
        return;
      }
    } catch {}

    log(`[boot] Port :${PORT} is in use but no healthy response detected. Exiting with error.`);
    process.exit(1);
  }

  log(`[boot] server error: ${code || "unknown"} ${err?.message || err}`);
  process.exit(1);
});
