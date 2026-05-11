"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Project {
  id: string;
  name: string;
  source_pdf_pages_count: number | null;
  created_at: string;
  updated_at: string;
}

const API_BASE = "/generator-instrukcji/api/v2";

export default function HomePage(): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Projekty</h2>
          <p className="text-sm text-slate-500">
            Lista wszystkich instrukcji w trakcie pracy.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowUpload((v) => !v)}
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700"
        >
          {showUpload ? "Anuluj" : "+ Nowy projekt"}
        </button>
      </div>

      {showUpload && (
        <UploadForm
          onUploaded={() => {
            setShowUpload(false);
            void refresh();
          }}
        />
      )}

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

      {!loading && !error && projects.length === 0 && !showUpload && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <p className="text-sm font-medium text-slate-700">Brak projektów.</p>
          <p className="mt-2 text-sm text-slate-500">
            Stwórz nowy projekt, aby rozpocząć pracę nad instrukcją.
          </p>
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="mt-6 inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-100"
          >
            Stwórz nowy projekt
          </button>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/table/projects/${p.id}`}
                className="block rounded-xl border border-slate-200 bg-white p-5 transition hover:border-slate-400 hover:shadow-sm"
              >
                <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {p.source_pdf_pages_count != null
                    ? `${p.source_pdf_pages_count} stron`
                    : "PDF nie sparsowany"}
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
        Edytor tabelaryczny — Faza Y · 3-kolumnowy widok (w budowie).
      </p>
    </div>
  );
}

function UploadForm({ onUploaded }: { onUploaded: () => void }): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  const handleFile = (f: File | null | undefined) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setError("Plik musi być PDF.");
      return;
    }
    setFile(f);
    if (!name) setName(f.name.replace(/\.pdf$/i, ""));
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      // Step 1 — register project + get signed upload URL.
      setStage("Tworzenie projektu...");
      const initRes = await fetch(`${API_BASE}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), fileSize: file.size }),
      });
      if (!initRes.ok) {
        const j = await initRes.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${initRes.status}`);
      }
      const { id, uploadUrl } = (await initRes.json()) as {
        id: string;
        uploadUrl: string;
      };

      // Step 2 — direct PUT to Supabase Storage with progress.
      setStage("Wgrywanie PDF...");
      await uploadWithProgress(uploadUrl, file, (pct) => setProgress(pct));

      // Step 3 — finalize (verify upload + commit source_pdf_path).
      setStage("Finalizacja...");
      const finRes = await fetch(`${API_BASE}/projects/${id}/finalize`, {
        method: "POST",
      });
      if (!finRes.ok) {
        const j = await finRes.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${finRes.status}`);
      }

      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
      setProgress(null);
      setStage(null);
    }
  };

  return (
    <form onSubmit={submit} className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
      <label
        htmlFor="pdf-input"
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        className={
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 text-center transition " +
          (dragActive
            ? "border-slate-900 bg-slate-50"
            : "border-slate-300 hover:border-slate-400")
        }
      >
        <input
          id="pdf-input"
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <p className="text-sm font-medium text-slate-700">
          {file ? file.name : "Przeciągnij PDF tutaj lub kliknij, aby wybrać"}
        </p>
        {file && (
          <p className="mt-1 text-xs text-slate-500">
            {(file.size / 1024 / 1024).toFixed(2)} MB
          </p>
        )}
      </label>

      <div className="mt-4">
        <label htmlFor="project-name" className="block text-xs font-medium text-slate-700">
          Nazwa projektu
        </label>
        <input
          id="project-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="np. GJD.15 BG — QSG+KG"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          required
        />
      </div>

      {busy && progress != null && (
        <div className="mt-4">
          <p className="text-xs text-slate-500">{stage}</p>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-slate-900 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-slate-400">{progress.toFixed(0)}%</p>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-700">{error}</p>
      )}

      <div className="mt-5 flex justify-end gap-3">
        <button
          type="submit"
          disabled={!file || !name.trim() || busy}
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Wgrywanie..." : "Stwórz projekt"}
        </button>
      </div>
    </form>
  );
}

function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/pdf");
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload HTTP ${xhr.status}: ${xhr.responseText}`));
    });
    xhr.addEventListener("error", () => reject(new Error("upload network error")));
    xhr.send(file);
  });
}
