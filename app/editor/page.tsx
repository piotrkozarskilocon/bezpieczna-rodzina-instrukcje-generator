import Link from "next/link";

export default function EditorPage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-6 text-sm text-slate-500">
        <Link href="/" className="hover:text-slate-900">
          Projekty
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">Edytor</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-12">
        <h2 className="text-2xl font-semibold text-slate-900">Edytor</h2>
        <p className="mt-2 text-sm text-slate-500">
          Phase 1: edytor blokowy (PDF import, parser layoutu, multi-lang, eksport) będzie wkrótce.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Import PDF</h3>
            <p className="mt-1 text-xs text-slate-500">pdfjs-dist + pdf-lib</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Tłumaczenia</h3>
            <p className="mt-1 text-xs text-slate-500">DeepL + Anthropic Claude</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Layout drag &amp; drop</h3>
            <p className="mt-1 text-xs text-slate-500">interactjs</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Eksport XLSX/PDF</h3>
            <p className="mt-1 text-xs text-slate-500">xlsx + pdf-lib</p>
          </div>
        </div>
      </div>
    </div>
  );
}
