import Link from "next/link";

export default function HomePage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Projekty</h2>
          <p className="text-sm text-slate-500">
            Lista wszystkich instrukcji w trakcie pracy.
          </p>
        </div>
        <Link
          href="/editor"
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700"
        >
          + Nowy projekt
        </Link>
      </div>

      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <p className="text-sm font-medium text-slate-700">Brak projektów.</p>
        <p className="mt-2 text-sm text-slate-500">
          Stwórz nowy projekt, aby rozpocząć pracę nad instrukcją.
        </p>
        <Link
          href="/editor"
          className="mt-6 inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-100"
        >
          Stwórz nowy projekt
        </Link>
      </div>

      <p className="mt-10 text-xs uppercase tracking-[0.16em] text-slate-400">
        Phase 0 · Następne fazy: import PDF, parser layoutu, edytor blokowy, eksport PDF.
      </p>
    </div>
  );
}
