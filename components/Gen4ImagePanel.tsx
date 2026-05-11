"use client";

/**
 * Biblioteka obrazków projektu v4. Lista miniatur z opisami i przypisaniem
 * do preferowanej strony. AI używa kolumny `description` żeby zdecydować
 * gdzie i którą grafikę wstawić (faza 2b — jeszcze nie zaimplementowana).
 *
 * Drag & drop wgrywa wiele plików naraz. Każdy obrazek dostaje placeholder
 * opisu którego user może doedytować — bez sensownych opisów AI nie będzie
 * w stanie skojarzyć obrazków ze stronami.
 */

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface Gen4Image {
  id: string;
  name: string;
  path: string;
  size_bytes: number | null;
  width_px: number | null;
  height_px: number | null;
  mime_type: string | null;
  description: string | null;
  preferred_page_id: string | null;
  url: string | null;
  created_at: string;
}

interface PageOption {
  id: string;
  page_number: number;
  template: string | null;
  title: string | null;
}

interface Props {
  projectId: string;
  pages: PageOption[];
}

export default function Gen4ImagePanel({ projectId, pages }: Props): React.ReactElement {
  const [images, setImages] = useState<Gen4Image[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/images/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { images: Gen4Image[] };
      setImages(j.images ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`${API}/projects/${projectId}/images/`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const text = await res.text();
          let parsed: { error?: string } = {};
          try { parsed = JSON.parse(text); } catch { /* ignore */ }
          throw new Error(parsed.error ?? `HTTP ${res.status}: ${file.name}`);
        }
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  const updateImage = async (id: string, patch: Partial<Pick<Gen4Image, "description" | "preferred_page_id" | "name">>) => {
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    try {
      const res = await fetch(`${API}/images/${id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "update failed");
      void refresh();
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Usunąć obrazek?")) return;
    try {
      const res = await fetch(`${API}/images/${id}/`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setImages((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) void upload(files);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">📷 Biblioteka obrazków</h3>
          <p className="text-xs text-slate-500">
            Wgraj grafiki (PNG/JPG/WEBP, max 10 MB) i opisz każdą krótko —
            opis pozwala AI dopasować obrazek do właściwej strony instrukcji.
          </p>
        </div>
        <label className="cursor-pointer rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">
          {busy ? "Wgrywam..." : "+ Wgraj obrazki"}
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            disabled={busy}
            onChange={(e) => void upload(Array.from(e.target.files ?? []))}
          />
        </label>
      </div>

      {error && (
        <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">zamknij</button>
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={
          "rounded-lg border-2 border-dashed p-3 transition " +
          (drag ? "border-emerald-500 bg-emerald-50" : "border-slate-200 bg-slate-50")
        }
      >
        {loading && <p className="py-4 text-center text-xs text-slate-500">Ładuję bibliotekę...</p>}
        {!loading && images.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-500">
            Brak obrazków. Przeciągnij pliki tutaj albo kliknij <strong>+ Wgraj obrazki</strong>.
          </p>
        )}

        {!loading && images.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {images.map((img) => (
              <ImageCard
                key={img.id}
                image={img}
                pages={pages}
                onUpdate={(patch) => void updateImage(img.id, patch)}
                onRemove={() => void remove(img.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ImageCardProps {
  image: Gen4Image;
  pages: PageOption[];
  onUpdate: (patch: Partial<Pick<Gen4Image, "description" | "preferred_page_id">>) => void;
  onRemove: () => void;
}

function ImageCard({ image, pages, onUpdate, onRemove }: ImageCardProps): React.ReactElement {
  const [desc, setDesc] = useState(image.description ?? "");
  const [pageId, setPageId] = useState<string>(image.preferred_page_id ?? "");

  const sizeKb = image.size_bytes ? Math.round(image.size_bytes / 1024) : null;
  const hasDescription = (image.description ?? "").trim().length > 0;

  return (
    <div className="overflow-hidden rounded border border-slate-200 bg-white">
      <div className="relative h-32 bg-slate-100">
        {image.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt={image.name} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-400">brak podglądu</div>
        )}
        {!hasDescription && (
          <span className="absolute right-1 top-1 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
            BRAK OPISU
          </span>
        )}
      </div>
      <div className="space-y-2 p-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="truncate font-medium text-slate-700" title={image.name}>{image.name}</span>
          {sizeKb !== null && <span className="ml-2 shrink-0 text-slate-400">{sizeKb} KB</span>}
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Opis (dla AI)</span>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              const trimmed = desc.trim();
              if (trimmed !== (image.description ?? "")) {
                onUpdate({ description: trimmed || null });
              }
            }}
            rows={2}
            placeholder='np. "ekran logowania w aplikacji" / "front zegarka GJD.16"'
            className="mt-0.5 w-full rounded border border-slate-300 px-1.5 py-1"
          />
        </label>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Preferowana strona (opcjonalnie)</span>
          <select
            value={pageId}
            onChange={(e) => {
              const v = e.target.value;
              setPageId(v);
              onUpdate({ preferred_page_id: v || null });
            }}
            className="mt-0.5 w-full rounded border border-slate-300 px-1.5 py-1"
          >
            <option value="">— (AI sam dobierze)</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                #{p.page_number} {p.title ?? (p.template ?? "strona")}
              </option>
            ))}
          </select>
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRemove}
            className="text-[10px] font-medium text-red-700 hover:underline"
          >
            Usuń
          </button>
        </div>
      </div>
    </div>
  );
}
