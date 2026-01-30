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

function setStatus(text, state) {
  statusEl.textContent = text;
  dot.classList.remove("ok", "bad");
  if (state === "ok") dot.classList.add("ok");
  if (state === "bad") dot.classList.add("bad");
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

  const created = result?.create?.sellerProductId || "-";
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
      const body = JSON.parse(result?.create?.body || "{}");
      if (body?.code === "SUCCESS") return "성공";
      if (body?.message) return `실패: ${body.message}`;
    } catch {}
    return result?.create?.status ? `HTTP ${result.create.status}` : "알 수 없음";
  })();

  const ipBlocked = (() => {
    try {
      const body = JSON.parse(result?.create?.body || "{}");
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
    </div>
    ${ipBlocked ? `<div class="warn">IP 허용 필요: ${ipBlocked}</div>` : ""}
  `;
}

function switchTab(name) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  Object.values(panels).forEach((p) => p.classList.add("hidden"));
  panels[name].classList.remove("hidden");
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    Object.values(settingsEls).forEach((el) => {
      el.value = "";
    });
    return;
  }
  const s = json.settings || {};
  settingsEls.coupangAccessKey.value = s.coupangAccessKey || "";
  settingsEls.coupangSecretKey.value = s.coupangSecretKey || "";
  settingsEls.coupangVendorId.value = s.coupangVendorId || "";
  settingsEls.coupangVendorUserId.value = s.coupangVendorUserId || "";
  settingsEls.coupangDeliveryCompanyCode.value = s.coupangDeliveryCompanyCode || "";
  settingsEls.imageProxyBase.value = s.imageProxyBase || "";
  settingsEls.marginRate.value = s.marginRate ?? "";
  settingsEls.marginAdd.value = s.marginAdd ?? "";
  settingsEls.priceMin.value = s.priceMin ?? "";
  settingsEls.roundUnit.value = s.roundUnit ?? "";
  settingsEls.autoRequest.checked = String(s.autoRequest || "") === "1";
}

async function saveSettings() {
  const payload = {
    coupangAccessKey: settingsEls.coupangAccessKey.value.trim(),
    coupangSecretKey: settingsEls.coupangSecretKey.value.trim(),
    coupangVendorId: settingsEls.coupangVendorId.value.trim(),
    coupangVendorUserId: settingsEls.coupangVendorUserId.value.trim(),
    coupangDeliveryCompanyCode: settingsEls.coupangDeliveryCompanyCode.value.trim(),
    imageProxyBase: settingsEls.imageProxyBase.value.trim(),
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
    return;
  }
  const json = await res.json();
  const label = json?.user?.email || json?.user?.id || "알 수 없음";
  authEls.status.textContent = `로그인됨: ${label}`;
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

updateAuthStatus();
loadSettings();
