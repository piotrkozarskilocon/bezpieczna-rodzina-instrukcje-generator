"use client";

import { useState } from "react";

const API = "/generator-instrukcji/api/v4";

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

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = `lang=${lang}${draft ? "&draft=1" : ""}`;
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

        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="ml-auto inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Generuję..." : `📄 Pobierz PDF (${lang.toUpperCase()}${draft ? " · DRAFT" : ""})`}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
      )}
    </div>
  );
}
