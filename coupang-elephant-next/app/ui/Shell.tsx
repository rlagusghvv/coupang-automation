"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={
        "rounded-full px-3 py-2 text-sm font-extrabold transition " +
        (active
          ? "bg-gradient-to-r from-fuchsia-600 to-pink-600 text-white shadow"
          : "text-neutral-700 hover:bg-black/5")
      }
    >
      {label}
    </Link>
  );
}

export default function Shell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-50 border-b border-black/5 bg-white/75 backdrop-blur supports-[backdrop-filter]:bg-white/55">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-black tracking-tight">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white">
              C
            </span>
            <span className="text-sm">COUPILOT</span>
          </Link>
          <nav className="hidden items-center gap-2 pl-4 md:flex">
            <NavLink href="/keyword" label="발굴" />
            <NavLink href="/itemmanagement" label="관리" />
            <NavLink href="/trackingSales" label="추적" />
            <NavLink href="/recommend" label="추천" />
            <NavLink href="/upload" label="업로드" />
            <NavLink href="/console" label="콘솔" />
          </nav>
          <div className="ml-auto hidden text-sm font-semibold text-neutral-600 md:block">
            {title ? <span className="text-neutral-900">{title}</span> : null}
            {subtitle ? <span className="ml-2 text-neutral-500">{subtitle}</span> : null}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
