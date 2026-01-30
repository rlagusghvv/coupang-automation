const $ = (id) => document.getElementById(id);

const urlInput = $("url");
const submitBtn = $("submit");
const statusEl = $("status");
const logEl = $("log");
const dot = $("dot");
const summaryEl = $("summary");
const tabs = document.querySelectorAll(".tab");
const panels = {
  upload: $("panel-upload"),
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
  pagesProjectName: $("pagesProjectName"),
  pagesAccountId: $("pagesAccountId"),
  pagesApiToken: $("pagesApiToken"),
  pagesAutoDeploy: $("pagesAutoDeploy"),
  marginRate: $("marginRate"),
  marginAdd: $("marginAdd"),
  priceMin: $("priceMin"),
  roundUnit: $("roundUnit"),
  autoRequest: $("autoRequest"),
};

const authEls = {
  email: $("email"),
  password: $("password"),
  status: $("authStatus"),
};
const versionEl = $("versionInfo");
const currentIpEl = $("currentIp");
const refreshIpBtn = $("refreshIp");

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
  submitBtn.disabled = !enabled;
  if (!enabled && reason) {
    setStatus(reason, "bad");
  }
}

function log(obj) {
  logEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function renderSummary(result) {
  if (!result) {
    summaryEl.classList.add("hidden");
    summaryEl.innerHTML = "";
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
    </div>
    ${ipBlocked ? `<div class="warn">IP 허용 필요: ${ipBlocked}</div>` : ""}
    ${
      followUp?.approved && followUp?.productUrl
        ? `<div class="row"><div class="label">상품 페이지</div><div><a id="productLink" href="${followUp.productUrl}" target="_blank" rel="noreferrer">바로 열기</a></div></div>`
        : ""
    }
  `;

  if (followUp?.approved && followUp?.productUrl) {
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
}

function clearSettingsUI() {
  Object.values(settingsEls).forEach((el) => {
    if (el.type === "checkbox") el.checked = false;
    else el.value = "";
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
  settingsEls.pagesProjectName.value = s.pagesProjectName || "";
  settingsEls.pagesAccountId.value = s.pagesAccountId || "";
  settingsEls.pagesApiToken.value = s.pagesApiToken || "";
  settingsEls.pagesAutoDeploy.checked = String(s.pagesAutoDeploy || "") === "1";
  settingsEls.marginRate.value = s.marginRate ?? "";
  settingsEls.marginAdd.value = s.marginAdd ?? "";
  settingsEls.priceMin.value = s.priceMin ?? "";
  settingsEls.roundUnit.value = s.roundUnit ?? "";
  settingsEls.autoRequest.checked = String(s.autoRequest || "") === "1";

  // Re-evaluate upload availability after settings load
  await loadCurrentIp();
  evaluateUploadGate();
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
    pagesProjectName: settingsEls.pagesProjectName.value.trim(),
    pagesAccountId: settingsEls.pagesAccountId.value.trim(),
    pagesApiToken: settingsEls.pagesApiToken.value.trim(),
    pagesAutoDeploy: settingsEls.pagesAutoDeploy.checked ? "1" : "",
    marginRate: Number(settingsEls.marginRate.value || 0),
    marginAdd: Number(settingsEls.marginAdd.value || 0),
    priceMin: Number(settingsEls.priceMin.value || 0),
    roundUnit: Number(settingsEls.roundUnit.value || 0),
    autoRequest: settingsEls.autoRequest.checked ? "1" : "",
  };
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.ok) {
    setStatus("설정 저장 완료", "ok");
  } else {
    setStatus("설정 저장 실패", "bad");
  }
}

async function updateAuthStatus() {
  const res = await fetch("/api/me");
  if (!res.ok) {
    authEls.status.textContent = "로그인 필요";
    return false;
  }
  const json = await res.json();
  const label = json?.user?.email || json?.user?.id || "알 수 없음";
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
  } else {
    setStatus("로그인 실패", "bad");
    log(json);
  }
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  authEls.status.textContent = "로그인 필요";
  Object.values(settingsEls).forEach((el) => {
    el.value = "";
  });
}

async function run() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("URL을 입력하세요", "bad");
    return;
  }

  submitBtn.disabled = true;
  setStatus("업로드 중...", "");
  log("");
  renderSummary(null);

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      setStatus("실패", "bad");
      log(json);
      renderSummary(null);
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
    }
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
    renderSummary(null);
  } finally {
    submitBtn.disabled = false;
  }
}

submitBtn.addEventListener("click", run);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

tabs.forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("saveSettings").addEventListener("click", saveSettings);
$("signup").addEventListener("click", signup);
$("login").addEventListener("click", login);
$("logout").addEventListener("click", logout);
refreshIpBtn?.addEventListener("click", loadCurrentIp);
refreshIpBtn?.addEventListener("click", evaluateUploadGate);
settingsEls.allowedIps?.addEventListener("input", evaluateUploadGate);

(async () => {
  const authed = await updateAuthStatus();
  if (authed) await loadSettings();
  else clearSettingsUI();
  await loadVersionInfo();
  await loadCurrentIp();
  evaluateUploadGate();
})();
