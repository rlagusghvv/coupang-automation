"use client";

import { useEffect, useMemo, useState } from "react";
import Shell from "../ui/Shell";

type CatalogProduct = {
  id: string;
  sourceUrl?: string | null;
  confirmedTitle?: string | null;
  mainImageUrl?: string | null;
  sellerProductId?: string | null;
  productId?: string | null;
  productUrl?: string | null;
  status?: string | null;
  lastSyncedAt?: string | null;
  createdAt?: string | null;
};

type CatalogResponse = {
  ok?: boolean;
  products?: CatalogProduct[];
  total?: number;
};

type UploadHistoryEntry = {
  at?: string | null;
  url?: string | null;
  ok?: boolean;
  skipped?: boolean;
  skipReason?: string | null;
  title?: string | null;
  sellerProductId?: string | null;
  createStatus?: number | null;
  error?: string | null;
};

type UploadHistoryResponse = {
  ok?: boolean;
  history?: UploadHistoryEntry[];
};

type RefreshStatusResponse = {
  ok?: boolean;
  total?: number;
  success?: number;
  failed?: number;
};

type SyncResponse = {
  ok?: boolean;
  product?: CatalogProduct;
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

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR");
}

function statusClassName(status: string | null | undefined) {
  const s = String(status || "").toLowerCase();
  if (s === "deployed") return "bg-emerald-100 text-emerald-800";
  if (s === "deployed_invalid") return "bg-amber-100 text-amber-800";
  if (s === "deploy_failed") return "bg-rose-100 text-rose-700";
  if (s === "deleted_remote" || s === "deleted_local") return "bg-neutral-200 text-neutral-700";
  return "bg-sky-100 text-sky-800";
}

export default function ItemManagementPage() {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [history, setHistory] = useState<UploadHistoryEntry[]>([]);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [total, setTotal] = useState(0);
  const [statusText, setStatusText] = useState("-");
  const [log, setLog] = useState("-");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);

  const statusCount = useMemo(() => {
    const counter: Record<string, number> = {};
    for (const row of products) {
      const key = String(row.status || "unknown");
      counter[key] = (counter[key] || 0) + 1;
    }
    return counter;
  }, [products]);

  const fetchCatalog = async () => {
    const params = new URLSearchParams();
    params.set("limit", "150");
    if (q.trim()) params.set("q", q.trim());
    if (statusFilter.trim()) params.set("status", statusFilter.trim());

    const res = await apiJson<CatalogResponse>(`/api/catalog?${params.toString()}`);
    if (res.status === 401) {
      setNeedsLogin(true);
      setStatusText("로그인 필요");
      return 0;
    }
    if (!res.ok || !res.json?.ok || !Array.isArray(res.json.products)) {
      setLog((prev) => `${prev}\ncatalog 조회 실패 (${res.status})`);
      return 0;
    }

    setProducts(res.json.products);
    setTotal(Number(res.json.total || res.json.products.length || 0));
    return res.json.products.length;
  };

  const fetchHistory = async () => {
    const res = await apiJson<UploadHistoryResponse>("/api/upload/history");
    if (res.status === 401) {
      setNeedsLogin(true);
      setStatusText("로그인 필요");
      return 0;
    }
    if (!res.ok || !res.json?.ok || !Array.isArray(res.json.history)) {
      setLog((prev) => `${prev}\nupload history 조회 실패 (${res.status})`);
      return 0;
    }
    setHistory(res.json.history.slice(0, 40));
    return Math.min(res.json.history.length, 40);
  };

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [catalogCount, historyCount] = await Promise.all([fetchCatalog(), fetchHistory()]);
      setStatusText(`카탈로그 ${catalogCount}개 · 이력 ${historyCount}건`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncOne = async (catalogId: string) => {
    setBusy(true);
    try {
      const res = await apiJson<SyncResponse>(`/api/catalog/${encodeURIComponent(catalogId)}/sync`, {
        method: "POST",
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!res.ok || !res.json?.ok || !res.json.product) {
        setLog((prev) => `${prev}\n동기화 실패 (${catalogId}, ${res.status})`);
        return;
      }
      const next = res.json.product;
      setProducts((prev) => prev.map((row) => (row.id === catalogId ? next : row)));
      setLog((prev) => `${prev}\n동기화 완료: ${catalogId}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshStatuses = async () => {
    const sellerProductIds = products
      .map((row) => String(row.sellerProductId || "").trim())
      .filter(Boolean);
    if (sellerProductIds.length === 0) {
      setLog((prev) => `${prev}\n상태 갱신 대상 sellerProductId 없음`);
      return;
    }

    setBusy(true);
    try {
      const res = await apiJson<RefreshStatusResponse>("/api/products/status/refresh", {
        method: "POST",
        body: JSON.stringify({ sellerProductIds }),
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!res.ok || !res.json?.ok) {
        setLog((prev) => `${prev}\n일괄 상태 갱신 실패 (${res.status})`);
        return;
      }
      const body = res.json;

      setLog(
        (prev) =>
          `${prev}\n상태 갱신 완료: total=${Number(body.total || 0)}, success=${Number(
            body.success || 0,
          )}, failed=${Number(body.failed || 0)}`,
      );
      await fetchCatalog();
    } finally {
      setBusy(false);
    }
  };

  const subtitle = `${statusText} · 표시 ${products.length}/${total}`;

  return (
    <Shell title="상품 관리" subtitle={subtitle}>
      {needsLogin ? (
        <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="text-lg font-extrabold">로그인이 필요합니다</div>
          <p className="mt-2 text-sm text-neutral-600">카탈로그/업로드 이력은 로그인 세션에서만 조회됩니다.</p>
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
                void refreshAll();
              }}
            >
              다시 시도
            </button>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)] lg:col-span-2">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <input
                className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400 md:col-span-2"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="제목/URL 검색"
              />
              <select
                className="rounded-2xl border border-black/10 bg-white px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-fuchsia-400"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">전체 상태</option>
                <option value="confirmed">confirmed</option>
                <option value="deployed">deployed</option>
                <option value="deployed_invalid">deployed_invalid</option>
                <option value="deploy_failed">deploy_failed</option>
                <option value="deleted_remote">deleted_remote</option>
              </select>
              <div className="flex gap-2">
                <button
                  className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-bold text-white hover:bg-neutral-800 disabled:opacity-60"
                  onClick={() => void refreshAll()}
                  disabled={loading || busy}
                >
                  조회
                </button>
                <button
                  className="rounded-full px-4 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5 disabled:opacity-60"
                  onClick={() => void refreshStatuses()}
                  disabled={loading || busy}
                >
                  상태갱신
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {Object.keys(statusCount).length === 0 ? (
                <span className="text-xs text-neutral-500">상태 카운트 없음</span>
              ) : (
                Object.entries(statusCount).map(([status, count]) => (
                  <span
                    key={status}
                    className="inline-flex items-center rounded-full border border-black/10 bg-neutral-50 px-3 py-1 text-xs font-semibold text-neutral-700"
                  >
                    {status} · {count}
                  </span>
                ))
              )}
            </div>

            <div className="mt-5 max-h-[700px] overflow-auto rounded-2xl border border-black/10">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-neutral-700">
                  <tr>
                    <th className="border-b border-black/10 px-3 py-2">상품</th>
                    <th className="border-b border-black/10 px-3 py-2">상태</th>
                    <th className="border-b border-black/10 px-3 py-2">쿠팡 ID</th>
                    <th className="border-b border-black/10 px-3 py-2">동기화</th>
                    <th className="border-b border-black/10 px-3 py-2">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {products.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-neutral-500" colSpan={5}>
                        표시할 상품이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    products.map((row) => (
                      <tr key={row.id} className="border-b border-black/5 align-top last:border-b-0">
                        <td className="px-3 py-3">
                          <div className="max-w-[280px] truncate font-semibold text-neutral-900">
                            {row.confirmedTitle || "(제목 없음)"}
                          </div>
                          <div className="mt-1 max-w-[280px] truncate text-[11px] text-neutral-500">
                            {row.sourceUrl || "-"}
                          </div>
                          <div className="mt-1 text-[11px] text-neutral-500">
                            생성 {formatDate(row.createdAt)}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-[11px] font-bold ${statusClassName(row.status)}`}
                          >
                            {row.status || "-"}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="text-[11px] font-semibold text-neutral-700">
                            SPID: {row.sellerProductId || "-"}
                          </div>
                          <div className="mt-1 text-[11px] text-neutral-500">PID: {row.productId || "-"}</div>
                          {row.productUrl ? (
                            <a
                              className="mt-1 inline-flex text-[11px] font-semibold text-fuchsia-700 hover:underline"
                              href={row.productUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              상품 링크
                            </a>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-[11px] text-neutral-600">{formatDate(row.lastSyncedAt)}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-bold text-neutral-700 hover:bg-black/5 disabled:opacity-60"
                              onClick={() => void syncOne(row.id)}
                              disabled={busy}
                            >
                              sync
                            </button>
                            {row.sourceUrl ? (
                              <a
                                className="rounded-full border border-black/10 px-3 py-1 text-[11px] font-bold text-neutral-700 hover:bg-black/5"
                                href={row.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                원문
                              </a>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-3xl border border-black/10 bg-white p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
            <div className="text-sm font-extrabold">최근 업로드 이력</div>
            <div className="mt-3 max-h-[340px] space-y-2 overflow-auto">
              {history.length === 0 ? (
                <div className="rounded-2xl border border-black/10 bg-neutral-50 p-3 text-xs text-neutral-600">
                  업로드 이력이 없습니다.
                </div>
              ) : (
                history.map((row, idx) => (
                  <div key={`${row.at || "na"}-${idx}`} className="rounded-2xl border border-black/10 bg-neutral-50 p-3">
                    <div className="text-[11px] font-bold text-neutral-800">{row.title || row.url || "-"}</div>
                    <div className="mt-1 text-[11px] text-neutral-600">
                      {formatDate(row.at || null)} · {row.ok ? "성공" : row.skipped ? "스킵" : "실패"}
                      {row.sellerProductId ? ` · SPID ${row.sellerProductId}` : ""}
                    </div>
                    {row.error ? <div className="mt-1 text-[11px] text-rose-700">{row.error}</div> : null}
                  </div>
                ))
              )}
            </div>

            <div className="mt-5 text-sm font-extrabold">로그</div>
            <pre className="mt-3 h-[260px] overflow-auto rounded-2xl border border-black/10 bg-neutral-950 p-3 text-[11px] leading-5 text-white">
              {log || "-"}
            </pre>
          </section>
        </div>
      )}
    </Shell>
  );
}
