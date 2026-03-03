"use client";

import { useMemo, useState } from "react";
import Shell from "../ui/Shell";

type RecommendationItem = {
  id?: string | null;
  sourceUrl?: string | null;
  title?: string | null;
  keyword?: string | null;
  reason?: string | null;
  score?: number | null;
  finalPrice?: number | null;
  marginRate?: number | null;
  qc?: {
    tier?: string | null;
    eligibleUpload?: boolean | null;
  } | null;
};

type RecommendationListResponse = {
  ok?: boolean;
  items?: RecommendationItem[];
};

type RecommendationSavedResponse = {
  ok?: boolean;
  items?: Array<{ sourceUrl?: string | null }>;
};

type RecommendationFillResponse = {
  ok?: boolean;
  fill?: {
    count?: number;
    diagnostics?: {
      hint?: string;
    };
  };
  items?: RecommendationItem[];
};

type ApiResult<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

async function apiJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    credentials: "include",
    cache: "no-store",
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) as T };
  } catch {
    return { ok: res.ok, status: res.status, json: null };
  }
}

function parseKeywords(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/g)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ).slice(0, 30);
}

function formatWon(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

export default function KeywordPage() {
  const [items, setItems] = useState<RecommendationItem[]>([]);
  const [savedMap, setSavedMap] = useState<Record<string, boolean>>({});
  const [keywordsInput, setKeywordsInput] = useState("");
  const [targetCount, setTargetCount] = useState(20);
  const [cooldownDays, setCooldownDays] = useState(7);
  const [statusText, setStatusText] = useState("-");
  const [log, setLog] = useState("-");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);

  const keywordStats = useMemo(() => {
    const counter: Record<string, number> = {};
    for (const item of items) {
      const kw = String(item.keyword || "").trim();
      if (!kw) continue;
      counter[kw] = (counter[kw] || 0) + 1;
    }
    return Object.entries(counter)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14);
  }, [items]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [recoRes, savedRes] = await Promise.all([
        apiJson<RecommendationListResponse>("/api/recommendations?limit=120"),
        apiJson<RecommendationSavedResponse>("/api/recommendations/saved?limit=300"),
      ]);

      if (recoRes.status === 401 || savedRes.status === 401) {
        setNeedsLogin(true);
        setStatusText("로그인 필요");
        setLog((prev) => `${prev}\n401: 콘솔 로그인 필요`);
        return;
      }

      let nextItems: RecommendationItem[] = [];
      if (recoRes.ok && recoRes.json?.ok && Array.isArray(recoRes.json.items)) {
        nextItems = recoRes.json.items;
        setItems(nextItems);
      }

      let savedCount = 0;
      if (savedRes.ok && savedRes.json?.ok && Array.isArray(savedRes.json.items)) {
        const nextMap: Record<string, boolean> = {};
        for (const row of savedRes.json.items) {
          const url = String(row.sourceUrl || "").trim();
          if (!url) continue;
          nextMap[url] = true;
        }
        savedCount = Object.keys(nextMap).length;
        setSavedMap(nextMap);
      }

      setStatusText(`추천 ${nextItems.length}개 · 저장 ${savedCount}개`);
    } finally {
      setLoading(false);
    }
  };

  const runFill = async () => {
    setBusy(true);
    try {
      const keywords = parseKeywords(keywordsInput);
      const payload = {
        keywords,
        targetCount: Math.max(5, Math.min(100, targetCount)),
        cooldownDays: Math.max(1, Math.min(60, cooldownDays)),
      };
      const res = await apiJson<RecommendationFillResponse>("/api/recommendations/fill", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (res.status === 401) {
        setNeedsLogin(true);
        setStatusText("로그인 필요");
        return;
      }

      if (!res.ok || !res.json?.ok) {
        setLog((prev) => `${prev}\nfill 실패 (${res.status})`);
        return;
      }

      if (Array.isArray(res.json.items)) {
        setItems(res.json.items);
      }

      const hint = String(res.json.fill?.diagnostics?.hint || "").trim();
      const count = Number(res.json.fill?.count || 0);
      setLog((prev) => `${prev}\nfill 완료: ${count}개${hint ? ` · ${hint}` : ""}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleSave = async (item: RecommendationItem) => {
    const sourceUrl = String(item.sourceUrl || "").trim();
    if (!sourceUrl) return;

    setBusy(true);
    try {
      const alreadySaved = Boolean(savedMap[sourceUrl]);
      const res = alreadySaved
        ? await apiJson<{ ok?: boolean }>(
            `/api/recommendations/saved?sourceUrl=${encodeURIComponent(sourceUrl)}`,
            { method: "DELETE" },
          )
        : await apiJson<{ ok?: boolean }>("/api/recommendations/saved", {
            method: "POST",
            body: JSON.stringify({ item }),
          });

      if (res.status === 401) {
        setNeedsLogin(true);
        setStatusText("로그인 필요");
        return;
      }

      if (!res.ok || !res.json?.ok) {
        setLog((prev) => `${prev}\n저장 상태 변경 실패 (${res.status})`);
        return;
      }

      setSavedMap((prev) => {
        const next = { ...prev };
        if (alreadySaved) {
          delete next[sourceUrl];
        } else {
          next[sourceUrl] = true;
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="키워드 발굴" subtitle={statusText}>
      {needsLogin ? (
        <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="text-lg font-extrabold">로그인이 필요합니다</div>
          <p className="mt-2 text-sm text-neutral-600">
            추천/저장 데이터는 레거시 세션 기반입니다. 콘솔에서 로그인 후 다시 시도해 주세요.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              className="inline-flex items-center justify-center rounded-full bg-neutral-900 px-5 py-2 text-sm font-bold text-white hover:bg-neutral-800"
              href="/console"
            >
              콘솔 열고 로그인
            </a>
            <button
              className="rounded-full px-5 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5"
              onClick={() => {
                setNeedsLogin(false);
                void refresh();
              }}
            >
              다시 시도
            </button>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)] lg:col-span-2">
            <div className="text-sm font-extrabold">발굴 설정</div>
            <textarea
              className="mt-3 h-24 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400"
              value={keywordsInput}
              onChange={(e) => setKeywordsInput(e.target.value)}
              placeholder="예) 강아지 하네스, 차량용 방향제, 행거"
            />
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="rounded-2xl border border-black/10 bg-neutral-50 p-3">
                <div className="text-xs font-bold text-neutral-600">목표 후보 수</div>
                <input
                  className="mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400"
                  type="number"
                  min={5}
                  max={100}
                  value={targetCount}
                  onChange={(e) => setTargetCount(Number(e.target.value) || 20)}
                />
              </label>
              <label className="rounded-2xl border border-black/10 bg-neutral-50 p-3">
                <div className="text-xs font-bold text-neutral-600">쿨다운(일)</div>
                <input
                  className="mt-2 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400"
                  type="number"
                  min={1}
                  max={60}
                  value={cooldownDays}
                  onChange={(e) => setCooldownDays(Number(e.target.value) || 7)}
                />
              </label>
              <div className="rounded-2xl border border-black/10 bg-neutral-50 p-3">
                <div className="text-xs font-bold text-neutral-600">실행</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="rounded-full bg-neutral-900 px-4 py-2 text-xs font-bold text-white hover:bg-neutral-800 disabled:opacity-60"
                    onClick={runFill}
                    disabled={busy}
                  >
                    채우기
                  </button>
                  <button
                    className="rounded-full px-4 py-2 text-xs font-bold text-neutral-800 hover:bg-black/5 disabled:opacity-60"
                    onClick={refresh}
                    disabled={loading || busy}
                  >
                    새로고침
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              {keywordStats.length === 0 ? (
                <span className="text-xs text-neutral-500">키워드 통계 없음</span>
              ) : (
                keywordStats.map(([kw, count]) => (
                  <span
                    key={kw}
                    className="inline-flex items-center rounded-full border border-black/10 bg-neutral-50 px-3 py-1 text-xs font-semibold text-neutral-700"
                  >
                    {kw} · {count}
                  </span>
                ))
              )}
            </div>

            <div className="mt-5 space-y-2">
              {items.length === 0 ? (
                <div className="rounded-2xl border border-black/10 bg-neutral-50 p-4 text-sm text-neutral-600">
                  추천 데이터가 없습니다. 채우기 또는 새로고침을 실행해 주세요.
                </div>
              ) : (
                items.map((item, idx) => {
                  const sourceUrl = String(item.sourceUrl || "");
                  const saved = Boolean(savedMap[sourceUrl]);
                  const qcTier = String(item.qc?.tier || "").toUpperCase();
                  return (
                    <div
                      key={sourceUrl || item.id || `row-${idx}`}
                      className="rounded-2xl border border-black/10 bg-white p-4"
                    >
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-extrabold text-neutral-900">
                            {item.title || sourceUrl || "(제목 없음)"}
                          </div>
                          <div className="mt-1 text-xs text-neutral-600">
                            {item.keyword ? `키워드: ${item.keyword}` : "키워드 없음"}
                            {item.reason ? ` · ${item.reason}` : ""}
                          </div>
                          <div className="mt-1 text-[11px] text-neutral-500">
                            점수 {typeof item.score === "number" ? item.score.toFixed(1) : "-"} · 예상가{" "}
                            {formatWon(item.finalPrice)} · 마진 {formatPercent(item.marginRate)}
                            {qcTier ? ` · QC ${qcTier}` : ""}
                            {item.qc?.eligibleUpload ? " · 업로드 가능" : ""}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-bold text-neutral-700 hover:bg-black/5 disabled:opacity-60"
                            onClick={() => void toggleSave(item)}
                            disabled={busy}
                          >
                            {saved ? "저장해제" : "저장"}
                          </button>
                          {sourceUrl ? (
                            <a
                              className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-bold text-neutral-700 hover:bg-black/5"
                              href={sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              원문
                            </a>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
            <div className="text-sm font-extrabold">실행 로그</div>
            <pre className="mt-3 h-[620px] overflow-auto rounded-2xl border border-black/10 bg-neutral-950 p-3 text-[11px] leading-5 text-white">
              {log || "-"}
            </pre>
          </section>
        </div>
      )}
    </Shell>
  );
}
