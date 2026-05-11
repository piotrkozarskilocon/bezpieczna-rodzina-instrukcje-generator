"use client";

/**
 * 3-column editor for v2 (Edytor tabelaryczny).
 *
 * Layout:
 *   ┌─────────────────────────┬───────────────┬───────────────┐
 *   │ A: PDF + bloki overlay  │ B: bloki      │ C: Excel      │
 *   │   per-page navigation   │   listy edyt. │   per stronie │
 *   └─────────────────────────┴───────────────┴───────────────┘
 *
 * Y.2 implements column A end-to-end (PDF.js render, per-page OCR,
 * blocks saved to gen2_blocks). Columns B and C land in Y.3 / Y.4.
 */

import { useEffect, useMemo, useRef, useState } from "react";

interface TableEditorProps {
  projectId: string;
  totalPagesHint: number | null;
  onTotalPagesChange?: (n: number) => void;
}

const API_BASE = "/generator-instrukcji/api/v2";
const DISPLAY_SCALE = 2; // smaller than v1 (4×) because column A is narrower
const OCR_RENDER_SCALE = 7;
const MM_PER_PT = 25.4 / 72;

interface BlockData {
  id: string;
  text: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  source: "pdf" | "ocr" | "db" | "manual";
  title: string;
  /** Text colour sampled from the original bitmap (one pixel inside the
   *  block area). Used to render the overlay text in the same colour as
   *  the original PDF, so edits look native. */
  textColor?: string;
  /** Background colour sampled just outside the block — used to "erase"
   *  the old rasterised text from the canvas before drawing the overlay. */
  bgColor?: string;
}

interface PageCache {
  status: "idle" | "loading" | "ocr" | "done" | "error";
  blocks: BlockData[];
  /** mm dimensions of the page (constant once loaded). */
  widthMm: number;
  heightMm: number;
  error?: string;
  /** PDF page rendered once and then erased at every block area, so the
   *  resulting bitmap has *no* original text — only graphics + background.
   *  Display canvas is built each render by copying this + drawing React
   *  overlay text on top. Invalidated (set undefined) on edit/delete so
   *  expanded/shrunk blocks get re-erased. */
  backgroundCanvas?: HTMLCanvasElement;
}

interface PdfPageProxy {
  getViewport: (params: { scale: number }) => { width: number; height: number; transform: number[] };
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }>;
}

interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageProxy>;
}

type AnyWorker = {
  recognize: (
    img: HTMLCanvasElement,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>,
  ) => Promise<RecognizeOutput>;
  terminate: () => Promise<unknown>;
};

interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface RecognizeOutput {
  data: {
    blocks?: Array<{
      paragraphs?: Array<{
        lines?: Array<{
          words?: OcrWord[];
        }>;
      }>;
    }>;
  };
}

export default function TableEditor({
  projectId,
  totalPagesHint,
  onTotalPagesChange,
}: TableEditorProps): React.ReactElement {
  const [totalPages, setTotalPages] = useState<number>(totalPagesHint ?? 0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pdfReady, setPdfReady] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [showBlocks, setShowBlocks] = useState(true);
  const [pageVersion, setPageVersion] = useState(0); // re-renders JSX (overlay text/list)
  const [renderTrigger, setRenderTrigger] = useState(0); // re-runs render useEffect (re-erase bitmap)
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  const pdfRef = useRef<PdfDocument | null>(null);
  const workerRef = useRef<AnyWorker | null>(null);
  const cacheRef = useRef<Map<number, PageCache>>(new Map());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const pdfjsRef = useRef<typeof import("pdfjs-dist") | null>(null);

  const onTotalPagesChangeRef = useRef(onTotalPagesChange);
  onTotalPagesChangeRef.current = onTotalPagesChange;

  // 1) Load PDF + restore saved blocks once per project.
  useEffect(() => {
    let cancelled = false;
    setPdfReady(false);
    setGlobalError(null);
    cacheRef.current = new Map();

    (async () => {
      try {
        const urlRes = await fetch(`${API_BASE}/projects/${projectId}/pdf-url`, { cache: "no-store" });
        if (!urlRes.ok) throw new Error(`pdf-url HTTP ${urlRes.status}`);
        const { url } = (await urlRes.json()) as { url: string };

        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc =
          `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
        pdfjsRef.current = pdfjs;

        const pdf = (await pdfjs.getDocument({ url }).promise) as unknown as PdfDocument;
        if (cancelled) return;
        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);
        onTotalPagesChangeRef.current?.(pdf.numPages);

        // Pre-seed cache with pending entries — actual render happens on demand.
        for (let i = 1; i <= pdf.numPages; i++) {
          cacheRef.current.set(i, { status: "idle", blocks: [], widthMm: 0, heightMm: 0 });
        }

        // Restore previously saved blocks (all pages).
        try {
          const blocksRes = await fetch(`${API_BASE}/projects/${projectId}/blocks`, { cache: "no-store" });
          if (blocksRes.ok) {
            const { pages } = (await blocksRes.json()) as { pages: SavedPage[] };
            for (const p of pages ?? []) {
              const cache = cacheRef.current.get(p.page_number);
              if (!cache) continue;
              cache.widthMm = p.width_mm;
              cache.heightMm = p.height_mm;
              cache.blocks = (p.blocks ?? []).map(toBlockData);
              if (cache.blocks.length > 0) cache.status = "done";
            }
          }
        } catch (err) {
          console.warn("[v2 restore] failed", err);
        }

        // Init Tesseract worker lazily (parallel with first render).
        void ensureWorker();

        setPdfReady(true);
      } catch (err) {
        if (cancelled) return;
        setGlobalError(err instanceof Error ? err.message : "pdf load failed");
      }
    })();

    return () => {
      cancelled = true;
      if (workerRef.current) {
        void workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [projectId]);

  // 2) Render current page whenever it changes (or pdfReady flips).
  useEffect(() => {
    if (!pdfReady || !pdfRef.current) return;
    const pdf = pdfRef.current;
    if (currentPage < 1 || currentPage > pdf.numPages) return;

    let cancelled = false;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    (async () => {
      try {
        const cache = cacheRef.current.get(currentPage);
        if (!cache) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas ctx unavailable");

        // Fast path: background already prepared → just blit it.
        if (cache.backgroundCanvas && cache.blocks.length > 0) {
          canvas.width = cache.backgroundCanvas.width;
          canvas.height = cache.backgroundCanvas.height;
          overlay.style.width = `${canvas.width}px`;
          overlay.style.height = `${canvas.height}px`;
          ctx.drawImage(cache.backgroundCanvas, 0, 0);
          cache.status = "done";
          setPageVersion((v) => v + 1);
          return;
        }

        cache.status = cache.blocks.length > 0 ? "done" : "loading";
        setPageVersion((v) => v + 1);

        const page = await pdf.getPage(currentPage);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: DISPLAY_SCALE });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        overlay.style.width = `${canvas.width}px`;
        overlay.style.height = `${canvas.height}px`;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (cancelled) return;

        // Cache mm dimensions if we don't have them yet.
        if (cache.widthMm === 0 || cache.heightMm === 0) {
          const baseVp = page.getViewport({ scale: 1 });
          cache.widthMm = baseVp.width * MM_PER_PT;
          cache.heightMm = baseVp.height * MM_PER_PT;
        }

        // If no blocks yet — try PDF.js text extraction first; if empty, OCR.
        if (cache.blocks.length === 0) {
          const pdfjs = pdfjsRef.current!;
          const textContent = await page.getTextContent();
          const pdfBlocks: BlockData[] = [];
          for (const item of textContent.items) {
            if (!item.transform || !item.str) continue;
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]);
            const widthPx = (item.width ?? 0) * DISPLAY_SCALE;
            const left = tx[4];
            const top = tx[5] - fontHeight;
            pdfBlocks.push({
              id: newBlockId(),
              text: item.str,
              xMm: pxToMm(left),
              yMm: pxToMm(top),
              wMm: pxToMm(widthPx),
              hMm: pxToMm(fontHeight),
              source: "pdf",
              title: item.str,
            });
          }

          if (pdfBlocks.length > 0) {
            cache.blocks = pdfBlocks;
            cache.status = "done";
            setPageVersion((v) => v + 1);
            void persistAllPages(projectId);
          } else {
            // Fallback OCR (only this page).
            cache.status = "ocr";
            setPageVersion((v) => v + 1);
            const worker = await ensureWorker();
            if (cancelled) return;

            // Off-screen high-res render for crisp OCR.
            const hiVp = page.getViewport({ scale: OCR_RENDER_SCALE });
            const hiCanvas = document.createElement("canvas");
            hiCanvas.width = Math.floor(hiVp.width);
            hiCanvas.height = Math.floor(hiVp.height);
            const hiCtx = hiCanvas.getContext("2d");
            if (!hiCtx) throw new Error("offscreen ctx unavailable");
            await page.render({ canvasContext: hiCtx, viewport: hiVp, canvas: hiCanvas }).promise;
            if (cancelled) return;

            const result = await worker.recognize(hiCanvas, {}, { blocks: true });
            if (cancelled) return;

            const downscale = OCR_RENDER_SCALE / DISPLAY_SCALE;
            const ocrBlocks: BlockData[] = [];
            for (const block of result.data.blocks ?? []) {
              for (const para of block.paragraphs ?? []) {
                for (const line of para.lines ?? []) {
                  for (const word of line.words ?? []) {
                    const text = word.text?.trim();
                    if (!text || word.confidence < 30) continue;
                    const { x0, y0, x1, y1 } = word.bbox;
                    ocrBlocks.push({
                      id: newBlockId(),
                      text,
                      xMm: pxToMm(x0 / downscale),
                      yMm: pxToMm(y0 / downscale),
                      wMm: pxToMm((x1 - x0) / downscale),
                      hMm: pxToMm((y1 - y0) / downscale),
                      source: "ocr",
                      title: `${text} (conf ${Math.round(word.confidence)}%)`,
                    });
                  }
                }
              }
            }
            cache.blocks = ocrBlocks;
            cache.status = "done";
            setPageVersion((v) => v + 1);
            void persistAllPages(projectId);
          }
        } else {
          cache.status = "done";
        }

        if (cancelled) return;

        // Sample text/bg colours per block (only those still missing one),
        // then erase the original text from the bitmap so the overlay is
        // the only source of text on this page.
        for (const b of cache.blocks) {
          if (!b.textColor) b.textColor = sampleTextColor(ctx, b);
          if (!b.bgColor) b.bgColor = sampleBgColor(ctx, b, canvas.width, canvas.height);
        }
        for (const b of cache.blocks) {
          eraseBlockArea(ctx, b);
        }

        // Snapshot the now-erased canvas as the cached background — every
        // future render of this page can skip the costly PDF render + OCR.
        const bg = document.createElement("canvas");
        bg.width = canvas.width;
        bg.height = canvas.height;
        bg.getContext("2d")?.drawImage(canvas, 0, 0);
        cache.backgroundCanvas = bg;

        setPageVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        const cache = cacheRef.current.get(currentPage);
        if (cache) {
          cache.status = "error";
          cache.error = err instanceof Error ? err.message : "render failed";
        }
        setPageVersion((v) => v + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
    // renderTrigger in deps so the effect re-runs after edit/delete and
    // rebuilds the erased background bitmap with the new block geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pdfReady, projectId, renderTrigger]);

  async function ensureWorker(): Promise<AnyWorker> {
    if (workerRef.current) return workerRef.current;
    const Tesseract = await import("tesseract.js");
    workerRef.current = (await Tesseract.createWorker("pol", 1)) as unknown as AnyWorker;
    return workerRef.current;
  }

  /** Replace blocks for a given page with a new array, producing a new
   *  PageCache and Map so React-tracked state can pick up the change.
   *  Without immutable replacement React keeps rendering the same children.
   *  Also invalidates the cached background so the next render re-erases. */
  function mutatePage(pageNum: number, mutate: (blocks: BlockData[]) => BlockData[]) {
    const old = cacheRef.current.get(pageNum);
    if (!old) return;
    const nextBlocks = mutate(old.blocks);
    if (nextBlocks === old.blocks) return; // no-op
    const nextCache: PageCache = {
      ...old,
      blocks: nextBlocks,
      backgroundCanvas: undefined, // force re-erase on next render pass
    };
    const nextMap = new Map(cacheRef.current);
    nextMap.set(pageNum, nextCache);
    cacheRef.current = nextMap;
    setPageVersion((v) => v + 1);
    setRenderTrigger((t) => t + 1);
  }

  function findPageOfBlock(id: string): number | null {
    for (const [pageNum, c] of cacheRef.current.entries()) {
      if (c.blocks.some((b) => b.id === id)) return pageNum;
    }
    return null;
  }

  function updateBlockText(id: string, newText: string) {
    const text = newText.trim();
    if (!text) return;
    const pageNum = findPageOfBlock(id);
    if (pageNum == null) return;
    console.log("[v2 edit]", id, "→", text, "on page", pageNum);
    mutatePage(pageNum, (blocks) =>
      blocks.map((b) => {
        if (b.id !== id || b.text === text) return b;
        // Auto-grow the block width to fit the new text — otherwise the
        // overlay clips the change and the user thinks nothing happened.
        const minWidth = estimateTextWidthMm(text, b.hMm);
        return { ...b, text, title: text, wMm: Math.max(b.wMm, minWidth) };
      }),
    );
    void persistAllPages(projectId);
  }

  /** Rough mm width estimate based on glyph height — assumes proportional
   *  font with average char width ≈ 55% of height plus a small padding. */
  function estimateTextWidthMm(text: string, heightMm: number): number {
    if (heightMm <= 0) return 0;
    return text.length * heightMm * 0.55 + heightMm * 0.4;
  }

  function deleteBlock(id: string) {
    const pageNum = findPageOfBlock(id);
    if (pageNum == null) return;
    console.log("[v2 delete]", id, "from page", pageNum);
    if (selectedBlockId === id) setSelectedBlockId(null);
    if (hoveredBlockId === id) setHoveredBlockId(null);
    mutatePage(pageNum, (blocks) => blocks.filter((b) => b.id !== id));
    void persistAllPages(projectId);
  }

  async function persistAllPages(pid: string) {
    const pages = Array.from(cacheRef.current.entries())
      .filter(([, c]) => c.blocks.length > 0)
      .map(([pageNumber, c]) => ({
        page_number: pageNumber,
        width_mm: c.widthMm,
        height_mm: c.heightMm,
        blocks: c.blocks.map((b, i) => ({
          type: "text",
          x_mm: b.xMm,
          y_mm: b.yMm,
          w_mm: b.wMm,
          h_mm: b.hMm,
          z_index: i,
          content: { pl: b.text, _title: b.title, _src: b.source, _id: b.id },
          lang_default: "pl",
        })),
      }));
    try {
      const res = await fetch(`${API_BASE}/projects/${pid}/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages }),
      });
      if (!res.ok) console.error("[v2 save] HTTP", res.status);
    } catch (err) {
      console.error("[v2 save] error", err);
    }
  }

  const cache = cacheRef.current.get(currentPage);
  const statusText = useMemo(() => {
    if (!cache) return "—";
    if (cache.status === "loading") return "Renderowanie...";
    if (cache.status === "ocr") return "OCR po polsku...";
    if (cache.status === "done") return `${cache.blocks.length} bloków`;
    if (cache.status === "error") return `Błąd: ${cache.error ?? "?"}`;
    return "—";
    // pageVersion in deps so the memo recomputes after status mutations
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, pageVersion]);

  return (
    <div className="space-y-4">
      {globalError && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          Błąd: {globalError}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* ──────── Column A: PDF + page navigation ──────── */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-30"
              >
                ← Poprzednia
              </button>
              <span className="text-sm font-medium text-slate-700">
                Strona{" "}
                <select
                  value={currentPage}
                  onChange={(e) => setCurrentPage(parseInt(e.target.value, 10))}
                  className="mx-1 rounded border border-slate-300 px-1 py-0.5 text-sm"
                >
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>{" "}
                / {totalPages || "?"}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-30"
              >
                Następna →
              </button>
            </div>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={showBlocks}
                onChange={(e) => setShowBlocks(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              bloki
            </label>
          </div>

          <p className="mb-2 text-xs text-slate-500">{statusText}</p>

          <div className="flex items-start justify-center overflow-auto bg-slate-50 p-3">
            <div className="relative inline-block">
              <canvas ref={canvasRef} className="block bg-white shadow-sm" />
              <div
                ref={overlayRef}
                className="pdf-block-overlay pointer-events-none absolute left-0 top-0"
                data-blocks-visible={showBlocks ? "1" : undefined}
              >
                {showBlocks && cache?.blocks.map((b) => {
                  const isSelected = selectedBlockId === b.id;
                  const isHovered = hoveredBlockId === b.id;
                  const heightPx = mmToPx(b.hMm);
                  // Glyphs are typically ~80% of leading height; lower-case
                  // letters fit comfortably at this ratio.
                  const fontPx = Math.max(4, heightPx * 0.78);
                  return (
                    <div
                      key={b.id}
                      className={
                        `pdf-text-block pdf-text-block--${b.source}` +
                        (isSelected ? " selected" : "") +
                        (isHovered ? " hovered" : "")
                      }
                      style={{
                        left: `${mmToPx(b.xMm)}px`,
                        top: `${mmToPx(b.yMm)}px`,
                        width: `${mmToPx(b.wMm)}px`,
                        height: `${heightPx}px`,
                        pointerEvents: "auto",
                        // When colours are sampled, override the source-coded
                        // backgrounds so the overlay actually replaces the
                        // original text (instead of layering on top of it).
                        background: b.bgColor ?? undefined,
                        color: b.textColor ?? undefined,
                        outline: isSelected || isHovered ? undefined : "none",
                        fontSize: `${fontPx}px`,
                        lineHeight: 1,
                      }}
                      title={b.title}
                      onMouseEnter={() => setHoveredBlockId(b.id)}
                      onMouseLeave={() => setHoveredBlockId(null)}
                      onClick={() => setSelectedBlockId(b.id)}
                    >
                      {heightPx > 6 ? b.text : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ──────── Column B: blocks list (Y.3) ──────── */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Bloki strony {currentPage}</h3>
            <span className="text-xs text-slate-500">
              {cache?.blocks.length ?? 0} {cache && cache.blocks.length === 1 ? "blok" : "bloków"}
            </span>
          </div>
          <p className="mb-3 text-[11px] text-slate-500">
            Najedź — podświetlasz blok w podglądzie. Dwuklik — edycja. <kbd className="rounded border border-slate-300 bg-white px-1">Enter</kbd> zatwierdza, <kbd className="rounded border border-slate-300 bg-white px-1">Esc</kbd> anuluje.
          </p>

          {cache && cache.blocks.length === 0 && cache.status === "done" && (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-center text-xs text-slate-500">
              Brak bloków na tej stronie.
            </p>
          )}

          <ul className="max-h-[640px] space-y-1 overflow-y-auto pr-1">
            {cache?.blocks.map((b) => (
              <BlockListItem
                key={b.id}
                block={b}
                hovered={hoveredBlockId === b.id}
                selected={selectedBlockId === b.id}
                onMouseEnter={() => setHoveredBlockId(b.id)}
                onMouseLeave={() => setHoveredBlockId(null)}
                onClick={() => setSelectedBlockId(b.id)}
                onCommit={(text) => updateBlockText(b.id, text)}
                onDelete={() => deleteBlock(b.id)}
              />
            ))}
          </ul>
        </div>

        {/* ──────── Column C: Excel entries (Y.4 placeholder) ──────── */}
        <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-4 text-center text-sm text-slate-500">
          <p className="font-medium text-slate-700">C · Wpisy Excela</p>
          <p className="mt-2 text-xs">
            Sub-faza Y.4 — wpisy filtrowane po stronie {currentPage}, drag mapping.
          </p>
        </div>
      </div>
    </div>
  );
}

interface BlockListItemProps {
  block: BlockData;
  hovered: boolean;
  selected: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
  onCommit: (text: string) => void;
  onDelete: () => void;
}

function BlockListItem({
  block,
  hovered,
  selected,
  onMouseEnter,
  onMouseLeave,
  onClick,
  onCommit,
  onDelete,
}: BlockListItemProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.text);

  // If parent updates block.text (e.g. after another edit), keep draft in sync
  // when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(block.text);
  }, [block.text, editing]);

  const startEdit = () => {
    setDraft(block.text);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== block.text) onCommit(draft.trim());
  };
  const cancel = () => {
    setDraft(block.text);
    setEditing(false);
  };

  const sourceColor: Record<BlockData["source"], string> = {
    pdf: "bg-teal-100 text-teal-800",
    ocr: "bg-sky-100 text-sky-800",
    db: "bg-slate-200 text-slate-700",
    manual: "bg-emerald-100 text-emerald-800",
  };

  return (
    <li
      data-block-id={block.id}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      className={
        "group cursor-pointer rounded-md border px-2 py-1.5 text-xs transition " +
        (selected
          ? "border-amber-500 bg-amber-100"
          : hovered
            ? "border-amber-300 bg-amber-50"
            : "border-slate-200 bg-white hover:border-slate-300")
      }
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${sourceColor[block.source]}`}
        >
          {block.source}
        </span>
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            // Prevent the click handler from firing on input clicks/selection.
            onClick={(e) => e.stopPropagation()}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="flex-1 rounded border border-slate-400 bg-white px-1.5 py-0.5 text-xs text-slate-900 outline-none focus:border-blue-500"
          />
        ) : (
          <span
            className="flex-1 break-words text-slate-800"
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
            title="Dwuklik aby edytować"
          >
            {block.text}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Usunąć blok "${block.text}"?`)) onDelete();
          }}
          className="shrink-0 text-[11px] font-medium text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-red-700"
          title="Usuń blok"
        >
          ×
        </button>
      </div>
    </li>
  );
}

interface SavedBlock {
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  content: { pl?: string; _title?: string; _src?: string; _id?: string } | null;
}

interface SavedPage {
  page_number: number;
  width_mm: number;
  height_mm: number;
  blocks: SavedBlock[];
}

function toBlockData(sb: SavedBlock): BlockData {
  const text = sb.content?.pl ?? "";
  return {
    id: sb.content?._id ?? newBlockId(),
    text,
    xMm: sb.x_mm,
    yMm: sb.y_mm,
    wMm: sb.w_mm,
    hMm: sb.h_mm,
    source: (sb.content?._src as BlockData["source"]) ?? "db",
    title: sb.content?._title ?? text,
  };
}

function newBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function pxToMm(px: number): number {
  return (px / DISPLAY_SCALE) * MM_PER_PT;
}

function mmToPx(mm: number): number {
  return (mm / MM_PER_PT) * DISPLAY_SCALE;
}

/** Pick a representative pixel inside the block area (avoiding the very
 *  edges where antialiasing might wash the colour) and convert to rgb(). */
function sampleTextColor(ctx: CanvasRenderingContext2D, b: BlockData): string {
  const x = Math.round(mmToPx(b.xMm) + mmToPx(b.wMm) * 0.15);
  const y = Math.round(mmToPx(b.yMm) + mmToPx(b.hMm) * 0.55);
  const px = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
  return `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
}

/** Sample a pixel just outside the block's bounding box — that's most likely
 *  the page background colour, which we use to erase the original text. */
function sampleBgColor(
  ctx: CanvasRenderingContext2D,
  b: BlockData,
  canvasW: number,
  canvasH: number,
): string {
  const left = mmToPx(b.xMm);
  const top = mmToPx(b.yMm);
  const right = left + mmToPx(b.wMm);
  const bottom = top + mmToPx(b.hMm);
  // Try, in order: directly above, directly below, left, right.
  const candidates: Array<[number, number]> = [
    [Math.round((left + right) / 2), Math.round(top - 3)],
    [Math.round((left + right) / 2), Math.round(bottom + 3)],
    [Math.round(left - 3), Math.round((top + bottom) / 2)],
    [Math.round(right + 3), Math.round((top + bottom) / 2)],
  ];
  for (const [x, y] of candidates) {
    if (x < 0 || y < 0 || x >= canvasW || y >= canvasH) continue;
    const px = ctx.getImageData(x, y, 1, 1).data;
    return `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
  }
  return "rgb(255, 255, 255)";
}

/** Paint over the original rasterised text with the sampled background.
 *  Slight pixel overgrow handles antialiasing fringe around glyphs. */
function eraseBlockArea(ctx: CanvasRenderingContext2D, b: BlockData): void {
  if (!b.bgColor) return;
  const x = mmToPx(b.xMm) - 1;
  const y = mmToPx(b.yMm) - 1;
  const w = mmToPx(b.wMm) + 2;
  const h = mmToPx(b.hMm) + 2;
  ctx.fillStyle = b.bgColor;
  ctx.fillRect(x, y, w, h);
}
