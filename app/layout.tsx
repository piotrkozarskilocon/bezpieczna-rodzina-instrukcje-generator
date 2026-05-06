import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Generator instrukcji · Locon",
  description: "Wewnętrzny generator instrukcji QSG + KG dla zegarków BR.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="pl" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                Locon · Bezpieczna Rodzina
              </span>
            </Link>
            <nav className="flex items-center gap-6 text-sm font-medium text-slate-600">
              <Link href="/" className="hover:text-slate-900">
                Projekty
              </Link>
              <Link href="/editor" className="hover:text-slate-900">
                Edytor
              </Link>
              <a
                href="https://bezpieczna-rodzina-prototypy.vercel.app/"
                className="hover:text-slate-900"
              >
                Hub
              </a>
            </nav>
          </div>
          <div className="mx-auto max-w-6xl px-6 pb-5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Generator instrukcji
            </h1>
            <p className="text-sm text-slate-500">
              Multilang QSG + Karta Gwarancyjna dla GJD.15, GJD.16, GJD.08, BS.07 i nowszych modeli.
            </p>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 text-xs text-slate-500">
            <span>Locon · materiały wewnętrzne</span>
            <span>Phase 0 · skeleton deploy</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
