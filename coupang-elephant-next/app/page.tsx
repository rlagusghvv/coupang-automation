import Shell from "./ui/Shell";

export default function Home() {
  return (
    <Shell title="Coupang Elephant" subtitle="v1 console (new UI + legacy embed)">
      <div className="grid grid-cols-1 gap-6">
        <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="text-xl font-black tracking-tight">대시보드</div>
          <p className="mt-2 text-sm text-neutral-600">
            요청하신 대로 <b>https://app.splui.com/app/</b> 에서 새 디자인을 유지하면서,
            기존 기능(업로드/추천/큐/설정/주문 등)은 우선 <b>레거시 콘솔</b>을 동일 화면에 이식(임베드)
            해둔 상태입니다. 이후 기능을 Next UI로 점진적으로 옮깁니다.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href="/keyword"
              className="inline-flex items-center justify-center rounded-full px-5 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5"
            >
              발굴
            </a>
            <a
              href="/itemmanagement"
              className="inline-flex items-center justify-center rounded-full px-5 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5"
            >
              관리
            </a>
            <a
              href="/trackingSales"
              className="inline-flex items-center justify-center rounded-full px-5 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5"
            >
              추적
            </a>
            <a
              href="/recommend"
              className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-fuchsia-600 to-pink-600 px-5 py-2 text-sm font-extrabold text-white shadow hover:opacity-95"
            >
              추천
            </a>
            <a
              href="/upload"
              className="inline-flex items-center justify-center rounded-full bg-neutral-900 px-5 py-2 text-sm font-bold text-white hover:bg-neutral-800"
            >
              업로드
            </a>
            <a
              href="/console"
              className="inline-flex items-center justify-center rounded-full px-5 py-2 text-sm font-bold text-neutral-800 hover:bg-black/5"
            >
              콘솔(전체 기능)
            </a>
          </div>
        </section>

        <section className="rounded-3xl border border-black/10 bg-white shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-black/5 px-5 py-3">
            <div className="text-sm font-extrabold">콘솔 (기능 이식: v1)</div>
            <a href="/console" className="text-xs font-bold text-neutral-600 hover:text-neutral-900">
              새 창으로 열기
            </a>
          </div>
          <iframe
            title="Couplus Console"
            src="/console"
            style={{ width: "100%", height: "calc(100vh - 260px)", border: "0" }}
          />
        </section>
      </div>
    </Shell>
  );
}
