"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Project {
  id: string;
  name: string;
  status: string;
  pages_count: number;
  default_lang: string;
  created_at: string;
}

const API_BASE = "/generator-instrukcji/api/v4";

export default function AiHomePage(): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/projects`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setProjects(json.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Generator AI ✨</h2>
          <p className="text-sm text-slate-500">
            Lista projektów wygenerowanych przez AI.
          </p>
        </div>
        <Link
          href="/ai/new"
          className="inline-flex items-center gap-2 rounded-md bg-purple-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-purple-800"
        >
          ✨ Nowy projekt AI
        </Link>
      </div>

      {loading && (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">
          Ładowanie...
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          Błąd: {error}
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="rounded-xl border border-dashed border-purple-300 bg-purple-50 p-12 text-center">
          <p className="text-sm font-medium text-slate-800">Jeszcze nie masz projektów AI.</p>
          <p className="mt-2 text-sm text-slate-600">
            Kliknij <strong>✨ Nowy projekt AI</strong>, opisz model i funkcje, AI wygeneruje
            kompletny szkic instrukcji w PL — kilkanaście stron z gotowymi tekstami.
          </p>
          <Link
            href="/ai/new"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-purple-700 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-800"
          >
            ✨ Stwórz pierwszy projekt
          </Link>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/ai/projects/${p.id}`}
                className="block rounded-xl border border-slate-200 bg-white p-5 transition hover:border-purple-400 hover:shadow-sm"
              >
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                  <span className={
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase " +
                    (p.status === "ready" ? "bg-emerald-100 text-emerald-800" :
                     p.status === "generating" ? "bg-amber-100 text-amber-800" :
                     p.status === "error" ? "bg-red-100 text-red-800" :
                     "bg-slate-100 text-slate-700")
                  }>{p.status}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {p.pages_count > 0 ? `${p.pages_count} stron` : "—"} · {p.default_lang.toUpperCase()}
                </p>
                <p className="mt-3 text-xs text-slate-400">
                  Utworzony: {new Date(p.created_at).toLocaleString("pl-PL")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-10 text-xs uppercase tracking-[0.16em] text-slate-400">
        Generator AI · v4 · model Claude Sonnet 4.6 (initial) + Haiku 4.5 (edycja)
      </p>
    </div>
  );
}
