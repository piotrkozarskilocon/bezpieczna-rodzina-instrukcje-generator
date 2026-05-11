"use client";

import { useEffect, useRef, useState } from "react";
import type { LangKey, TranslationRow } from "./TranslationsPanel";

interface PdfPagesViewerProps {
  projectId: string;
  /** Notified after PDF is loaded so the parent can persist pages_count. */
  onPagesLoaded?: (pagesCount: number) => void;
  /** Render scale for the on-screen preview bitmap. */
  scale?: number;
  /** Multilang translations from the parent (uploaded XLSX). */
  translations?: TranslationRow[];
  /** Currently displayed language — blocks mapped to a translation row will
   *  swap their text accordingly. */
  displayLang?: LangKey;
}

const API_BASE = "/generator-instrukcji/api";
/** Default OCR scale — user can tune this in the UI and re-run. */
const DEFAULT_OCR_SCALE = 7;
const DEFAULT_DISPLAY_SCALE = 4;
/** Re-OCR for user-selected regions targets ~80 px glyph height. */
const RE_OCR_TARGET_HEIGHT_PX = 80;
const RE_OCR_MAX_SCALE = 16;
/** PDF native unit is the typographic point (1pt = 1/72 in = 0.3527... mm). */
const MM_PER_PT = 25.4 / 72;
/** Hard caps for the resolution inputs. Browser canvas is limited to ~16384 px
 *  on a side; for a 76×76mm (~215pt) page that's roughly scale 76. We cap
 *  much lower since OCR doesn't benefit from going past ~16x and rendering
 *  becomes painfully slow well before the canvas limit. */
const DISPLAY_SCALE_MAX = 8;
const OCR_SCALE_MAX = 16;

function clampScale(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

type Stage = "idle" | "loading" | "rendering" | "ocr" | "done" | "error";

interface PdfPageProxy {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
    canvas: HTMLCanvasElement;
  }) => { promise: Promise<void> };
}

interface BlockData {
  /** Stable client-side id used as DOM data-block-id attribute. */
  id: string;
  type: "text" | "image";
  /** PL/source text (from PDF.js or OCR). Used as the fallback when no
   *  translation mapping exists. Edits via inline-edit overwrite this field. */
  text: string;
  /** Source of truth: millimetres on the original PDF page. */
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  title: string;
  source: "pdf" | "ocr" | "re-ocr" | "db" | "manual";
  /** Index into translations[] (matched on import or set manually). When set,
   *  the displayed text comes from translations[i].content[displayLang]. */
  translationRowIndex?: number;
}

interface PageState {
  pageWrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  pageBlocksLabel: HTMLSpanElement;
  rerunButton: HTMLButtonElement;
  textsList: HTMLOListElement;
  textsSummary: HTMLElement;
  pageIndex: number;
  pageNumber: number;
  pageProxy: PdfPageProxy | null;
  /** Page dimensions in millimetres (constant per page, stored once). */
  widthMm: number;
  heightMm: number;
  /** In-memory mirror of the per-page block list — source of truth for save. */
  blocks: BlockData[];
}

interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

type RecognizeOutput = {
  data: {
    blocks?: Array<{
      paragraphs?: Array<{
        lines?: Array<{
          words?: OcrWord[];
        }>;
      }>;
    }>;
  };
};

type AnyWorker = {
  recognize: (
    img: HTMLCanvasElement,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>,
  ) => Promise<RecognizeOutput>;
  terminate: () => Promise<unknown>;
};

export default function PdfPagesViewer({
  projectId,
  onPagesLoaded,
  scale,
  translations,
  displayLang = "pl",
}: PdfPagesViewerProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<AnyWorker | null>(null);
  const pageStatesRef = useRef<PageState[]>([]);

  const [displayScale, setDisplayScale] = useState(scale ?? DEFAULT_DISPLAY_SCALE);
  const [ocrScale, setOcrScale] = useState(DEFAULT_OCR_SCALE);
  // Bumped to force a full re-render + re-OCR of the document.
  const [rerunTrigger, setRerunTrigger] = useState(0);

  // Form state for the inputs (commits to displayScale/ocrScale only when the
  // user clicks "Zastosuj" — otherwise typing 8.5 would trigger a render after
  // every keystroke).
  const [displayInput, setDisplayInput] = useState(displayScale);
  const [ocrInput, setOcrInput] = useState(ocrScale);

  const [stage, setStage] = useState<Stage>("idle");
  const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);
  const [ocrProgress, setOcrProgress] = useState<{ current: number; total: number; pct: number } | null>(null);
  const [blocksTotal, setBlocksTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showBlocks, setShowBlocks] = useState(true);
  const [selectionPage, setSelectionPage] = useState<{ pageIndex: number; mode: "re-ocr" | "add" } | null>(null);
  const [reOcrBusy, setReOcrBusy] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const onPagesLoadedRef = useRef(onPagesLoaded);
  onPagesLoadedRef.current = onPagesLoaded;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced save — collects rapid re-OCR adds into a single POST.
  function scheduleSave(): void {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus({ ok: true, text: "Zapisuję..." });
      const result = await saveBlocksToDb(projectId, pageStatesRef.current);
      setSaveStatus(
        result.ok
          ? { ok: true, text: `Zapisano ${result.blocks} bloków` }
          : { ok: false, text: `Błąd zapisu: ${result.error ?? "?"}` },
      );
      // Auto-clear successful status after 4s; keep errors visible.
      if (result.ok) {
        setTimeout(() => setSaveStatus((cur) => (cur?.ok ? null : cur)), 4000);
      }
    }, 1500);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (showBlocks) container.dataset.blocksVisible = "1";
    else delete container.dataset.blocksVisible;
  }, [showBlocks]);

  // Auto-map unmapped blocks to translation rows by fuzzy PL match, then
  // re-render visible text in the currently selected display language.
  // Triggered when translations or displayLang change, or after pages render.
  useEffect(() => {
    if (stage !== "done") return;
    const pageStates = pageStatesRef.current;
    if (pageStates.length === 0) return;

    let mappedCount = 0;
    if (translations && translations.length > 0) {
      const byIndex = new Map<number, TranslationRow>();
      for (const t of translations) byIndex.set(t.row_index, t);

      for (const state of pageStates) {
        for (const block of state.blocks) {
          if (block.translationRowIndex != null) continue;
          if (!block.text || block.text.length < 2) continue;
          const best = bestMatch(block.text, translations);
          if (best && best.score >= 0.85) {
            block.translationRowIndex = best.row.row_index;
            mappedCount++;
          }
        }
      }
      if (mappedCount > 0) {
        scheduleSave();
        console.log(`[multilang] auto-mapped ${mappedCount} new blocks`);
      }
      // Re-paint texts for the active language.
      for (const state of pageStates) {
        for (const block of state.blocks) {
          paintBlockText(state, block, byIndex, displayLang);
        }
      }
    } else {
      // No translations loaded → show original text everywhere.
      for (const state of pageStates) {
        for (const block of state.blocks) {
          paintBlockText(state, block, null, displayLang);
        }
      }
    }
  }, [translations, displayLang, stage]);

  // Main render + first-pass OCR effect.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Defensive: if state was set out-of-band, refuse to render at insane
    // scales (canvas allocations become unrecoverable browser hangs).
    if (
      displayScale > DISPLAY_SCALE_MAX ||
      displayScale < 1 ||
      ocrScale > OCR_SCALE_MAX ||
      ocrScale < 3
    ) {
      setStage("error");
      setError(
        `Niepoprawna rozdzielczość (display ${displayScale}×, OCR ${ocrScale}×). ` +
        `Limity: display 1-${DISPLAY_SCALE_MAX}, OCR 3-${OCR_SCALE_MAX}.`,
      );
      return;
    }

    let cancelled = false;
    setStage("loading");
    setError(null);
    setRenderProgress(null);
    setOcrProgress(null);
    setBlocksTotal(0);
    container.innerHTML = "";
    pageStatesRef.current = [];
    setSelectionPage(null);
    setSelectedBlockId(null);

    (async () => {
      try {
        const urlRes = await fetch(`${API_BASE}/projects/${projectId}/pdf-url`, {
          cache: "no-store",
        });
        if (!urlRes.ok) throw new Error(`pdf-url HTTP ${urlRes.status}`);
        const { url } = (await urlRes.json()) as { url: string };

        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc =
          `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

        const pdf = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;

        const total = pdf.numPages;
        setStage("rendering");
        setRenderProgress({ current: 0, total });
        onPagesLoadedRef.current?.(total);

        const pageStates: PageState[] = [];
        let extractedTextCount = 0;
        let runningBlocks = 0;

        for (let i = 1; i <= total; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: displayScale });

          const figure = document.createElement("figure");
          figure.className = "mb-6 inline-block rounded-md border border-slate-200 bg-white shadow-sm";

          const pageWrap = document.createElement("div");
          pageWrap.className = "relative";
          pageWrap.style.width = `${Math.floor(viewport.width)}px`;
          pageWrap.style.height = `${Math.floor(viewport.height)}px`;

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = "block";
          pageWrap.appendChild(canvas);

          const overlay = document.createElement("div");
          overlay.className = "pdf-block-overlay absolute inset-0 pointer-events-none";
          pageWrap.appendChild(overlay);

          const caption = document.createElement("figcaption");
          caption.className = "px-3 py-1.5 text-xs text-slate-500 border-t border-slate-100 flex items-center justify-between gap-2";
          const labelLeft = document.createElement("span");
          labelLeft.textContent = `Strona ${i} / ${total}`;
          const labelMiddle = document.createElement("span");
          labelMiddle.className = "text-slate-400";
          labelMiddle.textContent = "—";
          const rerunButton = document.createElement("button");
          rerunButton.type = "button";
          rerunButton.className =
            "rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-slate-500 hover:text-slate-900 disabled:opacity-50";
          rerunButton.textContent = "🔍 OCR fragment";
          const pageIndex = i - 1;
          rerunButton.addEventListener("click", () => {
            setSelectionPage((prev) =>
              prev?.pageIndex === pageIndex && prev.mode === "re-ocr"
                ? null
                : { pageIndex, mode: "re-ocr" },
            );
          });
          const addButton = document.createElement("button");
          addButton.type = "button";
          addButton.className =
            "rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-green-600 hover:text-green-700 disabled:opacity-50";
          addButton.textContent = "+ Dodaj blok";
          addButton.addEventListener("click", () => {
            setSelectionPage((prev) =>
              prev?.pageIndex === pageIndex && prev.mode === "add"
                ? null
                : { pageIndex, mode: "add" },
            );
          });
          caption.appendChild(labelLeft);
          caption.appendChild(labelMiddle);
          caption.appendChild(addButton);
          caption.appendChild(rerunButton);

          figure.appendChild(pageWrap);
          figure.appendChild(caption);

          // Collapsible per-page text list. Auto-grows as appendBlockToPage runs.
          const detailsEl = document.createElement("details");
          detailsEl.className = "border-t border-slate-100 text-xs";
          const summary = document.createElement("summary");
          summary.className = "cursor-pointer select-none px-3 py-2 text-slate-600 hover:bg-slate-50";
          summary.textContent = "Lista bloków (0)";
          detailsEl.appendChild(summary);

          const detailsBody = document.createElement("div");
          detailsBody.className = "px-3 pb-3 flex items-start gap-3";

          const ol = document.createElement("ol");
          ol.className = "flex-1 list-decimal list-inside max-h-56 overflow-y-auto text-slate-700 space-y-0.5";

          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-slate-500 hover:text-slate-900";
          copyBtn.textContent = "Kopiuj";
          copyBtn.addEventListener("click", () => {
            const texts = Array.from(ol.querySelectorAll("li")).map((li) => li.textContent ?? "");
            void navigator.clipboard.writeText(texts.join("\n"));
            const orig = copyBtn.textContent;
            copyBtn.textContent = "Skopiowano";
            setTimeout(() => { copyBtn.textContent = orig; }, 1200);
          });

          detailsBody.appendChild(ol);
          detailsBody.appendChild(copyBtn);
          detailsEl.appendChild(detailsBody);
          figure.appendChild(detailsEl);

          container.appendChild(figure);

          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("canvas context unavailable");
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          if (cancelled) return;

          // Page dimensions in mm — read once at scale=1 for portability across
          // display scales / future imports.
          const baseViewport = page.getViewport({ scale: 1 });
          const widthMm = baseViewport.width * MM_PER_PT;
          const heightMm = baseViewport.height * MM_PER_PT;

          const state: PageState = {
            pageWrap,
            canvas,
            overlay,
            pageBlocksLabel: labelMiddle,
            rerunButton,
            textsList: ol,
            textsSummary: summary,
            pageIndex,
            pageNumber: i,
            pageProxy: page as unknown as PdfPageProxy,
            widthMm,
            heightMm,
            blocks: [],
          };

          // PDF.js text extraction first (works for non-outlined PDFs).
          const textContent = await page.getTextContent();
          let pageBlocks = 0;
          for (const item of textContent.items) {
            if (!("transform" in item) || !item.str) continue;
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]);
            const widthPx = item.width * displayScale;
            appendBlockToPage(state, {
              text: item.str,
              left: tx[4],
              top: tx[5] - fontHeight,
              width: widthPx,
              height: fontHeight,
              source: "pdf",
            }, displayScale);
            pageBlocks++;
          }
          extractedTextCount += pageBlocks;
          runningBlocks += pageBlocks;
          labelMiddle.textContent = pageBlocks > 0 ? `${pageBlocks} bloków (PDF)` : "OCR oczekuje";
          setBlocksTotal(runningBlocks);
          setRenderProgress({ current: i, total });
          pageStates.push(state);
        }

        pageStatesRef.current = pageStates;

        // Try to restore previously-saved blocks (skip OCR entirely on reload).
        // Skipped when the user explicitly hits "Przeskanuj ponownie OCR".
        let restoredFromDb = false;
        if (rerunTrigger === 0 && extractedTextCount === 0 && !cancelled) {
          try {
            const savedPages = await fetchSavedBlocks(projectId);
            if (savedPages.length > 0) {
              for (const state of pageStates) {
                const saved = savedPages.find((p) => p.page_number === state.pageNumber);
                if (!saved) continue;
                restoreSavedBlocksToPage(state, saved, displayScale);
                state.pageBlocksLabel.textContent = `${saved.blocks.length} bloków (DB)`;
              }
              runningBlocks = pageStates.reduce((acc, s) => acc + s.blocks.length, 0);
              setBlocksTotal(runningBlocks);
              restoredFromDb = true;
              console.log(`[load DB] restored ${runningBlocks} blocks from ${savedPages.length} pages`);
            }
          } catch (err) {
            console.warn("[load DB] failed, falling back to OCR", err);
          }
        }

        // Init worker for re-OCR fragment regardless of whether OCR pass runs.
        // (Cheap if cached locally; lets the user re-OCR fragments after reload.)
        const ensureWorker = async () => {
          if (workerRef.current || cancelled) return;
          const Tesseract = await import("tesseract.js");
          workerRef.current = (await Tesseract.createWorker("pol", 1)) as unknown as AnyWorker;
        };

        // First-pass OCR if PDF.js found nothing AND we couldn't restore from DB.
        if (!restoredFromDb && extractedTextCount === 0 && !cancelled) {
          setStage("ocr");
          setOcrProgress({ current: 0, total, pct: 0 });

          const Tesseract = await import("tesseract.js");
          workerRef.current = (await Tesseract.createWorker("pol", 1, {
            logger: (m) => {
              if (typeof m.progress === "number") {
                setOcrProgress((prev) =>
                  prev ? { ...prev, pct: Math.round(m.progress * 100) } : prev,
                );
              }
            },
          })) as unknown as AnyWorker;

          const downscale = ocrScale / displayScale;
          for (let i = 0; i < pageStates.length; i++) {
            if (cancelled) break;
            const state = pageStates[i];
            if (!state.pageProxy) continue; // shouldn't happen on first OCR pass
            setOcrProgress({ current: i + 1, total: pageStates.length, pct: 0 });

            // Re-render this page off-screen at ocrScale for crisper glyphs.
            const hiVp = state.pageProxy.getViewport({ scale: ocrScale });
            const hiCanvas = document.createElement("canvas");
            hiCanvas.width = Math.floor(hiVp.width);
            hiCanvas.height = Math.floor(hiVp.height);
            const hiCtx = hiCanvas.getContext("2d");
            if (!hiCtx) throw new Error("offscreen ocr canvas unavailable");
            await state.pageProxy.render({ canvasContext: hiCtx, viewport: hiVp, canvas: hiCanvas }).promise;
            if (cancelled) break;

            const result = await workerRef.current.recognize(hiCanvas, {}, { blocks: true });
            if (cancelled) break;

            const added = appendOcrWordsToPage(
              result,
              state,
              { offsetX: 0, offsetY: 0, downscale },
              displayScale,
              "ocr",
            );
            runningBlocks += added;
            state.pageBlocksLabel.textContent = `${added} bloków (OCR)`;
            setBlocksTotal(runningBlocks);
          }
          // Persist after a full pass so subsequent reloads skip OCR.
          if (!cancelled) {
            setSaveStatus({ ok: true, text: "Zapisuję wyniki OCR..." });
            try {
              const result = await saveBlocksToDb(projectId, pageStates);
              setSaveStatus(
                result.ok
                  ? { ok: true, text: `Zapisano ${result.blocks} bloków do bazy` }
                  : { ok: false, text: `Błąd zapisu: ${result.error ?? "?"}` },
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : "unknown";
              console.warn("[save] post-OCR save threw", err);
              setSaveStatus({ ok: false, text: `Błąd zapisu: ${msg}` });
            }
          }
        } else if (extractedTextCount > 0 && !cancelled) {
          // PDF had real text — save it too (so DB is the canonical source).
          try {
            const result = await saveBlocksToDb(projectId, pageStates);
            setSaveStatus(
              result.ok
                ? { ok: true, text: `Zapisano ${result.blocks} bloków` }
                : { ok: false, text: `Błąd zapisu: ${result.error ?? "?"}` },
            );
          } catch (err) {
            console.warn("[save] post-PDF-extract save threw", err);
          }
          await ensureWorker();
        } else if (restoredFromDb && !cancelled) {
          // Loaded from DB — no OCR pass ran, but we still want a worker
          // ready for selection-based re-OCR.
          await ensureWorker();
        }

        if (!cancelled) setStage("done");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "render failed");
        setStage("error");
      }
    })();

    return () => {
      cancelled = true;
      if (workerRef.current) {
        void workerRef.current.terminate();
        workerRef.current = null;
      }
    };
    // displayScale and ocrScale are intentionally read at effect entry; re-runs
    // are gated by rerunTrigger so simply tweaking inputs doesn't restart.
  }, [projectId, displayScale, ocrScale, rerunTrigger]);

  // ─── Block-level selection + drag + delete ───────────────────────────────
  // Click on a `.pdf-text-block` selects it (visual highlight). The selected
  // block is draggable via interactjs and removable with Delete/Backspace.
  // Click outside any block deselects.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const findBlock = (target: EventTarget | null): { id: string; el: HTMLElement } | null => {
      if (!(target instanceof HTMLElement)) return null;
      const el = target.closest<HTMLElement>(".pdf-text-block");
      if (!el || !el.dataset.blockId) return null;
      return { id: el.dataset.blockId, el };
    };

    const onClick = (e: MouseEvent) => {
      // Ignore clicks while a re-OCR selection is being drawn — the selection
      // overlay swallows mousedown anyway, but be defensive.
      if (selectionPage != null) return;
      const hit = findBlock(e.target);
      if (hit) {
        setSelectedBlockId(hit.id);
      } else {
        // Clicked empty area in the viewer wrapper — deselect.
        if (e.target instanceof HTMLElement && container.contains(e.target)) {
          setSelectedBlockId(null);
        }
      }
    };

    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [selectionPage]);

  // Apply `.selected` class + wire up interactjs drag/resize + dbl-click edit.
  useEffect(() => {
    if (!selectedBlockId) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`.pdf-text-block[data-block-id="${selectedBlockId}"]`);
    if (!el) return;

    el.classList.add("selected");

    const findBlockData = (): { state: PageState; block: BlockData } | null => {
      for (const state of pageStatesRef.current) {
        const block = state.blocks.find((b) => b.id === selectedBlockId);
        if (block) return { state, block };
      }
      return null;
    };

    const commitGeometryFromDom = (target: HTMLElement) => {
      const left = parseFloat(target.style.left) || 0;
      const top = parseFloat(target.style.top) || 0;
      const width = parseFloat(target.style.width) || 0;
      const height = parseFloat(target.style.height) || 0;
      const found = findBlockData();
      if (!found) return;
      found.block.xMm = pxToMm(left, displayScale);
      found.block.yMm = pxToMm(top, displayScale);
      found.block.wMm = pxToMm(width, displayScale);
      found.block.hMm = pxToMm(height, displayScale);
      scheduleSave();
    };

    let interactInstance: { unset: () => void } | null = null;
    let cancelled = false;

    (async () => {
      const interactMod = await import("interactjs");
      if (cancelled) return;
      const interact = interactMod.default;
      const inst = interact(el)
        .draggable({
          listeners: {
            move(event) {
              const target = event.target as HTMLElement;
              if (target.isContentEditable) return; // avoid drag while editing text
              const left = (parseFloat(target.style.left) || 0) + event.dx;
              const top = (parseFloat(target.style.top) || 0) + event.dy;
              target.style.left = `${left}px`;
              target.style.top = `${top}px`;
            },
            end(event) {
              commitGeometryFromDom(event.target as HTMLElement);
            },
          },
        })
        .resizable({
          edges: { left: true, right: true, top: true, bottom: true },
          margin: 6,
          listeners: {
            move(event) {
              const target = event.target as HTMLElement;
              if (target.isContentEditable) return;
              let left = parseFloat(target.style.left) || 0;
              let top = parseFloat(target.style.top) || 0;
              target.style.width = `${event.rect.width}px`;
              target.style.height = `${event.rect.height}px`;
              left += event.deltaRect.left;
              top += event.deltaRect.top;
              target.style.left = `${left}px`;
              target.style.top = `${top}px`;
            },
            end(event) {
              commitGeometryFromDom(event.target as HTMLElement);
            },
          },
          modifiers: [
            interact.modifiers.restrictSize({ min: { width: 8, height: 8 } }),
          ],
        });
      interactInstance = inst as unknown as { unset: () => void };
    })();

    // Inline text edit on double-click.
    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      const found = findBlockData();
      if (!found) return;
      const oldText = found.block.text;
      el.contentEditable = "true";
      el.classList.add("editing");
      el.focus();
      // Select all text so the user can immediately type to replace.
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      const finish = (commit: boolean) => {
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onKey);
        el.classList.remove("editing");
        el.contentEditable = "false";
        const newText = (el.textContent ?? "").trim();
        if (commit && newText !== oldText && newText.length > 0) {
          found.block.text = newText;
          found.block.title = newText;
          // Update the corresponding <li> in the texts list too.
          const li = found.state.textsList.querySelector<HTMLLIElement>(`li[data-block-id="${selectedBlockId}"]`);
          if (li) li.textContent = newText;
          scheduleSave();
        } else {
          // Revert visual content if the user cancelled or cleared.
          el.textContent = oldText;
        }
      };
      const onBlur = () => finish(true);
      const onKey = (ke: KeyboardEvent) => {
        if (ke.key === "Enter" && !ke.shiftKey) {
          ke.preventDefault();
          finish(true);
          el.blur();
        } else if (ke.key === "Escape") {
          ke.preventDefault();
          finish(false);
          el.blur();
        }
      };
      el.addEventListener("blur", onBlur);
      el.addEventListener("keydown", onKey);
    };
    el.addEventListener("dblclick", onDblClick);

    return () => {
      cancelled = true;
      el.classList.remove("selected", "editing");
      el.contentEditable = "false";
      el.removeEventListener("dblclick", onDblClick);
      if (interactInstance) interactInstance.unset();
    };
  }, [selectedBlockId, displayScale]);

  // Delete / Backspace removes the selected block.
  useEffect(() => {
    if (!selectedBlockId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Don't hijack the keystroke when the user is editing text somewhere.
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(`.pdf-text-block[data-block-id="${selectedBlockId}"]`);
      if (el) el.remove();
      // Remove from per-page in-memory list + matching <li> in the texts list.
      for (const state of pageStatesRef.current) {
        const idx = state.blocks.findIndex((b) => b.id === selectedBlockId);
        if (idx === -1) continue;
        state.blocks.splice(idx, 1);
        const li = state.textsList.querySelector<HTMLLIElement>(`li[data-block-id="${selectedBlockId}"]`);
        if (li) li.remove();
        state.textsSummary.textContent = `Lista bloków (${state.textsList.children.length})`;
        break;
      }
      setBlocksTotal((n) => Math.max(0, n - 1));
      setSelectedBlockId(null);
      scheduleSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedBlockId]);

  // Selection-mode effect: attach mouse handlers to the active page's canvas.
  // Supports two modes:
  //   - "re-ocr"  → recognize the selected region with Tesseract
  //   - "add"     → create a new "manual" block at the selected geometry
  useEffect(() => {
    if (selectionPage == null) return;
    const state = pageStatesRef.current[selectionPage.pageIndex];
    if (!state) return;
    const { mode } = selectionPage;

    state.pageWrap.dataset.selectionMode = "1";
    if (mode === "re-ocr") {
      state.rerunButton.textContent = "✕ Anuluj selekcję";
    }

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let box: HTMLDivElement | null = null;

    const toLocal = (e: MouseEvent): { x: number; y: number } => {
      const rect = state.canvas.getBoundingClientRect();
      const sx = state.canvas.width / rect.width;
      const sy = state.canvas.height / rect.height;
      return {
        x: Math.max(0, Math.min(state.canvas.width, (e.clientX - rect.left) * sx)),
        y: Math.max(0, Math.min(state.canvas.height, (e.clientY - rect.top) * sy)),
      };
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = toLocal(e);
      startX = p.x;
      startY = p.y;
      dragging = true;
      console.log("[re-OCR] mousedown", { x: startX, y: startY, page: state.pageIndex + 1 });
      box = document.createElement("div");
      box.className = "pdf-selection-box";
      const rect = state.canvas.getBoundingClientRect();
      box.style.left = `${(startX / state.canvas.width) * rect.width}px`;
      box.style.top = `${(startY / state.canvas.height) * rect.height}px`;
      box.style.width = "0px";
      box.style.height = "0px";
      state.pageWrap.appendChild(box);
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging || !box) return;
      const p = toLocal(e);
      const rect = state.canvas.getBoundingClientRect();
      const ratioW = rect.width / state.canvas.width;
      const ratioH = rect.height / state.canvas.height;
      const left = Math.min(startX, p.x) * ratioW;
      const top = Math.min(startY, p.y) * ratioH;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.abs(p.x - startX) * ratioW}px`;
      box.style.height = `${Math.abs(p.y - startY) * ratioH}px`;
    };

    const onUp = async (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      const p = toLocal(e);
      const x = Math.min(startX, p.x);
      const y = Math.min(startY, p.y);
      const w = Math.abs(p.x - startX);
      const h = Math.abs(p.y - startY);

      if (box) {
        box.remove();
        box = null;
      }

      console.log(`[selection mode=${mode}] mouseup`, { x, y, w, h });

      if (w < 8 || h < 8) {
        console.log("[selection] too small, skipping");
        return;
      }

      // Branch on mode: "add" creates a manual block, "re-ocr" runs Tesseract.
      if (mode === "add") {
        const text = window.prompt("Tekst nowego bloku:")?.trim();
        if (!text) {
          setSelectionPage(null);
          return;
        }
        const newBlock = appendBlockToPage(state, {
          text,
          left: x,
          top: y,
          width: w,
          height: h,
          source: "manual",
        }, displayScale);
        setBlocksTotal((b) => b + 1);
        setSelectionPage(null);
        setSelectedBlockId(newBlock.id);
        scheduleSave();
        return;
      }

      // mode === "re-ocr"
      if (!workerRef.current) {
        setError("Worker OCR jeszcze nie gotowy. Poczekaj aż pierwszy OCR skończy lub wgraj projekt ponownie.");
        return;
      }

      if (!state.pageProxy) {
        setError("PDF.js nie wczytany dla tej strony");
        return;
      }

      setReOcrBusy(true);
      setError(null);
      try {
        const { region, ratio } = await renderHighResRegion(state.pageProxy, x, y, w, h, displayScale);
        console.log(`[re-OCR] region rendered at ${ratio.toFixed(2)}× display scale (${region.width}×${region.height} px)`);
        const result = await workerRef.current.recognize(region, {}, { blocks: true });
        const added = appendOcrWordsToPage(
          result,
          state,
          { offsetX: x, offsetY: y, downscale: ratio },
          displayScale,
          "re-ocr",
        );
        console.log(`[re-OCR] appended ${added} blocks`);
        const prevText = state.pageBlocksLabel.textContent ?? "";
        // Strip any previous "+N (re-OCR)" suffix to keep label readable.
        const baseText = prevText.replace(/ \+ \d+ \(re-OCR\)$/, "");
        const totalReOcr = parseInt(prevText.match(/\+ (\d+) \(re-OCR\)$/)?.[1] ?? "0", 10) + added;
        state.pageBlocksLabel.textContent = totalReOcr > 0
          ? `${baseText} + ${totalReOcr} (re-OCR)`
          : baseText;
        setBlocksTotal((b) => b + added);
        // Auto-exit selection mode so the user can immediately see the new
        // blocks rendered in the (now-restored) overlay.
        setSelectionPage(null);
        scheduleSave();
      } catch (err) {
        console.error("[re-OCR] error", err);
        setError(err instanceof Error ? err.message : "re-OCR failed");
      } finally {
        setReOcrBusy(false);
      }
    };

    state.canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      delete state.pageWrap.dataset.selectionMode;
      state.rerunButton.textContent = "🔍 OCR fragment";
      state.canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (box) box.remove();
    };
  }, [selectionPage, displayScale]);

  const busy = stage === "loading" || stage === "rendering" || stage === "ocr";

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 text-sm">
        <span className="font-medium text-slate-700">Strony PDF</span>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={showBlocks}
              onChange={(e) => setShowBlocks(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Pokaż bloki tekstowe
          </label>
          <span className="text-xs text-slate-500">
            {stage === "loading" && "Pobieranie pliku..."}
            {stage === "rendering" && renderProgress &&
              `Renderowanie ${renderProgress.current}/${renderProgress.total}`}
            {stage === "ocr" && ocrProgress &&
              `OCR ${ocrProgress.current}/${ocrProgress.total} · ${ocrProgress.pct}%`}
            {stage === "done" && renderProgress &&
              `Gotowe — ${renderProgress.total} stron · ${blocksTotal} bloków`}
            {stage === "error" && <span className="text-red-700">Błąd: {error}</span>}
            {reOcrBusy && <span className="ml-2 text-blue-600">re-OCR...</span>}
          </span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          <span>
            Rozdzielczość podglądu (×){" "}
            <span className="text-slate-400">aktywne: {displayScale}</span>
          </span>
          <input
            type="number"
            min={1}
            max={DISPLAY_SCALE_MAX}
            step={0.5}
            value={displayInput}
            onChange={(e) => setDisplayInput(clampScale(parseFloat(e.target.value), 1, DISPLAY_SCALE_MAX, displayInput))}
            disabled={busy}
            className="w-20 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          <span>
            Rozdzielczość OCR (×){" "}
            <span className="text-slate-400">aktywne: {ocrScale}</span>
          </span>
          <input
            type="number"
            min={3}
            max={OCR_SCALE_MAX}
            step={0.5}
            value={ocrInput}
            onChange={(e) => setOcrInput(clampScale(parseFloat(e.target.value), 3, OCR_SCALE_MAX, ocrInput))}
            disabled={busy}
            className="w-20 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          disabled={busy || displayInput === displayScale}
          onClick={() => {
            setDisplayScale(clampScale(displayInput, 1, DISPLAY_SCALE_MAX, displayScale));
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          title="Zmiana podglądu wymusza pełen ponowny render + OCR"
        >
          Zastosuj podgląd
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOcrScale(clampScale(ocrInput, 3, OCR_SCALE_MAX, ocrScale));
            setRerunTrigger((t) => t + 1);
          }}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          title="Wyczyść aktualne bloki i przeskanuj ponownie cały dokument"
        >
          Przeskanuj ponownie OCR
        </button>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
          <span>Źródło bloku:</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-teal-200" /> PDF</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-sky-200" /> OCR</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-purple-200" /> re-OCR</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-slate-200" /> DB</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-green-200" /> manualny</span>
        </div>
      </div>

      {selectionPage != null && (
        <p className="mb-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {selectionPage.mode === "re-ocr" ? (
            <>Tryb <strong>re-OCR</strong>: kliknij i przeciągnij myszą po stronie {selectionPage.pageIndex + 1}, aby zaznaczyć fragment do ponownego OCR. Tryb wyłączy się po jednym OCR.</>
          ) : (
            <>Tryb <strong>dodawania bloku</strong>: kliknij i przeciągnij na stronie {selectionPage.pageIndex + 1} aby narysować prostokąt nowego bloku. Po puszczeniu pojawi się prompt na tekst.</>
          )}
        </p>
      )}

      {selectedBlockId && (() => {
        const block = pageStatesRef.current
          .flatMap((s) => s.blocks.map((b) => ({ b, page: s.pageNumber })))
          .find((entry) => entry.b.id === selectedBlockId);
        if (!block) return null;
        return (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Wybrany blok (str. {block.page}): <strong>{block.b.text}</strong> ·
            Przeciągnij myszą aby przesunąć · <kbd className="rounded border border-amber-300 bg-white px-1">Del</kbd> aby usunąć ·
            kliknij obok aby odznaczyć
          </p>
        );
      })()}

      {error && stage !== "error" && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}{" "}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">
            zamknij
          </button>
        </p>
      )}

      {saveStatus && (
        <p className={
          "mb-3 rounded-md px-3 py-2 text-xs " +
          (saveStatus.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800")
        }>
          {saveStatus.text}
          {!saveStatus.ok && (
            <button type="button" onClick={() => setSaveStatus(null)} className="ml-2 underline">
              zamknij
            </button>
          )}
        </p>
      )}

      {(stage === "ocr" || stage === "rendering") && (
        <p className="mb-3 text-xs text-slate-500">
          {stage === "ocr"
            ? `OCR po polsku przy ${ocrScale}× rozdzielczości. Bloki dopisują się stopniowo.`
            : "Renderowanie podglądu stron..."}
        </p>
      )}

      <div ref={containerRef} className="pdf-pages-stack flex flex-col items-center" />
    </div>
  );
}

interface AppendBlockArgs {
  text: string;
  /** Pixel coordinates on the displayed canvas (display scale). */
  left: number;
  top: number;
  width: number;
  height: number;
  title?: string;
  source: BlockData["source"];
}

/** Generate a short stable id for a block. Crypto.randomUUID is widely
 *  available; the fallback is here for very old environments only. */
function newBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Adds a block to:
 *   - the visual overlay (DOM, in display pixels)
 *   - the per-page text list (DOM)
 *   - the in-memory blocks array (mm — used for DB save)
 */
function appendBlockToPage(state: PageState, args: AppendBlockArgs, displayScale: number): BlockData {
  const id = newBlockId();
  drawBlockDom(state, { ...args, id });
  const data: BlockData = {
    id,
    type: "text",
    text: args.text,
    xMm: pxToMm(args.left, displayScale),
    yMm: pxToMm(args.top, displayScale),
    wMm: pxToMm(args.width, displayScale),
    hMm: pxToMm(args.height, displayScale),
    title: args.title ?? args.text,
    source: args.source,
  };
  state.blocks.push(data);
  return data;
}

/** Renders only the DOM (no in-memory push) — used when restoring from DB. */
function drawBlockDom(state: PageState, args: AppendBlockArgs & { id: string }): void {
  const block = document.createElement("div");
  block.className = `pdf-text-block pdf-text-block--${args.source}`;
  block.dataset.blockId = args.id;
  block.dataset.source = args.source;
  block.style.left = `${args.left}px`;
  block.style.top = `${args.top}px`;
  block.style.width = `${args.width}px`;
  block.style.height = `${args.height}px`;
  block.title = args.title ?? args.text;
  if (args.height > 8) block.textContent = args.text;
  state.overlay.appendChild(block);

  const li = document.createElement("li");
  li.textContent = args.text;
  li.dataset.blockId = args.id;
  if (args.title && args.title !== args.text) li.title = args.title;
  state.textsList.appendChild(li);
  state.textsSummary.textContent = `Lista bloków (${state.textsList.children.length})`;
}

function pxToMm(px: number, displayScale: number): number {
  return (px / displayScale) * MM_PER_PT;
}

function mmToPx(mm: number, displayScale: number): number {
  return (mm / MM_PER_PT) * displayScale;
}

interface AppendOcrOptions {
  offsetX: number;
  offsetY: number;
  /** If region was rendered at higher scale before recognize, divide bbox by this. */
  downscale: number;
}

function appendOcrWordsToPage(
  result: RecognizeOutput,
  state: PageState,
  opts: AppendOcrOptions,
  displayScale: number,
  source: BlockData["source"],
): number {
  let added = 0;
  for (const block of result.data?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text?.trim();
          if (!text) continue;
          if (word.confidence < 30) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          appendBlockToPage(state, {
            text,
            left: opts.offsetX + x0 / opts.downscale,
            top: opts.offsetY + y0 / opts.downscale,
            width: (x1 - x0) / opts.downscale,
            height: (y1 - y0) / opts.downscale,
            title: `${text} (conf ${Math.round(word.confidence)}%)`,
            source,
          }, displayScale);
          added++;
        }
      }
    }
  }
  return added;
}

interface SaveResult {
  ok: boolean;
  pages: number;
  blocks: number;
  error?: string;
}

async function saveBlocksToDb(projectId: string, pageStates: PageState[]): Promise<SaveResult> {
  const payload = {
    pages: pageStates.map((s) => ({
      page_number: s.pageNumber,
      width_mm: s.widthMm,
      height_mm: s.heightMm,
      blocks: s.blocks.map((b, i) => ({
        type: b.type,
        x_mm: b.xMm,
        y_mm: b.yMm,
        w_mm: b.wMm,
        h_mm: b.hMm,
        z_index: i,
        content: {
          pl: b.text,
          _title: b.title,
          _src: b.source,
          _translation_row: b.translationRowIndex,
        },
        lang_default: "pl",
      })),
    })),
  };
  const totalBlocks = payload.pages.reduce((acc, p) => acc + p.blocks.length, 0);
  const bodyJson = JSON.stringify(payload);
  console.log(`[save] sending ${payload.pages.length} pages / ${totalBlocks} blocks (${(bodyJson.length / 1024).toFixed(1)} KB)`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/projects/${projectId}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyJson,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    console.error("[save] network error", err);
    return { ok: false, pages: 0, blocks: 0, error: msg };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[save] HTTP", res.status, text);
    return { ok: false, pages: 0, blocks: 0, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const json = (await res.json().catch(() => ({}))) as Partial<SaveResult>;
  const result: SaveResult = {
    ok: true,
    pages: json.pages ?? payload.pages.length,
    blocks: json.blocks ?? totalBlocks,
  };
  console.log(`[save] OK — ${result.pages} pages / ${result.blocks} blocks persisted`);
  return result;
}

interface SavedBlock {
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  content: {
    pl?: string;
    _title?: string;
    _src?: BlockData["source"];
    _translation_row?: number;
  } | null;
}

interface SavedPage {
  page_number: number;
  width_mm: number;
  height_mm: number;
  blocks: SavedBlock[];
}

async function fetchSavedBlocks(projectId: string): Promise<SavedPage[]> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/blocks`, { cache: "no-store" });
  if (!res.ok) return [];
  const json = (await res.json()) as { pages?: SavedPage[] };
  return json.pages ?? [];
}

function restoreSavedBlocksToPage(
  state: PageState,
  saved: SavedPage,
  displayScale: number,
): void {
  for (const sb of saved.blocks ?? []) {
    const id = newBlockId();
    const text = sb.content?.pl ?? "";
    const left = mmToPx(sb.x_mm, displayScale);
    const top = mmToPx(sb.y_mm, displayScale);
    const width = mmToPx(sb.w_mm, displayScale);
    const height = mmToPx(sb.h_mm, displayScale);
    const title = sb.content?._title ?? text;
    const source = sb.content?._src ?? "db";
    drawBlockDom(state, { id, text, left, top, width, height, title, source });
    state.blocks.push({
      id,
      type: "text",
      text,
      xMm: sb.x_mm,
      yMm: sb.y_mm,
      wMm: sb.w_mm,
      hMm: sb.h_mm,
      title,
      source,
      translationRowIndex:
        typeof sb.content?._translation_row === "number" ? sb.content._translation_row : undefined,
    });
  }
}

/** Returns the translation row whose `pl` text best matches `query`,
 *  along with a similarity score in [0, 1]. Returns null if translations
 *  is empty. Exact matches short-circuit at 1.0 (saves Levenshtein passes). */
function bestMatch(query: string, translations: TranslationRow[]): { row: TranslationRow; score: number } | null {
  if (translations.length === 0) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best: { row: TranslationRow; score: number } | null = null;
  for (const t of translations) {
    const pl = (t.content.pl ?? "").trim().toLowerCase();
    if (!pl) continue;
    if (pl === q) return { row: t, score: 1 };
    // Cheap pre-filter: if lengths differ by more than 50%, skip Levenshtein
    // (its cost is O(m*n) and obviously dissimilar pairs aren't worth scoring).
    const longer = Math.max(q.length, pl.length);
    const shorter = Math.min(q.length, pl.length);
    if (shorter / longer < 0.5) continue;
    const dist = levenshtein(q, pl);
    const score = 1 - dist / longer;
    if (!best || score > best.score) best = { row: t, score };
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Updates the DOM textContent of a block + its <li> in the per-page list,
 *  using the translated text when a mapping exists, falling back to the
 *  original PL text otherwise. */
function paintBlockText(
  state: PageState,
  block: BlockData,
  byIndex: Map<number, TranslationRow> | null,
  lang: LangKey,
): void {
  let text = block.text;
  if (byIndex && block.translationRowIndex != null) {
    const row = byIndex.get(block.translationRowIndex);
    if (row) {
      const translated = row.content[lang];
      const fallback = row.content.pl ?? block.text;
      text = (translated && translated.length > 0 ? translated : fallback) ?? block.text;
    }
  }
  const blockEl = state.overlay.querySelector<HTMLElement>(`.pdf-text-block[data-block-id="${block.id}"]`);
  if (blockEl && !blockEl.classList.contains("editing")) {
    if (block.hMm * 0 + parseFloat(blockEl.style.height) > 8) blockEl.textContent = text;
    blockEl.title = text;
  }
  const li = state.textsList.querySelector<HTMLLIElement>(`li[data-block-id="${block.id}"]`);
  if (li) li.textContent = text;
}

async function renderHighResRegion(
  pageProxy: PdfPageProxy,
  x: number,
  y: number,
  w: number,
  h: number,
  displayScale: number,
): Promise<{ region: HTMLCanvasElement; ratio: number }> {
  const desiredScale = (RE_OCR_TARGET_HEIGHT_PX / h) * displayScale;
  const reScale = Math.min(RE_OCR_MAX_SCALE, Math.max(displayScale * 1.5, desiredScale));
  const ratio = reScale / displayScale;

  const viewport = pageProxy.getViewport({ scale: reScale });
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = Math.floor(viewport.width);
  fullCanvas.height = Math.floor(viewport.height);
  const fullCtx = fullCanvas.getContext("2d");
  if (!fullCtx) throw new Error("offscreen canvas context unavailable");
  await pageProxy.render({ canvasContext: fullCtx, viewport, canvas: fullCanvas }).promise;

  const xRe = Math.round(x * ratio);
  const yRe = Math.round(y * ratio);
  const wRe = Math.round(w * ratio);
  const hRe = Math.round(h * ratio);

  const region = document.createElement("canvas");
  region.width = wRe;
  region.height = hRe;
  const regionCtx = region.getContext("2d");
  if (!regionCtx) throw new Error("region canvas context unavailable");
  regionCtx.drawImage(fullCanvas, xRe, yRe, wRe, hRe, 0, 0, wRe, hRe);
  return { region, ratio };
}
