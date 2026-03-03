export default function ConsoleEmbedPage() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-50 border-b border-black/5 bg-white/75 backdrop-blur supports-[backdrop-filter]:bg-white/55">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-black tracking-tight">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white">C</span>
            <span className="text-sm">COUPILOT</span>
          </div>
          <nav className="hidden items-center gap-5 pl-6 text-sm font-semibold text-neutral-700 md:flex">
            <a className="hover:text-neutral-950" href="/">홈</a>
            <a className="hover:text-neutral-950" href="/console">콘솔</a>
          </nav>
          <div className="ml-auto text-sm font-semibold text-neutral-600">Console (Legacy embed)</div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-6">
        <div className="rounded-3xl border border-black/10 bg-white shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)] overflow-hidden">
          <iframe
            title="Couplus Console"
            src="/console"
            style={{ width: "100%", height: "calc(100vh - 140px)", border: "0" }}
          />
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          목표: 기존 기능은 유지하면서, 이 새 UI 안으로 기능을 단계적으로 이식합니다.
        </p>
      </section>
    </main>
  );
}
