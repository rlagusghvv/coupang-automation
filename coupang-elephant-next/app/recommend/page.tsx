"use client";

import { useEffect, useMemo, useState } from "react";
import Shell from "../ui/Shell";

type RecoItem = {
  id?: string;
  sourceUrl: string;
  title: string;
  finalPrice?: number;
  profit?: number;
  marginRate?: number;
  reason?: string;
  keyword?: string;
  score?: number;
};

async function apiJson(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    credentials: "include",
  });
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(text) };
  } catch {
    return { ok: r.ok, status: r.status, json: { ok: false, raw: text } };
  }
}

export default function RecommendPage() {
  const [items, setItems] = useState<RecoItem[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [statusText, setStatusText] = useState<string>("-");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string>("");
  const [continueOnError, setContinueOnError] = useState(true);

  const selectedUrls = useMemo(
    () => items.map((x) => x.sourceUrl).filter((u) => selected[u]),
    [items, selected],
  );

  const refresh = async () => {
    const [a, b] = await Promise.all([
      apiJson("/api/recommendations?limit=60"),
      apiJson("/api/recommendations/status"),
    ]);

    const unauthorized = a.status === 401 || b.status === 401;
    setNeedsLogin(unauthorized);
    if (unauthorized) {
      setStatusText("로그인 필요");
      return;
    }

    if (a.ok && a.json?.ok) {
      setItems(Array.isArray(a.json.items) ? a.json.items : []);
    }
    if (b.ok && b.json?.ok) {
      const c = b.json.count;
      const p = b.json.progress;
      const msg = [
        typeof c === "number" ? `캐시 ${c}개` : null,
        p?.stage ? `stage=${p.stage}` : null,
        p?.keyword ? `kw=${p.keyword}` : null,
        typeof p?.kept === "number" ? `kept=${p.kept}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setStatusText(msg || "-");
    }
  };

  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fill = async (reset: boolean) => {
    setBusy(true);
    try {
      const r = await apiJson("/api/recommendations/fill", {
        method: "POST",
        body: JSON.stringify({ targetCount: 30, reset }),
      });
      if (!r.ok) {
        setLog((s) => `${s}\nfill failed: ${r.status}`);
      } else {
        setLog((s) => `${s}\nfill started`);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const batchEnqueue = async () => {
    const urls = selectedUrls;
    if (urls.length === 0) {
      setLog((s) => `${s}\n선택된 추천 상품이 없습니다.`);
      return;
    }

    setBusy(true);
    setLog((s) => `${s}\n배치 업로드 시작: ${urls.length}개 (직렬)`);

    try {
      let okCount = 0;
      let failCount = 0;

      for (let i = 0; i < urls.length; i += 1) {
        const url = urls[i];
        setLog((s) => `${s}\n[${i + 1}/${urls.length}] enqueue: ${url}`);

        const r = await apiJson("/api/upload-queue/enqueue", {
          method: "POST",
          body: JSON.stringify({ url, force: "0" }),
        });

        if (r.ok && r.json?.ok) {
          okCount += 1;
          setLog((s) => `${s}\n  ✅ queued`);
        } else {
          failCount += 1;
          setLog((s) => `${s}\n  ❌ failed (${r.status})`);
          if (!continueOnError) break;
        }

        // light spacing to avoid bursts
        await new Promise((res) => setTimeout(res, 250));
      }

      setLog((s) => `${s}\n배치 enqueue 완료: ok=${okCount}, fail=${failCount}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="추천" subtitle={statusText}>
      {needsLogin ? (
        <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="text-lg font-extrabold">로그인이 필요합니다</div>
          <p className="mt-2 text-sm text-neutral-600">
            기존 기능(세션/설정/추천 캐시)은 레거시 서버(콘솔)에서 로그인 후 사용할 수 있어요.
          </p>
          <div className="mt-4 flex gap-2">
            <a
              className="inline-flex items-center justify-center rounded-full bg-neutral-900 px-5 py-2 text-sm font-bold text-white hover:bg-neutral-800"
              href="/console"
            >
              콘솔 열고 로그인
            </a>
            <button
              className="rounded-full px-5 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5"
              onClick={refresh}
            >
              다시 시도
            </button>
          </div>
        </section>
      ) : (
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <section className="md:col-span-2 rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-bold text-white hover:bg-neutral-800 disabled:opacity-60"
              onClick={() => fill(false)}
              disabled={busy}
            >
              추천 채우기
            </button>
            <button
              className="rounded-full px-4 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5 disabled:opacity-60"
              onClick={() => fill(true)}
              disabled={busy}
            >
              초기화 후 채우기
            </button>
            <button
              className="rounded-full px-4 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5 disabled:opacity-60"
              onClick={refresh}
              disabled={busy}
            >
              새로고침
            </button>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs font-semibold text-neutral-600">
                <input
                  type="checkbox"
                  checked={continueOnError}
                  onChange={(e) => setContinueOnError(e.target.checked)}
                />
                실패해도 계속
              </label>
              <button
                className="rounded-full bg-gradient-to-r from-fuchsia-600 to-pink-600 px-4 py-2 text-sm font-extrabold text-white shadow hover:opacity-95 disabled:opacity-60"
                onClick={batchEnqueue}
                disabled={busy}
              >
                선택 업로드(직렬)
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-black/10 bg-neutral-50 p-3 text-xs text-neutral-700">
            선택한 추천을 업로드 큐에 <b>1개씩 순서대로</b> 넣습니다. (동시 요청/DB 락 이슈 방지)
          </div>

          <div className="mt-4 space-y-2">
            {items.length === 0 ? (
              <div className="rounded-2xl border border-black/10 bg-white p-5 text-sm text-neutral-600">
                추천이 비어있습니다. “추천 채우기”를 눌러주세요.
              </div>
            ) : (
              items.map((it) => (
                <label
                  key={it.sourceUrl}
                  className="flex cursor-pointer items-start gap-3 rounded-2xl border border-black/10 bg-white p-4 hover:bg-neutral-50"
                >
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={!!selected[it.sourceUrl]}
                    onChange={(e) =>
                      setSelected((s) => ({ ...s, [it.sourceUrl]: e.target.checked }))
                    }
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-extrabold text-neutral-900">
                      {it.title || it.sourceUrl}
                    </div>
                    <div className="mt-1 text-xs text-neutral-600">
                      {it.keyword ? `키워드: ${it.keyword}` : null}
                      {it.reason ? (it.keyword ? ` · ${it.reason}` : it.reason) : null}
                    </div>
                    <div className="mt-2 text-xs text-neutral-500 truncate">{it.sourceUrl}</div>
                  </div>
                </label>
              ))
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="text-sm font-extrabold">로그</div>
          <pre className="mt-3 h-[520px] overflow-auto rounded-2xl border border-black/10 bg-neutral-950 p-3 text-[11px] leading-5 text-white">
            {log || "-"}
          </pre>
        </section>
      </div>
      )}
    </Shell>
  );
}
