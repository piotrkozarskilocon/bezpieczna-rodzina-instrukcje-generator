"use client";

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface LintResult {
  issues_per_page: Array<{
    page_number: number;
    page_title: string | null;
    issues: Array<{ severity: "error" | "warning" | "info"; message: string; fix_hint?: string }>;
  }>;
  missing_sections: Array<{ id: string; title: string; reason: string }>;
  orphan_images: string[];
  summary: { errors: number; warnings: number; infos: number; total: number };
  total_pages: number;
}

const LANGS = [
  { code: "pl", label: "Polski" },
  { code: "bg", label: "Български" },
  { code: "hr", label: "Hrvatski" },
  { code: "ro", label: "Română" },
  { code: "mk", label: "Македонски" },
  { code: "sq", label: "Shqip" },
  { code: "en", label: "English" },
];

interface Props {
  projectId: string;
  defaultLang: string;
  /** Optional: how many translations exist per language (for the "X% complete"
   *  badge next to non-default languages). Pass an empty Map if unknown. */
  coverageByLang?: Map<string, number>;
  totalTextElements?: number;
}

export default function Gen4ExportPanel({
  projectId,
  defaultLang,
  coverageByLang,
  totalTextElements,
}: Props): React.ReactElement {
  const [lang, setLang] = useState(defaultLang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  const [print, setPrint] = useState(false); // crop marks + 3mm bleed
  const [lint, setLint] = useState<LintResult | null>(null);
  const [lintBusy, setLintBusy] = useState(false);
  const [lintExpanded, setLintExpanded] = useState(false);

  const refreshLint = useCallback(async () => {
    setLintBusy(true);
    try {
      const res = await fetch(`${API}/projects/${projectId}/lint/`, { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as LintResult;
      setLint(j);
    } catch {
      /* ignore */
    } finally {
      setLintBusy(false);
    }
  }, [projectId]);

  useEffect(() => { void refreshLint(); }, [refreshLint]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = `lang=${lang}${draft ? "&draft=1" : ""}${print ? "&bleed=3&crop=1" : ""}`;
      const res = await fetch(`${API}/projects/${projectId}/export-pdf/?${query}`, {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        // PDF endpoint should return JSON on errors thanks to its content-type guard.
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const j = await res.json();
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      // Pull filename from Content-Disposition or fall back.
      const cd = res.headers.get("content-disposition") ?? "";
      const filenameMatch = cd.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? `instrukcja_${lang.toUpperCase()}.pdf`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <h3 className="mb-1 text-base font-semibold text-slate-900">Eksport PDF</h3>
      <p className="mb-4 text-xs text-slate-600">
        Generuje wektorowy PDF (Inter font embedded) dla wybranego języka. Dla języków innych
        niż <strong>{defaultLang.toUpperCase()}</strong> teksty są zastępowane tłumaczeniami
        z panelu wyżej (jeśli istnieją; brakujące zostają w {defaultLang.toUpperCase()}).
      </p>

      {lint && (
        <div className="mb-4">
          <LintCard lint={lint} expanded={lintExpanded} onToggle={() => setLintExpanded((v) => !v)} onRefresh={() => void refreshLint()} busy={lintBusy} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-slate-700">Język:</label>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {LANGS.map((l) => {
            const cov = coverageByLang?.get(l.code) ?? 0;
            const isDefault = l.code === defaultLang;
            const total = totalTextElements ?? 0;
            const pct = total > 0 && !isDefault ? Math.round((cov / total) * 100) : null;
            return (
              <option key={l.code} value={l.code}>
                {l.code.toUpperCase()} — {l.label}
                {isDefault ? " (bazowy)" : pct != null ? ` (${pct}%)` : ""}
              </option>
            );
          })}
        </select>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>
            Watermark <strong>DRAFT</strong>
            <span className="ml-1 text-[10px] text-slate-500">(do review, nie do druku)</span>
          </span>
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={print}
            onChange={(e) => setPrint(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>
            <strong>3 mm bleed + crop marks</strong>
            <span className="ml-1 text-[10px] text-slate-500">(do drukarni profesjonalnej)</span>
          </span>
        </label>

        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="ml-auto inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Generuję..." : `📄 Pobierz PDF (${lang.toUpperCase()}${draft ? " · DRAFT" : ""}${print ? " · PRINT" : ""})`}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
      )}
    </div>
  );
}

interface LintCardProps {
  lint: LintResult;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}

function LintCard({ lint, expanded, busy, onToggle, onRefresh }: LintCardProps): React.ReactElement {
  const { summary, missing_sections, orphan_images, issues_per_page, total_pages } = lint;
  const blocking = summary.errors > 0 || missing_sections.length > 0 || orphan_images.length > 0;
  const allGood = summary.total === 0 && missing_sections.length === 0 && orphan_images.length === 0;

  const headerBg = allGood
    ? "border-emerald-200 bg-emerald-50"
    : blocking
      ? "border-red-200 bg-red-50"
      : "border-amber-200 bg-amber-50";

  return (
    <div className={`rounded-lg border ${headerBg}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-black/5">
        <span className="flex items-center gap-2 text-xs font-medium">
          {allGood ? "✅ Projekt gotowy do druku" : blocking ? "🚫 Blokery przed eksportem" : "⚠️ Ostrzeżenia do sprawdzenia"}
          <span className="text-slate-500">({total_pages} stron · {summary.total} problemów)</span>
          {summary.errors > 0 && <span className="rounded bg-red-200 px-1.5 py-0.5 text-[10px] font-semibold text-red-900">{summary.errors} błędów</span>}
          {summary.warnings > 0 && <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">{summary.warnings} ostrzeżeń</span>}
          {summary.infos > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">{summary.infos} info</span>}
          {missing_sections.length > 0 && <span className="rounded bg-red-200 px-1.5 py-0.5 text-[10px] font-semibold text-red-900">brak sekcji: {missing_sections.length}</span>}
          {orphan_images.length > 0 && <span className="rounded bg-red-200 px-1.5 py-0.5 text-[10px] font-semibold text-red-900">obrazki sierot: {orphan_images.length}</span>}
        </span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={(e) => { e.stopPropagation(); onRefresh(); }} disabled={busy}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            {busy ? "..." : "Odśwież"}
          </button>
          <span className="text-slate-500">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-black/10 px-3 py-2 text-[11px]">
          {missing_sections.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 font-semibold text-red-900">🚫 Brakujące obowiązkowe sekcje:</p>
              <ul className="space-y-0.5">
                {missing_sections.map((s) => (
                  <li key={s.id} className="text-slate-700">
                    <strong>{s.title}</strong> <span className="text-slate-500">— {s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {orphan_images.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 font-semibold text-red-900">🚫 Elementy image z nieistniejącym image_id ({orphan_images.length}):</p>
              <p className="text-slate-500">Te elementy nie wyrenderują się w PDF. Usuń je lub wgraj brakujące obrazki do biblioteki.</p>
            </div>
          )}

          {issues_per_page.length > 0 && (
            <details>
              <summary className="cursor-pointer font-semibold text-slate-700 hover:text-slate-900">
                Problemy per strona ({issues_per_page.length} stron)
              </summary>
              <div className="mt-1 max-h-64 overflow-auto">
                {issues_per_page.map((p) => (
                  <div key={p.page_number} className="mb-2 rounded border border-slate-200 bg-white p-2">
                    <p className="mb-1 text-[10px] font-semibold text-slate-700">
                      Strona {p.page_number}{p.page_title ? ` — ${p.page_title}` : ""}
                    </p>
                    <ul className="space-y-0.5">
                      {p.issues.map((i, idx) => (
                        <li key={idx} className="flex items-start gap-1.5">
                          <span className={
                            "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase " +
                            (i.severity === "error" ? "bg-red-200 text-red-900"
                              : i.severity === "warning" ? "bg-amber-200 text-amber-900"
                              : "bg-slate-200 text-slate-700")
                          }>{i.severity}</span>
                          <span className="text-slate-600">{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          {allGood && (
            <p className="text-emerald-800">Wszystkie wymagane sekcje obecne, brak ostrzeżeń layoutu, obrazki podpięte. Możesz eksportować PDF bez DRAFT.</p>
          )}
        </div>
      )}
    </div>
  );
}
