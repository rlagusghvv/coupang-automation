// server.js (ESM)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runUploadFromUrl } from "./src/pipeline/runUploadFromUrl.js";
import { previewUploadFromUrl } from "./src/pipeline/previewUploadFromUrl.js";
import { evaluateQcGate } from "./src/pipeline/qcGate.js";
import { classifyUrl } from "./src/utils/urlFilter.js";
import { computePrice } from "./src/utils/price.js";
import { extractImageUrls } from "./src/utils/contentImages.js";
import { resolveDisplayCategoryCode } from "./src/utils/categoryMap.js";
import { suggestTitlesHybrid } from "./src/utils/titleSuggest.js";
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
  getUploadedProductById,
  getUploadedProductBySourceUrl,
  getUploadedProductBySellerProductId,
  updateUploadedProductById,
} from "./src/server/storage_sqlite.js";
import { exportOrdersToDomeme } from "./src/pipeline/exportOrdersToDomeme.js";
import { uploadDomemeExcel } from "./src/pipeline/uploadDomemeExcel.js";
import { spawn } from "node:child_process";
import { getSellerProduct } from "./src/coupang/api/getSellerProduct.js";
import { getSellerProductHistories } from "./src/coupang/api/getSellerProductHistories.js";
import {
  listRecommendations,
  listSavedRecommendations,
  saveRecommendationForUser,
  removeSavedRecommendationForUser,
  refreshRecommendationsForUser,
} from "./src/server/recommendations.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
const PUBLIC_DIR = path.join(process.cwd(), "public");
const PUBLIC_APP_DIR = path.join(PUBLIC_DIR, "app");

// ✅ DB 초기화
await initDb();

// ✅ out 폴더(이미지 파일) 정적 서빙
app.use(
  "/couplus-out",
  express.static(
    "/Users/kimhyeonho/Desktop/2025.01.26_new project/couplus-clone/out",
  ),
);
app.use("/tmp", express.static(path.join(process.cwd(), "out"))); // /tmp/tmp_main.jpg 같은 형태로도 접근 가능
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
const DATA_DIR = path.join(process.cwd(), "data");
const UPLOAD_HISTORY_PATH = path.join(process.cwd(), "data", "upload_history.json");
const UPLOAD_HISTORY_LIMIT = 200;
const ECON_AUTH_PATH = path.join(DATA_DIR, 'econ_auth.json');
const ECON_PROGRESS_PATH = path.join(DATA_DIR, 'econ_progress.json');

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

// image proxy for Flutter web (avoid hotlink/CORS issues)
app.get('/api/image-proxy', async (req, res) => {
  try {
    const raw = String(req.query?.url || '').trim();
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

    const ab = await upstream.arrayBuffer();
    return res.status(200).send(Buffer.from(ab));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- Backward-compatible endpoints for Flutter /app runtime ---
const legacyJobs = new Map();
const recommendationRunByUser = new Map();

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
  };
}

function parseRecommendationRunRequest(req) {
  const userSettings = req?.user?.settings || {};
  const keywords = normalizeStringList(req.body?.keywords, 30);
  const targetCount = Math.max(5, Math.min(100, Number(req.body?.targetCount || 20) || 20));
  const cooldownDays = Math.max(
    1,
    Math.min(60, Number(req.body?.cooldownDays || userSettings?.recommendationCooldownDays || 7) || 7),
  );
  return { keywords, targetCount, cooldownDays };
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

function startRecommendationRefreshJob({
  userId,
  settings = {},
  keywords = [],
  targetCount = 20,
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
  });
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
        },
      });

      const fill = await refreshRecommendationsForUser({
        userId: uid,
        settings,
        keywords,
        targetCount,
        cooldownDays,
        onProgress: (progress) => {
          patchLegacyJob(job, {
            status: "running",
            progress: {
              stage: String(progress?.stage || "running"),
              ...progress,
            },
          });
        },
      });

      const items = await listRecommendations(uid, {
        limit: Math.max(40, targetCount),
      });

      patchLegacyJob(job, {
        status: "success",
        progress: {
          stage: "done",
          count: Number(fill?.count || items.length) || items.length,
          removedCount: Number(fill?.removedCount || 0) || 0,
          targetCount,
          cooldownDays,
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
  return res.json({
    ok: true,
    auth: { authenticated: true },
    sessions: { domeggook: { ready: false }, domeme: { ready: false } },
    recentUploads: uploadHistory,
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
    deleted,
    productId,
    vendorItemId,
    title: title || null,
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
  if (snapshot.deleted) return "deleted_remote";
  if (snapshot.detailEmpty) return "deployed_invalid";
  if (snapshot.approved && !String(snapshot.productId || "").trim()) return "deployed_invalid";
  if (snapshot.approved) return "deployed";
  if (current === "deploy_failed" || current === "deployed_invalid") return current;
  return "confirmed";
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
    followUp,
    validation,
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
        status: remoteDeleted ? "deleted_remote" : inferCatalogStatus(row.status, live, "confirmed"),
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
        const overrides = {
          titleOverride: String(meta.confirmedTitle || "").trim() || undefined,
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
            deployedDetailImages.length > 0
              ? deployedDetailImages
              : normalizeStringList(
                  Array.isArray(live?.detailImages) ? live.detailImages : Array.isArray(meta.detailImages) ? meta.detailImages : [],
                  200,
                ),
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

app.get("/api/products/status/:sellerProductId", authRequired, async (req, res) => {
  try {
    const sellerProductId = String(req.params?.sellerProductId || "").trim();
    if (!sellerProductId) {
      return res.status(400).json({ ok: false, error: "sellerProductId required" });
    }
    const status = await fetchSellerStatusLive({
      sellerProductId,
      settings: req.user.settings || {},
      includeHistory: true,
    });

    const linked = await getUploadedProductBySellerProductId(req.user.id, sellerProductId);
    const remoteDeleted = isRemoteDeleted(status);
    if (linked) {
      const nextMeta = linked.meta && typeof linked.meta === "object" ? { ...linked.meta } : {};
      const nowIso = new Date().toISOString();
      nextMeta.lastSyncedAt = nowIso;
      if (status?.ok) {
        Object.assign(
          nextMeta,
          applyLiveSnapshotToMeta(nextMeta, status, {
            fallbackTitle: linked.title,
            fallbackImageUrl: linked.imageUrl,
          }),
        );
        if (nextMeta.validation && typeof nextMeta.validation === "object") {
          nextMeta.validation.checkedAt = nowIso;
        }
      } else {
        nextMeta.lastRemoteError = status;
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
      await updateUploadedProductById({
        userId: req.user.id,
        id: linked.id,
        patch: {
          status: remoteDeleted ? "deleted_remote" : inferCatalogStatus(linked.status, status, "confirmed"),
          title: pickFirstNonEmpty(nextMeta.confirmedTitle, status?.title, linked.title),
          imageUrl: pickFirstNonEmpty(nextMeta.mainImageUrl, status?.mainImageUrl, linked.imageUrl),
          metaReplace: nextMeta,
        },
      });
    }

    return res.json({
      ok: Boolean(status?.ok),
      status,
      sellerProductId,
      remoteDeleted,
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
      const live = await fetchSellerStatusLive({
        sellerProductId,
        settings: req.user.settings || {},
        includeHistory: true,
      });
      const linked = await getUploadedProductBySellerProductId(req.user.id, sellerProductId);
      const remoteDeleted = isRemoteDeleted(live);
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
        await updateUploadedProductById({
          userId: req.user.id,
          id: linked.id,
          patch: {
            status: remoteDeleted ? "deleted_remote" : inferCatalogStatus(linked.status, live, "confirmed"),
            title: pickFirstNonEmpty(nextMeta.confirmedTitle, live?.title, linked.title),
            imageUrl: pickFirstNonEmpty(nextMeta.mainImageUrl, live?.mainImageUrl, linked.imageUrl),
            metaReplace: nextMeta,
          },
        });
      }
      results.push({
        sellerProductId,
        ok: Boolean(live?.ok),
        statusName: live?.statusName || null,
        approved: Boolean(live?.approved),
        productId: live?.productId || null,
        remoteDeleted,
        error: live?.ok ? null : live?.error || "status_fetch_failed",
      });
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
    await recordUploadedProduct({
      userId: user?.id,
      sourceUrl: c.url,
      title: result?.draft?.title || draftTitle,
      imageUrl: result?.draft?.imageUrl || preview?.draft?.imageUrl || "",
      imageFingerprint,
      sellerProductId: result?.create?.sellerProductId ?? null,
      status: "uploaded",
      meta: {
        skipReason: null,
        createStatus: result?.create?.status ?? null,
      },
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

async function runUploadLocked(handler, res) {
  if (uploadInProgress) {
    return res.status(409).json({ ok: false, error: "upload in progress" });
  }
  uploadInProgress = true;
  try {
    return await handler();
  } finally {
    uploadInProgress = false;
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
        const o = overridesByUrlRaw?.[url];
        const overrides = {
          titleOverride: o?.titleOverride,
          imagesOverride: Array.isArray(o?.imagesOverride) ? o.imagesOverride : undefined,
          categoryOverrideCode: o?.categoryOverrideCode,
        };
        const outcome = await executeUploadForUrl({ url, user: req.user, force, overrides });
        appendUploadHistoryFromOutcome(url, outcome);
        const followUp =
          outcome?.result?.followUp && typeof outcome.result.followUp === "object"
            ? outcome.result.followUp
            : {};
        const productId = pickFirstNonEmpty(followUp.productId);
        const productUrl = pickFirstNonEmpty(
          followUp.productUrl,
          buildCoupangProductUrl(productId),
        );
        items.push({
          url,
          ok: Boolean(outcome?.ok),
          skipped: Boolean(outcome?.skipped),
          skipReason: normalizeSkipReason(outcome),
          error: outcome?.error || null,
          sellerProductId: resolveOutcomeSellerProductId(outcome),
          productId: productId || null,
          productUrl: productUrl || null,
          statusName: pickFirstNonEmpty(followUp.statusName) || null,
        });
      }

      const summary = {
        total: items.length,
        uploaded: items.filter((x) => x.ok && !x.skipped).length,
        skipped: items.filter((x) => x.skipped).length,
        failed: items.filter((x) => !x.ok && !x.skipped).length,
        force,
      };

      return res.json({ ok: true, summary, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }, res);
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
    const started = startRecommendationRefreshJob({
      userId: req.user.id,
      settings: req.user.settings || {},
      keywords: params.keywords,
      targetCount: params.targetCount,
      cooldownDays: params.cooldownDays,
      kind: "recommendations_fill",
    });

    return res.json({
      ok: true,
      reused: Boolean(started.reused),
      job: compactLegacyJob(started.job),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/fill", authRequired, async (req, res) => {
  try {
    const keywords = normalizeStringList(req.body?.keywords, 30);
    const targetCount = Math.max(5, Math.min(100, Number(req.body?.targetCount || 20) || 20));
    const cooldownDays = Math.max(
      1,
      Math.min(60, Number(req.body?.cooldownDays || req.user?.settings?.recommendationCooldownDays || 7) || 7),
    );
    // Product decision: "fill" is now replace-mode.
    const fill = await refreshRecommendationsForUser({
      userId: req.user.id,
      settings: req.user.settings || {},
      keywords,
      targetCount,
      cooldownDays,
    });

    const items = await listRecommendations(req.user.id, {
      limit: Math.max(40, targetCount),
    });

    return res.json({
      ok: true,
      fill,
      items,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/recommendations/refresh", authRequired, async (req, res) => {
  try {
    const params = parseRecommendationRunRequest(req);
    const started = startRecommendationRefreshJob({
      userId: req.user.id,
      settings: req.user.settings || {},
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

      const recoItems = await listRecommendations(req.user.id, { limit: Math.max(limit, 50) });
      const candidates = recoItems
        .filter((it) => {
          const url = String(it?.sourceUrl || "").trim();
          if (!url) return false;
          if (!onlyEligible) return true;
          return Boolean(it?.qc?.eligibleUpload);
        })
        .slice(0, limit);

      const items = [];
      for (const cand of candidates) {
        const outcome = await executeUploadForUrl({
          url: cand.sourceUrl,
          user: req.user,
          force,
        });
        appendUploadHistoryFromOutcome(cand.sourceUrl, outcome);

        items.push({
          recommendationId: cand.id || null,
          title: cand.title || "",
          url: cand.sourceUrl,
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
      };

      return res.json({ ok: true, summary, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }, res);
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
    const filePath = path.join(process.cwd(), "storageState.domeme.json");
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
});
