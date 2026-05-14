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

interface MappingSuggestion {
  image_id: string;
  image_name: string;
  image_description: string | null;
  suggested_page_id: string | null;
  suggested_page_number: number | null;
  suggested_page_title: string | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
}

export default function Gen4ImagePanel({ projectId, pages }: Props): React.ReactElement {
  const [images, setImages] = useState<Gen4Image[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<MappingSuggestion[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

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

  const fetchMapping = async () => {
    setMappingBusy(true);
    setError(null);
    setSuggestions([]);
    setAccepted(new Set());
    try {
      const res = await fetch(`${API}/projects/${projectId}/image-mapping/preview/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      const j = JSON.parse(text) as { mappings: MappingSuggestion[]; message?: string };
      setSuggestions(j.mappings ?? []);
      // Pre-zaznacz propozycje z confidence high/medium.
      const preset = new Set<string>();
      for (const s of j.mappings ?? []) {
        if (s.suggested_page_id && (s.confidence === "high" || s.confidence === "medium")) {
          preset.add(s.image_id);
        }
      }
      setAccepted(preset);
      setMappingOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "mapping preview failed");
    } finally {
      setMappingBusy(false);
    }
  };

  const applyMapping = async () => {
    const toApply = suggestions.filter((s) => accepted.has(s.image_id) && s.suggested_page_id);
    if (toApply.length === 0) {
      setMappingOpen(false);
      return;
    }
    setMappingBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/image-mapping/apply/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: toApply.map((s) => ({
            image_id: s.image_id,
            preferred_page_id: s.suggested_page_id,
          })),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      setMappingOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "apply mapping failed");
    } finally {
      setMappingBusy(false);
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={mappingBusy || images.length === 0 || pages.length === 0}
            onClick={() => void fetchMapping()}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
            title={
              images.length === 0
                ? "Wgraj najpierw obrazki"
                : pages.length === 0
                  ? "Projekt nie ma stron"
                  : "AI zaproponuje na której stronie umieścić każdy obrazek"
            }
          >
            {mappingBusy ? "AI analizuje..." : "🔮 Zaproponuj rozmieszczenie przez AI"}
          </button>
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
                projectId={projectId}
                onUpdate={(patch) => void updateImage(img.id, patch)}
                onRemove={() => void remove(img.id)}
              />
            ))}
          </div>
        )}
      </div>

      {mappingOpen && (
        <MappingModal
          suggestions={suggestions}
          accepted={accepted}
          setAccepted={setAccepted}
          busy={mappingBusy}
          onClose={() => setMappingOpen(false)}
          onApply={() => void applyMapping()}
        />
      )}
    </div>
  );
}

interface MappingModalProps {
  suggestions: MappingSuggestion[];
  accepted: Set<string>;
  setAccepted: (s: Set<string>) => void;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}

function MappingModal({ suggestions, accepted, setAccepted, busy, onClose, onApply }: MappingModalProps): React.ReactElement {
  const toggle = (id: string) => {
    const next = new Set(accepted);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAccepted(next);
  };
  const confColor = (c: MappingSuggestion["confidence"]) =>
    c === "high" ? "bg-emerald-100 text-emerald-800"
    : c === "medium" ? "bg-amber-100 text-amber-800"
    : c === "low" ? "bg-slate-100 text-slate-700"
    : "bg-red-50 text-red-700";

  const acceptedCount = suggestions.filter((s) => accepted.has(s.image_id) && s.suggested_page_id).length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="my-8 w-full max-w-4xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">
            🔮 Propozycja rozmieszczenia obrazków
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>

        <div className="p-5">
          <p className="mb-3 text-xs text-slate-600">
            AI przeanalizował opisy obrazków i tytuły stron. Zaznacz te, które chcesz
            zatwierdzić — propozycje z wysoką pewnością są wstępnie zaznaczone.
            Po kliknięciu „Zastosuj" w każdym zaznaczonym obrazku ustawi się <em>preferowana strona</em>,
            a kolejne uruchomienie auto-populate wstawi obrazek na właściwej stronie.
          </p>

          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                <th className="p-2 w-8"></th>
                <th className="p-2">Obrazek</th>
                <th className="p-2">Propozycja</th>
                <th className="p-2 w-20">Pewność</th>
                <th className="p-2">Powód</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => {
                const checkable = !!s.suggested_page_id;
                return (
                  <tr key={s.image_id} className="border-b border-slate-100 align-top">
                    <td className="p-2">
                      <input
                        type="checkbox"
                        disabled={!checkable || busy}
                        checked={accepted.has(s.image_id)}
                        onChange={() => toggle(s.image_id)}
                      />
                    </td>
                    <td className="p-2">
                      <div className="font-medium text-slate-800">{s.image_name}</div>
                      <div className="text-[10px] text-slate-500">
                        {s.image_description ?? <span className="italic text-amber-700">(brak opisu)</span>}
                      </div>
                    </td>
                    <td className="p-2">
                      {s.suggested_page_id ? (
                        <span className="font-medium text-slate-800">
                          #{s.suggested_page_number} {s.suggested_page_title}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">— bez przypisania —</span>
                      )}
                    </td>
                    <td className="p-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confColor(s.confidence)}`}>
                        {s.confidence}
                      </span>
                    </td>
                    <td className="p-2 text-slate-600">{s.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {suggestions.length === 0 && (
            <p className="py-6 text-center text-xs text-slate-500">Brak propozycji.</p>
          )}

          <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3">
            <span className="text-xs text-slate-500">
              Wybrano: <strong>{acceptedCount}</strong> z {suggestions.length}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Anuluj
              </button>
              <button
                type="button"
                disabled={busy || acceptedCount === 0}
                onClick={onApply}
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                {busy ? "Zapisuję..." : `Zastosuj zaznaczone (${acceptedCount})`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ImageCardProps {
  image: Gen4Image;
  pages: PageOption[];
  projectId: string;
  onUpdate: (patch: Partial<Pick<Gen4Image, "description" | "preferred_page_id">>) => void;
  onRemove: () => void;
}

interface Callout {
  label_pl: string;
  label_en?: string;
  description?: string;
  bbox_ymin: number;
  bbox_xmin: number;
  bbox_ymax: number;
  bbox_xmax: number;
}

function ImageCard({ image, pages, projectId, onUpdate, onRemove }: ImageCardProps): React.ReactElement {
  const [desc, setDesc] = useState(image.description ?? "");
  const [pageId, setPageId] = useState<string>(image.preferred_page_id ?? "");
  const [calloutsBusy, setCalloutsBusy] = useState(false);
  const [calloutsResult, setCalloutsResult] = useState<{
    callouts: Callout[];
    product_description: string | null;
  } | null>(null);
  const [calloutsError, setCalloutsError] = useState<string | null>(null);

  const sizeKb = image.size_bytes ? Math.round(image.size_bytes / 1024) : null;
  const hasDescription = (image.description ?? "").trim().length > 0;

  const runAutoCallouts = async () => {
    setCalloutsBusy(true);
    setCalloutsError(null);
    setCalloutsResult(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/auto-callouts/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_id: image.id, language: "pl" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as {
        callouts: Callout[];
        product_description: string | null;
        invalid_count?: number;
      };
      setCalloutsResult({ callouts: j.callouts ?? [], product_description: j.product_description });
    } catch (err) {
      setCalloutsError(err instanceof Error ? err.message : "Gemini failed");
    } finally {
      setCalloutsBusy(false);
    }
  };

  const applyCallouts = async (targetPageId: string) => {
    if (!calloutsResult) return;
    setCalloutsBusy(true);
    setCalloutsError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/auto-callouts/apply/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_id: image.id,
          target_page_id: targetPageId,
          callouts: calloutsResult.callouts,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { elements_created: number };
      alert(`Dodano ${j.elements_created} elementów na stronie. Otwórz edytor żeby zobaczyć.`);
      setCalloutsResult(null);
    } catch (err) {
      setCalloutsError(err instanceof Error ? err.message : "apply failed");
    } finally {
      setCalloutsBusy(false);
    }
  };

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

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void runAutoCallouts()}
            disabled={calloutsBusy}
            className="rounded border border-purple-300 bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800 hover:bg-purple-100 disabled:opacity-40"
            title="Gemini 2.5 Pro Vision identyfikuje przyciski/porty/czujniki na zdjęciu"
          >
            {calloutsBusy ? "Analizuję (~30s)..." : "✨ Callouts AI"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="text-[10px] font-medium text-red-700 hover:underline"
          >
            Usuń
          </button>
        </div>

        {calloutsError && (
          <p className="rounded border border-red-200 bg-red-50 px-1.5 py-1 text-[10px] text-red-800">
            ❌ {calloutsError}
          </p>
        )}

        {calloutsResult && (
          <div className="rounded border border-purple-200 bg-purple-50 p-1.5 text-[10px]">
            <p className="mb-1 font-semibold text-purple-900">
              ✨ AI znalazł {calloutsResult.callouts.length} interface points:
            </p>
            {calloutsResult.product_description && (
              <p className="mb-1 italic text-purple-700">{calloutsResult.product_description}</p>
            )}
            <ul className="mb-2 max-h-32 overflow-auto space-y-0.5 text-purple-900">
              {calloutsResult.callouts.map((c, i) => (
                <li key={i}>
                  <strong>{i + 1}.</strong> {c.label_pl}
                  {c.description ? ` — ${c.description}` : ""}
                </li>
              ))}
            </ul>
            <label className="block">
              <span className="text-purple-700">Wstaw do strony:</span>
              <select
                onChange={(e) => {
                  if (e.target.value) void applyCallouts(e.target.value);
                }}
                disabled={calloutsBusy}
                defaultValue=""
                className="mt-0.5 w-full rounded border border-purple-300 px-1 py-0.5"
              >
                <option value="">— wybierz stronę —</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    #{p.page_number} {p.title ?? p.template ?? "strona"}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setCalloutsResult(null)}
              className="mt-1 text-[10px] text-purple-600 hover:underline"
            >
              Anuluj
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
