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
  document_type?: string | null;
  device_type?: string | null;
}

const API_BASE = "/generator-instrukcji/api/v4";

export default function AiHomePage(): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "draft" | "generating" | "error">("all");

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

  const filtered = projects.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const haystack = [
      p.name,
      p.document_type ?? "",
      p.device_type ?? "",
      p.default_lang,
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });

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
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Szukaj po nazwie, typie dokumentu, urządzeniu…"
              className="flex-1 min-w-[200px] rounded border border-slate-300 px-2 py-1 text-sm focus:border-purple-500 focus:outline-none"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="all">Wszystkie statusy</option>
              <option value="ready">Ready</option>
              <option value="generating">Generating</option>
              <option value="draft">Draft</option>
              <option value="error">Error</option>
            </select>
            <span className="text-xs text-slate-500">
              {filtered.length}/{projects.length}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
              Nic nie pasuje do filtra. <button type="button" onClick={() => { setSearch(""); setStatusFilter("all"); }} className="underline hover:text-slate-700">Wyczyść filtr</button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
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
        </>
      )}

      <p className="mt-10 text-xs uppercase tracking-[0.16em] text-slate-400">
        Generator AI · v4 · Claude Haiku 4.5 (skeleton + per-page) · Sonnet 4.6 (premium)
      </p>
    </div>
  );
}
