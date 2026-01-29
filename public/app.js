const $ = (id) => document.getElementById(id);

const urlInput = $("url");
const submitBtn = $("submit");
const statusEl = $("status");
const logEl = $("log");
const dot = $("dot");
const summaryEl = $("summary");

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

  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `
    <div class="title">업로드 결과</div>
    <div class="row">
      <div class="label">상품명</div><div>${result?.draft?.title || "-"}</div>
      <div class="label">가격</div><div>${result?.finalPrice ?? "-"}</div>
      <div class="label">카테고리</div><div>${result?.category?.used ?? "-"}</div>
      <div class="label">상품 ID</div><div>${created}</div>
      <div class="label">승인 요청</div><div>${approvalMsg}</div>
    </div>
  `;
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
      setStatus("완료", "ok");
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
