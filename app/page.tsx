import Link from "next/link";

export default function GeneratorHomePage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-10">
        <h2 className="text-2xl font-semibold text-slate-900">Wybierz tryb edytora</h2>
        <p className="mt-2 text-sm text-slate-500">
          Każdy tryb pracuje w osobnej bazie projektów — możesz testować jednocześnie
          oba bez ryzyka pomieszania danych.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Link
          href="/canvas"
          className="block rounded-xl border border-slate-200 bg-white p-6 transition hover:border-slate-400 hover:shadow-sm"
        >
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
            wersja 1 · canvas
          </div>
          <h3 className="text-lg font-semibold text-slate-900">Edytor wizualny</h3>
          <p className="mt-2 text-sm text-slate-600">
            Bezpośrednia edycja bloków na podglądzie PDF — drag &amp; drop, resize,
            podwójny klik dla edycji tekstu. Bloki kolorowane wg źródła
            (PDF / OCR / re-OCR / DB / manualny).
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Najlepsze do drobnych korekt nad istniejącym layoutem.
          </p>
          <p className="mt-4 text-sm font-medium text-slate-900">→ Otwórz</p>
        </Link>

        <Link
          href="/table"
          className="block rounded-xl border border-slate-200 bg-white p-6 transition hover:border-slate-400 hover:shadow-sm"
        >
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
            wersja 2 · table
          </div>
          <h3 className="text-lg font-semibold text-slate-900">Edytor tabelaryczny</h3>
          <p className="mt-2 text-sm text-slate-600">
            Trzy kolumny: PDF + lista bloków edytowalna inline + lista wpisów
            Excela. Per-page navigation, hover sync. Edycja na warstwie
            overlay nad zrasteryzowanym PDF.
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Eksperymentalny. Działa do podglądu OCR per stronie.
          </p>
          <p className="mt-4 text-sm font-medium text-slate-900">→ Otwórz</p>
        </Link>

        <Link
          href="/structured"
          className="block rounded-xl border border-blue-300 bg-white p-6 transition hover:border-blue-500 hover:shadow-sm"
        >
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-700">
            wersja 3 · strukturalny
          </div>
          <h3 className="text-lg font-semibold text-slate-900">Edytor strukturalny</h3>
          <p className="mt-2 text-sm text-slate-600">
            Budujesz instrukcję od zera z gotowych szablonów stron i
            elementów (text, obraz, linia, QR). Pełna kontrola nad fontem,
            kolorem, layoutem.
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Eksport: wektorowy PDF per język. Najlepsze do drukowanych
            instrukcji.
          </p>
          <p className="mt-4 text-sm font-medium text-slate-900">→ Otwórz</p>
        </Link>

        <Link
          href="/ai"
          className="block rounded-xl border-2 border-purple-300 bg-gradient-to-br from-white to-purple-50 p-6 transition hover:border-purple-500 hover:shadow-md"
        >
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-purple-700">
            wersja 4 · AI-first ✨
          </div>
          <h3 className="text-lg font-semibold text-slate-900">Generator AI</h3>
          <p className="mt-2 text-sm text-slate-600">
            Opisujesz model i funkcje, AI generuje pełen szkielet instrukcji
            (cover, kroki, gwarancja, kontakt) z treścią po polsku.
            Edytujesz iteracyjnie poleceniami w naturalnym języku.
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Najszybsza droga do kompletnej instrukcji nowego modelu.
            Tłumaczenia + eksport PDF.
          </p>
          <p className="mt-4 text-sm font-medium text-purple-900">→ Otwórz</p>
        </Link>
      </div>

      <p className="mt-10 text-xs uppercase tracking-[0.16em] text-slate-400">
        Generator instrukcji · Locon · materiały wewnętrzne
      </p>
    </div>
  );
}
