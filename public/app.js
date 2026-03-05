const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const urlInput = $("url");
const submitBtn = $("submit");
const previewBtn = $("previewUpload");
const forceUploadEl = $("forceUpload");
const enablePushBtn = $("enablePush");
const exportOrdersBtn = $("exportOrders");
const orderFromInput = $("orderFrom");
const orderToInput = $("orderTo");
const uploadOrdersBtn = $("uploadOrders");
const lastExportPathEl = $("lastExportPath");
const loadMissingBtn = $("loadMissing");
const loadSkuMapBtn = $("loadSkuMap");
const saveSkuMapBtn = $("saveSkuMap");
const missingSkuEl = $("missingSku");
const skuMapEl = $("skuMap");
const statusEl = $("status");
const logEl = $("log");
const dot = $("dot");
const summaryEl = $("summary");
const tabs = document.querySelectorAll(".tab");
const panels = {
  upload: $("panel-upload"),
  orders: $("panel-orders"),
  history: $("panel-history"),
  settings: $("panel-settings"),
  account: $("panel-account"),
};

const settingsEls = {
  coupangAccessKey: $("ckey"),
  coupangSecretKey: $("skey"),
  coupangVendorId: $("vendorId"),
  coupangVendorUserId: $("vendorUserId"),
  coupangDeliveryCompanyCode: $("deliveryCode"),
  imageProxyBase: $("proxyBase"),
  allowedIps: $("allowedIps"),
  domeggookStorageStatePath: $("domeggookStorageStatePath"),
  domemeId: $("domemeId"),
  domemePw: $("domemePw"),
  domemeStorageStatePath: $("domemeStorageStatePath"),
  pagesProjectName: $("pagesProjectName"),
  pagesAccountId: $("pagesAccountId"),
  pagesApiToken: $("pagesApiToken"),
  pagesAutoDeploy: $("pagesAutoDeploy"),
  payloadOnly: $("payloadOnly"),
  soundOnComplete: $("soundOnComplete"),
  marginRate: $("marginRate"),
  marginAdd: $("marginAdd"),
  priceMin: $("priceMin"),
  roundUnit: $("roundUnit"),
  autoRequest: $("autoRequest"),
  recommendationDailyAutoEnabled: $("recommendationDailyAutoEnabled"),
  recommendationDailyAutoTargetCount: $("recommendationDailyAutoTargetCount"),
  recommendationDailyAutoUploadLimit: $("recommendationDailyAutoUploadLimit"),
  recommendationDailyAutoCooldownDays: $("recommendationDailyAutoCooldownDays"),
  recommendationDailyAutoOnlyEligible: $("recommendationDailyAutoOnlyEligible"),
  recommendationDailyAutoForce: $("recommendationDailyAutoForce"),
  recommendationDailyAutoKeywords: $("recommendationDailyAutoKeywords"),
};

const badgeDomeggook = $("badgeDomeggook");
const badgeDomeme = $("badgeDomeme");

// Home dashboard elements
const homeChipDomeggook = $("homeChipDomeggook");
const homeChipDomeme = $("homeChipDomeme");
const homeDomeggookSessionText = $("homeDomeggookSessionText");
const homeDomemeSessionText = $("homeDomemeSessionText");
const homeCreateDomeggookSessionBtn = $("homeCreateDomeggookSession");
const homeSaveDomeggookSessionBtn = $("homeSaveDomeggookSession");
const homeCreateDomemeSessionBtn = $("homeCreateDomemeSession");
const homeSaveDomemeSessionBtn = $("homeSaveDomemeSession");
const homeDraftPurchaseBtn = $("homeDraftPurchase");
const homeUploadPurchaseBtn = $("homeUploadPurchase");
const homePayButtonsEl = $("homePayButtons");
const homeRefreshActivityBtn = $("homeRefreshActivity");
const homeActivityListEl = $("homeActivityList");
const homeUploadGateEl = $("homeUploadGate");
const uploadPreviewCard = $("uploadPreviewCard");
const uploadPreviewKv = $("uploadPreviewKv");

// Upload confirm modal
const uploadConfirmModal = $("uploadConfirmModal");
const uploadConfirmBody = $("uploadConfirmBody");
const uploadConfirmCancelBtn = $("uploadConfirmCancel");
const uploadConfirmProceedBtn = $("uploadConfirmProceed");

// Recommendations (auto digger)
const recoCategoryPresetEl = $("recoCategoryPreset");
const recoCategoryApplyBtn = $("recoCategoryApply");
const recoKeywordsEl = $("recoKeywords");
const recoFillBtn = $("recoFill");
const recoRefreshBtn = $("recoRefresh");
const recoAutoCountEl = $("recoAutoCount");
const recoAutoUploadBtn = $("recoAutoUpload");
const recoSelectAllBtn = $("recoSelectAll");
const recoClearSelectionBtn = $("recoClearSelection");
const recoUploadSelectedBtn = $("recoUploadSelected");
const recoSelectedMetaEl = $("recoSelectedMeta");
const recoListEl = $("recoList");
const recoAutoRunStatusHomeEl = $("recoAutoRunStatusHome");
const recoAutoRunStatusSettingsEl = $("recoAutoRunStatusSettings");
const recoAutoRunNowHomeBtn = $("recoAutoRunNowHome");
const recoAutoRunNowSettingsBtn = $("recoAutoRunNowSettings");
const recoAutoRunRefreshHomeBtn = $("recoAutoRunRefreshHome");
const recoAutoRunRefreshSettingsBtn = $("recoAutoRunRefreshSettings");

const domeggookSessionBtn = $("createDomeggookSession");
const domeggookSessionSaveBtn = $("saveDomeggookSession");
const domeggookSessionStatusEl = $("domeggookSessionStatus");
const domemeSessionBtn = $("createDomemeSession");
const domemeSessionSaveBtn = $("saveDomemeSession");
const domemeSessionStatusEl = $("domemeSessionStatus");

const authEls = {
  email: $("email"),
  password: $("password"),
  status: $("authStatus"),
};
const versionEl = $("versionInfo");
const currentIpEl = $("currentIp");
const refreshIpBtn = $("refreshIp");
const historyTableEl = $("historyTable");
const refreshHistoryBtn = $("refreshHistory");
let currentUserEmail = "";
let recoAutoRunStatusTimer = null;
let lastManualAutoRunResult = null;
let recoCurrentItems = [];
let recoSelectedSourceUrls = new Set();
let recoCategoryPresets = [];
let recoCategoryPresetMap = new Map();

// Dev-only dummy orders
const devOrdersRow = $("devOrdersRow");
const seedOrdersBtn = $("seedOrders");
const refreshOrdersBtn = $("refreshOrders");
const ordersListWrap = $("ordersListWrap");
const ordersListEl = $("ordersList");

// MVP: seeded orders -> vendor purchase upload
const draftPurchaseBtn = $("draftPurchase");
const uploadPurchaseBtn = $("uploadPurchase");
const lastPurchaseDraftEl = $("lastPurchaseDraft");
const purchaseLogEl = $("purchaseLog");
const purchasePayActionsEl = $("purchasePayActions");

// Register Service Worker (PWA)
try {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
} catch {}

try {
  enablePushBtn?.addEventListener("click", () => enablePush());
} catch {}

// Push (PWA)
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function enablePush() {
  try {
    if (!("serviceWorker" in navigator)) {
      setStatus("푸시 미지원 브라우저", "bad");
      return;
    }
    if (!("PushManager" in window)) {
      setStatus("푸시 미지원", "bad");
      return;
    }

    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      setStatus("알림 권한이 필요합니다", "bad");
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const keyRes = await fetch("/api/push/public-key");
    const keyJson = await keyRes.json().catch(() => ({}));
    const publicKey = keyJson?.publicKey || "";
    if (!publicKey) {
      setStatus("푸시 키 오류", "bad");
      log(keyJson);
      return;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("푸시 등록 실패", "bad");
      log(json);
      return;
    }

    setStatus("푸시 알림 ON", "ok");
  } catch (e) {
    setStatus("푸시 등록 에러", "bad");
    log(String(e?.message || e));
  }
}

// Theme: auto | light | dark
const THEME_KEY = "couplus.theme";
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark") root.dataset.theme = "dark";
  else if (mode === "light") root.dataset.theme = "light";
  else root.removeAttribute("data-theme");

  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = mode === "dark" ? "다크" : mode === "light" ? "라이트" : "자동";
}
function getTheme() {
  return localStorage.getItem(THEME_KEY) || "auto";
}
function setTheme(mode) {
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
}
try {
  applyTheme(getTheme());
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const cur = getTheme();
    const next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
    setTheme(next);
  });
} catch {}

let lastPayload = null;
let lastPurchaseDrafts = null;
let lastPayUrls = null;

function setStatus(text, state) {
  statusEl.textContent = text;
  dot.classList.remove("ok", "bad");
  if (state === "ok") dot.classList.add("ok");
  if (state === "bad") dot.classList.add("bad");
}

function parseAllowedIps(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function setUploadEnabled(enabled, reason = "") {
  if (submitBtn) submitBtn.disabled = !enabled;
  if (homeUploadGateEl) {
    homeUploadGateEl.textContent = enabled ? "업로드 가능" : reason || "업로드 불가";
  }
  if (!enabled && reason) {
    setStatus(reason, "bad");
  }
}

function log(obj) {
  logEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function shouldPlaySound() {
  return Boolean(settingsEls.soundOnComplete?.checked);
}

function playSuccessSound() {
  if (!shouldPlaySound()) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playBeep = (startDelay = 0) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + startDelay;
      osc.start(t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      osc.stop(t0 + 0.19);
    };
    playBeep(0);
    playBeep(0.22);
    setTimeout(() => ctx.close?.(), 600);
  } catch {}
}

function renderSummary(result) {
  if (!result) {
    summaryEl.classList.add("hidden");
    summaryEl.innerHTML = "";
    lastPayload = null;
    return;
  }

  if (result?.reason === "ip_not_allowed") {
    const allowed = Array.isArray(result.allowedIps) ? result.allowedIps.join(", ") : "-";
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `
      <div class="title">업로드 차단됨</div>
      <div class="row">
        <div class="label">현재 IP</div><div>${result.ip || "-"}</div>
        <div class="label">허용 IP</div><div>${allowed}</div>
        <div class="label">이유</div><div>허용되지 않은 IP</div>
      </div>
    `;
    return;
  }

  if (result?.error === "image_host_unreachable") {
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `
      <div class="title">업로드 차단됨</div>
      <div class="row">
        <div class="label">이유</div><div>이미지 호스트 접근 실패</div>
        <div class="label">이미지 URL</div><div>${result.imageUrl || "-"}</div>
      </div>
    `;
    return;
  }

  if (result?.error === "pages_deploy_failed") {
    const deploy = result.deploy || {};
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `
      <div class="title">업로드 차단됨</div>
      <div class="row">
        <div class="label">이유</div><div>Pages 배포 실패</div>
        <div class="label">상세</div><div>${result.detail || "-"}</div>
        <div class="label">코드</div><div>${deploy.code ?? "-"}</div>
      </div>
      ${deploy.stderr ? `<div class="warn">stderr: ${deploy.stderr}</div>` : ""}
    `;
    return;
  }

  if (result?.payloadOnly) {
    lastPayload = result.payload || null;
    const check = result.payloadCheck || null;
    const checkSummary = check?.summary || {};
    const checkLabel = check
      ? `${check.ok ? "통과" : "불일치"} · 옵션 ${checkSummary.total ?? 0}개 · 가격불일치 ${checkSummary.priceMismatch ?? 0} · 재고불일치 ${checkSummary.stockMismatch ?? 0}`
      : "검산 없음";
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `
      <div class="title">Payload 생성 완료</div>
      <div class="row">
        <div class="label">상품명</div><div>${result?.draft?.title || "-"}</div>
        <div class="label">가격</div><div>${result?.finalPrice ?? "-"}</div>
        <div class="label">카테고리</div><div>${result?.category?.used ?? "-"}</div>
        <div class="label">상태</div><div>쿠팡 API 호출 없음</div>
        <div class="label">검산</div><div>${checkLabel}</div>
      </div>
      <div class="row">
        <div class="label">Payload</div>
        <div><button id="downloadPayload" class="mini-btn">JSON 다운로드</button></div>
      </div>
      ${check ? `<details class="payload-preview"><summary>검산 상세</summary><pre id="payloadCheckPreview" class="payload-pre"></pre></details>` : ""}
      <details class="payload-preview">
        <summary>Payload 미리보기</summary>
        <pre id="payloadPreview" class="payload-pre"></pre>
      </details>
    `;
    const btn = document.getElementById("downloadPayload");
    btn?.addEventListener("click", () => {
      if (!lastPayload) return;
      const blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "coupang_payload.json";
      a.click();
      URL.revokeObjectURL(url);
    });
    const pre = document.getElementById("payloadPreview");
    if (pre && lastPayload) {
      pre.textContent = JSON.stringify(lastPayload, null, 2);
    }
    const checkPre = document.getElementById("payloadCheckPreview");
    if (checkPre && check) {
      checkPre.textContent = JSON.stringify(check, null, 2);
    }
    return;
  }

  const created = result?.create?.sellerProductId || "-";
  const followUp = result?.followUp || null;
  const approvalMsg = (() => {
    try {
      const body = JSON.parse(result?.approval?.body || "{}");
      return body?.message || "-";
    } catch {
      return result?.approval?.body || "-";
    }
  })();

  const createStatus = (() => {
    try {
      const rawBody = result?.create?.body || "";
      if (typeof rawBody === "string" && /access denied|permission to access/i.test(rawBody)) {
        return "실패: 접근 권한 없음 (IP 허용 필요)";
      }
      const body = JSON.parse(rawBody || "{}");
      if (body?.code === "SUCCESS") return "성공";
      if (body?.message) return `실패: ${body.message}`;
    } catch {}
    return result?.create?.status ? `HTTP ${result.create.status}` : "알 수 없음";
  })();

  const approved = (() => {
    if (followUp?.approved === true) return true;
    const statusName = String(followUp?.statusName || "").toUpperCase();
    return statusName.includes("승인완료") || statusName === "APPROVED";
  })();

  const visibilityStatus = approved ? "승인완료(노출 가능)" : "승인 대기/검수 중";
  const productId = followUp?.productId || "-";

  const ipBlocked = (() => {
    try {
      const rawBody = result?.create?.body || "";
      if (typeof rawBody === "string" && /access denied|permission to access/i.test(rawBody)) {
        return "API 접근 권한 없음 (허용 IP 확인 필요)";
      }
      const body = JSON.parse(rawBody || "{}");
      if (body?.message?.includes("ip address")) return body.message;
    } catch {}
    return "";
  })();

  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `
    <div class="title">업로드 결과</div>
    <div class="row">
      <div class="label">상품명</div><div>${result?.draft?.title || "-"}</div>
      <div class="label">가격</div><div>${result?.finalPrice ?? "-"}</div>
      <div class="label">카테고리</div><div>${result?.category?.used ?? "-"}</div>
      <div class="label">상품 ID</div><div>${created}</div>
      <div class="label">생성 결과</div><div>${createStatus}</div>
      <div class="label">승인 요청</div><div>${approvalMsg}</div>
      <div class="label">승인 상태</div><div>${followUp?.statusName || "-"}</div>
      <div class="label">노출 상태</div><div>${visibilityStatus}</div>
      <div class="label">대표상품 ID</div><div>${productId}</div>
    </div>
    ${ipBlocked ? `<div class="warn">IP 허용 필요: ${ipBlocked}</div>` : ""}
    ${
      followUp?.productUrl
        ? `<div class="row"><div class="label">쿠팡 상품 페이지(대표상품)</div><div><a id="productLink" href="${followUp.productUrl}" target="_blank" rel="noreferrer">바로 열기</a></div></div>`
        : ""
    }
    ${
      !approved
        ? `<div class="warn">등록은 되었지만 아직 승인/노출 전일 수 있습니다. WING에서 SellerProductId(${created})로 상태를 확인하세요.</div>`
        : ""
    }
  `;

  if (approved && followUp?.productUrl) {
    const key = `opened:${followUp.productUrl}`;
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, "1");
      window.open(followUp.productUrl, "_blank");
    }
  }
}

function switchTab(name) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  Object.values(panels).forEach((p) => p.classList.add("hidden"));
  panels[name].classList.remove("hidden");
  if (name === "history") {
    loadUploadHistory();
  }
}

function clearSettingsUI() {
  Object.values(settingsEls).forEach((el) => {
    if (el.type === "checkbox") el.checked = false;
    else el.value = "";
  });
}

function parseBoolLike(value, fallback = false) {
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

function toIntInRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function formatDateTimeLabel(iso) {
  const text = String(iso || "").trim();
  if (!text) return "-";
  const dt = new Date(text);
  if (Number.isNaN(dt.getTime())) return text;
  return dt.toLocaleString();
}


function lockSensitiveField(id) {
  const input = document.getElementById(id);
  const locked = document.querySelector(`[data-sensitive="${id}"]`);
  if (!input || !locked) return;
  input.classList.add("hidden");
  locked.classList.remove("hidden");
}

function unlockSensitiveField(id) {
  const input = document.getElementById(id);
  const locked = document.querySelector(`[data-sensitive="${id}"]`);
  if (!input || !locked) return;
  locked.classList.add("hidden");
  input.classList.remove("hidden");
  try {
    input.focus();
    input.select?.();
  } catch {}
}

function initSensitiveFields() {
  document.querySelectorAll('[data-action="unlock"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.target;
      if (!id) return;
      unlockSensitiveField(id);
    });
  });

  document.querySelectorAll('.sensitive-input').forEach((input) => {
    if (input.dataset._sensInit) return;
    input.dataset._sensInit = "1";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        lockSensitiveField(input.id);
      }
    });
    input.addEventListener("blur", () => {
      // Keep it explicit: if user clicks away, re-lock.
      lockSensitiveField(input.id);
    });
  });
}

function updateSensitiveMasks() {
  document.querySelectorAll('.field.sensitive').forEach((wrap) => {
    const id = wrap.dataset.sensitiveId;
    if (!id) return;
    const input = document.getElementById(id);
    const mask = wrap.querySelector('.mask-input');
    const btn = wrap.querySelector('[data-action="unlock"]');
    if (!input || !mask) return;
    const has = Boolean(String(input.value || "").trim());
    // Fixed-length mask (avoid leaking length)
    mask.value = has ? "••••••••" : "";
    if (btn) btn.textContent = has ? "Reveal/Edit" : "Set";
  });
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    clearSettingsUI();
    return;
  }
  const s = json.settings || {};
  settingsEls.coupangAccessKey.value = s.coupangAccessKey || "";
  settingsEls.coupangSecretKey.value = s.coupangSecretKey || "";
  settingsEls.coupangVendorId.value = s.coupangVendorId || "";
  settingsEls.coupangVendorUserId.value = s.coupangVendorUserId || "";
  settingsEls.coupangDeliveryCompanyCode.value = s.coupangDeliveryCompanyCode || "";
  settingsEls.imageProxyBase.value = s.imageProxyBase || "";
  settingsEls.allowedIps.value = s.allowedIps || "";
  if (settingsEls.domeggookStorageStatePath) {
    settingsEls.domeggookStorageStatePath.value = s.domeggookStorageStatePath || "";
  }
  settingsEls.domemeId.value = s.domemeId || "";
  settingsEls.domemePw.value = s.domemePw || "";
  settingsEls.domemeStorageStatePath.value = s.domemeStorageStatePath || "";
  settingsEls.pagesProjectName.value = s.pagesProjectName || "";
  settingsEls.pagesAccountId.value = s.pagesAccountId || "";
  settingsEls.pagesApiToken.value = s.pagesApiToken || "";
  settingsEls.pagesAutoDeploy.checked = String(s.pagesAutoDeploy || "") === "1";
  settingsEls.payloadOnly.checked = String(s.payloadOnly || "") === "1";
  settingsEls.soundOnComplete.checked = String(s.soundOnComplete || "") === "1";
  settingsEls.marginRate.value = s.marginRate ?? "";
  settingsEls.marginAdd.value = s.marginAdd ?? "";
  settingsEls.priceMin.value = s.priceMin ?? "";
  settingsEls.roundUnit.value = s.roundUnit ?? "";
  settingsEls.autoRequest.checked = String(s.autoRequest || "") === "1";
  if (settingsEls.recommendationDailyAutoEnabled) {
    settingsEls.recommendationDailyAutoEnabled.checked = parseBoolLike(
      s.recommendationDailyAutoEnabled,
      false,
    );
  }
  if (settingsEls.recommendationDailyAutoTargetCount) {
    settingsEls.recommendationDailyAutoTargetCount.value = String(
      toIntInRange(s.recommendationDailyAutoTargetCount, 1, 100, 6),
    );
  }
  if (settingsEls.recommendationDailyAutoUploadLimit) {
    settingsEls.recommendationDailyAutoUploadLimit.value = String(
      toIntInRange(s.recommendationDailyAutoUploadLimit, 1, 30, 3),
    );
  }
  if (settingsEls.recommendationDailyAutoCooldownDays) {
    settingsEls.recommendationDailyAutoCooldownDays.value = String(
      toIntInRange(s.recommendationDailyAutoCooldownDays, 1, 60, 7),
    );
  }
  if (settingsEls.recommendationDailyAutoOnlyEligible) {
    settingsEls.recommendationDailyAutoOnlyEligible.checked = parseBoolLike(
      s.recommendationDailyAutoOnlyEligible,
      true,
    );
  }
  if (settingsEls.recommendationDailyAutoForce) {
    settingsEls.recommendationDailyAutoForce.checked = parseBoolLike(
      s.recommendationDailyAutoForce,
      false,
    );
  }
  if (settingsEls.recommendationDailyAutoKeywords) {
    const keywords = Array.isArray(s.recommendationDailyAutoKeywords)
      ? s.recommendationDailyAutoKeywords
      : parseKeywords(s.recommendationDailyAutoKeywords || "");
    settingsEls.recommendationDailyAutoKeywords.value = keywords.join("\n");
  }

  // Re-evaluate upload availability after settings load
  await loadCurrentIp();
  evaluateUploadGate();
  updateSensitiveMasks();
  await loadRecoAutoRunStatus();
}


function setSessionBadge(el, { label, exists, updatedAt }) {
  if (!el) return;
  el.classList.remove("ok", "bad");
  if (exists) {
    el.classList.add("ok");
    el.textContent = `${label}: OK`;
    if (updatedAt) el.title = `updatedAt: ${updatedAt}`;
  } else {
    el.classList.add("bad");
    el.textContent = `${label}: 없음`;
    el.title = "";
  }
}

function setSessionChip(el, { label, exists, updatedAt }) {
  if (!el) return;
  el.classList.remove("ok", "bad");
  if (exists) {
    el.classList.add("ok");
    el.textContent = `${label}: OK`;
    if (updatedAt) el.title = `updatedAt: ${updatedAt}`;
  } else {
    el.classList.add("bad");
    el.textContent = `${label}: 없음`;
    el.title = "";
  }
}

async function refreshDomeggookSessionStatus() {
  if (domeggookSessionStatusEl) domeggookSessionStatusEl.textContent = "조회중...";
  try {
    const res = await fetch("/api/domeggook/session/status");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error("status failed");

    if (json.exists) {
      const label = `저장됨 (${json.updatedAt})`;
      if (domeggookSessionStatusEl) domeggookSessionStatusEl.textContent = label;
      if (homeDomeggookSessionText) homeDomeggookSessionText.textContent = label;
      if (settingsEls.domeggookStorageStatePath && json.filePath) {
        settingsEls.domeggookStorageStatePath.value = json.filePath;
      }
    } else {
      if (domeggookSessionStatusEl) domeggookSessionStatusEl.textContent = "없음";
      if (homeDomeggookSessionText) homeDomeggookSessionText.textContent = "없음";
    }

    setSessionBadge(badgeDomeggook, {
      label: "도매꾹",
      exists: Boolean(json.exists),
      updatedAt: json.updatedAt || "",
    });
    setSessionChip(homeChipDomeggook, {
      label: "도매꾹",
      exists: Boolean(json.exists),
      updatedAt: json.updatedAt || "",
    });
  } catch {
    if (domeggookSessionStatusEl) domeggookSessionStatusEl.textContent = "-";
    if (homeDomeggookSessionText) homeDomeggookSessionText.textContent = "-";
    setSessionBadge(badgeDomeggook, { label: "도매꾹", exists: false });
    setSessionChip(homeChipDomeggook, { label: "도매꾹", exists: false });
  }
}

async function refreshDomemeSessionStatus() {
  if (domemeSessionStatusEl) domemeSessionStatusEl.textContent = "조회중...";
  try {
    const res = await fetch("/api/domeme/session/status");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error("status failed");
    if (json.exists) {
      const label = `저장됨 (${json.updatedAt})`;
      if (domemeSessionStatusEl) domemeSessionStatusEl.textContent = label;
      if (homeDomemeSessionText) homeDomemeSessionText.textContent = label;
      if (settingsEls.domemeStorageStatePath && json.filePath) {
        settingsEls.domemeStorageStatePath.value = json.filePath;
      }
    } else {
      if (domemeSessionStatusEl) domemeSessionStatusEl.textContent = "없음";
      if (homeDomemeSessionText) homeDomemeSessionText.textContent = "없음";
    }

    setSessionBadge(badgeDomeme, {
      label: "도매매",
      exists: Boolean(json.exists),
      updatedAt: json.updatedAt || "",
    });
    setSessionChip(homeChipDomeme, {
      label: "도매매",
      exists: Boolean(json.exists),
      updatedAt: json.updatedAt || "",
    });
  } catch {
    if (domemeSessionStatusEl) domemeSessionStatusEl.textContent = "-";
    if (homeDomemeSessionText) homeDomemeSessionText.textContent = "-";
    setSessionBadge(badgeDomeme, { label: "도매매", exists: false });
    setSessionChip(homeChipDomeme, { label: "도매매", exists: false });
  }
}

async function saveSettings() {
  const payload = {
    coupangAccessKey: settingsEls.coupangAccessKey.value.trim(),
    coupangSecretKey: settingsEls.coupangSecretKey.value.trim(),
    coupangVendorId: settingsEls.coupangVendorId.value.trim(),
    coupangVendorUserId: settingsEls.coupangVendorUserId.value.trim(),
    coupangDeliveryCompanyCode: settingsEls.coupangDeliveryCompanyCode.value.trim(),
    imageProxyBase: settingsEls.imageProxyBase.value.trim(),
    allowedIps: settingsEls.allowedIps.value.trim(),
    domeggookStorageStatePath: settingsEls.domeggookStorageStatePath?.value?.trim?.() || "",
    domemeId: settingsEls.domemeId.value.trim(),
    domemePw: settingsEls.domemePw.value,
    domemeStorageStatePath: settingsEls.domemeStorageStatePath.value.trim(),
    pagesProjectName: settingsEls.pagesProjectName.value.trim(),
    pagesAccountId: settingsEls.pagesAccountId.value.trim(),
    pagesApiToken: settingsEls.pagesApiToken.value.trim(),
    pagesAutoDeploy: settingsEls.pagesAutoDeploy.checked ? "1" : "",
    payloadOnly: settingsEls.payloadOnly.checked ? "1" : "",
    soundOnComplete: settingsEls.soundOnComplete.checked ? "1" : "",
    marginRate: Number(settingsEls.marginRate.value || 0),
    marginAdd: Number(settingsEls.marginAdd.value || 0),
    priceMin: Number(settingsEls.priceMin.value || 0),
    roundUnit: Number(settingsEls.roundUnit.value || 0),
    autoRequest: settingsEls.autoRequest.checked ? "1" : "",
    recommendationDailyAutoEnabled: settingsEls.recommendationDailyAutoEnabled?.checked ? "1" : "",
    recommendationDailyAutoTargetCount: toIntInRange(
      settingsEls.recommendationDailyAutoTargetCount?.value,
      1,
      100,
      6,
    ),
    recommendationDailyAutoUploadLimit: toIntInRange(
      settingsEls.recommendationDailyAutoUploadLimit?.value,
      1,
      30,
      3,
    ),
    recommendationDailyAutoCooldownDays: toIntInRange(
      settingsEls.recommendationDailyAutoCooldownDays?.value,
      1,
      60,
      7,
    ),
    recommendationDailyAutoOnlyEligible: settingsEls.recommendationDailyAutoOnlyEligible?.checked
      ? "1"
      : "0",
    recommendationDailyAutoForce: settingsEls.recommendationDailyAutoForce?.checked ? "1" : "",
    recommendationDailyAutoKeywords: parseKeywords(
      settingsEls.recommendationDailyAutoKeywords?.value || "",
    ),
  };
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.ok) {
    setStatus("설정 저장 완료", "ok");
    await loadRecoAutoRunStatus();
  } else {
    setStatus("설정 저장 실패", "bad");
  }
}

async function updateAuthStatus() {
  const res = await fetch("/api/me");
  if (!res.ok) {
    authEls.status.textContent = "로그인 필요";
    currentUserEmail = "";
    return false;
  }
  const json = await res.json();
  const label = json?.user?.email || json?.user?.id || "알 수 없음";
  currentUserEmail = String(json?.user?.email || "").trim().toLowerCase();
  authEls.status.textContent = `로그인됨: ${label}`;
  return true;
}

async function loadVersionInfo() {
  if (!versionEl) return;
  try {
    const res = await fetch("/api/version");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error("version fetch failed");
    const v = json.version ? `v${json.version}` : "v?";
    const sha = json.gitSha ? `#${json.gitSha}` : "#?";
    const codeTime = json.codeUpdatedAt ? new Date(json.codeUpdatedAt).toLocaleString() : "-";
    const started = json.serverStartedAt ? new Date(json.serverStartedAt).toLocaleString() : "-";
    versionEl.textContent = `버전 ${v} ${sha} · 코드수정 ${codeTime} · 서버시작 ${started}`;
  } catch {
    versionEl.textContent = "버전 정보를 불러오지 못했습니다.";
  }
}

async function loadCurrentIp() {
  if (!currentIpEl) return;
  currentIpEl.textContent = "조회중...";
  try {
    const res = await fetch("/api/ip");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error("ip fetch failed");
    currentIpEl.textContent = json.ip || "-";
  } catch {
    currentIpEl.textContent = "-";
  }
}

function evaluateUploadGate() {
  const allowed = parseAllowedIps(settingsEls.allowedIps?.value);
  const currentIp = String(currentIpEl?.textContent || "").trim();
  const payloadOnly = settingsEls.payloadOnly?.checked;
  if (payloadOnly) {
    setUploadEnabled(true);
    return;
  }
  if (!allowed.length) {
    setUploadEnabled(true);
    return;
  }
  if (!currentIp || currentIp === "-") {
    setUploadEnabled(false, "현재 IP 확인 후 업로드 가능");
    return;
  }
  if (!allowed.includes(currentIp)) {
    setUploadEnabled(false, "허용 IP가 아님");
    return;
  }
  setUploadEnabled(true);
}

async function signup() {
  const res = await fetch("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: authEls.email.value.trim(),
      password: authEls.password.value,
    }),
  });
  const json = await res.json();
  if (json.ok) {
    setStatus("회원가입 완료", "ok");
    await updateAuthStatus();
    await loadSettings();
    await loadRecoAutoRunStatus();
    startRecoAutoRunStatusPolling();
  } else {
    setStatus("회원가입 실패", "bad");
    log(json);
  }
}

async function login() {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: authEls.email.value.trim(),
      password: authEls.password.value,
    }),
  });
  const json = await res.json();
  if (json.ok) {
    setStatus("로그인 완료", "ok");
    await updateAuthStatus();
    await loadSettings();
    await loadRecoAutoRunStatus();
    startRecoAutoRunStatusPolling();
  } else {
    setStatus("로그인 실패", "bad");
    log(json);
  }
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  authEls.status.textContent = "로그인 필요";
  currentUserEmail = "";
  stopRecoAutoRunStatusPolling();
  clearSettingsUI();
  renderRecoAutoRunStatusCard({ ok: false, unauthorized: true });
}

async function fetchUploadPreviewData(url) {
  const res = await fetch("/api/upload/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function renderUploadPreviewCard(json) {
  const p = json?.preview || {};
  const title = p?.draft?.title || "-";
  const price = p?.draft?.price ?? "-";
  const opts = Array.isArray(p?.draft?.options) ? p.draft.options.length : "-";
  const images = [p?.draft?.imageUrl, ...(p?.preview?.contentImagesFiltered || [])].filter(Boolean);

  if (uploadPreviewKv) {
    const firstImg = images[0] || "";
    uploadPreviewKv.innerHTML = `
      <div class="kv-row"><span class="k">상품명</span><span class="v">${escapeHtml(title)}</span></div>
      <div class="kv-row"><span class="k">원가</span><span class="v">${escapeHtml(String(price))}</span></div>
      <div class="kv-row"><span class="k">옵션</span><span class="v">${escapeHtml(String(opts))}개</span></div>
      <div class="kv-row"><span class="k">상세이미지(필터후)</span><span class="v">${escapeHtml(String(p?.preview?.contentImagesFiltered?.length || 0))}개</span></div>
      ${firstImg ? `<div class="thumb-row"><img class="thumb" src="${firstImg}" alt="preview" loading="lazy" /></div>` : ""}
    `;
  }
  uploadPreviewCard?.classList.remove("hidden");
}

function openUploadConfirmModal({ url, preview, qc, force }) {
  if (!uploadConfirmModal || !uploadConfirmBody || !uploadConfirmProceedBtn) return;

  const title = preview?.draft?.title || "-";
  const categoryCode = preview?.category?.usedCode ?? preview?.category?.resolvedCode ?? "-";
  const categoryName = preview?.draft?.categoryText || preview?.category?.predicted?.name || "-";
  const detailImages = Array.isArray(preview?.preview?.contentImagesFiltered)
    ? preview.preview.contentImagesFiltered
    : [];
  const detailCount = detailImages.length;
  const qcOk = qc?.ok === true;
  const reasons = Array.isArray(qc?.reasons) ? qc.reasons.slice(0, 5) : [];

  const thumbHtml = detailImages.length
    ? `<div style="margin-top:10px;">
        <div class="hint" style="margin-bottom:6px;">상세 이미지 미리보기 (최대 8장)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;max-height:280px;overflow:auto;padding:4px;border:1px solid var(--line,#eee);border-radius:10px;">
          ${detailImages.slice(0, 8).map((u, i) => `<img src="${escapeHtml(u)}" alt="detail-${i + 1}" loading="lazy" style="width:100%;height:90px;object-fit:cover;border-radius:8px;border:1px solid #eee;"/>`).join("")}
        </div>
      </div>`
    : `<div class="hint" style="margin-top:10px;">상세 이미지가 없습니다.</div>`;

  uploadConfirmBody.innerHTML = `
    <div class="kv-row"><span class="k">원본 URL</span><span class="v"><code>${escapeHtml(url)}</code></span></div>
    <div class="kv-row"><span class="k">업로드 제목</span><span class="v">${escapeHtml(title)}</span></div>
    <div class="kv-row"><span class="k">카테고리</span><span class="v">${escapeHtml(String(categoryCode))} / ${escapeHtml(String(categoryName))}</span></div>
    <div class="kv-row"><span class="k">상세 이미지</span><span class="v">${escapeHtml(String(detailCount))}개</span></div>
    <div class="kv-row"><span class="k">QC 판정</span><span class="v ${qcOk ? 'ok-text' : 'bad-text'}">${qcOk ? '통과' : '실패'}</span></div>
    ${reasons.length ? `<div class="hint" style="margin-top:8px;">사유: ${escapeHtml(reasons.join(' / '))}</div>` : ''}
    ${force ? `<div class="hint" style="margin-top:8px;">강제 재업로드 모드</div>` : ''}
    ${thumbHtml}
  `;

  uploadConfirmProceedBtn.disabled = !qcOk;
  uploadConfirmProceedBtn.dataset.url = url;
  uploadConfirmProceedBtn.dataset.force = force ? "1" : "0";
  uploadConfirmModal.classList.remove("hidden");
  uploadConfirmModal.style.display = "flex";
}

function closeUploadConfirmModal() {
  if (!uploadConfirmModal) return;
  uploadConfirmModal.classList.add("hidden");
  uploadConfirmModal.style.display = "none";
}
window.__closeUploadConfirmModal = closeUploadConfirmModal;

async function previewUpload() {
  const url = urlInput?.value?.trim?.() || "";
  if (!url) {
    setStatus("URL을 입력하세요", "bad");
    return;
  }
  if (previewBtn) previewBtn.disabled = true;
  setStatus("미리보기 생성 중...", "");
  log("");

  try {
    const { res, json } = await fetchUploadPreviewData(url);
    if (!res.ok || !json.ok) {
      setStatus("미리보기 실패", "bad");
      log(json);
      if (uploadPreviewCard) uploadPreviewCard.classList.add("hidden");
      return;
    }

    renderUploadPreviewCard(json);
    setStatus("미리보기 완료", "ok");
    log(json);
  } catch (e) {
    setStatus("미리보기 에러", "bad");
    log(String(e?.message || e));
    uploadPreviewCard?.classList.add("hidden");
  } finally {
    if (previewBtn) previewBtn.disabled = false;
  }
}

// ----- Recommendations / Auto digger -----
const RECO_CATEGORY_STORAGE_KEY = "couplus.reco.categoryPreset";
const FALLBACK_RECO_CATEGORIES = [
  { key: "all", label: "전체 (기본)", description: "기본 키워드셋 전체 사용", keywords: [] },
  {
    key: "car",
    label: "차량용",
    description: "차량 정리/거치 중심",
    keywords: [
      "차량용 수납함",
      "차량 틈새 수납",
      "차량 트렁크 정리함",
      "차량 송풍구 거치대",
      "차량 휴대폰 거치대",
      "차량 케이블 정리",
      "차량 컵홀더 수납",
      "차량 선바이저 포켓",
      "차량 헤드레스트 훅",
    ],
  },
  {
    key: "pet",
    label: "반려동물",
    description: "반려동물 용품 중심",
    keywords: [
      "강아지 장난감",
      "고양이 장난감",
      "강아지 하네스",
      "강아지 리드줄",
      "고양이 스크래쳐",
      "반려동물 급수기",
      "펫 브러쉬",
      "반려동물 이동가방",
      "고양이 모래 삽",
    ],
  },
  {
    key: "home",
    label: "생활/수납",
    description: "주방/욕실/정리 중심",
    keywords: [
      "싱크대 정리 선반",
      "주방 서랍 정리",
      "냉장고 정리 트레이",
      "욕실 수납 선반",
      "세탁실 정리함",
      "신발장 정리대",
      "옷장 수납함",
      "압축 수납팩",
      "현관 우산꽂이",
    ],
  },
  {
    key: "desk",
    label: "데스크/사무",
    description: "책상/케이블 정리 중심",
    keywords: [
      "멀티탭 정리함",
      "전선 정리함",
      "서랍 칸막이",
      "서랍 정리 트레이",
      "책상 수납 정리",
      "모니터 받침대 수납",
      "노트북 거치대",
      "데스크 케이블 홀더",
      "USB 수납 케이스",
    ],
  },
  {
    key: "outdoor",
    label: "여행/캠핑",
    description: "아웃도어/차박 중심",
    keywords: [
      "여행용 파우치 세트",
      "캐리어 정리 파우치",
      "압축 파우치",
      "캠핑 수납 박스",
      "캠핑 랜턴 걸이",
      "차박 수납함",
    ],
  },
];

function normalizeRecoCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function getSavedRecoCategoryKey() {
  try {
    return normalizeRecoCategoryKey(localStorage.getItem(RECO_CATEGORY_STORAGE_KEY)) || "all";
  } catch {
    return "all";
  }
}

function saveRecoCategoryKey(key) {
  const normalized = normalizeRecoCategoryKey(key) || "all";
  try {
    localStorage.setItem(RECO_CATEGORY_STORAGE_KEY, normalized);
  } catch {}
}

function getSelectedRecoCategoryKey() {
  const raw = recoCategoryPresetEl?.value;
  const key = normalizeRecoCategoryKey(raw);
  return key || "all";
}

function getSelectedRecoCategoryPreset() {
  const key = getSelectedRecoCategoryKey();
  return recoCategoryPresetMap.get(key) || recoCategoryPresetMap.get("all") || null;
}

function applyRecoCategoryPresetToKeywords({ forceOverwrite = false } = {}) {
  if (!recoKeywordsEl) return false;
  const preset = getSelectedRecoCategoryPreset();
  if (!preset || !Array.isArray(preset.keywords) || preset.keywords.length === 0) return false;
  const hasCustomKeywords = parseKeywords(recoKeywordsEl.value).length > 0;
  if (hasCustomKeywords && !forceOverwrite) return false;
  recoKeywordsEl.value = preset.keywords.join(", ");
  return true;
}

function renderRecoCategoryPresetOptions(categories = []) {
  if (!recoCategoryPresetEl) return;
  const list = Array.isArray(categories) && categories.length > 0 ? categories : FALLBACK_RECO_CATEGORIES;
  const normalizedList = list
    .map((row) => {
      const key = normalizeRecoCategoryKey(row?.key);
      if (!key) return null;
      const label = String(row?.label || key).trim();
      const description = String(row?.description || "").trim();
      const keywords = parseKeywords(
        Array.isArray(row?.keywords) ? row.keywords.join(", ") : row?.keywords || "",
      );
      return {
        key,
        label,
        description,
        keywords,
      };
    })
    .filter(Boolean);
  const hasAll = normalizedList.some((row) => row.key === "all");
  if (!hasAll) {
    normalizedList.unshift({
      key: "all",
      label: "전체 (기본)",
      description: "기본 키워드셋 전체 사용",
      keywords: [],
    });
  }

  recoCategoryPresets = normalizedList;
  recoCategoryPresetMap = new Map(recoCategoryPresets.map((row) => [row.key, row]));

  const savedKey = getSavedRecoCategoryKey();
  const defaultKey = recoCategoryPresetMap.has(savedKey) ? savedKey : "all";

  recoCategoryPresetEl.innerHTML = recoCategoryPresets
    .map((row) => {
      const title = row.description ? `${row.description} / 키워드 ${row.keywords.length}개` : "";
      return `<option value="${escapeHtml(row.key)}" title="${escapeHtml(title)}">${escapeHtml(row.label)}</option>`;
    })
    .join("");
  recoCategoryPresetEl.value = defaultKey;
  saveRecoCategoryKey(defaultKey);
}

async function loadRecoCategoryPresets() {
  try {
    const res = await fetch("/api/recommendations/categories");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok || !Array.isArray(json.categories)) {
      renderRecoCategoryPresetOptions(FALLBACK_RECO_CATEGORIES);
      return;
    }
    renderRecoCategoryPresetOptions(json.categories);
  } catch {
    renderRecoCategoryPresetOptions(FALLBACK_RECO_CATEGORIES);
  }
}

function buildRecommendationRunBody({ targetCount = 80 } = {}) {
  const keywords = parseKeywords(recoKeywordsEl?.value);
  const categoryKey = getSelectedRecoCategoryKey();
  const body = {
    targetCount: Math.max(50, Math.min(100, Number(targetCount) || 80)),
    categoryKey,
  };
  if (keywords.length > 0) body.keywords = keywords;
  return body;
}

function syncRecoSelectionWithList(items = []) {
  const list = Array.isArray(items) ? items : [];
  recoCurrentItems = list;
  const available = new Set(
    list
      .map((it) => String(it?.sourceUrl || "").trim())
      .filter(Boolean),
  );
  const next = new Set();
  for (const url of recoSelectedSourceUrls) {
    if (available.has(url)) next.add(url);
  }
  recoSelectedSourceUrls = next;
  updateRecoSelectionUi();
}

function updateRecoSelectionUi() {
  const selectedCount = recoSelectedSourceUrls.size;
  const totalCount = Array.isArray(recoCurrentItems) ? recoCurrentItems.length : 0;
  if (recoSelectedMetaEl) {
    recoSelectedMetaEl.textContent = `선택 ${selectedCount}개 / ${totalCount}개`;
  }
  if (recoUploadSelectedBtn) {
    recoUploadSelectedBtn.disabled = selectedCount <= 0;
  }
}

function setRecoItemSelected(url, checked) {
  const key = String(url || "").trim();
  if (!key) return;
  if (checked) recoSelectedSourceUrls.add(key);
  else recoSelectedSourceUrls.delete(key);
  updateRecoSelectionUi();
}

function toggleRecoSelectionAll(checked = true) {
  const list = Array.isArray(recoCurrentItems) ? recoCurrentItems : [];
  for (const item of list) {
    const url = String(item?.sourceUrl || "").trim();
    if (!url) continue;
    if (checked) recoSelectedSourceUrls.add(url);
    else recoSelectedSourceUrls.delete(url);
  }
  renderRecoList(recoCurrentItems);
}

function getSelectedRecoItems() {
  const list = Array.isArray(recoCurrentItems) ? recoCurrentItems : [];
  if (recoSelectedSourceUrls.size <= 0) return [];
  return list.filter((it) => recoSelectedSourceUrls.has(String(it?.sourceUrl || "").trim()));
}

function parseKeywords(raw) {
  const s = String(raw || "");
  // split by comma or newline
  const parts = s
    .split(/[,\n]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  // de-dupe, keep order
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function formatWon(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("ko-KR") + "원";
}

function renderRecoList(items) {
  if (!recoListEl) return;
  const list = Array.isArray(items) ? items : [];
  syncRecoSelectionWithList(list);
  if (!list.length) {
    recoListEl.innerHTML = `<div class="hint">아직 후보가 없어요. ‘후보 채우기’를 눌러주세요.</div>`;
    updateRecoSelectionUi();
    return;
  }

  recoListEl.innerHTML = list
    .map((it) => {
      const title = it.seoTitle || it.title || "(제목 없음)";
      const originalTitle = it.originalTitle || "";
      const keyword = it.keyword || "";
      const img = it.mainImageUrl || "";
      const finalPrice = formatWon(it.finalPrice);
      const profit = formatWon(it.profit);
      const margin = Number(it.marginRate);
      const marginText = Number.isFinite(margin) ? `${Math.round(margin * 100)}%` : "-";
      const sourceUrl = it.sourceUrl || "";
      const isSelected = sourceUrl ? recoSelectedSourceUrls.has(sourceUrl) : false;
      const categoryCode = Number(it.categoryCode);
      const categorySource = String(it.categorySource || "").trim();
      const categoryChip =
        Number.isFinite(categoryCode) && categoryCode > 0
          ? `카테고리: ${categoryCode}${categorySource ? ` (${categorySource})` : ""}`
          : "";

      return `
        <div class="reco-item" style="display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--line,#eee);">
          <div style="width:72px; flex:0 0 72px;">
            ${img ? `<img src="${img}" alt="thumb" style="width:72px; height:72px; object-fit:cover; border-radius:10px;" loading="lazy"/>` : `<div style="width:72px; height:72px; border-radius:10px; background:#f2f2f2;"></div>`}
          </div>
          <div style="flex:1 1 auto; min-width:0;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
              <label style="display:inline-flex; align-items:center; gap:6px; margin:0; color:var(--muted); font-size:12px;">
                <input type="checkbox" data-action="reco-select" data-url="${escapeHtml(sourceUrl)}" ${isSelected ? "checked" : ""} />
                선택
              </label>
              <span class="hint">${escapeHtml(it?.qc?.eligibleUpload ? "업로드 가능" : "QC 점검 필요")}</span>
            </div>
            <div style="font-weight:700; line-height:1.25;">${escapeHtml(title)}</div>
            ${
              originalTitle && originalTitle !== title
                ? `<div class="hint" style="margin-top:2px;">원본: ${escapeHtml(originalTitle)}</div>`
                : ""
            }
            <div class="hint" style="margin-top:4px; display:flex; flex-wrap:wrap; gap:8px;">
              ${keyword ? `<span class="chip">키워드: ${escapeHtml(keyword)}</span>` : ""}
              ${categoryChip ? `<span class="chip">${escapeHtml(categoryChip)}</span>` : ""}
              <span class="chip">예상가: ${escapeHtml(finalPrice)}</span>
              <span class="chip">예상이익: ${escapeHtml(profit)}</span>
              <span class="chip">마진: ${escapeHtml(marginText)}</span>
            </div>
            <div class="btn-row" style="margin-top:8px;">
              <button type="button" class="ghost" data-action="reco-preview" data-url="${escapeHtml(sourceUrl)}">미리보기</button>
              <a class="btn-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">원문 열기</a>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  // bind preview buttons
  recoListEl.querySelectorAll('[data-action="reco-preview"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url") || "";
      if (!url) return;
      // reuse existing preview UI card
      if (urlInput) urlInput.value = url;
      await previewUpload();
      // scroll to upload card for visibility
      document.getElementById("uploadPreviewCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  // bind selection checkboxes
  recoListEl.querySelectorAll('[data-action="reco-select"]').forEach((input) => {
    input.addEventListener("change", () => {
      const url = input.getAttribute("data-url") || "";
      setRecoItemSelected(url, Boolean(input.checked));
    });
  });

  updateRecoSelectionUi();
}

async function uploadSelectedRecommendations() {
  if (recoUploadSelectedBtn) recoUploadSelectedBtn.disabled = true;
  try {
    const selectedItems = getSelectedRecoItems();
    if (selectedItems.length <= 0) {
      setStatus("업로드할 추천 아이템을 먼저 선택하세요.", "bad");
      return;
    }

    setStatus(`선택 업로드 실행 중... (${selectedItems.length}개)`, "");
    const urls = [];
    const overridesByUrl = {};

    for (const item of selectedItems) {
      const sourceUrl = String(item?.sourceUrl || "").trim();
      if (!sourceUrl) continue;
      urls.push(sourceUrl);

      const titleOverride = String(item?.seoTitle || item?.title || "").trim();
      const categoryOverrideCode = Number(item?.categoryCode);
      const previewImages = Array.isArray(item?.previewImages)
        ? item.previewImages.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 20)
        : [];

      const overrides = {};
      if (titleOverride) overrides.titleOverride = titleOverride;
      if (Number.isFinite(categoryOverrideCode) && categoryOverrideCode > 0) {
        overrides.categoryOverrideCode = categoryOverrideCode;
      }
      if (previewImages.length > 0) overrides.imagesOverride = previewImages;
      if (Object.keys(overrides).length > 0) {
        overridesByUrl[sourceUrl] = overrides;
      }
    }

    const res = await fetch("/api/upload/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, force: "0", overridesByUrl }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("선택 업로드 실패", "bad");
      log(json);
      return;
    }

    const summary = json.summary || {};
    setStatus(
      `선택 업로드 완료 (성공 ${summary.uploaded || 0} / 스킵 ${summary.skipped || 0} / 실패 ${summary.failed || 0})`,
      Number(summary.failed || 0) > 0 ? "bad" : "ok",
    );
    log(json);

    if (Number(summary.uploaded || 0) > 0) {
      playSuccessSound();
    }

    recoSelectedSourceUrls.clear();
    await loadRecommendations();
    await loadUploadHistory();
  } catch (e) {
    setStatus("선택 업로드 에러", "bad");
    log(String(e?.message || e));
  } finally {
    updateRecoSelectionUi();
  }
}

async function loadRecommendations() {
  try {
    const res = await fetch("/api/recommendations?limit=120");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      renderRecoList([]);
      return;
    }
    renderRecoList(json.items || []);
  } catch {
    renderRecoList([]);
  }
}

async function syncRecommendationsAfterError(tries = 4, waitMs = 1200) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await loadRecommendations();
    } catch {}
    if (i < tries - 1) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

function formatRecoDiagnosticsHint(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return "";
  const hint = String(diagnostics.hint || "").trim();
  if (hint) return hint;

  const keywordDiagnostics = Array.isArray(diagnostics.keywordDiagnostics)
    ? diagnostics.keywordDiagnostics
    : [];
  const firstError = keywordDiagnostics
    .flatMap((d) => (Array.isArray(d?.errors) ? d.errors : []))
    .map((e) => String(e || "").trim())
    .find(Boolean);

  if (firstError) {
    const lower = firstError.toLowerCase();
    if (lower.includes("domeggook_openapi_getitemlist_failed")) {
      return "도매꾹 OpenAPI 응답 오류로 후보 수집이 불안정합니다. 잠시 후 다시 시도하세요.";
    }
    if (lower.includes("domeggook_openapi_key_missing")) {
      return "도매꾹 OpenAPI 키가 없어 후보 수집을 시작하지 못했습니다.";
    }
    return `후보 수집 오류: ${firstError}`;
  }
  if (Number(diagnostics.collectedCandidates || 0) === 0) {
    return "후보가 0개입니다. 키워드/네트워크 상태를 확인하세요.";
  }
  return "";
}

async function refreshRecommendationsReplacing() {
  if (recoRefreshBtn) recoRefreshBtn.disabled = true;
  setStatus("추천 새로고침 중... (기존 목록 교체)", "");
  try {
    const body = buildRecommendationRunBody({ targetCount: 80 });

    const res = await fetch("/api/recommendations/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("추천 새로고침 실패", "bad");
      log(json);
      await syncRecommendationsAfterError();
      return;
    }

    const refresh = json.refresh || {};
    const removed = Number(refresh.removedCount || 0);
    const count = Number(refresh.count || 0);
    const cooldown = Number(refresh.cooldownDays || 7);
    const diagnostics = refresh.diagnostics || {};
    const hint = formatRecoDiagnosticsHint(diagnostics);
    if (count <= 0) {
      setStatus(
        `추천 새로고침 완료 (이전 ${removed}개 교체, 새 0개 / 재노출 제외 ${cooldown}일)${
          hint ? ` - ${hint}` : ""
        }`,
        "bad",
      );
      if (Object.keys(diagnostics).length) log({ recommendationDiagnostics: diagnostics });
    } else {
      setStatus(
        `추천 새로고침 완료 (이전 ${removed}개 교체, 새 ${count}개 / 재노출 제외 ${cooldown}일)`,
        "ok",
      );
    }
    renderRecoList(json.items || []);
  } catch (e) {
    setStatus("추천 새로고침 에러", "bad");
    log(String(e?.message || e));
    await syncRecommendationsAfterError();
  } finally {
    if (recoRefreshBtn) recoRefreshBtn.disabled = false;
  }
}

async function fillRecommendations() {
  if (recoFillBtn) recoFillBtn.disabled = true;
  setStatus("후보 생성 중...", "");
  try {
    const body = buildRecommendationRunBody({ targetCount: 80 });

    const res = await fetch("/api/recommendations/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("후보 생성 실패", "bad");
      log(json);
      return;
    }

    const fill = json.fill || {};
    const count = Number(fill.count || (json.items || []).length || 0);
    const diagnostics = fill.diagnostics || {};
    const hint = formatRecoDiagnosticsHint(diagnostics);
    if (count <= 0) {
      setStatus(`후보 생성 완료: 현재 0개${hint ? ` - ${hint}` : ""}`, "bad");
      if (Object.keys(diagnostics).length) log({ recommendationDiagnostics: diagnostics });
    } else {
      setStatus("후보 생성 요청 완료(잠시 후 목록 확인)", "ok");
    }

    // poll the list a few times
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 1800));
      await loadRecommendations();
    }
  } catch (e) {
    setStatus("후보 생성 에러", "bad");
    log(String(e?.message || e));
  } finally {
    if (recoFillBtn) recoFillBtn.disabled = false;
  }
}

async function autoUploadRecommendations() {
  if (recoAutoUploadBtn) recoAutoUploadBtn.disabled = true;
  setStatus("추천 자동 업로드 실행 중...", "");
  try {
    const rawLimit = Number(recoAutoCountEl?.value || 5);
    const limit = Math.max(1, Math.min(30, Number.isFinite(rawLimit) ? rawLimit : 5));
    if (recoAutoCountEl) recoAutoCountEl.value = String(limit);

    const res = await fetch("/api/recommendations/auto-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, onlyEligible: "1" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("추천 자동 업로드 실패", "bad");
      log(json);
      return;
    }

    const summary = json.summary || {};
    setStatus(
      `자동 업로드 완료 (성공 ${summary.uploaded || 0} / 스킵 ${summary.skipped || 0} / 실패 ${summary.failed || 0})`,
      summary.failed ? "bad" : "ok",
    );
    log(json);

    if (Number(summary.uploaded || 0) > 0) {
      playSuccessSound();
    }

    await loadRecommendations();
    await loadUploadHistory();
  } catch (e) {
    setStatus("추천 자동 업로드 에러", "bad");
    log(String(e?.message || e));
  } finally {
    if (recoAutoUploadBtn) recoAutoUploadBtn.disabled = false;
  }
}

function setRecoAutoRunButtonsDisabled(disabled) {
  [recoAutoRunNowHomeBtn, recoAutoRunNowSettingsBtn, recoAutoRunRefreshHomeBtn, recoAutoRunRefreshSettingsBtn]
    .forEach((btn) => {
      if (!btn) return;
      btn.disabled = Boolean(disabled);
    });
}

function renderRecoAutoRunStatusCard(payload = {}) {
  const targets = [recoAutoRunStatusHomeEl, recoAutoRunStatusSettingsEl].filter(Boolean);
  if (!targets.length) return;

  if (payload?.unauthorized) {
    const html = `<div class="hint">로그인 후 일일 자동 업로드 상태를 확인할 수 있습니다.</div>`;
    targets.forEach((el) => {
      el.innerHTML = html;
    });
    return;
  }

  if (payload?.error) {
    const html = `<div class="hint">상태 조회 실패: ${escapeHtml(String(payload.error || "unknown"))}</div>`;
    targets.forEach((el) => {
      el.innerHTML = html;
    });
    return;
  }

  const scheduler = payload?.scheduler && typeof payload.scheduler === "object" ? payload.scheduler : {};
  const state = payload?.state && typeof payload.state === "object" ? payload.state : {};
  const user = payload?.user && typeof payload.user === "object" ? payload.user : {};
  const options = user?.options && typeof user.options === "object" ? user.options : {};
  const results = Array.isArray(state.lastResults) ? state.lastResults : [];

  const schedulerEnabled = parseBoolLike(scheduler.enabled, false);
  const hour = toIntInRange(scheduler.hour, 0, 23, 9);
  const minute = toIntInRange(scheduler.minute, 0, 59, 0);
  const schedulerLabel = schedulerEnabled
    ? `ON (매일 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")})`
    : "OFF (서버 환경변수 비활성)";
  const runningLabel = parseBoolLike(state.running, false) ? "실행 중" : "대기";
  const lastRunLabel = formatDateTimeLabel(state.lastRunAt);
  const lastError = String(state.lastError || "").trim();

  const total = results.reduce(
    (acc, row) => {
      acc.uploaded += Number(row?.upload?.uploaded || 0);
      acc.skipped += Number(row?.upload?.skipped || 0);
      acc.failed += Number(row?.upload?.failed || 0);
      if (row?.ok === false) acc.userErrors += 1;
      return acc;
    },
    { uploaded: 0, skipped: 0, failed: 0, userErrors: 0 },
  );

  const currentEmail = String(currentUserEmail || user.email || "").trim().toLowerCase();
  const myResult = results.find(
    (row) => String(row?.userEmail || "").trim().toLowerCase() === currentEmail,
  );
  const mySummary = myResult
    ? `성공 ${Number(myResult?.upload?.uploaded || 0)} / 스킵 ${Number(myResult?.upload?.skipped || 0)} / 실패 ${Number(myResult?.upload?.failed || 0)}`
    : "최근 스케줄 실행 이력 없음";

  const manualResult = lastManualAutoRunResult?.result || null;
  const manualAt = formatDateTimeLabel(lastManualAutoRunResult?.ranAt);
  const manualSummary = manualResult
    ? `성공 ${Number(manualResult?.upload?.uploaded || 0)} / 스킵 ${Number(manualResult?.upload?.skipped || 0)} / 실패 ${Number(manualResult?.upload?.failed || 0)}`
    : "-";

  const keywords = Array.isArray(options.keywords)
    ? options.keywords
    : parseKeywords(options.keywords || "");
  const html = `
    <div class="kv-row"><span class="k">서버 스케줄</span><span class="v">${escapeHtml(schedulerLabel)}</span></div>
    <div class="kv-row"><span class="k">내 계정 설정</span><span class="v">${parseBoolLike(user.enabled, false) ? "켜짐" : "꺼짐"} / 업로드 ${Number(options.uploadLimit || 3)}개 / 후보 ${Number(options.targetCount || 80)}개 / 키워드 ${keywords.length || 0}개</span></div>
    <div class="kv-row"><span class="k">스케줄 상태</span><span class="v">${escapeHtml(runningLabel)}</span></div>
    <div class="kv-row"><span class="k">최근 스케줄</span><span class="v">${escapeHtml(lastRunLabel)} / 전체 성공 ${total.uploaded} / 스킵 ${total.skipped} / 실패 ${total.failed}</span></div>
    <div class="kv-row"><span class="k">내 최근 결과</span><span class="v">${escapeHtml(mySummary)}</span></div>
    <div class="kv-row"><span class="k">수동 1회 실행</span><span class="v">${escapeHtml(manualAt)} / ${escapeHtml(manualSummary)}</span></div>
    ${lastError ? `<div class="kv-row"><span class="k">최근 에러</span><span class="v">${escapeHtml(lastError)}</span></div>` : ""}
  `;

  targets.forEach((el) => {
    el.innerHTML = html;
  });
}

async function loadRecoAutoRunStatus() {
  try {
    const res = await fetch("/api/recommendations/auto-run/status");
    if (res.status === 401) {
      renderRecoAutoRunStatusCard({ ok: false, unauthorized: true });
      return;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      renderRecoAutoRunStatusCard({ ok: false, error: json?.error || `http_${res.status}` });
      return;
    }
    renderRecoAutoRunStatusCard(json);
  } catch (e) {
    renderRecoAutoRunStatusCard({ ok: false, error: String(e?.message || e) });
  }
}

function startRecoAutoRunStatusPolling() {
  if (recoAutoRunStatusTimer) {
    clearInterval(recoAutoRunStatusTimer);
    recoAutoRunStatusTimer = null;
  }
  recoAutoRunStatusTimer = setInterval(() => {
    loadRecoAutoRunStatus().catch(() => {});
  }, 30_000);
}

function stopRecoAutoRunStatusPolling() {
  if (!recoAutoRunStatusTimer) return;
  clearInterval(recoAutoRunStatusTimer);
  recoAutoRunStatusTimer = null;
}

function buildRecoAutoRunRequestBody() {
  const uploadLimit = toIntInRange(
    settingsEls.recommendationDailyAutoUploadLimit?.value,
    1,
    30,
    3,
  );
  const body = {
    targetCount: toIntInRange(settingsEls.recommendationDailyAutoTargetCount?.value, 1, 100, 80),
    cooldownDays: toIntInRange(settingsEls.recommendationDailyAutoCooldownDays?.value, 1, 60, 7),
    uploadLimit,
    limit: uploadLimit,
    onlyEligible: settingsEls.recommendationDailyAutoOnlyEligible?.checked ? "1" : "0",
    force: settingsEls.recommendationDailyAutoForce?.checked ? "1" : "0",
  };
  const keywords = parseKeywords(settingsEls.recommendationDailyAutoKeywords?.value || "");
  if (keywords.length > 0) body.keywords = keywords;
  return body;
}

async function runRecoAutoRunNow() {
  setRecoAutoRunButtonsDisabled(true);
  setStatus("일일 자동 업로드 1회 실행 중...", "");
  try {
    const res = await fetch("/api/recommendations/auto-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRecoAutoRunRequestBody()),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("일일 자동 업로드 1회 실행 실패", "bad");
      log(json);
      return;
    }

    const result = json.result || {};
    const uploaded = Number(result?.upload?.uploaded || 0);
    const skipped = Number(result?.upload?.skipped || 0);
    const failed = Number(result?.upload?.failed || 0);
    const fillCount = Number(result?.fill?.count || 0);
    lastManualAutoRunResult = {
      ranAt: new Date().toISOString(),
      result,
    };

    setStatus(
      `일일 자동 업로드 1회 완료 (추천 ${fillCount} / 업로드 성공 ${uploaded} / 스킵 ${skipped} / 실패 ${failed})`,
      failed > 0 ? "bad" : "ok",
    );
    log(json);

    if (uploaded > 0) {
      playSuccessSound();
    }

    await loadRecommendations();
    await loadUploadHistory();
    await loadRecoAutoRunStatus();
  } catch (e) {
    setStatus("일일 자동 업로드 1회 실행 에러", "bad");
    log(String(e?.message || e));
  } finally {
    setRecoAutoRunButtonsDisabled(false);
  }
}

function renderDuplicate(existing) {
  const title = existing?.title || "";
  const pid = existing?.sellerProductId || "";
  const productUrl = existing?.productUrl || "";

  setStatus("중복 상품", "bad");
  log({ error: "duplicate_product", existing });

  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `
    <div class="sum-title">중복 상품이 이미 등록되어 있어요</div>
    <div class="sum-grid">
      <div><span class="k">상품명</span><span class="v">${escapeHtml(title || "-")}</span></div>
      <div><span class="k">SellerProductId</span><span class="v">${escapeHtml(pid || "-")}</span></div>
    </div>
    <div class="btn-row" style="margin-top: 10px;">
      ${productUrl ? `<a class="btn-link" href="${productUrl}" target="_blank" rel="noreferrer">기존 상품 열기</a>` : ""}
      <button id="forceReuploadBtn" type="button" class="ghost">강제 재업로드</button>
    </div>
    <p class="hint" style="margin-top: 8px;">강제 재업로드는 같은 URL로 새 상품을 다시 등록합니다.</p>
  `;

  const btn = document.getElementById("forceReuploadBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      if (forceUploadEl) forceUploadEl.checked = true;
      run(true);
    });
  }
}

async function executeUpload(url, force = false) {
  submitBtn.disabled = true;
  setStatus("업로드 중...", "");
  log("");
  lastPayload = null;
  renderSummary(null);

  try {
    const res = await fetch("/api/upload/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, force: force ? "1" : "0" }),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok && json?.error === "duplicate_product" && json?.existing) {
      renderDuplicate(json.existing);
      return;
    }

    if (!res.ok || !json.ok) {
      if (json?.error === 'missing_coupang_keys' && Array.isArray(json?.missing)) {
        setStatus("설정에 쿠팡 키가 필요합니다", "bad");
        log(json);
        renderSummary(null);
        return;
      }

      setStatus("실패", "bad");
      log(json);
      renderSummary(null);
    } else {
      if (json?.result?.payloadOnly) {
        setStatus("완료", "ok");
        renderSummary(json.result);
        log(json.result);
        playSuccessSound();
      } else {
        const createBody = (() => {
          try {
            return JSON.parse(json?.result?.create?.body || "{}");
          } catch {
            return {};
          }
        })();
        const ok = createBody?.code === "SUCCESS";
        setStatus(ok ? "완료" : "실패", ok ? "ok" : "bad");
        renderSummary(json.result);
        log(json.result);
        if (ok) playSuccessSound();
      }
    }
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
    renderSummary(null);
  } finally {
    submitBtn.disabled = false;
  }
}

async function run(forceOverride = null) {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("URL을 입력하세요", "bad");
    return;
  }

  const force = forceOverride == null ? Boolean(forceUploadEl?.checked) : Boolean(forceOverride);

  setStatus("업로드 전 검수 중...", "");
  try {
    const { res, json } = await fetchUploadPreviewData(url);
    if (!res.ok || !json.ok) {
      setStatus("미리검수 실패", "bad");
      log(json);
      return;
    }

    renderUploadPreviewCard(json);
    openUploadConfirmModal({
      url,
      preview: json.preview,
      qc: json.qc,
      force,
    });
  } catch (e) {
    setStatus("검수 에러", "bad");
    log(String(e?.message || e));
  }
}

async function exportOrders() {
  const dateFrom = orderFromInput.value;
  const dateTo = orderToInput.value;
  if (!dateFrom || !dateTo) {
    setStatus("시작일/종료일을 입력하세요", "bad");
    return;
  }
  exportOrdersBtn.disabled = true;
  setStatus("엑셀 생성 중...", "");
  log("");
  renderSummary(null);
  try {
    const res = await fetch("/api/orders/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dateFrom, dateTo }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("실패", "bad");
      log(json);
      return;
    }
    const result = json.result || {};
    if (!result.ok) {
      setStatus("실패", "bad");
      log(result);
      return;
    }
    setStatus("엑셀 생성 완료", "ok");
    renderSummary(null);
    log(result);
    if (lastExportPathEl) lastExportPathEl.textContent = result.filePath || "-";
    if (result.filePath) lastExportPathEl?.setAttribute("data-path", result.filePath);
    playSuccessSound();
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
  } finally {
    exportOrdersBtn.disabled = false;
  }
}

async function uploadOrders() {
  const filePath = lastExportPathEl?.getAttribute("data-path") || "";
  if (!filePath) {
    setStatus("엑셀 파일 경로 없음", "bad");
    return;
  }
  uploadOrdersBtn.disabled = true;
  setStatus("도매매 업로드 중...", "");
  log("");
  try {
    const res = await fetch("/api/orders/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("실패", "bad");
      log(json);
      return;
    }
    setStatus("업로드 완료", "ok");
    log(json.result || json);
    playSuccessSound();
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
  } finally {
    uploadOrdersBtn.disabled = false;
  }
}

async function loadMissingSku() {
  const res = await fetch("/api/orders/missing");
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    setStatus("실패", "bad");
    log(json);
    return;
  }
  if (missingSkuEl) {
    missingSkuEl.value = JSON.stringify(json.missing || [], null, 2);
  }
}

async function loadSkuMap() {
  const res = await fetch("/api/sku-map");
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    setStatus("실패", "bad");
    log(json);
    return;
  }
  if (skuMapEl) {
    skuMapEl.value = JSON.stringify(json.map || {}, null, 2);
  }
}

async function saveSkuMap() {
  let map = {};
  try {
    map = JSON.parse(skuMapEl?.value || "{}");
  } catch (e) {
    setStatus("JSON 파싱 실패", "bad");
    return;
  }
  const res = await fetch("/api/sku-map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    setStatus("저장 실패", "bad");
    log(json);
    return;
  }
  setStatus("매핑 저장 완료", "ok");
}

function renderUploadHistory(list) {
  if (!historyTableEl) return;
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) {
    historyTableEl.innerHTML = `<div class="empty">히스토리가 없습니다.</div>`;
    return;
  }
  historyTableEl.innerHTML = `
    <div class="history-header">
      <div>시간</div>
      <div>상품명</div>
      <div>결과</div>
      <div>옵션</div>
      <div>가격</div>
      <div>ID</div>
    </div>
    ${items
      .map((it) => {
        const time = it.at ? new Date(it.at).toLocaleString() : "-";
        const title = it.title || "-";
        const ok = it.ok ? "성공" : "실패";
        const mode = it.payloadOnly ? " (payload)" : "";
        const options = Number.isFinite(Number(it.optionsCount)) ? it.optionsCount : "-";
        const price = it.finalPrice ?? "-";
        const id = it.sellerProductId ?? "-";
        const cls = it.ok ? "ok" : "bad";
        return `
          <div class="history-row ${cls}">
            <div class="time">${time}</div>
            <div class="title" title="${title}">${title}</div>
            <div class="status">${ok}${mode}</div>
            <div class="count">${options}</div>
            <div class="price">${price}</div>
            <div class="id">${id}</div>
          </div>
        `;
      })
      .join("")}
  `;
}

async function loadUploadHistory() {
  if (!historyTableEl) return;
  historyTableEl.innerHTML = `<div class="empty">불러오는 중...</div>`;
  try {
    const res = await fetch("/api/upload/history");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      renderUploadHistory([]);
      setStatus("히스토리 불러오기 실패", "bad");
      return;
    }
    renderUploadHistory(json.history || []);
  } catch {
    renderUploadHistory([]);
    setStatus("히스토리 불러오기 실패", "bad");
  }
}

function renderHomeActivity(items) {
  if (!homeActivityListEl) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    homeActivityListEl.innerHTML = `<div class="empty">최근 활동이 없습니다.</div>`;
    return;
  }
  homeActivityListEl.innerHTML = list
    .slice(0, 10)
    .map((it) => {
      const time = it.at ? new Date(it.at).toLocaleString() : "-";
      const tag = it.tag || "-";
      const title = it.title || it.message || "-";
      const meta = it.meta || "";
      return `
        <div class="activity-row">
          <div class="activity-top">
            <span class="activity-tag">${escapeHtml(tag)}</span>
            <span class="activity-time">${escapeHtml(time)}</span>
          </div>
          <div class="activity-title">${escapeHtml(title)}</div>
          ${meta ? `<div class="activity-meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

async function loadPurchaseLogsAndRenderHomePay() {
  // Try server logs first
  let urls = null;
  try {
    const res = await fetch("/api/purchase/logs?limit=20");
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      const logs = Array.isArray(json.logs) ? json.logs : [];
      const map = {};
      for (const it of logs) {
        if (it?.vendor && it?.payUrl) {
          if (!map[it.vendor]) map[it.vendor] = it.payUrl;
        }
      }
      if (Object.keys(map).length) urls = map;
    }
  } catch {}

  // Fallback to localStorage
  if (!urls) {
    try {
      const raw = localStorage.getItem("couplus.lastPayUrls");
      const json = JSON.parse(raw || "{}") || {};
      urls = json.urls || null;
    } catch {
      urls = null;
    }
  }

  renderPayButtonsTo(homePayButtonsEl, urls);
}

async function loadHomeActivity() {
  if (!homeActivityListEl) return;
  homeActivityListEl.innerHTML = `<div class="empty">불러오는 중...</div>`;
  try {
    const [previewRes, purchaseRes] = await Promise.all([
      fetch("/api/upload/preview/history?limit=5").then((r) => r.json().catch(() => ({}))),
      fetch("/api/purchase/logs?limit=5").then((r) => r.json().catch(() => ({}))),
    ]);

    const preview = Array.isArray(previewRes?.history) ? previewRes.history : [];
    const purchases = Array.isArray(purchaseRes?.logs) ? purchaseRes.logs : [];

    const rows = [];
    for (const p of preview) {
      rows.push({
        at: p.at,
        tag: "PREVIEW",
        title: p.title || "미리보기",
        meta: p.finalPrice ? `가격 ${p.finalPrice}` : "",
      });
    }
    for (const l of purchases) {
      const vendorLabel = l.vendor === "domeggook" ? "도매꾹" : l.vendor === "domeme" ? "도매매" : l.vendor || "-";
      const title = l.type === "draft" ? `발주 엑셀 생성 (${vendorLabel})` : `발주 업로드 (${vendorLabel})`;
      const meta = l.ok === false ? `실패: ${l.error || "-"}` : l.payUrl ? "결제 링크 생성" : "";
      rows.push({ at: l.at, tag: "PURCHASE", title, meta });
    }

    rows.sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
    renderHomeActivity(rows);
  } catch {
    renderHomeActivity([]);
  }
}

async function loadOrders() {
  if (!ordersListEl || !ordersListWrap) return;
  try {
    const res = await fetch("/api/orders?limit=50");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      ordersListEl.value = JSON.stringify(json, null, 2);
      ordersListWrap.classList.remove("hidden");
      return;
    }
    ordersListEl.value = JSON.stringify(json.orders || [], null, 2);
    ordersListWrap.classList.remove("hidden");
  } catch (e) {
    ordersListEl.value = String(e?.message || e);
    ordersListWrap.classList.remove("hidden");
  }
}

async function appendPurchaseLog(line) {
  if (!purchaseLogEl) return;
  const prev = purchaseLogEl.value || "";
  purchaseLogEl.value = (prev ? prev + "\n" : "") + String(line || "");
  purchaseLogEl.scrollTop = purchaseLogEl.scrollHeight;
}

async function draftPurchase() {
  try {
    setStatus("발주 엑셀 생성 중...", "");
    if (purchaseLogEl) purchaseLogEl.value = "";
    appendPurchaseLog(`[draft] 요청: ${new Date().toLocaleString()}`);

    const res = await fetch("/api/purchase/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 200 }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      appendPurchaseLog(`[draft] 실패: ${JSON.stringify(json)}`);
      setStatus("발주 엑셀 생성 실패", "bad");
      return;
    }

    const results = json?.draft?.results || [];
    lastPurchaseDrafts = {};
    for (const r of results) {
      if (r?.vendor && r?.filePath) lastPurchaseDrafts[r.vendor] = r.filePath;
    }

    if (lastPurchaseDraftEl) {
      lastPurchaseDraftEl.textContent = results
        .map((r) => `${r.vendor || "-"}: ${r.filePath || "-"}`)
        .join(" | ");
    }

    appendPurchaseLog(`[draft] 완료: ${JSON.stringify(results, null, 2)}`);
    setStatus("발주 엑셀 생성 완료", "ok");
    setTimeout(loadHomeActivity, 600);
    setTimeout(loadPurchaseLogsAndRenderHomePay, 600);
  } catch (e) {
    appendPurchaseLog(`[draft] 에러: ${String(e?.message || e)}`);
    setStatus("발주 엑셀 생성 에러", "bad");
  }
}

function renderPayButtonsTo(targetEl, payUrlsMap) {
  if (!targetEl) return;
  targetEl.innerHTML = "";
  if (!payUrlsMap) return;

  const vendors = [
    { key: "domeggook", label: "도매꾹 결제하러 가기" },
    { key: "domeme", label: "도매매 결제하러 가기" },
  ];

  for (const v of vendors) {
    const url = payUrlsMap[v.key];
    if (!url) continue;

    const goUrl = `/go?u=${encodeURIComponent(url)}`;

    const a = document.createElement("a");
    a.href = goUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = v.label;
    a.className = "pay-link";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ghost";
    copyBtn.textContent = "링크 복사";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        setStatus("링크 복사됨", "ok");
      } catch {
        setStatus("복사 실패(브라우저 권한)", "bad");
      }
    });

    const wrap = document.createElement("div");
    wrap.className = "pay-row";
    wrap.appendChild(a);
    wrap.appendChild(copyBtn);

    targetEl.appendChild(wrap);
  }
}

function renderPayButtons(payUrlsMap) {
  renderPayButtonsTo(purchasePayActionsEl, payUrlsMap);
  renderPayButtonsTo(homePayButtonsEl, payUrlsMap);
}

async function uploadPurchase() {
  try {
    setStatus("발주 업로드 중...", "");
    appendPurchaseLog(`[upload] 요청: ${new Date().toLocaleString()}`);
    lastPayUrls = null;
    renderPayButtons(null);

    const res = await fetch("/api/purchase/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendors: ["domeme", "domeggook"], filePaths: lastPurchaseDrafts || {} }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      appendPurchaseLog(`[upload] 실패: ${JSON.stringify(json)}`);
      setStatus("발주 업로드 실패", "bad");
      return;
    }

    const results = json.results || [];
    appendPurchaseLog(`[upload] 결과: ${JSON.stringify(results, null, 2)}`);

    lastPayUrls = {};
    for (const r of results) {
      if (r && r.ok && r.vendor && r.payUrl) lastPayUrls[r.vendor] = r.payUrl;
    }

    if (Object.keys(lastPayUrls).length) {
      appendPurchaseLog(`[upload] 결제하러 가기 링크 생성됨`);
      renderPayButtons(lastPayUrls);
      try {
        localStorage.setItem("couplus.lastPayUrls", JSON.stringify({ at: Date.now(), urls: lastPayUrls }));
      } catch {}

      // Try to auto-open payment pages (may be blocked by popup blocker)
      try {
        const first = lastPayUrls.domeggook || lastPayUrls.domeme;
        if (first) window.open(`/go?u=${encodeURIComponent(first)}`, "_blank");
      } catch {}
    }

    setStatus("발주 업로드 완료", "ok");
    setTimeout(loadHomeActivity, 600);
    setTimeout(loadPurchaseLogsAndRenderHomePay, 600);
  } catch (e) {
    appendPurchaseLog(`[upload] 에러: ${String(e?.message || e)}`);
    setStatus("발주 업로드 에러", "bad");
  }
}

async function seedDummyOrders() {
  try {
    const res = await fetch("/api/dev/orders/seed?dev=1", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      log(json);
      setStatus("더미 주문 생성 실패", "bad");
      return;
    }
    setStatus("더미 주문 생성 완료", "ok");
    await loadOrders();
  } catch (e) {
    setStatus("더미 주문 생성 에러", "bad");
    log(String(e?.message || e));
  }
}

submitBtn?.addEventListener("click", run);
previewBtn?.addEventListener("click", previewUpload);
uploadConfirmCancelBtn?.addEventListener("click", closeUploadConfirmModal);
uploadConfirmModal?.addEventListener("click", (e) => {
  if (e.target === uploadConfirmModal) closeUploadConfirmModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeUploadConfirmModal();
});
uploadConfirmProceedBtn?.addEventListener("click", async () => {
  const url = uploadConfirmProceedBtn.dataset.url || "";
  const force = uploadConfirmProceedBtn.dataset.force === "1";
  closeUploadConfirmModal();
  if (!url) return;
  await executeUpload(url, force);
});
urlInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});
exportOrdersBtn.addEventListener("click", exportOrders);
uploadOrdersBtn.addEventListener("click", uploadOrders);
loadMissingBtn.addEventListener("click", loadMissingSku);
loadSkuMapBtn.addEventListener("click", loadSkuMap);
saveSkuMapBtn.addEventListener("click", saveSkuMap);

tabs.forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("saveSettings").addEventListener("click", saveSettings);

initSensitiveFields();

// Bottom navigation (Home / Work / More)
function switchView(name, { replace = false } = {}) {
  const views = {
    home: $("view-home"),
    work: $("view-work"),
    more: $("view-more"),
  };
  const next = views[name] ? name : "home";

  for (const [k, el] of Object.entries(views)) {
    if (!el) continue;
    if (k === next) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === next);
  });

  try {
    const url = `#${next}`;
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  } catch {}

  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 0);
  }
}

document.querySelectorAll(".nav-item").forEach((b) => {
  b.addEventListener("click", () => switchView(b.dataset.view));
});

// Initial route from hash (#home/#work/#more)
try {
  const initial = (location.hash || "").replace("#", "").trim();
  if (initial) switchView(initial, { replace: true });
  window.addEventListener("popstate", () => {
    const cur = (location.hash || "").replace("#", "").trim();
    switchView(cur || "home", { replace: true });
  });
} catch {}
$("signup").addEventListener("click", signup);
$("login").addEventListener("click", login);
$("logout").addEventListener("click", logout);
refreshIpBtn?.addEventListener("click", loadCurrentIp);
refreshIpBtn?.addEventListener("click", evaluateUploadGate);
refreshHistoryBtn?.addEventListener("click", loadUploadHistory);
settingsEls.allowedIps?.addEventListener("input", evaluateUploadGate);
recoAutoRunNowHomeBtn?.addEventListener("click", runRecoAutoRunNow);
recoAutoRunNowSettingsBtn?.addEventListener("click", runRecoAutoRunNow);
recoAutoRunRefreshHomeBtn?.addEventListener("click", loadRecoAutoRunStatus);
recoAutoRunRefreshSettingsBtn?.addEventListener("click", loadRecoAutoRunStatus);

// Dev-only UI: seed dummy orders when URL has ?dev=1
try {
  const dev = new URLSearchParams(location.search).get("dev") === "1";
  if (dev && devOrdersRow) devOrdersRow.classList.remove("hidden");
  if (dev && ordersListWrap) ordersListWrap.classList.remove("hidden");
} catch {}
seedOrdersBtn?.addEventListener("click", seedDummyOrders);
refreshOrdersBtn?.addEventListener("click", loadOrders);
draftPurchaseBtn?.addEventListener("click", draftPurchase);
uploadPurchaseBtn?.addEventListener("click", uploadPurchase);

// Home dashboard quick actions
homeDraftPurchaseBtn?.addEventListener("click", draftPurchase);
homeUploadPurchaseBtn?.addEventListener("click", uploadPurchase);
homeRefreshActivityBtn?.addEventListener("click", loadHomeActivity);
homeRefreshActivityBtn?.addEventListener("click", loadPurchaseLogsAndRenderHomePay);

homeCreateDomeggookSessionBtn?.addEventListener("click", () => domeggookSessionBtn?.click());
homeSaveDomeggookSessionBtn?.addEventListener("click", () => domeggookSessionSaveBtn?.click());
homeCreateDomemeSessionBtn?.addEventListener("click", () => domemeSessionBtn?.click());
homeSaveDomemeSessionBtn?.addEventListener("click", () => domemeSessionSaveBtn?.click());

domeggookSessionBtn?.addEventListener("click", async () => {
  setStatus("도매꾹 세션 생성 중...", "");
  try {
    const res = await fetch("/api/domeggook/session/start", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("실패", "bad");
      log(json);
      return;
    }
    setStatus("브라우저에서 네이버 로그인 후 ‘지금 저장’ 누르면 됩니다", "ok");
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
  } finally {
    setTimeout(refreshDomeggookSessionStatus, 1500);
  }
});

domeggookSessionSaveBtn?.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/domeggook/session/save", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("세션 저장 실패", "bad");
      log(json);
      return;
    }
    setStatus("세션 저장 요청 완료(잠시 후 배지 갱신)", "ok");
  } catch (e) {
    setStatus("세션 저장 에러", "bad");
    log(String(e?.message || e));
  } finally {
    setTimeout(refreshDomeggookSessionStatus, 1500);
  }
});

domemeSessionBtn?.addEventListener("click", async () => {
  setStatus("도매매 세션 생성 중...", "");
  try {
    const res = await fetch("/api/domeme/session/start", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("실패", "bad");
      log(json);
      return;
    }
    setStatus("브라우저에서 네이버 로그인 후 ‘지금 저장’ 누르면 됩니다", "ok");
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
  } finally {
    setTimeout(refreshDomemeSessionStatus, 1500);
  }
});

domemeSessionSaveBtn?.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/domeme/session/save", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      setStatus("세션 저장 실패", "bad");
      log(json);
      return;
    }
    setStatus("세션 저장 요청 완료(잠시 후 배지 갱신)", "ok");
  } catch (e) {
    setStatus("세션 저장 에러", "bad");
    log(String(e?.message || e));
  } finally {
    setTimeout(refreshDomemeSessionStatus, 1500);
  }
});

(async () => {
  const authed = await updateAuthStatus();
  if (authed) {
    await loadSettings();
    startRecoAutoRunStatusPolling();
  } else {
    clearSettingsUI();
    renderRecoAutoRunStatusCard({ ok: false, unauthorized: true });
  }
  await loadVersionInfo();
  await loadCurrentIp();
  await refreshDomeggookSessionStatus();
  await refreshDomemeSessionStatus();
  evaluateUploadGate();
  await loadHomeActivity();
  await loadPurchaseLogsAndRenderHomePay();

  // recommendations
  await loadRecoCategoryPresets();
  recoCategoryPresetEl?.addEventListener("change", () => {
    const key = getSelectedRecoCategoryKey();
    saveRecoCategoryKey(key);
    applyRecoCategoryPresetToKeywords({ forceOverwrite: false });
  });
  recoCategoryApplyBtn?.addEventListener("click", () => {
    const changed = applyRecoCategoryPresetToKeywords({ forceOverwrite: true });
    if (!changed) {
      setStatus("적용할 카테고리 키워드가 없습니다. (전체는 기본 키워드셋 사용)", "");
    }
  });
  recoFillBtn?.addEventListener("click", fillRecommendations);
  recoRefreshBtn?.addEventListener("click", refreshRecommendationsReplacing);
  recoAutoUploadBtn?.addEventListener("click", autoUploadRecommendations);
  recoSelectAllBtn?.addEventListener("click", () => toggleRecoSelectionAll(true));
  recoClearSelectionBtn?.addEventListener("click", () => toggleRecoSelectionAll(false));
  recoUploadSelectedBtn?.addEventListener("click", uploadSelectedRecommendations);
  applyRecoCategoryPresetToKeywords({ forceOverwrite: false });
  updateRecoSelectionUi();
  await loadRecommendations();
})();
