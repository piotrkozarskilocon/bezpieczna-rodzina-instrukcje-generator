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

interface ValidationIssue {
  severity: "error" | "warning" | "info";
  element_id?: string;
  element_type?: string;
  message: string;
  fix_hint?: string;
  /** Czy "Napraw przez AI" powinien dotykać tego problemu. Domyślnie true
   *  — false dla placeholderów DO UZUPEŁNIENIA, brakujących obrazków,
   *  brakujących tytułów (AI nie powinien wymyślać tych wartości). */
  ai_fixable?: boolean;
}
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

/** Presety formatów stron. User może wybrać z dropdown lub wpisać własne mm. */
const PAGE_FORMATS: Array<{ label: string; width_mm: number; height_mm: number }> = [
  { label: "Mini 76×76 mm (domyślne)", width_mm: 76, height_mm: 76 },
  { label: "Mini rozkład 152×76 mm", width_mm: 152, height_mm: 76 },
  { label: "A7 74×105 mm", width_mm: 74, height_mm: 105 },
  { label: "A6 105×148 mm", width_mm: 105, height_mm: 148 },
  { label: "A5 148×210 mm", width_mm: 148, height_mm: 210 },
  { label: "A4 210×297 mm", width_mm: 210, height_mm: 297 },
];

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
  // Multi-select. Single = jedno id, multi = wiele (Shift/Ctrl+click).
  // Większość operacji pojedynczych nadal używa selectedId (= pierwszy z set).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIds(id ? new Set([id]) : new Set());
  }, []);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [showAddPage, setShowAddPage] = useState(false);
  // Lazy loading sidebar — przy >50 stronach pokazujemy tylko pierwsze 50,
  // przycisk "Pokaż więcej" odsłania kolejne 50.
  const [pagesVisible, setPagesVisible] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(DEFAULT_DISPLAY_SCALE);
  const [rightTab, setRightTab] = useState<"properties" | "ai">("properties");
  // Mapa image_id → signed URL (z biblioteki obrazków projektu). Przeładowywana
  // po każdym uploadzie/usunięciu by canvas pokazywał aktualne dane.
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  // Walidacja layoutu bieżącej strony (zaciągana z /api/v4/pages/[id]/validate).
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [issuesBusy, setIssuesBusy] = useState(false);
  const [fixBusy, setFixBusy] = useState(false);
  // Apply style from current page to other pages — pętla per target page,
  // bieżący progress widoczny w toolbarze (X/N stron).
  const [applyStyleBusy, setApplyStyleBusy] = useState(false);
  const [applyStyleProgress, setApplyStyleProgress] = useState<{ done: number; total: number } | null>(null);
  const [applyStyleErr, setApplyStyleErr] = useState<string | null>(null);
  // Model picker per akcja AI. Default Haiku. Used by apply-style toolbar btn.
  const [editorAiModel, setEditorAiModel] = useState<string>("claude-haiku-4-5-20251001");
  const [fixStartedAt, setFixStartedAt] = useState<number | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  // Tick co 1s żeby pokazać upłynięty czas w pasku statusu (UX podczas 5-15s).
  const [fixTick, setFixTick] = useState(0);
  useEffect(() => {
    if (!fixBusy) return;
    const interval = setInterval(() => setFixTick((v) => v + 1), 1000);
    return () => clearInterval(interval);
  }, [fixBusy]);
  // Tryb API/manual — używany m.in. żeby zdecydować czy pokazać 'Napraw przez AI'.
  const [editorMode, setEditorMode] = useState<"auto" | "manual" | "unknown">("unknown");

  useEffect(() => {
    fetch(`${API}/status`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mode?: "auto" | "manual" } | null) => {
        if (j?.mode) setEditorMode(j.mode);
      })
      .catch(() => { /* zostaje 'unknown' */ });
  }, []);
  // Narzędzie rysowania aktywne — line/rect rysuje się przeciągnięciem myszą
  // po stronie. Po narysowaniu lub kliknięciu prawym przyciskiem tryb gaśnie.
  const [drawingTool, setDrawingTool] = useState<"line" | "rect" | null>(null);
  // Snap-to-grid: zaokrągla x/y/w/h do najbliższego 1 mm przy drag/resize.
  const [snapEnabled, setSnapEnabled] = useState<boolean>(true);
  // Modal pełnoekranowego podglądu + modal listy skrótów klawiszowych.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Side-by-side language preview — gdy != null, obok głównego canvasa
  // pokazujemy ten sam page ze swapem tekstów na wybrany język.
  const [compareLang, setCompareLang] = useState<string | null>(null);
  const [compareTranslations, setCompareTranslations] = useState<Map<string, string>>(new Map());

  // Załaduj tłumaczenia gdy włączone porównanie.
  useEffect(() => {
    if (!compareLang || !currentPageId) {
      setCompareTranslations(new Map());
      return;
    }
    let active = true;
    fetch(`${API}/projects/${projectId}/translations/?lang=${compareLang}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { translations?: Array<{ element_id: string; text: string }> } | null) => {
        if (!active || !j?.translations) return;
        const m = new Map<string, string>();
        for (const t of j.translations) m.set(t.element_id, t.text);
        setCompareTranslations(m);
      })
      .catch(() => { /* silent — empty map = fall back to PL */ });
    return () => { active = false; };
  }, [compareLang, currentPageId, projectId]);
  // Historia stanów elementów dla undo (Ctrl+Z). Trzyma do 10 ostatnich
  // snapshotów bieżącej strony. Reset przy zmianie strony.
  const [history, setHistory] = useState<ElementRow[][]>([]);
  const MAX_HISTORY = 10;
  const pushHistory = useCallback((snapshot: ElementRow[]) => {
    setHistory((prev) => {
      const next = [...prev, snapshot];
      if (next.length > MAX_HISTORY) next.shift();
      return next;
    });
  }, []);

  const refreshImages = useCallback(async () => {
    try {
      const res = await fetch(`${API}/projects/${projectId}/images/`, { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { images: Array<{ id: string; url: string | null }> };
      const map = new Map<string, string>();
      for (const img of j.images ?? []) {
        if (img.url) map.set(img.id, img.url);
      }
      setImageUrls(map);
    } catch {
      /* ignore — canvas pokaże placeholder */
    }
  }, [projectId]);

  useEffect(() => { void refreshImages(); }, [refreshImages]);

  // Walidacja layoutu bieżącej strony — uruchamiana automatycznie po
  // każdej zmianie elementów. Wynik widoczny jako pasek nad canvasem.
  const refreshIssues = useCallback(async () => {
    if (!currentPageId) {
      setIssues([]);
      return;
    }
    setIssuesBusy(true);
    try {
      const res = await fetch(`${API}/pages/${currentPageId}/validate/`, { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { issues: ValidationIssue[] };
        setIssues(j.issues ?? []);
      }
    } catch {
      /* ignore — walidacja nie jest krytyczna */
    } finally {
      setIssuesBusy(false);
    }
  }, [currentPageId]);

  useEffect(() => {
    void refreshIssues();
    // Re-walidacja po sukcesie zmiany elementów. Debounce 600ms by nie spamować
    // przy szybkich edycjach.
    const timer = setTimeout(() => void refreshIssues(), 600);
    return () => clearTimeout(timer);
  }, [refreshIssues, elements]);

  // Esc anuluje tryb rysowania ALBO odznacza zaznaczone elementy.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drawingTool) setDrawingTool(null);
      else if (selectedIds.size > 0) setSelectedIds(new Set());
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [drawingTool, selectedIds.size]);

  /** Sprawdza czy fokus jest w polu edytowalnym — wtedy ignorujemy globalne
   *  skróty (Del/Backspace usuwałyby tekst zamiast elementu). */
  const isEditableTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable
    );
  };

  const currentPage = pages.find((p) => p.id === currentPageId);
  const selectedElement = elements.find((e) => e.id === selectedId);
  const totalPages = pages.length;

  // Load pages once.
  const refreshPages = useCallback(async () => {
    try {
      const res = await fetch(`${API}/projects/${projectId}/pages/`, { cache: "no-store" });
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
    fetch(`${API}/pages/${currentPageId}/elements/`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { elements: ElementRow[] }) => {
        if (!active) return;
        setElements(j.elements ?? []);
        setHistory([]); // reset undo stack przy zmianie strony
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "fetch elements failed"); });
    return () => { active = false; };
  }, [currentPageId]);

  const addPage = async (template: string) => {
    setShowAddPage(false);
    try {
      const res = await fetch(`${API}/projects/${projectId}/pages/`, {
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
      const res = await fetch(`${API}/pages/${pageId}/`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPages((prev) => prev.filter((p) => p.id !== pageId));
      if (currentPageId === pageId) {
        setCurrentPageId(pages.find((p) => p.id !== pageId)?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  /** Zmiana wymiarów strony (PATCH). Wpływa na canvas i PDF eksport. */
  const changePageFormat = async (page: PageRow, widthMm: number, heightMm: number) => {
    if (widthMm < 10 || widthMm > 600 || heightMm < 10 || heightMm > 600) {
      setError("Nieprawidłowe wymiary (10-600 mm).");
      return;
    }
    try {
      const res = await fetch(`${API}/pages/${page.id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width_mm: widthMm, height_mm: heightMm }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPages((prev) =>
        prev.map((p) => (p.id === page.id ? { ...p, width_mm: widthMm, height_mm: heightMm } : p)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "format change failed");
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
      const res = await fetch(`${API}/pages/${page.id}/`, {
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

  /** Domyślne properties per typ — używane przez addElement i drawElement. */
  const propsForType = (type: ElementType): Record<string, unknown> => {
    switch (type) {
      case "text": return { content: "Nowy tekst", font_size_pt: 9, color: "#0f172a", align: "left" };
      case "rect": return { stroke_width: 0.3, color: "#0f172a", fill: "transparent" };
      case "line": return { stroke_width: 0.5, color: "#0f172a" };
      case "image": return { image_id: null, fit_mode: "contain" };
      case "qr": return { url: "https://locon.pl/", size_mm: 20 };
      case "page_number": return { format: "{n} / {N}" };
      case "callout": return { content: "Etykieta", font_size_pt: 7, color: "#0f172a" };
    }
  };

  /** Wywołanie kontraktu: insert nowego elementu w bazie + lokalne state. */
  const insertElement = async (
    type: ElementType,
    coords: { x_mm: number; y_mm: number; w_mm: number; h_mm: number },
    customProps?: Record<string, unknown>,
  ) => {
    if (!currentPageId) return;
    pushHistory(elements); // snapshot przed zmianą
    try {
      const res = await fetch(`${API}/pages/${currentPageId}/elements/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          ...coords,
          z_index: elements.length,
          properties: customProps ?? propsForType(type),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { element: ElementRow };
      setElements((prev) => [...prev, j.element]);
      setSelectedId(j.element.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "add element failed");
    }
  };

  /** Klik w toolbarze:
   *  - text/image/qr/page_number/callout → wstaw od razu w (5,5) z defaultem,
   *  - line/rect → włącz tryb rysowania (kursor crosshair na canvas). */
  const addElement = async (type: ElementType) => {
    if (!currentPageId || !currentPage) return;
    if (type === "line" || type === "rect") {
      setDrawingTool((prev) => (prev === type ? null : type));
      return;
    }
    const defaults = type === "qr"
      ? { x_mm: 5, y_mm: 5, w_mm: 20, h_mm: 20 }
      : type === "image"
        ? { x_mm: 5, y_mm: 5, w_mm: 30, h_mm: 30 }
        : { x_mm: 5, y_mm: 5, w_mm: 30, h_mm: 5 };
    await insertElement(type, defaults);
  };

  /** Napraw przez AI — buduje instrukcję z listy issues + fix_hints i wywołuje
   *  ai-edit endpoint (Haiku 4.5). Po sukcesie reload elementów + re-walidacja. */
  const fixIssuesWithAi = async () => {
    if (!currentPageId || issues.length === 0) return;
    // Filtrujemy po ai_fixable (nie po severity) — info-level overlap jest naprawialny,
    // ale placeholder DO UZUPEŁNIENIA już nie (AI nie powinien wymyślać wartości).
    const actionable = issues.filter((i) => i.ai_fixable !== false && i.fix_hint);
    if (actionable.length === 0) {
      setError("Brak problemów które AI mógłby naprawić automatycznie.");
      return;
    }
    const issuesBefore = issues.length;
    const actionableBefore = actionable.length;
    const instruction = [
      "Popraw następujące problemy z layoutem strony:",
      ...actionable.map((i, idx) => `${idx + 1}. ${i.message}. ${i.fix_hint ?? ""}`),
      "",
      "Zachowaj treść elementów — popraw tylko ich pozycje/rozmiary tak, by mieściły się",
      "na stronie z 3mm marginesem i żeby teksty się nie ucinały.",
    ].join("\n");
    pushHistory(elements);
    setError(null);
    setFixBusy(true);
    setFixStartedAt(Date.now());
    setFixTick(0);
    try {
      const res = await fetch(`${API}/pages/${currentPageId}/ai-edit/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // layout_only=true → endpoint pomija ładowanie PDF reference docs
        // (są niepotrzebne dla geometrycznych poprawek, a powodowały timeout
        // bo Claude próbował czytać wszystkie PDFy projektu).
        body: JSON.stringify({ instruction, layout_only: true }),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = (await res.json()) as { elements?: number };
      const newElementsCount = j.elements ?? 0;
      // Reload elementów po fix.
      const reload = await fetch(`${API}/pages/${currentPageId}/elements/`, { cache: "no-store" });
      if (reload.ok) {
        const jr = (await reload.json()) as { elements: ElementRow[] };
        setElements(jr.elements ?? []);
        setSelectedId(null);
      }
      await refreshIssues();
      // Po refreshIssues setIssues jeszcze może być stale w closure — czytamy
      // nową walidację z zewnątrz przez kolejne setTimeout, ale prościej:
      // poczekaj 1 tick na re-render, potem porównaj długości.
      setTimeout(() => {
        setIssues((current) => {
          const fixed = Math.max(0, issuesBefore - current.length);
          const elapsed = fixStartedAt ? Math.round((Date.now() - fixStartedAt) / 1000) : 0;
          setFixResult(
            `✅ AI naprawił ${fixed}/${actionableBefore} problemów (${newElementsCount} elementów po fixie, ` +
            `${elapsed}s, Haiku 4.5). Pasek walidacji powyżej już jest odświeżony.`,
          );
          return current;
        });
        setTimeout(() => setFixResult(null), 10000);
      }, 200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI fix failed");
    } finally {
      setFixBusy(false);
      setFixStartedAt(null);
    }
  };

  /** Zastosuj wygląd aktualnej strony do WSZYSTKICH innych stron projektu.
   *  Pętla per target page (każda strona = osobne wywołanie /apply-style/),
   *  bo Vercel Hobby ma 60s cap a 14 stron × ~5s = 70s. Po każdej stronie
   *  odświeżamy elementy jeśli to aktualnie wyświetlana strona. */
  const applyStyleToOtherPages = async () => {
    if (!currentPageId || applyStyleBusy) return;
    const targets = pages.filter((p) => p.id !== currentPageId);
    if (targets.length === 0) {
      setApplyStyleErr("Tylko jedna strona w projekcie — nie ma do czego zastosować stylu.");
      return;
    }
    const sourcePageNum = currentPage?.page_number ?? "?";
    const ok = window.confirm(
      `Zastosować wygląd strony ${sourcePageNum} do pozostałych ${targets.length} stron?\n\n` +
      "AI przeniesie kolory, fonty, układ i ozdobniki z tej strony, zachowując TREŚĆ pozostałych stron.\n\n" +
      "To może potrwać 30-90s. Możesz dalej pracować — odśwież stronę po zakończeniu.",
    );
    if (!ok) return;

    setApplyStyleBusy(true);
    setApplyStyleErr(null);
    setApplyStyleProgress({ done: 0, total: targets.length });
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        const res = await fetch(`${API}/pages/${target.id}/apply-style/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_page_id: currentPageId, model: editorAiModel }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          failures.push(`Strona ${target.page_number}: ${j.error ?? `HTTP ${res.status}`}`);
        }
      } catch (err) {
        failures.push(`Strona ${target.page_number}: ${err instanceof Error ? err.message : "fetch failed"}`);
      }
      setApplyStyleProgress({ done: i + 1, total: targets.length });
    }
    if (failures.length > 0) {
      setApplyStyleErr(`Zastosowano styl. ${failures.length} z ${targets.length} stron nie powiodło się:\n${failures.slice(0, 3).join("\n")}`);
    }
    setApplyStyleBusy(false);
    // Odśwież bieżącą stronę (jeśli była w targetach to mamy nowe elementy)
    if (currentPageId) {
      const res = await fetch(`${API}/pages/${currentPageId}/elements/`, { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { elements: ElementRow[] };
        setElements(j.elements ?? []);
      }
    }
    setTimeout(() => { setApplyStyleProgress(null); setApplyStyleErr(null); }, 12000);
  };

  /** Wywoływane przez PageCanvas po zakończeniu rysowania myszą.
   *  Dla linii w `direction` przekazane są procentowe pozycje obu końców
   *  wewnątrz bounding boxa — pozwala na dowolny kierunek (pion/skos/poziom). */
  const handleDrawComplete = async (
    type: "line" | "rect",
    coords: { x_mm: number; y_mm: number; w_mm: number; h_mm: number },
    direction?: { x1_pct: number; y1_pct: number; x2_pct: number; y2_pct: number },
  ) => {
    setDrawingTool(null);
    if (type === "line" && direction) {
      await insertElement(type, coords, {
        ...propsForType("line"),
        x1_pct: direction.x1_pct,
        y1_pct: direction.y1_pct,
        x2_pct: direction.x2_pct,
        y2_pct: direction.y2_pct,
      });
      return;
    }
    await insertElement(type, coords);
  };

  const updateElement = useCallback(async (id: string, patch: Partial<ElementRow>) => {
    setElements((prev) => {
      pushHistory(prev); // snapshot przed zmianą
      return prev.map((e) => (e.id === id ? { ...e, ...patch } : e));
    });
    try {
      await fetch(`${API}/elements/${id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      console.error("[v4 element patch]", err);
    }
  }, [pushHistory]);

  /** Usuwa WSZYSTKIE zaznaczone elementy. Snapshot do history przed pierwszym
   *  delete, pętla DELETE per element (idempotent). */
  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    pushHistory(elements);
    const ids = Array.from(selectedIds);
    setElements((prev) => prev.filter((e) => !selectedIds.has(e.id)));
    setSelectedIds(new Set());
    for (const id of ids) {
      try {
        await fetch(`${API}/elements/${id}/`, { method: "DELETE" });
      } catch (err) {
        console.error("[v4 element delete]", err);
      }
    }
  }, [elements, selectedIds, pushHistory]);

  /** Duplikuje wszystkie zaznaczone. Każda kopia +2mm. */
  const duplicateSelected = useCallback(async () => {
    if (selectedIds.size === 0 || !currentPageId) return;
    pushHistory(elements);
    const sources = elements.filter((e) => selectedIds.has(e.id));
    const newIds: string[] = [];
    let nextZ = elements.length;
    for (const src of sources) {
      try {
        const res = await fetch(`${API}/pages/${currentPageId}/elements/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: src.type,
            x_mm: src.x_mm + 2,
            y_mm: src.y_mm + 2,
            w_mm: src.w_mm,
            h_mm: src.h_mm,
            z_index: nextZ++,
            rotation_deg: src.rotation_deg,
            properties: src.properties,
          }),
        });
        if (!res.ok) continue;
        const j = (await res.json()) as { element: ElementRow };
        setElements((prev) => [...prev, j.element]);
        newIds.push(j.element.id);
      } catch {
        /* per-element fail nie blokuje */
      }
    }
    if (newIds.length > 0) setSelectedIds(new Set(newIds));
  }, [elements, selectedIds, currentPageId, pushHistory]);

  /** Duplikuje zaznaczony element — POST nowego ze starym properties + offset 2mm
   *  żeby kopia nie nakrywała się idealnie z oryginałem. */
  const duplicateElement = useCallback(async (id: string) => {
    const src = elements.find((e) => e.id === id);
    if (!src || !currentPageId) return;
    pushHistory(elements);
    try {
      const res = await fetch(`${API}/pages/${currentPageId}/elements/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: src.type,
          x_mm: src.x_mm + 2,
          y_mm: src.y_mm + 2,
          w_mm: src.w_mm,
          h_mm: src.h_mm,
          z_index: elements.length,
          rotation_deg: src.rotation_deg,
          properties: src.properties,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { element: ElementRow };
      setElements((prev) => [...prev, j.element]);
      setSelectedId(j.element.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "duplicate failed");
    }
  }, [elements, currentPageId, pushHistory]);

  const deleteElement = async (id: string) => {
    pushHistory(elements);
    setElements((prev) => prev.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
    try {
      await fetch(`${API}/elements/${id}/`, { method: "DELETE" });
    } catch (err) {
      console.error("[v4 element delete]", err);
    }
  };

  /** Cofnięcie — przywraca ostatni snapshot przez replace-elements (atomic
   *  wymiana). Bezpieczne nawet gdy historia ma nieaktualne id z bazy. */
  const undo = useCallback(async () => {
    if (!currentPageId || history.length === 0) return;
    const lastSnapshot = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    const payload = JSON.stringify({
      elements: lastSnapshot.map((el) => ({
        type: el.type,
        x_mm: el.x_mm,
        y_mm: el.y_mm,
        w_mm: el.w_mm,
        h_mm: el.h_mm,
        z_index: el.z_index,
        rotation_deg: el.rotation_deg,
        properties: el.properties,
      })),
    });
    try {
      const res = await fetch(`${API}/pages/${currentPageId}/replace-elements/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Reload elementów żeby dostać nowe id (replace robi delete+insert).
      const reload = await fetch(`${API}/pages/${currentPageId}/elements/`, { cache: "no-store" });
      if (reload.ok) {
        const j = (await reload.json()) as { elements: ElementRow[] };
        setElements(j.elements ?? []);
        setSelectedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "undo failed");
    }
  }, [currentPageId, history]);

  // Skróty klawiszowe — wszystkie aktywne tylko gdy fokus NIE jest w polu
  // edytowalnym (textarea/input/contenteditable), żeby nie kolidować z
  // natywnym zachowaniem przeglądarki w edycji tekstu.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Ctrl+Z / Cmd+Z — cofnij
      if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        void undo();
        return;
      }
      // Ctrl+D / Cmd+D — duplicate (multi-select aware)
      if (mod && key === "d") {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        if (selectedIds.size > 1) void duplicateSelected();
        else if (selectedId) void duplicateElement(selectedId);
        return;
      }
      // Cmd+P / Ctrl+P — fullscreen preview
      if (mod && key === "p") {
        e.preventDefault();
        setPreviewOpen(true);
        return;
      }
      // Cmd+/ — modal skrótów
      if (mod && (key === "/" || e.code === "Slash")) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Ctrl+A / Cmd+A — select all elements on current page
      if (mod && key === "a") {
        if (elements.length === 0) return;
        e.preventDefault();
        setSelectedIds(new Set(elements.map((el) => el.id)));
        return;
      }
      // Ctrl+S / Cmd+S — auto-save info (wszystko już jest na bieżąco zapisywane)
      if (mod && key === "s") {
        e.preventDefault();
        setError("✓ Zmiany są zapisywane automatycznie po każdej edycji.");
        setTimeout(() => setError(null), 2500);
        return;
      }
      // Del / Backspace — usuń wszystkie zaznaczone elementy
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault();
        if (selectedIds.size > 1) void deleteSelected();
        else if (selectedId) void deleteElement(selectedId);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, duplicateElement, duplicateSelected, deleteSelected, selectedId, selectedIds, elements]);

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
            {pages.slice(0, pagesVisible).map((p) => {
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
            {pages.length > pagesVisible && (
              <li className="mt-1">
                <button
                  type="button"
                  onClick={() => setPagesVisible((v) => v + 50)}
                  className="block w-full rounded border border-dashed border-slate-300 px-2 py-1 text-center text-[11px] text-slate-600 hover:bg-slate-100"
                >
                  ▾ Pokaż więcej ({pages.length - pagesVisible} ukrytych)
                </button>
              </li>
            )}
          </ul>
        </aside>

        {/* ─── Canvas + toolbar (center) ───────────────────────────────── */}
        <main className="flex flex-col bg-slate-100">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 text-xs">
            <span className="font-medium text-slate-600">Dodaj element:</span>
            {(["text", "image", "line", "rect", "qr", "page_number"] as ElementType[]).map((t) => {
              const isDrawTool = t === "line" || t === "rect";
              const isActive = drawingTool === t;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={!currentPageId}
                  onClick={() => void addElement(t)}
                  className={
                    "rounded border px-2 py-0.5 font-medium disabled:opacity-30 " +
                    (isActive
                      ? "border-amber-500 bg-amber-100 text-amber-900"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-500 hover:bg-slate-50")
                  }
                  title={
                    isDrawTool
                      ? "Kliknij, potem narysuj na stronie przeciągnięciem myszy"
                      : "Wstaw element na stronę"
                  }
                >
                  {isActive ? `✏️ ${labelForType(t)}` : labelForType(t)}
                </button>
              );
            })}
            {drawingTool && (
              <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
                Tryb rysowania: <strong>{labelForType(drawingTool)}</strong> — przeciągnij myszą po stronie (Esc anuluje).
              </span>
            )}
            {selectedIds.size > 1 && (
              <span className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-[11px] text-blue-800">
                <strong>{selectedIds.size}</strong> zaznaczonych
                <button
                  type="button"
                  onClick={() => void duplicateSelected()}
                  className="ml-1 rounded bg-blue-700 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-blue-800"
                  title="Ctrl+D"
                >
                  Duplikuj
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSelected()}
                  className="rounded bg-red-700 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-red-800"
                  title="Del"
                >
                  Usuń
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded border border-blue-300 bg-white px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100"
                  title="Esc"
                >
                  Odznacz
                </button>
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-700" title="Zaokrąglaj pozycje i rozmiary do 1 mm">
                <input
                  type="checkbox"
                  checked={snapEnabled}
                  onChange={(e) => setSnapEnabled(e.target.checked)}
                  className="h-3 w-3"
                />
                <span>Snap 1mm</span>
              </label>
              <button
                type="button"
                disabled={history.length === 0}
                onClick={() => void undo()}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 hover:border-slate-500 hover:bg-slate-50 disabled:opacity-30"
                title={
                  history.length === 0
                    ? "Brak zmian do cofnięcia"
                    : `Cofnij ostatnią zmianę (${history.length}/${MAX_HISTORY}) — Ctrl+Z`
                }
              >
                ↶ Cofnij {history.length > 0 && <span className="text-slate-400">({history.length})</span>}
              </button>
              <button
                type="button"
                disabled={applyStyleBusy || pages.length < 2 || !currentPageId}
                onClick={() => void applyStyleToOtherPages()}
                className="rounded border border-purple-300 bg-purple-50 px-2 py-0.5 font-medium text-purple-700 hover:border-purple-500 hover:bg-purple-100 disabled:opacity-30"
                title="AI przepisze pozostałe strony używając stylu tej strony jako wzorca (zachowuje treść, zmienia kolory/fonty/układ)."
              >
                {applyStyleBusy && applyStyleProgress
                  ? `✨ Wygląd → inne (${applyStyleProgress.done}/${applyStyleProgress.total})...`
                  : "✨ Wygląd → inne strony"}
              </button>
              <select
                value={editorAiModel}
                onChange={(e) => setEditorAiModel(e.target.value)}
                className="rounded border border-purple-300 bg-white px-1 py-0.5 text-[10px] text-purple-700"
                title="Model AI dla akcji Wygląd → inne strony i innych AI w toolbarze. Sonnet/Opus dają lepsze rezultaty ale są droższe i wolniejsze."
                disabled={applyStyleBusy}
              >
                <option value="claude-haiku-4-5-20251001">Haiku</option>
                <option value="claude-sonnet-4-6">Sonnet</option>
                <option value="claude-opus-4-7">Opus</option>
              </select>
              <span className="text-slate-500">Zoom:</span>
              <button type="button" onClick={() => setZoom((z) => Math.max(2, z - 1))}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50">−</button>
              <input
                type="number"
                value={zoom}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) setZoom(Math.min(16, Math.max(2, v)));
                }}
                min={2}
                max={16}
                className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center font-mono"
              />
              <span className="text-slate-500">×</span>
              <button type="button" onClick={() => setZoom((z) => Math.min(16, z + 1))}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50">+</button>
              <button
                type="button"
                onClick={() => {
                  // Fit: rozmiar canvas (76mm) ma się zmieścić w ~700px szer.
                  if (!currentPage) return;
                  const targetPx = 700;
                  const fitZoom = Math.round(targetPx / Math.max(currentPage.width_mm, currentPage.height_mm));
                  setZoom(Math.min(16, Math.max(2, fitZoom)));
                }}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50"
                title="Zoom-to-fit (dopasuj do widoku)"
              >
                Fit
              </button>
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50"
                title="Pełnoekranowy podgląd (Cmd+P)"
              >
                👁️
              </button>
              <button
                type="button"
                onClick={() => setShortcutsOpen(true)}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-50"
                title="Skróty klawiszowe (Cmd+/)"
              >
                ⌨️
              </button>
              <select
                value={compareLang ?? ""}
                onChange={(e) => setCompareLang(e.target.value || null)}
                className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                title="Porównaj side-by-side z innym językiem (sprawdź czy tłumaczenia się mieszczą)"
              >
                <option value="">🌍 Porównaj…</option>
                <option value="bg">+ BG</option>
                <option value="hr">+ HR</option>
                <option value="ro">+ RO</option>
                <option value="mk">+ MK</option>
                <option value="sq">+ SQ</option>
                <option value="en">+ EN</option>
              </select>
              <span className="ml-2 text-slate-400">
                {currentPage ? `${currentPage.width_mm}×${currentPage.height_mm} mm` : "—"}
              </span>
              {currentPage && (
                <select
                  value={`${currentPage.width_mm}x${currentPage.height_mm}`}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const found = PAGE_FORMATS.find(
                      (f) => `${f.width_mm}x${f.height_mm}` === e.target.value,
                    );
                    if (!found || !currentPage) return;
                    void changePageFormat(currentPage, found.width_mm, found.height_mm);
                  }}
                  className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                  title="Zmień format tej strony (np. rozkład 152×76)"
                >
                  {PAGE_FORMATS.find((f) => f.width_mm === currentPage.width_mm && f.height_mm === currentPage.height_mm) === undefined && (
                    <option value={`${currentPage.width_mm}x${currentPage.height_mm}`}>
                      {currentPage.width_mm}×{currentPage.height_mm} (custom)
                    </option>
                  )}
                  {PAGE_FORMATS.map((f) => (
                    <option key={f.label} value={`${f.width_mm}x${f.height_mm}`}>
                      {f.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Pasek walidacji — pokazuje liczbę problemów + przycisk Napraw przez AI */}
          {currentPageId && (issues.length > 0 || fixBusy || fixResult) && (
            <ValidationBar
              issues={issues}
              busy={issuesBusy}
              mode={editorMode}
              onFix={() => void fixIssuesWithAi()}
              fixBusy={fixBusy}
              fixStartedAt={fixStartedAt}
              fixResult={fixResult}
              onClearResult={() => setFixResult(null)}
            />
          )}

          {/* Status apply-style — gdy trwa lub po zakończeniu z błędami */}
          {(applyStyleBusy || applyStyleProgress || applyStyleErr) && (
            <div
              className={
                "border-b px-4 py-2 text-[12px] " +
                (applyStyleErr
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : applyStyleBusy
                    ? "border-purple-300 bg-purple-50 text-purple-800"
                    : "border-emerald-300 bg-emerald-50 text-emerald-800")
              }
            >
              {applyStyleBusy && applyStyleProgress && (
                <>
                  ✨ AI stosuje styl strony {currentPage?.page_number ?? "?"} do pozostałych — postęp{" "}
                  <strong>{applyStyleProgress.done}/{applyStyleProgress.total}</strong>. Możesz dalej pracować, ale nie zmieniaj
                  zaznaczonej strony.
                </>
              )}
              {!applyStyleBusy && applyStyleProgress && !applyStyleErr && (
                <>✅ Zastosowano wygląd do {applyStyleProgress.total} stron. Zmień stronę i wróć, aby zobaczyć efekty.</>
              )}
              {applyStyleErr && <span className="whitespace-pre-line">{applyStyleErr}</span>}
            </div>
          )}

          <div className="flex-1 overflow-auto p-6">
            {!currentPage && (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
                Brak wybranej strony. Dodaj pierwszą po lewej.
              </div>
            )}
            {currentPage && (
              <div className="flex gap-4">
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {defaultLang.toUpperCase()} (edycja)
                  </p>
                  <PageCanvas
                    page={currentPage}
                    elements={elements}
                    selectedIds={selectedIds}
                    onSelect={setSelectedId}
                    onToggleSelect={toggleSelected}
                    onUpdate={updateElement}
                    zoom={zoom}
                    defaultLang={defaultLang}
                    totalPages={totalPages}
                    imageUrls={imageUrls}
                    drawingTool={drawingTool}
                    onDrawComplete={handleDrawComplete}
                    snapEnabled={snapEnabled}
                  />
                </div>
                {compareLang && (
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
                      {compareLang.toUpperCase()} (podgląd, read-only)
                    </p>
                    <PageCanvas
                      page={currentPage}
                      elements={elements.map((el) => {
                        if (el.type !== "text" && el.type !== "callout") return el;
                        const translated = compareTranslations.get(el.id);
                        if (!translated) return el;
                        return {
                          ...el,
                          properties: { ...el.properties, content: translated },
                        };
                      })}
                      selectedIds={new Set()}
                      onSelect={() => { /* read-only */ }}
                      onToggleSelect={() => { /* read-only */ }}
                      onUpdate={() => { /* read-only */ }}
                      zoom={zoom}
                      defaultLang={compareLang}
                      totalPages={totalPages}
                      imageUrls={imageUrls}
                      drawingTool={null}
                      onDrawComplete={() => { /* noop */ }}
                      snapEnabled={false}
                    />
                  </div>
                )}
              </div>
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
                    pageId={currentPageId}
                    onAiFixApplied={async () => {
                      // reload elementów po per-element AI fix
                      const res = await fetch(`${API}/pages/${currentPageId}/elements/`, { cache: "no-store" });
                      if (res.ok) {
                        const j = (await res.json()) as { elements: ElementRow[] };
                        setElements(j.elements ?? []);
                      }
                    }}
                  />
                )}
              </>
            )}
            {rightTab === "ai" && currentPageId && (
              <PageAiAssistant
                pageId={currentPageId}
                pageNumber={currentPage?.page_number ?? 0}
                projectId={projectId}
                onImagesChanged={refreshImages}
                onApplied={async () => {
                  // Reload elements for the page after a successful replace.
                  const res = await fetch(`${API}/pages/${currentPageId}/elements/`, { cache: "no-store" });
                  if (res.ok) {
                    const j = (await res.json()) as { elements: ElementRow[] };
                    setElements(j.elements ?? []);
                    setSelectedId(null);
                  }
                  // Po edycji AI — odśwież też mapę obrazków (AI mógł użyć
                  // nowo wgranego obrazka i jego url trzeba załadować do mapy).
                  await refreshImages();
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

      {previewOpen && currentPage && (
        <FullscreenPreview
          page={currentPage}
          elements={elements}
          imageUrls={imageUrls}
          defaultLang={defaultLang}
          totalPages={totalPages}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
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
  selectedIds: Set<string>;
  onSelect: (id: string | null) => void;
  onToggleSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ElementRow>) => void;
  zoom: number;
  defaultLang: string;
  totalPages: number;
  imageUrls: Map<string, string>;
  drawingTool: "line" | "rect" | null;
  onDrawComplete: (
    type: "line" | "rect",
    coords: { x_mm: number; y_mm: number; w_mm: number; h_mm: number },
    direction?: { x1_pct: number; y1_pct: number; x2_pct: number; y2_pct: number },
  ) => void;
  snapEnabled: boolean;
}

/** Zaokrągla mm do 1mm gdy snap włączony. */
const snap = (val: number, enabled: boolean): number =>
  enabled ? Math.round(val) : Math.round(val * 10) / 10;

function PageCanvas({
  page, elements, selectedIds, onSelect, onToggleSelect, onUpdate, zoom, defaultLang, totalPages, imageUrls,
  drawingTool, onDrawComplete, snapEnabled,
}: PageCanvasProps): React.ReactElement {
  // Wygodny pojedynczy selected dla interactjs (działa na pojedynczym elemencie).
  const selectedId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
  // Live preview rysowania — start i bieżący punkt w pikselach względem canvas.
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ x: number; y: number } | null>(null);
  // Smart guides — wyrównanie do innych elementów podczas drag. Lista współrzędnych
  // (w mm) gdzie element się wyrównuje. Pokazujemy pionowe/poziome linie pomocnicze.
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] }>({ vertical: [], horizontal: [] });

  const isDrawing = drawingTool !== null;

  const beginDraw = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDrawStart({ x, y });
    setDrawEnd({ x, y });
  };

  const updateDraw = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || !drawStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDrawEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const finishDraw = () => {
    if (!isDrawing || !drawStart || !drawEnd || !drawingTool) {
      setDrawStart(null);
      setDrawEnd(null);
      return;
    }
    // Bounding box w px.
    const x1 = Math.min(drawStart.x, drawEnd.x);
    const y1 = Math.min(drawStart.y, drawEnd.y);
    const x2 = Math.max(drawStart.x, drawEnd.x);
    const y2 = Math.max(drawStart.y, drawEnd.y);
    let wPxBox = x2 - x1;
    let hPxBox = y2 - y1;
    let wMm = wPxBox / zoom;
    let hMm = hPxBox / zoom;

    if (drawingTool === "line") {
      // Kierunek linii: który koniec w którym rogu bounding boxa.
      // Procenty (0/100) tych punktów wewnątrz bounding boxa po normalizacji.
      // Klik bez przeciągnięcia (mała odległość) → domyślna pozioma 30 mm.
      const dist = Math.hypot(drawEnd.x - drawStart.x, drawEnd.y - drawStart.y);
      if (dist < 4) {
        // Mała linia → pozioma domyślna.
        const xMm = drawStart.x / zoom;
        const yMm = drawStart.y / zoom;
        setDrawStart(null);
        setDrawEnd(null);
        onDrawComplete(drawingTool, { x_mm: xMm, y_mm: yMm, w_mm: 30, h_mm: 0.5 }, {
          x1_pct: 0, y1_pct: 50, x2_pct: 100, y2_pct: 50,
        });
        return;
      }
      // Minimalne wymiary bounding boxa żeby renderowanie miało sens.
      if (wPxBox < 1) wPxBox = 1;
      if (hPxBox < 1) hPxBox = 1;
      wMm = wPxBox / zoom;
      hMm = hPxBox / zoom;
      // Punkty drawStart i drawEnd w lokalnych współrzędnych bounding boxa (px).
      const startLocalX = drawStart.x - x1;
      const startLocalY = drawStart.y - y1;
      const endLocalX = drawEnd.x - x1;
      const endLocalY = drawEnd.y - y1;
      const x1_pct = (startLocalX / wPxBox) * 100;
      const y1_pct = (startLocalY / hPxBox) * 100;
      const x2_pct = (endLocalX / wPxBox) * 100;
      const y2_pct = (endLocalY / hPxBox) * 100;
      setDrawStart(null);
      setDrawEnd(null);
      onDrawComplete(
        drawingTool,
        { x_mm: x1 / zoom, y_mm: y1 / zoom, w_mm: wMm, h_mm: hMm },
        { x1_pct, y1_pct, x2_pct, y2_pct },
      );
      return;
    }
    // Prostokąt — sensowne minimum.
    if (wMm < 2) wMm = 20;
    if (hMm < 2) hMm = 20;
    setDrawStart(null);
    setDrawEnd(null);
    onDrawComplete(drawingTool, {
      x_mm: x1 / zoom,
      y_mm: y1 / zoom,
      w_mm: wMm,
      h_mm: hMm,
    });
  };
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
      // Smart guides — sąsiednie elementy do których możemy się wyrównać.
      // Lista (x_mm krawędzi lewej, x_mm krawędzi prawej, x_mm środka, ...
      // analogicznie dla y_mm). Obliczamy raz przy starcie drag (nie zmienia
      // się podczas drag bo to inne elementy).
      const others = elements.filter((e) => e.id !== selectedId);
      const xCandidates: number[] = [];
      const yCandidates: number[] = [];
      for (const o of others) {
        xCandidates.push(o.x_mm, o.x_mm + o.w_mm, o.x_mm + o.w_mm / 2);
        yCandidates.push(o.y_mm, o.y_mm + o.h_mm, o.y_mm + o.h_mm / 2);
      }
      // Też krawędzie strony (lewa, prawa, środek).
      xCandidates.push(0, page.width_mm, page.width_mm / 2);
      yCandidates.push(0, page.height_mm, page.height_mm / 2);

      // Bieżący element — szukamy w state. Wymiary potrzebne do śledzenia.
      const currentEl = elements.find((e) => e.id === selectedId);
      const elWmm = currentEl?.w_mm ?? 0;
      const elHmm = currentEl?.h_mm ?? 0;

      /** Dla danej współrzędnej szuka najbliższego kandydata <= 1mm różnicy.
       *  Zwraca [nowa wartość, czy znaleziono]. */
      const findSnap = (val: number, candidates: number[]): { snapped: number; hit: number | null } => {
        let bestHit: number | null = null;
        let bestDiff = 1.0; // 1mm tolerancja
        for (const c of candidates) {
          const diff = Math.abs(val - c);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestHit = c;
          }
        }
        return bestHit !== null ? { snapped: bestHit, hit: bestHit } : { snapped: val, hit: null };
      };

      const inst = interact(el)
        .draggable({
          listeners: {
            move(e) {
              const t = e.target as HTMLElement;
              let left = (parseFloat(t.style.left) || 0) + e.dx;
              let top = (parseFloat(t.style.top) || 0) + e.dy;

              // Smart guides — sprawdzamy wszystkie 3 punkty (lewa krawędź,
              // środek, prawa krawędź) bieżącego elementu vs candidates.
              const vGuides: number[] = [];
              const hGuides: number[] = [];
              const xMm = left / zoom;
              const yMm = top / zoom;
              const lefts = [xMm, xMm + elWmm / 2, xMm + elWmm];
              const tops = [yMm, yMm + elHmm / 2, yMm + elHmm];
              // Lewa krawędź
              {
                const r = findSnap(lefts[0], xCandidates);
                if (r.hit !== null) { left = r.hit * zoom; vGuides.push(r.hit); }
              }
              // Środek
              {
                const newLeftMm = left / zoom;
                const r = findSnap(newLeftMm + elWmm / 2, xCandidates);
                if (r.hit !== null) { left = (r.hit - elWmm / 2) * zoom; vGuides.push(r.hit); }
              }
              // Prawa krawędź
              {
                const newLeftMm = left / zoom;
                const r = findSnap(newLeftMm + elWmm, xCandidates);
                if (r.hit !== null) { left = (r.hit - elWmm) * zoom; vGuides.push(r.hit); }
              }
              // Y axis
              { const r = findSnap(tops[0], yCandidates); if (r.hit !== null) { top = r.hit * zoom; hGuides.push(r.hit); } }
              {
                const newTopMm = top / zoom;
                const r = findSnap(newTopMm + elHmm / 2, yCandidates);
                if (r.hit !== null) { top = (r.hit - elHmm / 2) * zoom; hGuides.push(r.hit); }
              }
              {
                const newTopMm = top / zoom;
                const r = findSnap(newTopMm + elHmm, yCandidates);
                if (r.hit !== null) { top = (r.hit - elHmm) * zoom; hGuides.push(r.hit); }
              }

              t.style.left = `${left}px`;
              t.style.top = `${top}px`;
              setGuides({ vertical: vGuides, horizontal: hGuides });
            },
            end(e) {
              const t = e.target as HTMLElement;
              const xMm = snap((parseFloat(t.style.left) || 0) / zoom, snapEnabled);
              const yMm = snap((parseFloat(t.style.top) || 0) / zoom, snapEnabled);
              setGuides({ vertical: [], horizontal: [] });
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
              setGuides({ vertical: [], horizontal: [] });
              onUpdate(selectedId, {
                x_mm: snap((parseFloat(t.style.left) || 0) / zoom, snapEnabled),
                y_mm: snap((parseFloat(t.style.top) || 0) / zoom, snapEnabled),
                w_mm: snap((parseFloat(t.style.width) || 0) / zoom, snapEnabled),
                h_mm: snap((parseFloat(t.style.height) || 0) / zoom, snapEnabled),
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
  }, [selectedId, onUpdate, zoom, snapEnabled, elements, page.width_mm, page.height_mm]);

  // Overlay rysowanego elementu — pokazuje live preview (linia lub prostokąt)
  // dopóki user nie zwolni przycisku myszy. Linia rysowana jako SVG między
  // dokładnymi punktami startu i końca (dowolny kąt).
  const previewBox = (() => {
    if (!isDrawing || !drawStart || !drawEnd) return null;
    if (drawingTool === "line") {
      return (
        <svg
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: wPx,
            height: hPx,
            pointerEvents: "none",
          }}
        >
          <line
            x1={drawStart.x}
            y1={drawStart.y}
            x2={drawEnd.x}
            y2={drawEnd.y}
            stroke="#f59e0b"
            strokeWidth={2}
            strokeDasharray="4 4"
          />
        </svg>
      );
    }
    const x = Math.min(drawStart.x, drawEnd.x);
    const y = Math.min(drawStart.y, drawEnd.y);
    const w = Math.abs(drawEnd.x - drawStart.x);
    const h = Math.abs(drawEnd.y - drawStart.y);
    return (
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: w,
          height: h,
          border: "1px dashed #f59e0b",
          background: "rgba(254,243,199,0.3)",
          pointerEvents: "none",
        }}
      />
    );
  })();

  return (
    <div className="inline-block">
      <div
        className="relative shadow-md"
        style={{
          width: `${wPx}px`,
          height: `${hPx}px`,
          background: PAGE_BG,
          cursor: isDrawing ? "crosshair" : "default",
          userSelect: isDrawing ? "none" : undefined,
        }}
        onMouseDown={isDrawing ? beginDraw : undefined}
        onMouseMove={isDrawing && drawStart ? updateDraw : undefined}
        onMouseUp={isDrawing ? finishDraw : undefined}
        onMouseLeave={isDrawing && drawStart ? finishDraw : undefined}
        onClick={(e) => {
          if (isDrawing) return; // klik traktowany jako część rysowania
          // Click on bare canvas → deselect.
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        {elements.map((el) => (
          <ElementView
            key={el.id}
            el={el}
            selected={selectedIds.has(el.id)}
            onClick={(modifierKey) => {
              if (modifierKey) onToggleSelect(el.id);
              else onSelect(el.id);
            }}
            onUpdate={onUpdate}
            zoom={zoom}
            defaultLang={defaultLang}
            pageNumber={page.page_number}
            totalPages={totalPages}
            imageUrls={imageUrls}
            disablePointer={isDrawing}
          />
        ))}
        {previewBox}

        {/* Smart guides — pomarańczowe linie wyrównania w trakcie drag */}
        {guides.vertical.map((xMm, i) => (
          <div
            key={`v-${i}-${xMm}`}
            style={{
              position: "absolute",
              left: `${xMm * zoom}px`,
              top: 0,
              width: 1,
              height: hPx,
              background: "#f59e0b",
              pointerEvents: "none",
              zIndex: 100,
            }}
          />
        ))}
        {guides.horizontal.map((yMm, i) => (
          <div
            key={`h-${i}-${yMm}`}
            style={{
              position: "absolute",
              top: `${yMm * zoom}px`,
              left: 0,
              height: 1,
              width: wPx,
              background: "#f59e0b",
              pointerEvents: "none",
              zIndex: 100,
            }}
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
  /** modifierKey = true gdy user trzymał Shift/Ctrl/Cmd przy kliknięciu
   *  (parent decyduje czy toggle czy single-select). */
  onClick: (modifierKey: boolean) => void;
  onUpdate: (id: string, patch: Partial<ElementRow>) => void;
  zoom: number;
  defaultLang: string;
  pageNumber: number;
  totalPages: number;
  imageUrls: Map<string, string>;
  disablePointer?: boolean;
}

function ElementView({ el, selected, onClick, onUpdate, zoom, defaultLang, pageNumber, totalPages, imageUrls, disablePointer }: ElementViewProps): React.ReactElement {
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
    // Gdy aktywny tryb rysowania na canvas, istniejące elementy nie łapią
    // mouse events — żeby user mógł narysować nową linię "przez" nie.
    pointerEvents: disablePointer ? ("none" as const) : undefined,
  };

  if (el.type === "text" || el.type === "callout") {
    const fontSizePt = typeof props.font_size_pt === "number" ? props.font_size_pt : 9;
    // 1pt = 1/72 in = 25.4/72 mm; px at given zoom = pt * mm_per_pt * zoom.
    const fontSizePx = fontSizePt * MM_PER_PT * zoom;
    const content = (props.content as string) ?? "";
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(e.shiftKey || e.ctrlKey || e.metaKey); }}
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
        onClick={(e) => { e.stopPropagation(); onClick(e.shiftKey || e.ctrlKey || e.metaKey); }}
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
    // Procentowe pozycje obu końców wewnątrz bounding boxa. Fallback dla
    // starych linii (tylko bounding box bez x1/x2): linia pozioma na środku.
    const x1Pct = typeof props.x1_pct === "number" ? props.x1_pct : 0;
    const y1Pct = typeof props.y1_pct === "number" ? props.y1_pct : 50;
    const x2Pct = typeof props.x2_pct === "number" ? props.x2_pct : 100;
    const y2Pct = typeof props.y2_pct === "number" ? props.y2_pct : 50;
    const stroke = (props.color as string) ?? "#0f172a";
    const sw = (typeof props.stroke_width === "number" ? props.stroke_width : 0.5) * zoom;
    // Bounding box dla SVG musi być przynajmniej 1px wysoki — gdy linia
    // jest pozioma (h_mm bliskie 0), wymuszamy minimalną wysokość żeby
    // <svg> w ogóle renderował.
    const svgW = Math.max(width, 1);
    const svgH = Math.max(height, sw + 2);
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(e.shiftKey || e.ctrlKey || e.metaKey); }}
        style={{
          ...baseStyle,
          height: `${svgH}px`,
          outline: selected ? "2px solid #f59e0b" : "1px dashed rgba(100,116,139,0.2)",
          cursor: selected ? "move" : "pointer",
          touchAction: "none",
        }}
      >
        <svg width={svgW} height={svgH} style={{ display: "block", pointerEvents: "none" }}>
          <line
            x1={(x1Pct / 100) * svgW}
            y1={(y1Pct / 100) * svgH}
            x2={(x2Pct / 100) * svgW}
            y2={(y2Pct / 100) * svgH}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        </svg>
      </div>
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
    const imageId = (props.image_id as string | null) ?? null;
    const url = imageId ? imageUrls.get(imageId) : null;
    const placeholderDesc = (props.placeholder_description as string | undefined) ?? null;
    const fitMode = (props.fit_mode as string | undefined) ?? "contain";
    // Opacity — gdy AI lub user oznaczy obrazek jako watermark (np. opacity 0.1-0.3),
    // musi prześwitywać do elementów pod spodem. Wczesniej typeof === "number"
    // upadalo do 1 gdy AI zapisalo opacity jako string ("0.15") — watermark
    // renderowal sie nieprzezroczyscie. Number() coerce + jawny fallback dla
    // null/undefined/"" (zeby nie wpadly w Number(null)=0 → niewidoczny).
    const rawOpacity = props.opacity as unknown;
    const opacityNum =
      rawOpacity === undefined || rawOpacity === null || rawOpacity === ""
        ? 1
        : Number(rawOpacity);
    const opacity = Number.isFinite(opacityNum) ? Math.max(0, Math.min(1, opacityNum)) : 1;
    const isWatermark = opacity < 1;
    // grayscale: true → CSS filter:grayscale(100%). Uzywane przez AI dla
    // watermarkow czarno-bialych ("wstaw znak wodny w czerni i bieli").
    const gsRaw = props.grayscale as unknown;
    const isGrayscale = gsRaw === true || gsRaw === "true" || gsRaw === 1 || gsRaw === "1";
    return (
      <div
        data-el-id={el.id}
        onClick={(e) => { e.stopPropagation(); onClick(e.shiftKey || e.ctrlKey || e.metaKey); }}
        style={{
          ...baseStyle,
          // Bez bialego tla gdy to watermark — musi przeswityawc do elementow
          // ponizej. Tylko placeholder (brak url) ma kratke + obrysowanie.
          background: url
            ? "transparent"
            : "linear-gradient(45deg,#cbd5e1 25%,#e2e8f0 25%,#e2e8f0 50%,#cbd5e1 50%,#cbd5e1 75%,#e2e8f0 75%,#e2e8f0)",
          backgroundSize: url ? undefined : "12px 12px",
          // Watermark nie powinien miec widocznej ramki w trybie idle, zeby user
          // nie mylil go z normalnym obrazkiem. Selected dalej oznaczamy.
          outline: selected
            ? "2px solid #f59e0b"
            : isWatermark
              ? "1px dotted rgba(100,116,139,0.25)"
              : "1px dashed rgba(100,116,139,0.4)",
          cursor: selected ? "move" : "pointer",
          touchAction: "none",
          overflow: "hidden",
        }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={placeholderDesc ?? "image"}
            style={{
              width: "100%",
              height: "100%",
              objectFit: fitMode === "cover" ? "cover" : "contain",
              display: "block",
              pointerEvents: "none",
              opacity,
              filter: isGrayscale ? "grayscale(100%)" : undefined,
            }}
          />
        ) : (
          <div
            className="flex h-full w-full flex-col items-center justify-center px-1 text-center text-[9px] text-slate-600"
            style={{ lineHeight: 1.1 }}
          >
            <span>📷</span>
            {imageId && <span className="text-amber-700">brak url (image_id={imageId.slice(0, 8)}...)</span>}
            {placeholderDesc && <span className="mt-0.5 text-slate-500 italic">{placeholderDesc}</span>}
            {!imageId && !placeholderDesc && <span className="text-slate-500">Obraz</span>}
          </div>
        )}
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
        onClick={(e) => { e.stopPropagation(); onClick(e.shiftKey || e.ctrlKey || e.metaKey); }}
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
  pageId?: string | null;
  onAiFixApplied?: () => Promise<void> | void;
}

function ElementProperties({ element, onUpdate, onDelete, pageId, onAiFixApplied }: ElementPropertiesProps): React.ReactElement {
  const props = element.properties as Record<string, string | number>;
  const setProp = (k: string, v: string | number) =>
    onUpdate({ properties: { ...props, [k]: v } });
  const setNumberProp = (k: string, v: string) => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) setProp(k, n);
  };

  // Per-element AI fix — wywołuje /api/v4/pages/[pageId]/elements/[elementId]/ai-fix
  // i podmienia tylko ten jeden element. Szybciej niż edycja całej strony, bo
  // AI dostaje tylko jeden element + kontekst pozostałych jako read-only.
  const [aiInstr, setAiInstr] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiModel, setAiModel] = useState<string>("claude-haiku-4-5-20251001");
  const runAiFix = async () => {
    if (!pageId || !aiInstr.trim()) return;
    setAiBusy(true);
    setAiErr(null);
    // Vercel Hobby ma 60s function cap — Sonnet/Opus z dluga odpowiedzia
    // czasem podchodzi pod ten limit. Dajemy 75s na klienta, potem
    // explicit abort + jasny komunikat (zeby user nie patrzyl w infinitnie
    // krecace sie "AI poprawia...").
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 75_000);
    const reqStart = Date.now();
    console.log("[ai-fix-element] POST", { pageId, elementId: element.id, model: aiModel, instruction: aiInstr.trim() });
    try {
      const res = await fetch(`${API}/pages/${pageId}/elements/${element.id}/ai-fix/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: aiInstr.trim(), model: aiModel }),
        signal: controller.signal,
      });
      console.log("[ai-fix-element] response", res.status, `${Date.now() - reqStart}ms`);
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { element?: unknown };
      console.log("[ai-fix-element] success, applied element", data);
      setAiInstr("");
      if (onAiFixApplied) await onAiFixApplied();
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const msg = isAbort
        ? `Timeout 75s (Vercel Hobby ma 60s cap dla funkcji). Spróbuj Haiku zamiast ${aiModel.includes("opus") ? "Opus" : "Sonnet"}.`
        : err instanceof Error
          ? err.message
          : "AI fix failed";
      console.error("[ai-fix-element] FAILED:", msg);
      setAiErr(msg);
    } finally {
      clearTimeout(t);
      setAiBusy(false);
    }
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

      {element.type === "image" && (
        <div className="rounded border border-slate-200 bg-white p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Obraz</div>
          <Row label="image_id">
            <input type="text" value={(props.image_id as string) ?? ""}
              onChange={(e) => setProp("image_id", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5 font-mono"
              placeholder="(brak — wgraj w bibliotece obrazków)" />
          </Row>
          <Row label="Dopas.">
            <select value={(props.fit_mode as string) ?? "contain"}
              onChange={(e) => setProp("fit_mode", e.target.value)}
              className="w-full rounded border border-slate-300 px-1 py-0.5">
              <option value="contain">contain (mieści w boxie)</option>
              <option value="cover">cover (wypełnia, przycina)</option>
            </select>
          </Row>
          <Row label="Przezr.">
            <div className="flex items-center gap-1.5">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={typeof props.opacity === "number" ? (props.opacity as number) : 1}
                onChange={(e) => setProp("opacity", parseFloat(e.target.value))}
                className="flex-1"
                title="0 = niewidoczny, 1 = pełen. Dla watermarka ustaw 0.10-0.20."
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={typeof props.opacity === "number" ? (props.opacity as number).toFixed(2) : "1.00"}
                onChange={(e) => setNumberProp("opacity", e.target.value)}
                className="w-12 rounded border border-slate-300 px-1 py-0.5 text-right"
              />
            </div>
          </Row>
          {typeof props.opacity === "number" && (props.opacity as number) < 1 && (
            <p className="mt-1 text-[10px] text-slate-500">
              {(props.opacity as number) < 0.08
                ? "⚠️ Bardzo niska — obrazek prawie niewidoczny. Watermark: 0.10–0.20."
                : (props.opacity as number) < 0.25
                  ? "💧 Watermark — przeswituje, tlo pod spodem widoczne."
                  : (props.opacity as number) < 0.7
                    ? "Polprzezroczysty obrazek."
                    : "Niemal pelny obrazek."}
            </p>
          )}
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

      {pageId && (
        <div className="rounded border border-purple-200 bg-purple-50 p-2">
          {!aiPanelOpen ? (
            <button
              type="button"
              onClick={() => setAiPanelOpen(true)}
              className="w-full rounded bg-purple-600 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-purple-700"
            >
              ✨ Popraw ten element przez AI
            </button>
          ) : (
            <>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-purple-700">
                  ✨ AI fix dla tego elementu
                </span>
                <button
                  type="button"
                  onClick={() => { setAiPanelOpen(false); setAiErr(null); }}
                  className="text-[10px] text-purple-600 hover:underline"
                  disabled={aiBusy}
                >
                  zwiń
                </button>
              </div>
              <textarea
                value={aiInstr}
                onChange={(e) => setAiInstr(e.target.value)}
                placeholder={
                  element.type === "text" || element.type === "callout"
                    ? `np. „skróć do 2 zdań”, „popraw kontrast — biały tekst na ciemnym tle”, „pogrub nagłówek”...`
                    : element.type === "image"
                      ? `np. „przesuń wyżej żeby nie nakładał się na tekst”...`
                      : element.type === "rect"
                        ? `np. „zmień kolor na bardziej stonowany”, „zaokrąglij rogi”...`
                        : "Co chcesz zmienić w tym elemencie?"
                }
                rows={3}
                className="w-full rounded border border-purple-300 bg-white px-2 py-1 text-[11px]"
                disabled={aiBusy}
              />
              <label className="mt-1 block text-[10px] text-purple-700">
                Model:
                <select
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  className="ml-1 rounded border border-purple-300 bg-white px-1 py-0.5 text-[10px]"
                  disabled={aiBusy}
                  title="Wybierz model AI. Haiku — szybki/tani (default). Sonnet — lepsza jakość, ~5× drożej. Opus — najdroższy, do trudnych przypadków."
                >
                  <option value="claude-haiku-4-5-20251001">Haiku 4.5 (szybki/tani)</option>
                  <option value="claude-sonnet-4-6">Sonnet 4.6 (lepszy)</option>
                  <option value="claude-opus-4-7">Opus 4.7 (najlepszy/drogi)</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => void runAiFix()}
                disabled={aiBusy || !aiInstr.trim()}
                className="mt-1 w-full rounded bg-purple-600 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {aiBusy ? "AI poprawia..." : "Wyślij do AI"}
              </button>
              {aiErr && (
                <div className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-700">
                  {aiErr}
                </div>
              )}
            </>
          )}
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
  projectId: string;
  onApplied: () => Promise<void> | void;
  onImagesChanged?: () => Promise<void> | void;
}

function PageAiAssistant({ pageId, pageNumber, projectId, onApplied, onImagesChanged }: PageAiAssistantProps): React.ReactElement {
  const [instruction, setInstruction] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [importJson, setImportJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"auto" | "manual" | "unknown">("unknown");
  const [imageBusy, setImageBusy] = useState(false);
  const [explainBusy, setExplainBusy] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  // Model picker — user wybiera kazdorazowo. Defaultem Haiku (szybko/tanio).
  const [aiModel, setAiModel] = useState<string>("claude-haiku-4-5-20251001");
  // Preview-and-edit promptu: gdy ustawiona, frontend pokazuje modal z edytowalnymi
  // system_prompt i user_prompt; po kliknieciu "Wyslij teraz" wywoluje runAutoEdit
  // z custom_system/custom_user zamiast generator-built.
  const [previewedPrompt, setPreviewedPrompt] = useState<{ system: string; user: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

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
    setExplanation(null);
    setStreamingText(null);
  }, [pageId]);

  // Upload obrazka dla tej konkretnej strony — preferred_page_id ustawiamy
  // od razu, dzięki czemu AI w późniejszym apply/edit będzie wiedział, że
  // ten obrazek pasuje właśnie tutaj.
  const uploadImageForPage = async (file: File, description: string) => {
    setImageBusy(true);
    setError(null);
    setInfo(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (description.trim()) form.append("description", description.trim());
      form.append("preferred_page_id", pageId);
      const res = await fetch(`${API}/projects/${projectId}/images/`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      setInfo(`Wgrano obrazek "${file.name}" — będzie preferowany przy generowaniu treści tej strony.`);
      // Odśwież cache obrazków w parent (Gen4Editor) by canvas widział url.
      if (onImagesChanged) await onImagesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setImageBusy(false);
    }
  };

  // Wyjaśnij decyzję AI — analizuje aktualną stronę + legal templates + notatki
  // i zwraca markdown z uzasadnieniem.
  const explainPage = async () => {
    setExplainBusy(true);
    setError(null);
    setInfo(null);
    setExplanation(null);
    try {
      const res = await fetch(`${API}/pages/${pageId}/explain/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { explanation: string };
      setExplanation(j.explanation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "explain failed");
    } finally {
      setExplainBusy(false);
    }
  };

  /** Streaming variant — wyświetla fragmenty AI na bieżąco.
   *  Opcjonalne `override` z modalu "Edytuj prompt przed wysłaniem". */
  const runStreamEdit = async (override?: { system: string; user: string }) => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    setStreamingText("");
    try {
      const reqBody: Record<string, unknown> = { instruction: instruction.trim(), model: aiModel };
      if (override) {
        reqBody.custom_system = override.system;
        reqBody.custom_user = override.user;
      }
      const res = await fetch(`${API}/pages/${pageId}/ai-edit-stream/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let doneInfo: { elements: number } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // ostatnia może być niepełna
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as
              | { type: "delta"; text: string }
              | { type: "done"; elements: number; latency_ms: number }
              | { type: "error"; error: string };
            if (evt.type === "delta") {
              accumulated += evt.text;
              setStreamingText(accumulated);
            } else if (evt.type === "done") {
              doneInfo = { elements: evt.elements };
            } else if (evt.type === "error") {
              throw new Error(evt.error);
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes("JSON")) continue; // tolerujemy niepełne linie
            throw e;
          }
        }
      }
      setStreamingText(null);
      if (doneInfo) {
        setInfo(`✨ Streaming: zastąpiono ${doneInfo.elements} elementów na stronie.`);
        setInstruction("");
        await onApplied();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "stream failed");
      setStreamingText(null);
    } finally {
      setBusy(false);
    }
  };

  // Auto-tryb: jedno wywołanie API, bez krok-po-kroku copy/paste.
  // Opcjonalne `override` z modalu "Edytuj prompt przed wysłaniem".
  // Uzywamy ai-edit-stream zamiast ai-edit zeby ominac timeout hub middleware
  // (30s Edge). Stream pisze pierwszy bajt natychmiast, middleware passuje
  // body przez, total time = function maxDuration (60s) zamiast middleware (30s).
  const runAutoEdit = async (override?: { system: string; user: string }) => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 75_000);
    const reqStart = Date.now();
    try {
      const reqBody: Record<string, unknown> = { instruction: instruction.trim(), model: aiModel };
      if (override) {
        reqBody.custom_system = override.system;
        reqBody.custom_user = override.user;
      }
      console.log("[ai-edit] POST (stream)", { pageId, model: aiModel, instruction: instruction.trim(), promptEdited: !!override });
      const res = await fetch(`${API}/pages/${pageId}/ai-edit-stream/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      console.log("[ai-edit] response headers", res.status, `${Date.now() - reqStart}ms`);
      if (!res.ok || !res.body) {
        const text = await res.text();
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      // NDJSON streaming — parsujemy linia-po-linii, finalna ma type="done".
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let elementsCount = 0;
      let streamErr: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as
              | { type: "delta"; text: string }
              | { type: "done"; elements: number; latency_ms?: number }
              | { type: "error"; error: string };
            if (evt.type === "done") elementsCount = evt.elements;
            else if (evt.type === "error") streamErr = evt.error;
          } catch {
            // niepelna linia — bedzie scalona w nastepnej iteracji
          }
        }
      }
      if (streamErr) throw new Error(streamErr);
      const modelLabel = aiModel.includes("haiku") ? "Haiku 4.5" : aiModel.includes("sonnet") ? "Sonnet 4.6" : "Opus 4.7";
      setInfo(`Zastąpiono ${elementsCount} elementów (${modelLabel}${override ? ", prompt edytowany" : ""}).`);
      setInstruction("");
      setPrompt(null);
      setImportJson("");
      setPreviewedPrompt(null);
      await onApplied();
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const msg = isAbort
        ? `Timeout 75s (Vercel Hobby 60s function cap). Sonnet/Opus dla duzych stron moga nie zdazyc — sprobuj Haiku.`
        : err instanceof Error
          ? err.message
          : "ai-edit failed";
      console.error("[ai-edit] FAILED:", msg);
      setError(msg);
    } finally {
      clearTimeout(t);
      setBusy(false);
    }
  };

  /** Pobiera prompt z preview-prompt endpointu i otwiera modal do edycji.
   *  Po edycji user moze wywolac runAutoEdit z override = { system, user }. */
  const previewAndEditPrompt = async () => {
    if (!instruction.trim()) return;
    setPreviewBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/pages/${pageId}/ai-edit/preview-prompt/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { system: string; user: string };
      setPreviewedPrompt({ system: j.system, user: j.user });
    } catch (err) {
      setError(err instanceof Error ? err.message : "preview prompt failed");
    } finally {
      setPreviewBusy(false);
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
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-purple-800">
            Strona {pageNumber}
          </p>
          {mode === "auto" && (
            <button
              type="button"
              disabled={explainBusy}
              onClick={() => void explainPage()}
              className="rounded border border-purple-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-purple-700 hover:bg-purple-100 disabled:opacity-50"
              title="AI tłumaczy dlaczego ta strona wygląda tak jak wygląda"
            >
              {explainBusy ? "..." : "ℹ️ Dlaczego tak?"}
            </button>
          )}
        </div>
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
        {mode === "auto" && (
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-purple-700">
            <span>Model:</span>
            <select
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              className="rounded border border-purple-300 bg-white px-1 py-0.5"
              disabled={busy}
              title="Wybierz model AI dla tego wywołania. Haiku — szybki/tani (default). Sonnet — lepsza jakość. Opus — najwyższa jakość, najwolniejszy."
            >
              <option value="claude-haiku-4-5-20251001">Haiku 4.5 (szybki/tani)</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 (lepszy)</option>
              <option value="claude-opus-4-7">Opus 4.7 (najlepszy/drogi)</option>
            </select>
          </div>
        )}
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {mode === "auto" && (
            <>
              <button
                type="button"
                disabled={busy || previewBusy || !instruction.trim()}
                onClick={() => void previewAndEditPrompt()}
                className="rounded-md border border-amber-400 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                title="Pokaż prompt który generator zbuduje, edytuj przed wysłaniem (debug)"
              >
                {previewBusy ? "..." : "👁️ Edytuj prompt"}
              </button>
              <button
                type="button"
                disabled={busy || !instruction.trim()}
                onClick={() => void runStreamEdit()}
                className="rounded-md bg-indigo-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                title="Streaming — wyświetla generowany tekst na bieżąco"
              >
                {busy && streamingText !== null ? "Stream..." : "🔁 Stream"}
              </button>
              <button
                type="button"
                disabled={busy || !instruction.trim()}
                onClick={() => void runAutoEdit()}
                className="rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                title="Wywołaj Claude API i od razu zastosuj wynik"
              >
                {busy && streamingText === null ? "..." : "✨ Zastosuj przez AI"}
              </button>
            </>
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

      {/* ─── Modal: Edytuj prompt przed wysłaniem ─────────────────────────── */}
      {previewedPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewedPrompt(null);
          }}
        >
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">👁️ Edytuj prompt przed wysłaniem</h3>
                <p className="text-[10px] text-slate-500">
                  Generator zbudował poniższe prompty na podstawie Twojej instrukcji. Możesz je edytować i kliknąć
                  „Wyślij teraz” — wtedy AI dostanie Twoją wersję zamiast wygenerowanej.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewedPrompt(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-3 text-xs">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    System prompt ({previewedPrompt.system.length} znaków)
                  </span>
                </div>
                <textarea
                  value={previewedPrompt.system}
                  onChange={(e) => setPreviewedPrompt((prev) => (prev ? { ...prev, system: e.target.value } : prev))}
                  rows={12}
                  className="w-full rounded border border-slate-300 bg-slate-50 p-2 font-mono text-[10px]"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    User prompt ({previewedPrompt.user.length} znaków)
                  </span>
                </div>
                <textarea
                  value={previewedPrompt.user}
                  onChange={(e) => setPreviewedPrompt((prev) => (prev ? { ...prev, user: e.target.value } : prev))}
                  rows={12}
                  className="w-full rounded border border-slate-300 bg-slate-50 p-2 font-mono text-[10px]"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-2">
              <span className="mr-auto text-[10px] text-slate-500">Model: {aiModel}</span>
              <button
                type="button"
                onClick={() => setPreviewedPrompt(null)}
                disabled={busy}
                className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Anuluj
              </button>
              <button
                type="button"
                onClick={() => previewedPrompt && void runAutoEdit(previewedPrompt)}
                disabled={busy}
                className="rounded bg-emerald-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
              >
                {busy ? "Wysyłam..." : "✨ Wyślij teraz (z edytowanym promptem)"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Upload obrazka przypisanego do tej strony ─────────────────── */}
      <PageImageUpload
        pageNumber={pageNumber}
        busy={imageBusy}
        onUpload={(file, desc) => void uploadImageForPage(file, desc)}
      />

      {error && (
        <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-800">{error}</p>
      )}
      {info && (
        <p className="rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">{info}</p>
      )}
      {streamingText !== null && (
        <div className="rounded border border-indigo-300 bg-indigo-50 p-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
            🔁 AI generuje na żywo...
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-indigo-900">
            {streamingText}<span className="animate-pulse">▌</span>
          </pre>
        </div>
      )}

      {explanation && (
        <div className="rounded border border-indigo-200 bg-indigo-50 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
              ℹ️ Wyjaśnienie AI
            </span>
            <button
              type="button"
              onClick={() => setExplanation(null)}
              className="text-[10px] text-indigo-400 hover:text-indigo-700"
            >
              ✕
            </button>
          </div>
          <div className="whitespace-pre-wrap text-[11px] leading-snug text-slate-700">
            {explanation}
          </div>
        </div>
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

interface ValidationBarProps {
  issues: ValidationIssue[];
  busy: boolean;
  mode: "auto" | "manual" | "unknown";
  onFix: () => void;
  fixBusy: boolean;
  fixStartedAt: number | null;
  fixResult: string | null;
  onClearResult: () => void;
}

function ValidationBar({ issues, busy, mode, onFix, fixBusy, fixStartedAt, fixResult, onClearResult }: ValidationBarProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [, forceTick] = useState(0);
  // Tick co 0.5s gdy AI naprawia — pokazujemy upłynięty czas na żywo.
  useEffect(() => {
    if (!fixBusy) return;
    const t = setInterval(() => forceTick((v) => v + 1), 500);
    return () => clearInterval(t);
  }, [fixBusy]);

  const elapsed = fixStartedAt ? Math.round((Date.now() - fixStartedAt) / 1000) : 0;

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;
  const fixable = issues.filter((i) => i.ai_fixable !== false && i.fix_hint).length;

  const barColor =
    fixBusy ? "border-indigo-300 bg-indigo-50"
    : fixResult ? "border-emerald-300 bg-emerald-50"
    : errors > 0 ? "border-red-300 bg-red-50"
    : warnings > 0 ? "border-amber-300 bg-amber-50"
    : "border-slate-200 bg-slate-50";

  return (
    <div className={`border-b text-xs ${barColor}`}>
      {fixBusy && (
        <div className="flex items-center gap-2 border-b border-indigo-200 px-3 py-1.5 text-indigo-900">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-700 border-t-transparent" />
          <span className="font-medium">🔧 AI naprawia ({fixable} problemów)...</span>
          <span className="text-indigo-600">{elapsed}s</span>
          <span className="text-[10px] text-indigo-500">(typowo 5-15s · timeout 60s)</span>
        </div>
      )}
      {fixResult && !fixBusy && (
        <div className="flex items-start justify-between gap-2 border-b border-emerald-200 px-3 py-1.5 text-emerald-900">
          <span className="font-medium">{fixResult}</span>
          <button type="button" onClick={onClearResult} className="shrink-0 text-emerald-500 hover:text-emerald-800">✕</button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-black/5"
      >
        <span className="flex items-center gap-3">
          <span className="font-medium">
            🔍 Walidacja layoutu {busy && <span className="text-slate-400">(sprawdzam…)</span>}
          </span>
          {errors > 0 && <span className="rounded bg-red-200 px-1.5 py-0.5 text-[10px] font-semibold text-red-900">{errors} błędów</span>}
          {warnings > 0 && <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">{warnings} ostrzeżeń</span>}
          {infos > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{infos} info</span>}
        </span>
        <span className="flex items-center gap-2">
          {mode === "auto" && fixable > 0 && !fixBusy && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onFix(); }}
              className="rounded bg-emerald-700 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-800"
              title="AI poprawi pozycje/rozmiary elementów żeby usunąć problemy"
            >
              🔧 Napraw przez AI ({fixable})
            </button>
          )}
          <span className="text-slate-500">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <ul className="max-h-48 overflow-auto border-t border-black/10 px-3 py-2">
          {issues.map((i, idx) => (
            <li key={idx} className="mb-1 flex items-start gap-2 text-[11px]">
              <span className={
                "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase " +
                (i.severity === "error" ? "bg-red-200 text-red-900"
                  : i.severity === "warning" ? "bg-amber-200 text-amber-900"
                  : "bg-slate-200 text-slate-700")
              }>{i.severity}</span>
              <span className="flex-1 text-slate-700">
                {i.message}
                {i.fix_hint && <span className="block text-[10px] italic text-slate-500">↳ {i.fix_hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface PageImageUploadProps {
  pageNumber: number;
  busy: boolean;
  onUpload: (file: File, description: string) => void;
}

function PageImageUpload({ pageNumber, busy, onUpload }: PageImageUploadProps): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");

  const reset = () => {
    setFile(null);
    setDescription("");
  };

  return (
    <div className="rounded border border-sky-200 bg-sky-50 p-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800">
        📷 Obrazek dla strony {pageNumber}
      </p>
      <p className="mb-2 text-[10px] text-slate-600">
        Wgraj grafikę (screen z aplikacji, zdjęcie urządzenia) — AI użyje jej
        przy generowaniu treści tej strony, jeśli opis pasuje.
      </p>

      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        disabled={busy}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-[10px]"
      />

      {file && (
        <div className="mt-2 space-y-1.5">
          <p className="truncate text-[10px] text-slate-700" title={file.name}>
            📎 {file.name} <span className="text-slate-400">({Math.round(file.size / 1024)} KB)</span>
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder='np. "ekran logowania w aplikacji BR" / "front zegarka — przycisk Power"'
            className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-[10px]"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
            >
              Anuluj
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { onUpload(file, description); reset(); }}
              className="rounded bg-sky-700 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
            >
              {busy ? "Wgrywam..." : "Wgraj"}
            </button>
          </div>
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
  onClick: (modifierKey: boolean) => void;
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
      onClick={(e) => { e.stopPropagation(); onClick(e.shiftKey || e.ctrlKey || e.metaKey); }}
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

interface FullscreenPreviewProps {
  page: PageRow;
  elements: ElementRow[];
  imageUrls: Map<string, string>;
  defaultLang: string;
  totalPages: number;
  onClose: () => void;
}

/** Pełnoekranowy podgląd strony bez UI. Symuluje finalny druk —
 *  pokazuje stronę w skali ~viewport / page_mm. */
function FullscreenPreview({ page, elements, imageUrls, defaultLang, totalPages, onClose }: FullscreenPreviewProps): React.ReactElement {
  const [vw, setVw] = useState(800);
  const [vh, setVh] = useState(600);

  useEffect(() => {
    const update = () => { setVw(window.innerWidth); setVh(window.innerHeight); };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Zoom = dopasuj do mniejszej krawędzi viewportu (z marginesem 60px).
  const maxScaleByWidth = (vw - 60) / page.width_mm;
  const maxScaleByHeight = (vh - 100) / page.height_mm;
  const previewScale = Math.min(maxScaleByWidth, maxScaleByHeight);
  const wPx = page.width_mm * previewScale;
  const hPx = page.height_mm * previewScale;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-900/95 p-6">
      <div className="mb-3 flex items-center gap-3 text-xs text-slate-300">
        <span>Strona {page.page_number} · {page.width_mm}×{page.height_mm} mm · {Math.round(previewScale)}× (Esc zamyka)</span>
      </div>
      <div
        className="relative bg-white shadow-2xl"
        style={{ width: `${wPx}px`, height: `${hPx}px` }}
      >
        {elements.map((el) => (
          <ElementView
            key={el.id}
            el={el}
            selected={false}
            onClick={() => { /* read-only */ }}
            onUpdate={() => { /* read-only */ }}
            zoom={previewScale}
            defaultLang={defaultLang}
            pageNumber={page.page_number}
            totalPages={totalPages}
            imageUrls={imageUrls}
            disablePointer={true}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-4 rounded bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
      >
        Zamknij podgląd
      </button>
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const shortcuts: Array<{ keys: string; desc: string; section?: string }> = [
    { section: "Selekcja", keys: "Klik", desc: "Zaznacz element" },
    { section: "Selekcja", keys: "Shift / Ctrl + Klik", desc: "Dodaj/usuń z selekcji (multi-select)" },
    { section: "Selekcja", keys: "Ctrl / Cmd + A", desc: "Zaznacz wszystkie elementy" },
    { section: "Selekcja", keys: "Esc", desc: "Odznacz / anuluj rysowanie" },
    { section: "Edycja", keys: "Ctrl / Cmd + Z", desc: "Cofnij ostatnią zmianę" },
    { section: "Edycja", keys: "Ctrl / Cmd + D", desc: "Duplikuj zaznaczone (z offsetem 2 mm)" },
    { section: "Edycja", keys: "Del / Backspace", desc: "Usuń zaznaczone" },
    { section: "Edycja", keys: "Ctrl / Cmd + S", desc: "Informacja o auto-save (wszystko zapisuje się na bieżąco)" },
    { section: "Widok", keys: "Cmd + P", desc: "Pełnoekranowy podgląd strony" },
    { section: "Widok", keys: "Cmd + /", desc: "Ta lista skrótów" },
    { section: "Rysowanie", keys: "Klik Linia / Prostokąt → drag", desc: "Narysuj element przeciągnięciem myszy" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="my-8 w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">⌨️ Skróty klawiszowe</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>
        <div className="p-5">
          {["Selekcja", "Edycja", "Widok", "Rysowanie"].map((section) => (
            <div key={section} className="mb-4">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{section}</h4>
              <table className="w-full text-xs">
                <tbody>
                  {shortcuts.filter((s) => s.section === section).map((s, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-1.5 pr-3">
                        <kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                          {s.keys}
                        </kbd>
                      </td>
                      <td className="py-1.5 text-slate-600">{s.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <p className="mt-4 rounded bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            ℹ️ Skróty z modyfikatorem są wyłączone gdy fokus jest w polu edytowalnym (textarea/input).
          </p>
        </div>
      </div>
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
