"use client";

import { useEffect, useMemo, useState } from "react";
import Shell from "../ui/Shell";

type CatalogResponse = {
  ok?: boolean;
  products?: Array<{
    sellerProductId?: string | null;
  }>;
};

type RefreshStatusResult = {
  sellerProductId?: string;
  ok?: boolean;
  statusName?: string | null;
  approved?: boolean;
  productId?: string | null;
  remoteDeleted?: boolean;
  error?: string | null;
};

type RefreshStatusResponse = {
  ok?: boolean;
  total?: number;
  success?: number;
  failed?: number;
  results?: RefreshStatusResult[];
};

type SingleStatusResponse = {
  ok?: boolean;
  sellerProductId?: string;
  remoteDeleted?: boolean;
  status?: {
    statusName?: string | null;
    approved?: boolean;
    productId?: string | null;
    checkedAt?: string | null;
    error?: string | null;
  };
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

function parseIds(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/g)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ).slice(0, 100);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR");
}

export default function TrackingSalesPage() {
  const [catalogTargets, setCatalogTargets] = useState<string[]>([]);
  const [targetsInput, setTargetsInput] = useState("");
  const [results, setResults] = useState<RefreshStatusResult[]>([]);
  const [singleSellerProductId, setSingleSellerProductId] = useState("");
  const [singleResult, setSingleResult] = useState<SingleStatusResponse | null>(null);
  const [statusText, setStatusText] = useState("-");
  const [log, setLog] = useState("-");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);

  const summary = useMemo(() => {
    const total = results.length;
    const success = results.filter((x) => x.ok).length;
    const failed = total - success;
    const remoteDeleted = results.filter((x) => x.remoteDeleted).length;
    return { total, success, failed, remoteDeleted };
  }, [results]);

  const loadCatalogTargets = async () => {
    setLoading(true);
    try {
      const res = await apiJson<CatalogResponse>("/api/catalog?limit=200");
      if (res.status === 401) {
        setNeedsLogin(true);
        setStatusText("로그인 필요");
        return;
      }
      if (!res.ok || !res.json?.ok || !Array.isArray(res.json.products)) {
        setLog((prev) => `${prev}\n추적 대상 조회 실패 (${res.status})`);
        return;
      }

      const ids = Array.from(
        new Set(
          res.json.products
            .map((row) => String(row.sellerProductId || "").trim())
            .filter(Boolean),
        ),
      );
      setCatalogTargets(ids);
      if (!targetsInput.trim()) {
        setTargetsInput(ids.join("\n"));
      }
      setStatusText(`추적 대상 ${ids.length}개`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCatalogTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runRefresh = async () => {
    const ids = parseIds(targetsInput);
    if (ids.length === 0) {
      setLog((prev) => `${prev}\n추적 대상 sellerProductId가 없습니다.`);
      return;
    }

    setBusy(true);
    try {
      const res = await apiJson<RefreshStatusResponse>("/api/products/status/refresh", {
        method: "POST",
        body: JSON.stringify({ sellerProductIds: ids }),
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!res.ok || !res.json?.ok || !Array.isArray(res.json.results)) {
        setLog((prev) => `${prev}\n상태 갱신 실패 (${res.status})`);
        return;
      }
      const body = res.json;
      const resultRows = Array.isArray(body.results) ? body.results : [];

      setResults(resultRows);
      setStatusText(
        `총 ${Number(body.total || resultRows.length || 0)} · 성공 ${Number(
          body.success || 0,
        )} · 실패 ${Number(body.failed || 0)}`,
      );
      setLog((prev) => `${prev}\n상태 갱신 완료 (${resultRows.length}개)`);
    } finally {
      setBusy(false);
    }
  };

  const lookupSingle = async () => {
    const id = String(singleSellerProductId || "").trim();
    if (!id) return;

    setBusy(true);
    try {
      const res = await apiJson<SingleStatusResponse>(
        `/api/products/status/${encodeURIComponent(id)}`,
      );
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!res.ok || !res.json) {
        setLog((prev) => `${prev}\n단건 조회 실패 (${res.status})`);
        return;
      }
      setSingleResult(res.json);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="판매량 추적기" subtitle={statusText}>
      {needsLogin ? (
        <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="text-lg font-extrabold">로그인이 필요합니다</div>
          <p className="mt-2 text-sm text-neutral-600">
            판매 상태 추적 API는 세션 인증이 필요합니다. 콘솔 로그인 후 재시도해 주세요.
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
                void loadCatalogTargets();
              }}
            >
              다시 시도
            </button>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)] lg:col-span-2">
            <div className="text-sm font-extrabold">추적 대상 sellerProductId</div>
            <textarea
              className="mt-3 h-32 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400"
              value={targetsInput}
              onChange={(e) => setTargetsInput(e.target.value)}
              placeholder="한 줄에 하나 또는 콤마로 구분"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-bold text-white hover:bg-neutral-800 disabled:opacity-60"
                onClick={() => void runRefresh()}
                disabled={busy}
              >
                상태 갱신
              </button>
              <button
                className="rounded-full px-4 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5 disabled:opacity-60"
                onClick={() => void loadCatalogTargets()}
                disabled={loading || busy}
              >
                카탈로그에서 다시 불러오기
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-2xl border border-black/10 bg-neutral-50 p-3">
                <div className="text-[11px] font-bold text-neutral-600">전체</div>
                <div className="mt-1 text-xl font-black text-neutral-900">{summary.total}</div>
              </div>
              <div className="rounded-2xl border border-black/10 bg-emerald-50 p-3">
                <div className="text-[11px] font-bold text-emerald-700">성공</div>
                <div className="mt-1 text-xl font-black text-emerald-900">{summary.success}</div>
              </div>
              <div className="rounded-2xl border border-black/10 bg-rose-50 p-3">
                <div className="text-[11px] font-bold text-rose-700">실패</div>
                <div className="mt-1 text-xl font-black text-rose-900">{summary.failed}</div>
              </div>
              <div className="rounded-2xl border border-black/10 bg-neutral-100 p-3">
                <div className="text-[11px] font-bold text-neutral-600">원격삭제</div>
                <div className="mt-1 text-xl font-black text-neutral-900">{summary.remoteDeleted}</div>
              </div>
            </div>

            <div className="mt-5 max-h-[640px] overflow-auto rounded-2xl border border-black/10">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-neutral-700">
                  <tr>
                    <th className="border-b border-black/10 px-3 py-2">sellerProductId</th>
                    <th className="border-b border-black/10 px-3 py-2">상태명</th>
                    <th className="border-b border-black/10 px-3 py-2">승인</th>
                    <th className="border-b border-black/10 px-3 py-2">productId</th>
                    <th className="border-b border-black/10 px-3 py-2">결과</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-neutral-500" colSpan={5}>
                        아직 실행 결과가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    results.map((row, idx) => (
                      <tr
                        key={`${row.sellerProductId || "na"}-${idx}`}
                        className="border-b border-black/5 align-top last:border-b-0"
                      >
                        <td className="px-3 py-3 font-semibold text-neutral-800">
                          {row.sellerProductId || "-"}
                        </td>
                        <td className="px-3 py-3">{row.statusName || "-"}</td>
                        <td className="px-3 py-3">{row.approved ? "Y" : "N"}</td>
                        <td className="px-3 py-3">{row.productId || "-"}</td>
                        <td className="px-3 py-3">
                          {row.ok ? (
                            <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-bold text-emerald-800">
                              OK
                            </span>
                          ) : (
                            <span className="rounded-full bg-rose-100 px-2 py-1 text-[11px] font-bold text-rose-700">
                              FAIL
                            </span>
                          )}
                          {row.remoteDeleted ? (
                            <span className="ml-2 rounded-full bg-neutral-200 px-2 py-1 text-[11px] font-bold text-neutral-700">
                              deleted
                            </span>
                          ) : null}
                          {!row.ok && row.error ? (
                            <div className="mt-1 text-[11px] text-rose-700">{row.error}</div>
                          ) : null}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
            <div className="text-sm font-extrabold">단건 조회</div>
            <div className="mt-3 flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-2xl border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400"
                value={singleSellerProductId}
                onChange={(e) => setSingleSellerProductId(e.target.value)}
                placeholder="sellerProductId"
              />
              <button
                className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-bold text-white hover:bg-neutral-800 disabled:opacity-60"
                onClick={() => void lookupSingle()}
                disabled={busy}
              >
                조회
              </button>
            </div>

            <div className="mt-3 rounded-2xl border border-black/10 bg-neutral-50 p-3 text-xs text-neutral-700">
              <div>카탈로그 대상: {catalogTargets.length}개</div>
              <div className="mt-1 max-h-24 overflow-auto break-all text-[11px] text-neutral-500">
                {catalogTargets.slice(0, 18).join(", ") || "-"}
              </div>
            </div>

            <div className="mt-3 rounded-2xl border border-black/10 bg-neutral-50 p-3 text-xs text-neutral-700">
              {!singleResult ? (
                "단건 조회 결과가 없습니다."
              ) : (
                <div className="space-y-1">
                  <div>sellerProductId: {singleResult.sellerProductId || "-"}</div>
                  <div>statusName: {singleResult.status?.statusName || "-"}</div>
                  <div>approved: {singleResult.status?.approved ? "Y" : "N"}</div>
                  <div>productId: {singleResult.status?.productId || "-"}</div>
                  <div>remoteDeleted: {singleResult.remoteDeleted ? "Y" : "N"}</div>
                  <div>checkedAt: {formatDate(singleResult.status?.checkedAt || null)}</div>
                  {singleResult.status?.error ? (
                    <div className="text-rose-700">error: {singleResult.status.error}</div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="mt-5 text-sm font-extrabold">로그</div>
            <pre className="mt-3 h-[300px] overflow-auto rounded-2xl border border-black/10 bg-neutral-950 p-3 text-[11px] leading-5 text-white">
              {log || "-"}
            </pre>
          </section>
        </div>
      )}
    </Shell>
  );
}
