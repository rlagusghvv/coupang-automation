import Link from "next/link";

export const dynamic = "force-static";

export default function LoginPage() {
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
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-bold text-neutral-700 shadow-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-500" />
          로그인
        </div>
        <h1 className="mt-4 text-2xl font-black tracking-tight">로그인</h1>
        <div className="mt-6 rounded-3xl border border-black/10 bg-neutral-50 p-6 text-sm text-neutral-700">
          TODO: 기존 로그인/세션 플로우 이식
        </div>
      </main>
    </div>
  );
}
