import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coupang Elephant",
  description: "Coupang Elephant Next frontend",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
