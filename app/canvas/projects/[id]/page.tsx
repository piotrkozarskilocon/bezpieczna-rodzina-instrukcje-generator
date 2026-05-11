"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import PdfPagesViewer from "@/components/PdfPagesViewer";
import TranslationsPanel, {
  LANG_KEYS,
  LANG_LABELS,
  type LangKey,
  type TranslationRow,
} from "@/components/TranslationsPanel";

interface ProjectDetail {
  id: string;
  name: string;
  source_pdf_path: string | null;
  source_pdf_size_bytes: number | null;
  source_pdf_pages_count: number | null;
  created_at: string;
  updated_at: string;
}

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

const API_BASE = "/generator-instrukcji/api";

export default function ProjectPage({ params }: ProjectPageProps): React.ReactElement {
  const { id } = use(params);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [translations, setTranslations] = useState<TranslationRow[]>([]);
  const [displayLang, setDisplayLang] = useState<LangKey>("pl");

  const handleTranslationsChanged = useCallback((rows: TranslationRow[]) => {
    setTranslations(rows);
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/projects/${id}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (active) setProject(j.project);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "fetch failed");
      });
    return () => {
      active = false;
    };
  }, [id]);

  const handlePagesLoaded = useCallback(
    async (pagesCount: number) => {
      if (project?.source_pdf_pages_count === pagesCount) return;
      try {
        await fetch(`${API_BASE}/projects/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_pdf_pages_count: pagesCount }),
        });
        setProject((prev) =>
          prev ? { ...prev, source_pdf_pages_count: pagesCount } : prev,
        );
      } catch {
        // Silent — rendering already worked, count metadata is best-effort.
      }
    },
    [id, project?.source_pdf_pages_count],
  );

  const handleDelete = async () => {
    if (!confirm("Usunąć projekt? Operacja nieodwracalna.")) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = "/generator-instrukcji/canvas/";
    } catch (err) {
      alert(err instanceof Error ? err.message : "delete failed");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-6 text-sm text-slate-500">
        <Link href="/canvas" className="hover:text-slate-900">
          Projekty (Edytor wizualny)
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">{project?.name ?? id}</span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          Błąd: {error}
        </div>
      )}

      {!error && !project && (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">
          Ładowanie projektu...
        </div>
      )}

      {project && (
        <>
          <div className="mb-6 flex items-start justify-between rounded-xl border border-slate-200 bg-white p-6">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">{project.name}</h2>
              <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <dt className="text-slate-500">PDF źródłowy</dt>
                <dd className="text-slate-900">
                  {project.source_pdf_path ? (
                    <span>
                      Wgrany{" "}
                      {project.source_pdf_size_bytes != null && (
                        <span className="text-slate-500">
                          ({(project.source_pdf_size_bytes / 1024 / 1024).toFixed(2)} MB)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-amber-700">Brak</span>
                  )}
                </dd>

                <dt className="text-slate-500">Liczba stron</dt>
                <dd className="text-slate-900">
                  {project.source_pdf_pages_count ?? "—"}
                </dd>

                <dt className="text-slate-500">Utworzony</dt>
                <dd className="text-slate-900">
                  {new Date(project.created_at).toLocaleString("pl-PL")}
                </dd>

                <dt className="text-slate-500">ID</dt>
                <dd className="font-mono text-xs text-slate-500">{project.id}</dd>
              </dl>
            </div>

            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
            >
              Usuń projekt
            </button>
          </div>

          <TranslationsPanel projectId={project.id} onChanged={handleTranslationsChanged} />

          {translations.length > 0 && (
            <div className="mb-4 flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
              <label htmlFor="lang-select" className="font-medium text-slate-700">
                Wyświetl bloki w języku:
              </label>
              <select
                id="lang-select"
                value={displayLang}
                onChange={(e) => setDisplayLang(e.target.value as LangKey)}
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              >
                {LANG_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k.toUpperCase()} — {LANG_LABELS[k]}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                Bloki zmapowane automatycznie do wpisów Excela podmienią treść po wybraniu języka.
              </span>
            </div>
          )}

          {project.source_pdf_path ? (
            <PdfPagesViewer
              projectId={project.id}
              onPagesLoaded={handlePagesLoaded}
              translations={translations}
              displayLang={displayLang}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
              Brak źródłowego PDF w tym projekcie.
            </div>
          )}
        </>
      )}
    </div>
  );
}
