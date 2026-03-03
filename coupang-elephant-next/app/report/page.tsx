import Link from "next/link";

export const dynamic = "force-static";

export default function ReportPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-40 border-b border-black/5 bg-white/75 backdrop-blur supports-[backdrop-filter]:bg-white/55">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-black tracking-tight">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white">
              C
            </span>
            <span className="text-sm">COUPANG ELEPHANT</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/analyze"
              className="rounded-full px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-black/5"
            >
              분석
            </Link>
            <Link
              href="/recommend"
              className="rounded-full px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-black/5"
            >
              추천
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-bold text-neutral-700 shadow-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-500" />
          리포트
        </div>
        <h1 className="mt-4 text-2xl font-black tracking-tight">리포트</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600">
          기존 메인에서 <span className="font-bold">/report?keyword=...</span> 링크가 존재해서 404 방지용으로
          페이지를 우선 생성했습니다.
        </p>

        <div className="mt-6 rounded-3xl border border-black/10 bg-neutral-50 p-6 text-sm text-neutral-700">
          TODO: 기존 리포트 화면 이식
        </div>
      </main>
    </div>
  );
}
