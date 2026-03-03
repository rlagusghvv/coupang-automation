"use client";

import { useMemo, useState } from "react";

type AnalyzeResponse =
  | {
      ok: true;
      keyword: string;
      category: string;
      priceBand: string;
      asOf: string;
      summary: {
        title: string;
        subtitle: string;
        score: number;
        recommendation: string;
      };
      rationale: {
        sources: Array<{ name: string; note: string }>;
        assumptions: string[];
      };
      signals: Array<{ label: string; value: string; detail: string }>;
      actions: Array<{ title: string; why: string; impact: string }>;
    }
  | { ok: false; message: string };

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-bold text-neutral-700 shadow-sm">
      <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-500" />
      {children}
    </span>
  );
}

export default function AnalyzePage() {
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [priceBand, setPriceBand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyzeResponse | null>(null);

  const canSubmit = useMemo(() => keyword.trim().length > 0 && !loading, [keyword, loading]);

  async function submit() {
    setError(null);
    setLoading(true);
    setData(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, category, priceBand }),
      });
      const json = (await res.json().catch(() => null)) as AnalyzeResponse | null;
      if (!json) throw new Error("Invalid response");
      if (!res.ok || json.ok === false) {
        setError((json as any).message ?? "요청에 실패했습니다.");
        setData(json);
        return;
      }
      setData(json);
    } catch (e: any) {
      setError(e?.message ?? "요청에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-40 border-b border-black/5 bg-white/75 backdrop-blur supports-[backdrop-filter]:bg-white/55">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <a href="/" className="flex items-center gap-2 font-black tracking-tight">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white">
              C
            </span>
            <span className="text-sm">COUPANG ELEPHANT</span>
          </a>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="/"
              className="rounded-full px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-black/5"
            >
              홈
            </a>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className={cx(
                "rounded-full px-5 py-2 text-sm font-extrabold text-white shadow-sm",
                canSubmit
                  ? "bg-neutral-900 hover:bg-neutral-800"
                  : "bg-neutral-300 cursor-not-allowed",
              )}
            >
              {loading ? "분석 중…" : "분석 시작"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
            <Pill>상품 테스트</Pill>
            <h1 className="mt-4 text-3xl font-black tracking-tight">오늘 팔 아이템을 10분 만에 정리</h1>
            <p className="mt-3 text-sm leading-6 text-neutral-600">
              지금은 과금 없이 MVP를 빠르게 검증합니다. 내일부터 대표가 직접 테스트하고,
              이후 지인 테스트까지 확장할 수 있도록 “돌아가는 플로우”를 우선 제공합니다.
            </p>

            <div className="mt-6 grid gap-3">
              <label className="grid gap-2">
                <span className="text-sm font-bold text-neutral-700">키워드(필수)</span>
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  placeholder="예: 강남역, 스마트워치, 차량용 방향제"
                  className="rounded-2xl border border-black/10 bg-neutral-50 px-4 py-3 text-sm font-semibold outline-none ring-0 placeholder:text-neutral-400 focus:border-fuchsia-400"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-neutral-700">카테고리(선택)</span>
                  <input
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="예: 생활/주방"
                    className="rounded-2xl border border-black/10 bg-neutral-50 px-4 py-3 text-sm font-semibold outline-none placeholder:text-neutral-400 focus:border-fuchsia-400"
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-neutral-700">가격대(선택)</span>
                  <input
                    value={priceBand}
                    onChange={(e) => setPriceBand(e.target.value)}
                    placeholder="예: 1~2만원"
                    className="rounded-2xl border border-black/10 bg-neutral-50 px-4 py-3 text-sm font-semibold outline-none placeholder:text-neutral-400 focus:border-fuchsia-400"
                  />
                </label>
              </div>

              {error && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                  {error}
                </div>
              )}

              <button
                onClick={submit}
                disabled={!canSubmit}
                className={cx(
                  "mt-1 rounded-2xl px-5 py-3 text-sm font-extrabold text-white shadow-sm",
                  canSubmit
                    ? "bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:opacity-95"
                    : "bg-neutral-300 cursor-not-allowed",
                )}
              >
                {loading ? "분석 중…" : "무료로 분석하기"}
              </button>

              <div className="text-xs text-neutral-500">
                * 현재는 샘플 데이터로 플로우/UX를 먼저 검증합니다. 이후 실제 데이터(크롤링/제휴
                API/파트너 데이터)로 교체합니다.
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
            <Pill>분석 결과</Pill>

            {!data && (
              <div className="mt-6 rounded-3xl border border-black/10 bg-neutral-50 p-6">
                <div className="text-sm font-bold text-neutral-600">아직 분석 결과가 없습니다.</div>
                <div className="mt-2 text-sm text-neutral-500">
                  키워드를 입력하고 ‘분석 시작’을 눌러주세요.
                </div>
              </div>
            )}

            {data && data.ok === true && (
              <div className="mt-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xl font-black tracking-tight">{data.summary.title}</div>
                    <div className="mt-1 text-xs font-semibold text-neutral-500">
                      {new Date(data.asOf).toLocaleString()}
                    </div>
                    <div className="mt-2 text-sm text-neutral-600">{data.summary.subtitle}</div>
                  </div>
                  <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-center">
                    <div className="text-[11px] font-bold text-neutral-500">SCORE</div>
                    <div className="mt-1 text-3xl font-black text-neutral-900">{data.summary.score}</div>
                    <div className="mt-1 text-xs font-bold text-emerald-700">
                      {data.summary.recommendation}
                    </div>
                  </div>
                </div>

                <div className="mt-6 grid gap-3">
                  <div className="text-sm font-black">핵심 시그널</div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {data.signals.map((s) => (
                      <div key={s.label} className="rounded-3xl border border-black/10 bg-neutral-50 p-4">
                        <div className="text-xs font-bold text-neutral-500">{s.label}</div>
                        <div className="mt-2 text-lg font-black text-neutral-900">{s.value}</div>
                        <div className="mt-2 text-xs text-neutral-600">{s.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-7">
                  <div className="text-sm font-black">오늘의 액션(추천)</div>
                  <div className="mt-3 grid gap-3">
                    {data.actions.map((a) => (
                      <div key={a.title} className="rounded-3xl border border-black/10 bg-white p-5">
                        <div className="flex items-start justify-between gap-4">
                          <div className="text-base font-black">{a.title}</div>
                          <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs font-bold text-white">
                            {a.impact}
                          </div>
                        </div>
                        <div className="mt-2 text-sm text-neutral-600">{a.why}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-7 rounded-3xl border border-black/10 bg-neutral-50 p-5">
                  <div className="text-sm font-black">근거 / 출처</div>
                  <div className="mt-3 grid gap-2 text-sm text-neutral-700">
                    {data.rationale.sources.map((s) => (
                      <div key={s.name} className="flex gap-2">
                        <span className="font-extrabold">{s.name}:</span>
                        <span className="text-neutral-600">{s.note}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-neutral-500">
                    가정: {data.rationale.assumptions.join(" · ")}
                  </div>
                </div>
              </div>
            )}

            {data && data.ok === false && (
              <div className="mt-6 rounded-3xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">
                {data.message}
              </div>
            )}
          </section>
        </div>
      </main>

      <footer className="border-t border-black/5 bg-white py-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 text-sm text-neutral-600">
          <div className="font-semibold">Coupang Elephant MVP</div>
          <div>무료 베타 — 내일부터 실테스트 진행 예정</div>
        </div>
      </footer>
    </div>
  );
}
