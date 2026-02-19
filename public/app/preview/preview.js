function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatWon(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("ko-KR") + "원";
}

function chip(text) {
  return `<span class="chip">${escapeHtml(text)}</span>`;
}

function safeText(v) {
  const s = String(v ?? "").trim();
  return s ? s : "-";
}

function parseKeywords(raw) {
  const s = String(raw || "");
  const parts = s
    .split(/[,\n]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

const els = {
  authStatus: $("authStatus"),
  authBody: $("authBody"),
  keywords: $("keywords"),
  btnFill: $("btnFill"),
  btnRefresh: $("btnRefresh"),
  recoList: $("recoList"),
  url: $("url"),
  btnPreview: $("btnPreview"),
  btnUpload: $("btnUpload"),
  forceUpload: $("forceUpload"),
  previewSub: $("previewSub"),
  previewCard: $("previewCard"),
  previewKv: $("previewKv"),
  rawWrap: $("rawWrap"),
  log: $("log"),
  btnCopyLog: $("btnCopyLog"),
};

function log(x) {
  if (!els.log) return;
  if (!x) {
    els.log.textContent = "";
    return;
  }
  try {
    els.log.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2);
  } catch {
    els.log.textContent = String(x);
  }
}

async function copyLogText() {
  const text = String(els.log?.textContent || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (els.previewSub) els.previewSub.textContent = '로그 복사됨';
  } catch {
    // fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (els.previewSub) els.previewSub.textContent = '로그 복사됨';
    } catch {
      if (els.previewSub) els.previewSub.textContent = '로그 복사 실패';
    }
  }
}

function renderRecoList(items) {
  const list = Array.isArray(items) ? items : [];
  if (!els.recoList) return;
  if (!list.length) {
    els.recoList.innerHTML = `<div class="hint">후보가 없어요. ‘후보 채우기’를 눌러주세요.</div>`;
    return;
  }

  els.recoList.innerHTML = list
    .map((it) => {
      const title = it.title || "(제목 없음)";
      const keyword = it.keyword || "";
      const img = it.mainImageUrl || "";
      const finalPrice = formatWon(it.finalPrice);
      const profit = formatWon(it.profit);
      const margin = Number(it.marginRate);
      const marginText = Number.isFinite(margin) ? `${Math.round(margin * 100)}%` : "-";
      const qc = it.qc || {};
      const tier = qc.tier || "-";
      const detailCount = Number(qc.detailImageCount);
      const detailText = Number.isFinite(detailCount) ? `${detailCount}장` : "-";
      const sourceUrl = it.sourceUrl || "";

      return `
        <div style="display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--line,#eee);">
          <div style="width:72px; flex:0 0 72px;">
            ${img ? `<img src="${img}" alt="thumb" style="width:72px; height:72px; object-fit:cover; border-radius:10px;" loading="lazy"/>` : `<div style="width:72px; height:72px; border-radius:10px; background:#f2f2f2;"></div>`}
          </div>
          <div style="flex:1 1 auto; min-width:0;">
            <div style="font-weight:700; line-height:1.25;">${escapeHtml(title)}</div>
            <div class="hint" style="margin-top:4px; display:flex; flex-wrap:wrap; gap:8px;">
              ${keyword ? `<span class="chip">키워드: ${escapeHtml(keyword)}</span>` : ""}
              <span class="chip">등급: ${escapeHtml(String(tier))}</span>
              <span class="chip">상세이미지: ${escapeHtml(detailText)}</span>
              <span class="chip">예상가: ${escapeHtml(finalPrice)}</span>
              <span class="chip">예상이익: ${escapeHtml(profit)}</span>
              <span class="chip">마진: ${escapeHtml(marginText)}</span>
            </div>
            <div class="btn-row" style="margin-top:8px;">
              <button type="button" class="ghost" data-action="preview" data-url="${escapeHtml(sourceUrl)}">미리보기</button>
              <a class="btn-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">원문 열기</a>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  els.recoList.querySelectorAll('[data-action="preview"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url") || "";
      if (!url) return;
      if (els.url) els.url.value = url;
      await previewUpload();
      els.previewCard?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

async function loadRecommendations() {
  try {
    const res = await fetch("/api/recommendations?limit=40");
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

async function fillRecommendations() {
  if (els.btnFill) els.btnFill.disabled = true;
  log("");
  try {
    const authed = await checkAuth();
    if (!authed) {
      log({ ok: false, error: "not_logged_in" });
      return;
    }

    const keywords = parseKeywords(els.keywords?.value);
    const body = { targetCount: 20 };
    if (keywords.length) body.keywords = keywords;

    log({ sending: body });

    const res = await fetch("/api/recommendations/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      log(json);
      return;
    }

    const jobId = json.job?.id;
    if (els.previewSub) els.previewSub.textContent = "후보 생성 중…";
    log({ ok: true, requested: body, jobId: jobId || null });

    // If we have a job id, poll its progress.
    if (jobId) {
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        const jr = await fetch(`/api/jobs/${jobId}`);
        const jj = await jr.json().catch(() => ({}));
        if (jr.ok && jj.ok && jj.job) {
          const st = jj.job.status;
          // server returns `job.result` (not resultJson)
          const prog = jj.job.result?.progress || null;
          if (els.previewSub) {
            const msg = prog?.stage
              ? `${prog.stage} · candidates=${prog.candidates ?? "-"} · validated=${prog.validated ?? "-"} · kept=${prog.kept ?? "-"}`
              : st;
            els.previewSub.textContent = `후보 생성: ${msg}`;
          }
          log({ job: { status: st, progress: prog } });
          if (st === "success" || st === "failed") break;
        }
        // also refresh list while polling
        await loadRecommendations();
      }
    } else {
      // fallback: just poll list
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setTimeout(r, 1800));
        await loadRecommendations();
      }
    }

    await loadRecommendations();
    if (els.previewSub) els.previewSub.textContent = "후보 생성 완료";
  } finally {
    if (els.btnFill) els.btnFill.disabled = false;
  }
}

let lastPreviewUrl = "";

async function executeUpload() {
  const url = (els.url?.value?.trim?.() || lastPreviewUrl || "").trim();
  if (!url) return;
  if (els.btnUpload) els.btnUpload.disabled = true;
  if (els.previewSub) els.previewSub.textContent = "업로드 중...";
  log("");

  try {
    const force = Boolean(els.forceUpload?.checked);
    const res = await fetch("/api/upload/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, force: force ? "1" : "0" }),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.ok) {
      // Duplicate -> show link + allow force.
      if (json?.error === "duplicate_product" && json?.existing) {
        const ex = json.existing;
        const productUrl = ex.productUrl || "";
        if (els.previewSub) els.previewSub.textContent = "중복 상품(이미 업로드됨)";
        log(json);
        if (productUrl) {
          els.previewKv.insertAdjacentHTML(
            "afterbegin",
            `<div class="btn-row" style="margin-top:10px;"><a class="btn-link" href="${escapeHtml(productUrl)}" target="_blank" rel="noreferrer">쿠팡 기존 상품 열기</a></div>`,
          );
        }
        return;
      }

      if (json?.error === "missing_coupang_keys") {
        if (els.previewSub) els.previewSub.textContent = "쿠팡 키가 필요합니다(설정 탭)";
        log(json);
        return;
      }

      if (els.previewSub) els.previewSub.textContent = "업로드 실패";
      log(json);
      return;
    }

    const result = json.result || {};
    const sellerProductId = result?.create?.sellerProductId || "";
    const productUrl = sellerProductId
      ? `https://www.coupang.com/vp/products/${encodeURIComponent(String(sellerProductId))}`
      : "";

    if (els.previewSub) els.previewSub.textContent = "업로드 완료";
    log({ ok: true, sellerProductId, result });

    if (productUrl) {
      els.previewKv.insertAdjacentHTML(
        "afterbegin",
        `<div class="btn-row" style="margin-bottom:10px;"><a class="btn-link" href="${escapeHtml(productUrl)}" target="_blank" rel="noreferrer">쿠팡 상품 열기</a></div>`,
      );
    }
  } finally {
    if (els.btnUpload) els.btnUpload.disabled = false;
  }
}

async function previewUpload() {
  const url = els.url?.value?.trim?.() || "";
  if (!url) return;
  lastPreviewUrl = url;
  if (els.btnPreview) els.btnPreview.disabled = true;
  if (els.previewSub) els.previewSub.textContent = "미리보기 생성 중...";
  log("");

  try {
    const res = await fetch("/api/upload/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      if (els.previewSub) els.previewSub.textContent = "미리보기 실패";
      log(json);
      els.previewCard?.classList.add("hidden");
      return;
    }

    const p = json.preview || {};

    const draft = p.draft || {};
    const computed = p.computed || {};
    const category = p.category || {};

    const title = safeText(draft.title);
    const sourceUrl = safeText(draft.sourceUrl || p.url);

    const sourcePrice = formatWon(draft.price);
    const finalPrice = formatWon(computed.finalPrice ?? p.finalPrice);
    const shippingFee = draft.shippingFee == null ? "-" : formatWon(draft.shippingFee);
    const shippingPolicy = safeText(computed.shippingPolicy);
    const shippingSurcharge = computed.shippingSurchargeApplied ? formatWon(computed.shippingSurcharge) : "0원";

    const images = Array.isArray(computed.images) ? computed.images : [];
    const opts = Array.isArray(p.options) ? p.options : [];

    const usedCat = category?.usedCode;
    const pred = category?.predicted || null;

    const titleSuggestions = Array.isArray(p.titleSuggestions) ? p.titleSuggestions : [];

    const imageGrid = images.length
      ? `
        <div style="margin-top:10px; display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:8px;">
          ${images
            .slice(0, 12)
            .map(
              (u) => `
              <a href="${escapeHtml(u)}" target="_blank" rel="noreferrer" style="display:block;">
                <img src="${escapeHtml(u)}" alt="img" loading="lazy" style="width:100%; height:76px; object-fit:contain; background:#f6f6f6; border-radius:10px;" />
              </a>
            `,
            )
            .join("")}
        </div>
        <div class="hint" style="margin-top:6px;">이미지 ${images.length}개 (최대 12개만 미리 표시). 클릭하면 원본을 새 탭에서 열어요.</div>
      `
      : `<div class="hint" style="margin-top:8px;">이미지를 찾지 못했어요.</div>`;

    const optionList = opts.length
      ? `
        <div style="margin-top:10px;">
          <div class="mini-title" style="margin-bottom:6px;">옵션(${opts.length})</div>
          <div style="display:flex; flex-direction:column; gap:6px;">
            ${opts
              .slice(0, 20)
              .map((o) => {
                const name = safeText(o?.name);
                const values = Array.isArray(o?.values) ? o.values : [];
                const vSample = values.slice(0, 6).map((x) => String(x || "").trim()).filter(Boolean);
                const more = values.length > vSample.length ? ` 외 ${values.length - vSample.length}개` : "";
                return `
                  <div class="kv-row">
                    <span class="k">${escapeHtml(name)}</span>
                    <span class="v">${escapeHtml(vSample.join(", ") + more || "-")}</span>
                  </div>
                `;
              })
              .join("")}
          </div>
          ${opts.length > 20 ? `<div class="hint" style="margin-top:6px;">옵션이 많아 상위 20개만 표시했어요.</div>` : ""}
        </div>
      `
      : `<div class="hint" style="margin-top:8px;">옵션 없음</div>`;

    const suggestChips = titleSuggestions.length
      ? `<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:8px;">${titleSuggestions
          .slice(0, 10)
          .map((t) => chip(`제목 후보: ${t}`))
          .join("")}</div>`
      : "";

    if (els.previewKv) {
      els.previewKv.innerHTML = `
        <div class="kv-row"><span class="k">상품명</span><span class="v">${escapeHtml(title)}</span></div>
        <div class="kv-row"><span class="k">원가(소스)</span><span class="v">${escapeHtml(sourcePrice)}</span></div>
        <div class="kv-row"><span class="k">판매가(계산)</span><span class="v">${escapeHtml(finalPrice)}</span></div>
        <div class="kv-row"><span class="k">배송비(소스)</span><span class="v">${escapeHtml(shippingFee)}</span></div>
        <div class="kv-row"><span class="k">배송 정책</span><span class="v">${escapeHtml(shippingPolicy)} (추가분: ${escapeHtml(shippingSurcharge)})</span></div>
        <div class="kv-row"><span class="k">카테고리</span><span class="v">used=${escapeHtml(String(usedCat ?? "-"))}${pred?.id ? ` · predicted=${escapeHtml(String(pred.id))}(${escapeHtml(String(pred.name || ""))})` : ""}</span></div>
        <div class="kv-row"><span class="k">소스 URL</span><span class="v"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">열기</a></span></div>
        ${imageGrid}
        ${suggestChips}
        ${optionList}
      `;
    }

    els.previewCard?.classList.remove("hidden");
    if (els.previewSub) els.previewSub.textContent = "미리보기 완료";

    // Raw JSON is tucked under details by default
    if (els.rawWrap) els.rawWrap.open = false;
    log(p);
  } catch (e) {
    if (els.previewSub) els.previewSub.textContent = "미리보기 에러";
    log(String(e?.message || e));
  } finally {
    if (els.btnPreview) els.btnPreview.disabled = false;
  }
}

async function checkAuth() {
  try {
    const res = await fetch("/api/me");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      if (els.authStatus) els.authStatus.textContent = "로그인 필요";
      if (els.authBody) els.authBody.style.display = "block";
      return false;
    }
    if (els.authStatus) els.authStatus.textContent = `로그인됨: ${json.user?.email || ""}`;
    if (els.authBody) els.authBody.style.display = "none";
    return true;
  } catch {
    if (els.authStatus) els.authStatus.textContent = "세션 확인 실패(네트워크)";
    if (els.authBody) els.authBody.style.display = "block";
    return false;
  }
}

els.btnFill?.addEventListener("click", fillRecommendations);
els.btnRefresh?.addEventListener("click", loadRecommendations);
els.btnPreview?.addEventListener("click", previewUpload);
els.btnUpload?.addEventListener("click", executeUpload);
els.btnCopyLog?.addEventListener("click", copyLogText);

(async () => {
  const ok = await checkAuth();
  if (ok) await loadRecommendations();
})();
