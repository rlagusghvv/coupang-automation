// server.js (ESM)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { runUploadFromUrl } from "./src/pipeline/runUploadFromUrl.js";
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
} from "./src/server/storage_sqlite.js";
import { addOrder, clearOrders, listOrders } from "./src/server/orders_sqlite.js";
import { exportOrdersToDomeme } from "./src/pipeline/exportOrdersToDomeme.js";
import { uploadDomemeExcel } from "./src/pipeline/uploadDomemeExcel.js";
import { spawn } from "node:child_process";
import {
  DOMEME_STORAGE_STATE_PATH,
  DOMEGGOOK_STORAGE_STATE_PATH,
} from "./src/config/paths.js";

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
const UPLOAD_HISTORY_PATH = path.join(process.cwd(), "data", "upload_history.json");
const UPLOAD_HISTORY_LIMIT = 200;

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

// ✅ 업로드 Preview API (쿠팡 키 없어도 동작)
app.post("/api/upload/preview", authRequired, async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const c = classifyUrl(url);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.reason, url: c.url });

    const preview = await previewUploadFromUrl(c.url, req.user.settings || {});
    if (!preview.ok) return res.status(400).json({ ok: false, preview });

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
      });
    } catch {}

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
    const orders = await listOrders(req.user.id, limit);
    return res.json({ ok: true, orders });
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
            sourceUrl: "https://domeggook.com/44047997?from=lstBiz",
            title: "[MOCK] 도매꾹 테스트 상품",
            qty: 2,
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

    // NOTE: For now we simply reuse the existing pipeline.
    if (uploadInProgress) {
      return res.status(409).json({ ok: false, error: "upload in progress" });
    }
    uploadInProgress = true;

    const result = await runUploadFromUrl(c.url, settings);
    uploadInProgress = false;
    return res.json({ ok: true, result });
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

    if (uploadInProgress) {
      return res.status(409).json({ ok: false, error: "upload in progress" });
    }
    uploadInProgress = true;

    const result = await runUploadFromUrl(c.url, req.user.settings || {});
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
    return res.json({ ok: true, result });
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
    const child = spawn("node", [scriptPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, COUPLUS_DEV: String(process.env.COUPLUS_DEV || "") },
    });
    child.unref();
    return res.json({ ok: true, pid: child.pid, logPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매매 세션 상태 확인
app.get("/api/domeme/session/status", authRequired, (req, res) => {
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
    const child = spawn("node", [scriptPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, COUPLUS_DEV: String(process.env.COUPLUS_DEV || "") },
    });
    child.unref();
    return res.json({ ok: true, pid: child.pid, logPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 도매꾹 세션 상태 확인
app.get("/api/domeggook/session/status", authRequired, (req, res) => {
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

const HOST = (process.env.HOST || "127.0.0.1").trim();

app.listen(PORT, HOST, () => {
  const baseHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  log(`server running: http://${baseHost}:${PORT}`);
  log(`authorize start: http://${baseHost}:${PORT}/auth/kakao`);
  log(`bind: ${HOST}:${PORT}`);
});
