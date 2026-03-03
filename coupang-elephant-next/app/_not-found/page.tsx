export default function NotFoundPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <main className="mx-auto max-w-3xl px-4 py-14">
        <div className="rounded-3xl border border-black/10 bg-neutral-50 p-8">
          <div className="text-sm font-black">404</div>
          <h1 className="mt-2 text-2xl font-black tracking-tight">페이지를 찾을 수 없습니다.</h1>
          <p className="mt-3 text-sm leading-6 text-neutral-600">
            링크가 아직 이식되지 않았거나 경로가 변경되었습니다.
          </p>
          <a
            href="/"
            className="mt-6 inline-flex items-center justify-center rounded-full bg-neutral-900 px-6 py-3 text-sm font-extrabold text-white"
          >
            홈으로
          </a>
        </div>
      </main>
    </div>
  );
}
