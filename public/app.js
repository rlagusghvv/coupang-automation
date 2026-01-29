const $ = (id) => document.getElementById(id);

const urlInput = $("url");
const submitBtn = $("submit");
const statusEl = $("status");
const logEl = $("log");
const dot = $("dot");

function setStatus(text, state) {
  statusEl.textContent = text;
  dot.classList.remove("ok", "bad");
  if (state === "ok") dot.classList.add("ok");
  if (state === "bad") dot.classList.add("bad");
}

function log(obj) {
  logEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
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
    } else {
      setStatus("완료", "ok");
      log(json.result);
    }
  } catch (e) {
    setStatus("에러", "bad");
    log(String(e?.message || e));
  } finally {
    submitBtn.disabled = false;
  }
}

submitBtn.addEventListener("click", run);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});
