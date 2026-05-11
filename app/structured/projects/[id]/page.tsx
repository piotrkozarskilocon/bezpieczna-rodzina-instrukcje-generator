"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import StructuredEditor from "@/components/StructuredEditor";

interface ProjectDetail {
  id: string;
  name: string;
  default_lang: string;
  reference_pdf_path: string | null;
  reference_pdf_size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

const API_BASE = "/generator-instrukcji/api/v3";

export default function StructuredProjectPage({ params }: ProjectPageProps): React.ReactElement {
  const { id } = use(params);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const handleDelete = async () => {
    if (!confirm("Usunąć projekt? Operacja nieodwracalna.")) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = "/generator-instrukcji/structured/";
    } catch (err) {
      alert(err instanceof Error ? err.message : "delete failed");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-12">
      <div className="mb-6 text-sm text-slate-500">
        <Link href="/" className="hover:text-slate-900">
          Generator
        </Link>
        <span className="mx-2">/</span>
        <Link href="/structured" className="hover:text-slate-900">
          Edytor strukturalny
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
                <dt className="text-slate-500">Język domyślny</dt>
                <dd className="text-slate-900">{project.default_lang.toUpperCase()}</dd>

                <dt className="text-slate-500">PDF referencyjny</dt>
                <dd className="text-slate-900">
                  {project.reference_pdf_path ? (
                    <span>
                      Wgrany{" "}
                      {project.reference_pdf_size_bytes != null && (
                        <span className="text-slate-500">
                          ({(project.reference_pdf_size_bytes / 1024 / 1024).toFixed(2)} MB)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-500">Brak (opcjonalny)</span>
                  )}
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

          <StructuredEditor projectId={project.id} defaultLang={project.default_lang} />
        </>
      )}
    </div>
  );
}
