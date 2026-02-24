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
} from "./src/server/storage_sqlite.js";
import { exportOrdersToDomeme } from "./src/pipeline/exportOrdersToDomeme.js";
import { uploadDomemeExcel } from "./src/pipeline/uploadDomemeExcel.js";
import { spawn } from "node:child_process";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

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
app.use(express.static(path.join(process.cwd(), "public")));

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
      const items = [];

      for (const url of urls) {
        const outcome = await executeUploadForUrl({ url, user: req.user, force });
        appendUploadHistoryFromOutcome(url, outcome);
        items.push({
          url,
          ok: Boolean(outcome?.ok),
          skipped: Boolean(outcome?.skipped),
          skipReason: normalizeSkipReason(outcome),
          error: outcome?.error || null,
          sellerProductId: resolveOutcomeSellerProductId(outcome),
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
