"use client";

/**
 * Editor (v4 — port from v3 with /api/v4 endpoints + origin tracking) — build pages from templates and elements.
 *
 * Layout (CSS grid):
 *   ┌────────┬─────────────────────────┬──────────────┐
 *   │ Pages  │ Toolbar (add element)   │ Properties   │
 *   │ list   ├─────────────────────────┤ + reference  │
 *   │        │ Canvas (current page)   │ PDF panel    │
 *   └────────┴─────────────────────────┴──────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = "/generator-instrukcji/api/v4";
const MM_PER_PT = 25.4 / 72;
const DEFAULT_DISPLAY_SCALE = 6; // px per mm — 76mm × 6 = 456px on screen
const PT_TO_PX_AT_SCALE = (scale: number) => scale * MM_PER_PT; // 1pt → px at given mm-scale

type ElementType = "text" | "image" | "line" | "rect" | "qr" | "page_number" | "callout";

interface PageRow {
  id: string;
  page_number: number;
  width_mm: number;
  height_mm: number;
  template: string | null;
  title: string | null;
}

interface ElementRow {
  id: string;
  type: ElementType;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  z_index: number;
  rotation_deg: number;
  properties: Record<string, unknown>;
}

const TEMPLATES: Array<{ id: string; label: string; description: string }> = [
  { id: "blank", label: "Pusta", description: "Czysta strona bez elementów" },
  { id: "cover", label: "Okładka", description: "Logo + model + wersja" },
  { id: "toc", label: "Spis treści", description: "Lista pozostałych stron z numerami" },
  { id: "step", label: "Krok", description: "Numerowany krok z grafiką + opisem" },
  { id: "warranty_terms", label: "Gwarancja — warunki", description: "Lista key-value" },
  { id: "warranty_stamp", label: "Gwarancja — pieczątka", description: "Tabela na pieczątkę" },
  { id: "contact", label: "Kontakt", description: "Email, www, QR" },
];

const PAGE_BG = "#ffffff";

export default function Gen4Editor({
  projectId,
  defaultLang,
}: {
  projectId: string;
  defaultLang: string;
}): React.ReactElement {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [elements, setElements] = useState<ElementRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddPage, setShowAddPage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(DEFAULT_DISPLAY_SCALE);
  const [rightTab, setRightTab] = useState<"properties" | "ai">("properties");

  const currentPage = pages.find((p) => p.id === currentPageId);
  const selectedElement = elements.find((e) => e.id === selectedId);
  const totalPages = pages.length;

  // Load pages once.
  const refreshPages = useCallback(async () => {
    try {
      const res = await fetch(`${API}/projects/${projectId}/pages`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { pages: PageRow[] };
      setPages(j.pages);
      if (j.pages.length > 0 && !currentPageId) setCurrentPageId(j.pages[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch pages failed");
    }
  }, [projectId, currentPageId]);

  useEffect(() => { void refreshPages(); }, [refreshPages]);

  // Load elements for the current page.
  useEffect(() => {
    if (!currentPageId) {
      setElements([]);
      return;
    }
    let active = true;
    fetch(`${API}/pages/${currentPageId}/elements`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { elements: ElementRow[] }) => { if (active) setElements(j.elements ?? []); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "fetch elements failed"); });
    return () => { active = false; };
  }, [currentPageId]);

  const addPage = async (template: string) => {
    setShowAddPage(false);
    try {
      const res = await fetch(`${API}/projects/${projectId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { page: PageRow };
      setPages((prev) => [...prev, j.page]);
      setCurrentPageId(j.page.id);
      // If template seeded any default elements, load them.
      // (Server-side seeding can be added later — V3.3.)
    } catch (err) {
      setError(err instanceof Error ? err.message : "add page failed");
    }
  };

  const deletePage = async (pageId: string) => {
    if (!confirm("Usunąć stronę z wszystkimi elementami?")) return;
    try {
      const res = await fetch(`${API}/pages/${pageId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPages((prev) => prev.filter((p) => p.id !== pageId));
      if (currentPageId === pageId) {
        setCurrentPageId(pages.find((p) => p.id !== pageId)?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  const renamePage = async (page: PageRow) => {
    if (page.template === "cover") {
      setError("Strona okładkowa nie ma tytułu.");
      return;
    }
    const next = window.prompt("Nowy tytuł strony:", page.title ?? "");
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (trimmed === (page.title ?? "")) return;
    try {
      const res = await fetch(`${API}/pages/${page.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPages((prev) =>
        prev.map((p) => (p.id === page.id ? { ...p, title: trimmed || null } : p)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename failed");
    }
  };

  const addElement = async (type: ElementType) => {
    if (!currentPageId || !currentPage) return;
    const properties: Record<string, unknown> = (() => {
      switch (type) {
        case "text": return { content: "Nowy tekst", font_size_pt: 9, color: "#0f172a", align: "left" };
        case "rect": return { stroke_width: 0.3, color: "#0f172a", fill: "transparent" };
        case "line": return { stroke_width: 0.5, color: "#0f172a" };
        case "image": return { image_id: null, fit_mode: "contain" };
        case "qr": return { url: "https://locon.pl/", size_mm: 20 };
        case "page_number": return { format: "{n} / {N}" };
        case "callout": return { content: "Etykieta", font_size_pt: 7, color: "#0f172a" };
      }
    })();
    const defaults = type === "qr"
      ? { x_mm: 5, y_mm: 5, w_mm: 20, h_mm: 20 }
      : type === "line"
        ? { x_mm: 5, y_mm: 5, w_mm: 30, h_mm: 0.5 }
        : type === "image"
          ? { x_mm: 5, y_mm: 5, w_mm: 30, h_mm: 30 }
          : { x_mm: 5, y_mm: 5, w_mm: 30, h_mm: 5 };

    try {
      const res = await fetch(`${API}/pages/${currentPageId}/elements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...defaults, z_index: elements.length, properties }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { element: ElementRow };
      setElements((prev) => [...prev, j.element]);
      setSelectedId(j.element.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "add element failed");
    }
  };

  const updateElement = useCallback(async (id: string, patch: Partial<ElementRow>) => {
    setElements((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    try {
      await fetch(`${API}/elements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      console.error("[v3 element patch]", err);
    }
  }, []);

  const deleteElement = async (id: string) => {
    setElements((prev) => prev.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
    try {
      await fetch(`${API}/elements/${id}`, { method: "DELETE" });
    } catch (err) {
      console.error("[v3 element delete]", err);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">zamknij</button>
        </div>
      )}

      <div className="grid min-h-[700px] grid-cols-[220px_minmax(0,1fr)_280px]">
        {/* ─── Pages list (left) ───────────────────────────────────────── */}
        <aside className="border-r border-slate-200 bg-slate-50 p-3">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Strony</h3>
            <button
              type="button"
              onClick={() => setShowAddPage((v) => !v)}
              className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-slate-700"
            >
              + Dodaj
            </button>
          </div>
          {showAddPage && (
            <div className="mb-3 rounded border border-slate-200 bg-white p-2">
              <p className="mb-2 text-[11px] text-slate-500">Wybierz szablon:</p>
              <div className="space-y-1">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => addPage(t.id)}
                    className="block w-full rounded border border-slate-200 bg-slate-50 px-2 py-1 text-left text-xs hover:border-slate-400 hover:bg-white"
                  >
                    <div className="font-medium text-slate-800">{t.label}</div>
                    <div className="text-[10px] text-slate-500">{t.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul className="space-y-1">
            {pages.length === 0 && (
              <li className="rounded border border-dashed border-slate-300 p-3 text-center text-[11px] text-slate-500">
                Brak stron. Kliknij <strong>+ Dodaj</strong>.
              </li>
            )}
            {pages.map((p) => {
              const displayTitle =
                p.template === "cover"
                  ? "Okładka"
                  : p.template === "toc"
                    ? p.title ?? "Spis treści"
                    : p.title ?? "(brak tytułu — kliknij dwukrotnie)";
              const titleColor =
                p.template === "cover"
                  ? "text-slate-500 italic"
                  : p.title
                    ? "text-slate-700"
                    : "text-amber-700";
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setCurrentPageId(p.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      void renamePage(p);
                    }}
                    title="Kliknij dwukrotnie aby zmienić tytuł"
                    className={
                      "group flex w-full items-center justify-between rounded border px-2 py-1.5 text-left text-xs " +
                      (p.id === currentPageId
                        ? "border-blue-500 bg-blue-50 text-slate-900"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-400")
                    }
                  >
                    <span className="flex min-w-0 items-baseline gap-1">
                      <span className="font-mono font-semibold text-slate-500">#{p.page_number}</span>
                      <span className={`truncate ${titleColor}`}>{displayTitle}</span>
                    </span>
                    <span className="ml-1 flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void renamePage(p); }}
                        className="text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-slate-700"
                        title="Zmień tytuł"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void deletePage(p.id); }}
                        className="text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-red-700"
                        title="Usuń stronę"
                      >
                        ×
                      </button>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* ─── Canvas + toolbar (center) ───────────────────────────────── */}
        <main className="flex flex-col bg-slate-100">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 text-xs">
            <span className="font-medium text-slate-600">Dodaj element:</span>
            {(["text", "image", "line", "rect", "qr", "page_number"] as ElementType[]).map((t) => (
              <button
                key={t}
                type="button"
                disabled={!currentPageId}
                onClick={() => void addElement(t)}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 hover:border-slate-500 hover:bg-slate-50 disabled:opacity-30"
              >
                {labelForType(t)}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-slate-500">Zoom:</span>
              <button type="button" onClick={() => setZoom((z) => Math.max(2, z - 1))}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50">−</button>
              <span className="font-mono text-slate-600">{zoom}×</span>
              <button type="button" onClick={() => setZoom((z) => Math.min(16, z + 1))}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50">+</button>
              <span className="ml-2 text-slate-400">
                {currentPage ? `${currentPage.width_mm}×${currentPage.height_mm} mm` : "—"}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-6">
            {!currentPage && (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
                Brak wybranej strony. Dodaj pierwszą po lewej.
              </div>
            )}
            {currentPage && (
              <PageCanvas
                page={currentPage}
                elements={elements}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onUpdate={updateElement}
                zoom={zoom}
                defaultLang={defaultLang}
                totalPages={totalPages}
              />
            )}
          </div>
        </main>

        {/* ─── Right sidebar — Properties / AI Assistant tabs ──────────── */}
        <aside className="flex flex-col border-l border-slate-200 bg-slate-50">
          <div className="flex border-b border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => setRightTab("properties")}
              className={
                "flex-1 px-3 py-2 text-xs font-semibold transition " +
                (rightTab === "properties"
                  ? "border-b-2 border-slate-900 text-slate-900"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              Właściwości
            </button>
            <button
              type="button"
              onClick={() => setRightTab("ai")}
              className={
                "flex-1 px-3 py-2 text-xs font-semibold transition " +
                (rightTab === "ai"
                  ? "border-b-2 border-purple-700 text-purple-800"
                  : "text-slate-500 hover:text-purple-700")
              }
            >
              ✨ Assistant AI
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {rightTab === "properties" && (
              <>
                {!selectedElement && (
                  <p className="rounded border border-dashed border-slate-300 bg-white p-3 text-center text-[11px] text-slate-500">
                    Wybierz element na stronie aby edytować jego właściwości.
                  </p>
                )}
                {selectedElement && (
                  <ElementProperties
                    element={selectedElement}
                    onUpdate={(patch) => void updateElement(selectedElement.id, patch)}
                    onDelete={() => void deleteElement(selectedElement.id)}
                  />
                )}
              </>
            )}
            {rightTab === "ai" && currentPageId && (
              <PageAiAssistant
                pageId={currentPageId}
                pageNumber={currentPage?.page_number ?? 0}
                onApplied={async () => {
                  // Reload elements for the page after a successful replace.
                  const res = await fetch(`${API}/pages/${currentPageId}/elements`, { cache: "no-store" });
                  if (res.ok) {
                    const j = (await res.json()) as { elements: ElementRow[] };
                    setElements(j.elements ?? []);
                    setSelectedId(null);
                  }
                }}
              />
            )}
            {rightTab === "ai" && !currentPageId && (
              <p className="rounded border border-dashed border-slate-300 bg-white p-3 text-center text-[11px] text-slate-500">
                Wybierz stronę po lewej, aby użyć Asystenta AI.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function labelForType(t: ElementType): string {
  switch (t) {
    case "text": return "Tekst";
    case "image": return "Obraz";
    case "line": return "Linia";
    case "rect": return "Prostokąt";
    case "qr": return "QR";
    case "page_number": return "Nr strony";
    case "callout": return "Etykieta";
  }
}

interface PageCanvasProps {
  page: PageRow;
  elements: ElementRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<ElementRow>) => void;
  zoom: number;
  defaultLang: string;
  totalPages: number;
}

function PageCanvas({
  page, elements, selectedId, onSelect, onUpdate, zoom, defaultLang, totalPages,
}: PageCanvasProps): React.ReactElement {
  const wPx = page.width_mm * zoom;
  const hPx = page.height_mm * zoom;
  const interactRef = useRef<{ unset: () => void } | null>(null);

  // (zoom is referenced in handlers below — declared in component scope.)
  // Wire interactjs to the currently selected element for drag/resize.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      const interactMod = await import("interactjs");
      if (cancelled) return;
      const interact = interactMod.default;
      const el = document.querySelector<HTMLElement>(`[data-el-id="${selectedId}"]`);
      if (!el) return;
      const inst = interact(el)
        .draggable({
          listeners: {
            move(e) {
              const t = e.target as HTMLElement;
              const left = (parseFloat(t.style.left) || 0) + e.dx;
              const top = (parseFloat(t.style.top) || 0) + e.dy;
              t.style.left = `${left}px`;
              t.style.top = `${top}px`;
            },
            end(e) {
              const t = e.target as HTMLElement;
              const xMm = (parseFloat(t.style.left) || 0) / zoom;
              const yMm = (parseFloat(t.style.top) || 0) / zoom;
              onUpdate(selectedId, { x_mm: xMm, y_mm: yMm });
            },
          },
        })
        .resizable({
          edges: { left: true, right: true, top: true, bottom: true },
          margin: 5,
          listeners: {
            move(e) {
              const t = e.target as HTMLElement;
              let left = parseFloat(t.style.left) || 0;
              let top = parseFloat(t.style.top) || 0;
              t.style.width = `${e.rect.width}px`;
              t.style.height = `${e.rect.height}px`;
              left += e.deltaRect.left;
              top += e.deltaRect.top;
              t.style.left = `${left}px`;
              t.style.top = `${top}px`;
            },
            end(e) {
              const t = e.target as HTMLElement;
              onUpdate(selectedId, {
                x_mm: (parseFloat(t.style.left) || 0) / zoom,
                y_mm: (parseFloat(t.style.top) || 0) / zoom,
                w_mm: (parseFloat(t.style.width) || 0) / zoom,
                h_mm: (parseFloat(t.style.height) || 0) / zoom,
              });
            },
          },
          modifiers: [interact.modifiers.restrictSize({ min: { width: 4, height: 2 } })],
        });
      interactRef.current = inst as unknown as { unset: () => void };
    })();
    return () => {
      cancelled = true;
      if (interactRef.current) interactRef.current.unset();
      interactRef.current = null;
    };
  }, [selectedId, onUpdate, zoom]);

  return (
    <div className="inline-block">
      <div
        className="relative shadow-md"
        style={{ width: `${wPx}px`, height: `${hPx}px`, background: PAGE_BG }}
        onClick={(e) => {
          // Click on bare canvas → deselect.
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        {elements.map((el) => (
          <ElementView
            key={el.id}
            el={el}
            selected={selectedId === el.id}
            onClick={() => onSelect(el.id)}
            onUpdate={onUpdate}
            zoom={zoom}
            defaultLang={defaultLang}
            pageNumber={page.page_number}
            totalPages={totalPages}
          />
        ))}
      </div>
      <p className="mt-2 text-center text-[11px] text-slate-400">
        Strona {page.page_number} · {page.width_mm}×{page.height_mm} mm · scale {zoom}×
      </p>
    </div>
  );
}

interface ElementViewProps {
  el: ElementRow;
  selected: boolean;
  onClick: () => void;
  onUpdate: (id: string, patch: Partial<ElementRow>) => void;
  zoom: number;
  defaultLang: string;
  pageNumber: number;
  totalPages: number;
}

function ElementView({ el, selected, onClick, onUpdate, zoom, defaultLang, pageNumber, totalPages }: ElementViewProps): React.ReactElement {
  const [editingText, setEditingText] = useState(false);
  const left = el.x_mm * zoom;
  const top = el.y_mm * zoom;
  const width = el.w_mm * zoom;
  const height = el.h_mm * zoom;
  const props = el.properties as Record<string, string | number>;

  // Auto-grow text/callout boxes whenever the rendered content overflows
  // the current width or height. Runs after every render that changes
  // content, font size, or zoom — including edits made in the right-side
  // properties panel (textarea), not just inline edits on the canvas.
  const textContent = (props.content as string) ?? "";
  const fontSizePtForMeasure = typeof props.font_size_pt === "number" ? props.font_size_pt : 9;
  useEffect(() => {
    if (el.type !== "text" && el.type !== "callout") return;
    if (editingText) return; // skip while user is actively typing
    if (!textContent) return;
    const fontSizePx = fontSizePtForMeasure * MM_PER_PT * zoom;
    // Off-screen measurement DIV with the same typography as the rendered
    // element. Width is fixed at the current box width; we read scrollHeight
    // to find out how tall the content actually wants to be.
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;visibility:hidden;left:-99999px;top:0;" +
      "white-space:pre-wrap;word-break:break-word;line-height:1.2;padding:1px 2px;" +
      "box-sizing:border-box;font-family:inherit";
    probe.style.fontSize = `${fontSizePx}px`;
    probe.style.width = `${el.w_mm * zoom}px`;
    probe.textContent = textContent;
    document.body.appendChild(probe);
    const measuredH = probe.scrollHeight;
    // Also measure unbounded width to know whether a single line would
    // fit if the box grew horizontally — useful for short single-line text.
    probe.style.width = "auto";
    probe.style.whiteSpace = "nowrap";
    const singleLineW = probe.scrollWidth;
    document.body.removeChild(probe);

    // Convert px → mm. Add a small margin so antialiasing doesn't clip glyphs.
    const neededHmm = measuredH / zoom + 0.3;
    const neededWmm = singleLineW / zoom + 0.5;

    const updates: Partial<ElementRow> = {};
    if (neededHmm > el.h_mm + 0.05) updates.h_mm = neededHmm;
    // Only widen the box if a wrapped line is overflowing; if the single-line
    // width fits in the current box, don't stretch — let it stay wrapped.
    if (singleLineW > el.w_mm * zoom + 1 && neededHmm > el.h_mm + 0.05) {
      // Content wraps and the wrapped height is too tall — bump width to a
      // sensible larger value so it can break more naturally next time.
      updates.w_mm = Math.min(neededWmm, el.w_mm * 2);
    }
    if (Object.keys(updates).length > 0) {
      onUpdate(el.id, updates);
    }
  }, [el.type, el.id, el.w_mm, el.h_mm, textContent, fontSizePtForMeasure, zoom, editingText, onUpdate]);

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    boxSizing: "border-box",
    transform: el.rotation_deg ? `rotate(${el.rotation_deg}deg)` : undefined,
  };

  if (el.type === "text" || el.type === "callout") {
    const fontSizePt = typeof props.font_size_pt === "number" ? props.font_size_pt : 9;
    // 1pt = 1/72 in = 25.4/72 mm; px at given zoom = pt * mm_per_pt * zoom.
    const fontSizePx = fontSizePt * MM_PER_PT * zoom;
    const content = (props.content as string) ?? "";
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onDoubleClick={(e) => { e.stopPropagation(); setEditingText(true); }}
        style={{
          ...baseStyle,
          // While text is being edited let the box grow to fit so the user
          // sees what they're typing instead of clipped letters; we'll
          // commit the auto-grown size on blur.
          width: editingText ? "auto" : `${width}px`,
          minWidth: editingText ? `${width}px` : undefined,
          height: editingText ? "auto" : `${height}px`,
          minHeight: editingText ? `${height}px` : undefined,
          color: (props.color as string) ?? "#0f172a",
          fontSize: `${fontSizePx}px`,
          textAlign: ((props.align as React.CSSProperties["textAlign"]) ?? "left"),
          lineHeight: 1.2,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: editingText ? "visible" : "hidden",
          outline: selected ? "2px solid #f59e0b" : "1px dashed rgba(100,116,139,0.4)",
          background: selected ? "rgba(254,243,199,0.4)" : "transparent",
          cursor: selected ? "move" : "pointer",
          padding: "1px 2px",
          touchAction: "none",
        }}
      >
        {editingText ? (
          <textarea
            value={content}
            autoFocus
            onChange={(e) => onUpdate(el.id, { properties: { ...props, content: e.target.value } })}
            onBlur={(e) => {
              // Auto-grow the bounding box to fit the typed content. We measure
              // the textarea's scrollWidth/Height (px) and convert back to mm.
              const ta = e.currentTarget;
              const newWmm = Math.max(el.w_mm, ta.scrollWidth / zoom + 1);
              const newHmm = Math.max(el.h_mm, ta.scrollHeight / zoom + 0.5);
              if (newWmm !== el.w_mm || newHmm !== el.h_mm) {
                onUpdate(el.id, { w_mm: newWmm, h_mm: newHmm });
              }
              setEditingText(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditingText(false);
              }
              // Enter without Shift commits; Shift+Enter inserts newline.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            rows={Math.max(1, content.split("\n").length)}
            className="block w-full resize-none bg-white px-1 outline-none"
            style={{
              fontSize: `${fontSizePx}px`,
              fontFamily: "inherit",
              color: "inherit",
              textAlign: ((props.align as React.CSSProperties["textAlign"]) ?? "left"),
              lineHeight: 1.2,
              minWidth: `${width}px`,
            }}
          />
        ) : (
          content || <span className="text-slate-400">(pusty)</span>
        )}
      </div>
    );
  }

  if (el.type === "rect") {
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={{
          ...baseStyle,
          border: `${(typeof props.stroke_width === "number" ? props.stroke_width : 0.3) * zoom}px solid ${(props.color as string) ?? "#0f172a"}`,
          background: (props.fill as string) ?? "transparent",
          outline: selected ? "2px solid #f59e0b" : undefined,
          cursor: selected ? "move" : "pointer",
          touchAction: "none",
        }}
      />
    );
  }

  if (el.type === "line") {
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={{
          ...baseStyle,
          borderTop: `${(typeof props.stroke_width === "number" ? props.stroke_width : 0.5) * zoom}px solid ${(props.color as string) ?? "#0f172a"}`,
          height: 0,
          outline: selected ? "2px solid #f59e0b" : undefined,
          cursor: selected ? "move" : "pointer",
          touchAction: "none",
        }}
      />
    );
  }

  if (el.type === "qr") {
    return (
      <QrElement
        elId={el.id}
        url={(props.url as string) ?? ""}
        baseStyle={baseStyle}
        selected={selected}
        onClick={onClick}
      />
    );
  }

  if (el.type === "image") {
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={{
          ...baseStyle,
          background: "linear-gradient(45deg,#cbd5e1 25%,#e2e8f0 25%,#e2e8f0 50%,#cbd5e1 50%,#cbd5e1 75%,#e2e8f0 75%,#e2e8f0)",
          backgroundSize: "12px 12px",
          color: "#475569",
          fontSize: "10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          outline: selected ? "2px solid #f59e0b" : "1px dashed rgba(100,116,139,0.4)",
          cursor: selected ? "move" : "pointer",
          touchAction: "none",
        }}
      >
        Obraz
      </div>
    );
  }

  if (el.type === "page_number") {
    const format = (props.format as string) ?? "{LANG} {n}/{N}";
    const rendered = format
      .replace(/\{n\}/g, String(pageNumber))
      .replace(/\{N\}/g, String(totalPages))
      .replace(/\{lang\}/g, defaultLang.toLowerCase())
      .replace(/\{LANG\}/g, defaultLang.toUpperCase());
    const fontSizePt = typeof props.font_size_pt === "number" ? props.font_size_pt : 6;
    const fontSizePx = fontSizePt * MM_PER_PT * zoom;
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={{
          ...baseStyle,
          color: (props.color as string) ?? "#475569",
          fontSize: `${fontSizePx}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          outline: selected ? "2px solid #f59e0b" : "1px dashed rgba(100,116,139,0.4)",
          cursor: selected ? "move" : "pointer",
          touchAction: "none",
        }}
      >
        {rendered}
      </div>
    );
  }

  return <></>;
}

interface ElementPropertiesProps {
  element: ElementRow;
  onUpdate: (patch: Partial<ElementRow>) => void;
  onDelete: () => void;
}

function ElementProperties({ element, onUpdate, onDelete }: ElementPropertiesProps): React.ReactElement {
  const props = element.properties as Record<string, string | number>;
  const setProp = (k: string, v: string | number) =>
    onUpdate({ properties: { ...props, [k]: v } });
  const setNumberProp = (k: string, v: string) => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) setProp(k, n);
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded border border-slate-200 bg-white p-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Typ: {element.type}
        </div>
        <Row label="x (mm)">
          <input type="number" step="0.1" value={element.x_mm.toFixed(1)}
            onChange={(e) => onUpdate({ x_mm: parseFloat(e.target.value) || 0 })}
            className="w-full rounded border border-slate-300 px-1 py-0.5" />
        </Row>
        <Row label="y (mm)">
          <input type="number" step="0.1" value={element.y_mm.toFixed(1)}
            onChange={(e) => onUpdate({ y_mm: parseFloat(e.target.value) || 0 })}
            className="w-full rounded border border-slate-300 px-1 py-0.5" />
        </Row>
        <Row label="szer. (mm)">
          <input type="number" step="0.1" value={element.w_mm.toFixed(1)}
            onChange={(e) => onUpdate({ w_mm: parseFloat(e.target.value) || 1 })}
            className="w-full rounded border border-slate-300 px-1 py-0.5" />
        </Row>
        <Row label="wys. (mm)">
          <input type="number" step="0.1" value={element.h_mm.toFixed(1)}
            onChange={(e) => onUpdate({ h_mm: parseFloat(e.target.value) || 1 })}
            className="w-full rounded border border-slate-300 px-1 py-0.5" />
        </Row>
      </div>

      {(element.type === "text" || element.type === "callout") && (
        <div className="rounded border border-slate-200 bg-white p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Tekst</div>
          <Row label="Treść">
            <textarea value={(props.content as string) ?? ""}
              onChange={(e) => setProp("content", e.target.value)}
              rows={3}
              className="w-full rounded border border-slate-300 px-1 py-0.5" />
          </Row>
          <Row label="Rozmiar (pt)">
            <input type="number" step="0.5" value={(props.font_size_pt as number) ?? 9}
              onChange={(e) => setNumberProp("font_size_pt", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5" />
          </Row>
          <Row label="Kolor">
            <input type="color" value={(props.color as string) ?? "#0f172a"}
              onChange={(e) => setProp("color", e.target.value)}
              className="h-7 w-full rounded border border-slate-300" />
          </Row>
          <Row label="Wyrów.">
            <select value={(props.align as string) ?? "left"}
              onChange={(e) => setProp("align", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5">
              <option value="left">lewo</option>
              <option value="center">środek</option>
              <option value="right">prawo</option>
              <option value="justify">justify</option>
            </select>
          </Row>
        </div>
      )}

      {(element.type === "rect" || element.type === "line") && (
        <div className="rounded border border-slate-200 bg-white p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Kreska</div>
          <Row label="Grubość (mm)">
            <input type="number" step="0.05" value={(props.stroke_width as number) ?? 0.3}
              onChange={(e) => setNumberProp("stroke_width", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5" />
          </Row>
          <Row label="Kolor">
            <input type="color" value={(props.color as string) ?? "#0f172a"}
              onChange={(e) => setProp("color", e.target.value)}
              className="h-7 w-full rounded border border-slate-300" />
          </Row>
          {element.type === "rect" && (
            <Row label="Wypełnienie">
              <input type="text" value={(props.fill as string) ?? "transparent"}
                onChange={(e) => setProp("fill", e.target.value)}
                className="w-full rounded border border-slate-300 px-1 py-0.5"
                placeholder="transparent / #fff" />
            </Row>
          )}
        </div>
      )}

      {element.type === "qr" && (
        <div className="rounded border border-slate-200 bg-white p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">QR</div>
          <Row label="URL">
            <input type="url" value={(props.url as string) ?? ""}
              onChange={(e) => setProp("url", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5" />
          </Row>
        </div>
      )}

      {element.type === "page_number" && (
        <div className="rounded border border-slate-200 bg-white p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Numer strony</div>
          <Row label="Format">
            <input type="text" value={(props.format as string) ?? "{n} / {N}"}
              onChange={(e) => setProp("format", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5" />
          </Row>
        </div>
      )}

      <button
        type="button"
        onClick={onDelete}
        className="w-full rounded border border-red-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-50"
      >
        Usuń element
      </button>
    </div>
  );
}

interface PageAiAssistantProps {
  pageId: string;
  pageNumber: number;
  onApplied: () => Promise<void> | void;
}

function PageAiAssistant({ pageId, pageNumber, onApplied }: PageAiAssistantProps): React.ReactElement {
  const [instruction, setInstruction] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [importJson, setImportJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"auto" | "manual" | "unknown">("unknown");

  // Wykryj tryb API/manual przy mount.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/status`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mode?: "auto" | "manual" } | null) => {
        if (!cancelled && j?.mode) setMode(j.mode);
      })
      .catch(() => { /* zostaje 'unknown' */ });
    return () => { cancelled = true; };
  }, []);

  // Reset prompt/import state on page switch so we don't accidentally apply
  // someone else's response to the new page.
  useEffect(() => {
    setPrompt(null);
    setImportJson("");
    setError(null);
    setInfo(null);
  }, [pageId]);

  // Auto-tryb: jedno wywołanie API, bez krok-po-kroku copy/paste.
  const runAutoEdit = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`${API}/pages/${pageId}/ai-edit/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { elements: number };
      setInfo(`Zastąpiono ${j.elements} elementów (Haiku 4.5).`);
      setInstruction("");
      setPrompt(null);
      setImportJson("");
      await onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ai-edit failed");
    } finally {
      setBusy(false);
    }
  };

  const buildPrompt = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`${API}/pages/${pageId}/edit-prompt/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML — sesja wygasła?`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { combined: string; elementCount: number };
      setPrompt(j.combined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "build prompt failed");
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const applyResponse = async () => {
    if (!importJson.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`${API}/pages/${pageId}/replace-elements/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: importJson }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML — sesja wygasła?`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { elements: number };
      setInfo(`Zastąpiono ${j.elements} elementów na stronie.`);
      setImportJson("");
      setPrompt(null);
      setInstruction("");
      await onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "apply failed");
    } finally {
      setBusy(false);
    }
  };

  const examples = [
    "Zrób stronę bardziej profesjonalną i estetyczną",
    "Zwiększ wszystkie nagłówki o 2pt",
    "Dodaj na środku duży QR kod do aplikacji",
    "Skróć opis kroku do 2-3 zdań",
    "Zmień kolor akcentów na ciemniejszy szary",
  ];

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded border border-purple-200 bg-purple-50 p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-purple-800">
          Strona {pageNumber}
        </p>
        <label className="block text-[11px] text-slate-700">
          Co chcesz zrobić ze stroną?
        </label>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='np. "Zrób cover bardziej profesjonalny" lub "dodaj sekcję FAQ"...'
          rows={3}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-purple-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap gap-1">
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setInstruction(ex)}
              className="rounded border border-purple-200 bg-white px-1.5 py-0.5 text-[10px] text-purple-700 hover:bg-purple-100"
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {mode === "auto" && (
            <button
              type="button"
              disabled={busy || !instruction.trim()}
              onClick={() => void runAutoEdit()}
              className="rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              title="Wywołaj Claude API i od razu zastosuj wynik (Haiku 4.5, ~5-10 s)"
            >
              {busy ? "..." : "✨ Zastosuj przez AI"}
            </button>
          )}
          <button
            type="button"
            disabled={busy || !instruction.trim()}
            onClick={() => void buildPrompt()}
            className="rounded-md bg-purple-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-purple-800 disabled:opacity-50"
            title="Przygotuj prompt do skopiowania ręcznego w claude.ai (fallback)"
          >
            {busy ? "..." : "📋 Tylko prompt"}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-800">{error}</p>
      )}
      {info && (
        <p className="rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">{info}</p>
      )}

      {prompt && (
        <div className="rounded border border-slate-300 bg-white p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              Krok 1 — skopiuj
            </span>
            <button
              type="button"
              onClick={copyPrompt}
              className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-slate-700"
            >
              {copied ? "✓ Skopiowano" : "📋 Skopiuj prompt"}
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            Wklej w <a href="https://claude.ai/new" target="_blank" rel="noreferrer" className="underline">claude.ai/new</a> — Claude wygeneruje artifact <code>strona-{pageNumber}.json</code>.
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-900">▸ Pokaż prompt</summary>
            <textarea
              readOnly
              value={prompt}
              rows={6}
              className="mt-1 w-full rounded border border-slate-300 bg-slate-50 px-1.5 py-1 font-mono text-[10px]"
            />
          </details>
        </div>
      )}

      {prompt && (
        <div className="rounded border border-emerald-300 bg-white p-2">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
            Krok 2 — wklej JSON
          </span>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"elements": [...]}'
            rows={6}
            className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[10px]"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={busy || !importJson.trim()}
              onClick={() => void applyResponse()}
              className="rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? "Aplikowanie..." : "Zastąp elementy strony"}
            </button>
          </div>
          <p className="mt-1 text-[9px] text-slate-500">
            Operacja zastąpi <strong>wszystkie</strong> obecne elementy strony nową listą.
          </p>
        </div>
      )}
    </div>
  );
}

interface QrElementProps {
  elId: string;
  url: string;
  baseStyle: React.CSSProperties;
  selected: boolean;
  onClick: () => void;
}

function QrElement({ elId, url, baseStyle, selected, onClick }: QrElementProps): React.ReactElement {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const png = await QRCode.toDataURL(url, { errorCorrectionLevel: "Q", margin: 1, scale: 8 });
        if (!cancelled) setDataUrl(png);
      } catch (err) {
        if (!cancelled) setGenErr(err instanceof Error ? err.message : "qr generation failed");
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div
      data-el-id={elId}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        ...baseStyle,
        background: "#fff",
        outline: selected ? "2px solid #f59e0b" : "1px dashed rgba(100,116,139,0.4)",
        cursor: selected ? "move" : "pointer",
        touchAction: "none",
      }}
    >
      {dataUrl ? (
        // Use HTML img for simplicity — Next/image is overkill here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt={url} style={{ width: "100%", height: "100%", display: "block" }} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[9px] text-slate-500">
          {genErr ? `QR err` : url ? "..." : "QR (set URL)"}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="mb-1 grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2 text-[11px] text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  );
}
