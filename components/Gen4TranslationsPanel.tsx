"use client";

import { useCallback, useEffect, useState } from "react";

const SUPPORTED_LANGS = ["bg", "hr", "ro", "mk", "sq", "en"] as const;
type TargetLang = (typeof SUPPORTED_LANGS)[number];

const LANG_LABELS: Record<TargetLang, string> = {
  bg: "Български",
  hr: "Hrvatski",
  ro: "Română",
  mk: "Македонски",
  sq: "Shqip",
  en: "English",
};

const API = "/generator-instrukcji/api/v4";

interface TranslationRow {
  id: string;
  element_id: string;
  language: string;
  text: string;
  is_pinned: boolean;
  source: string;
}

interface Props {
  projectId: string;
  /** Total number of translatable (text/callout) elements in the project. */
  totalTextElements: number;
}

export default function Gen4TranslationsPanel({ projectId, totalTextElements }: Props): React.ReactElement {
  const [coverage, setCoverage] = useState<Map<TargetLang, number>>(new Map());
  const [activeLang, setActiveLang] = useState<TargetLang | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [promptItemCount, setPromptItemCount] = useState(0);
  const [importJson, setImportJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshCoverage = useCallback(async () => {
    try {
      const res = await fetch(`${API}/projects/${projectId}/translations/`, { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { translations: TranslationRow[] };
      const m = new Map<TargetLang, number>();
      for (const row of j.translations) {
        const lang = row.language as TargetLang;
        if (!SUPPORTED_LANGS.includes(lang)) continue;
        m.set(lang, (m.get(lang) ?? 0) + 1);
      }
      setCoverage(m);
    } catch {
      // silent — coverage is best-effort
    }
  }, [projectId]);

  useEffect(() => { void refreshCoverage(); }, [refreshCoverage]);

  const openLang = async (lang: TargetLang) => {
    setActiveLang(lang);
    setPrompt(null);
    setImportJson("");
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const res = await fetch(`${API}/projects/${projectId}/translate-prompt/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML — sesja wygasła?`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { combined: string; itemCount: number };
      setPrompt(j.combined);
      setPromptItemCount(j.itemCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
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

  const importTranslation = async () => {
    if (!activeLang || !importJson.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/translations/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: activeLang, json: importJson }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: serwer zwrócił HTML — sesja wygasła?`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { imported: number; skipped: number };
      setInfo(`Zaimportowano ${j.imported} tłumaczeń${j.skipped > 0 ? ` (pominięto ${j.skipped} z nieznanym element_id)` : ""}.`);
      setImportJson("");
      await refreshCoverage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <h3 className="mb-1 text-base font-semibold text-slate-900">Tłumaczenia</h3>
      <p className="mb-4 text-xs text-slate-500">
        Wygeneruj wersję dla wybranego języka. Workflow: kliknij język → skopiuj prompt → wklej w nowej rozmowie z Claude.ai → wynikowy JSON wklej do importu.
      </p>

      <ul className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SUPPORTED_LANGS.map((lang) => {
          const done = coverage.get(lang) ?? 0;
          const isActive = activeLang === lang;
          const completionPct = totalTextElements > 0 ? Math.round((done / totalTextElements) * 100) : 0;
          return (
            <li key={lang}>
              <button
                type="button"
                onClick={() => void openLang(lang)}
                disabled={busy && !isActive}
                className={
                  "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left transition disabled:opacity-50 " +
                  (isActive
                    ? "border-purple-500 bg-purple-50"
                    : "border-slate-200 bg-white hover:border-purple-300")
                }
              >
                <span className="flex w-full items-baseline justify-between gap-2 text-sm font-semibold text-slate-900">
                  <span>{lang.toUpperCase()}</span>
                  <span className="text-[10px] font-medium text-slate-500">{LANG_LABELS[lang]}</span>
                </span>
                <span className="mt-1 flex items-baseline gap-2 text-[11px] text-slate-500">
                  <span>{done}/{totalTextElements}</span>
                  <span className={done === totalTextElements && totalTextElements > 0 ? "text-emerald-600" : ""}>
                    {completionPct}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}
      {info && (
        <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {info}
        </p>
      )}

      {activeLang && (
        <div className="space-y-4">
          <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-900">
                Krok 1 — Skopiuj prompt PL → {activeLang.toUpperCase()}
              </h4>
              <button
                type="button"
                disabled={!prompt}
                onClick={copyPrompt}
                className="rounded-md bg-purple-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-800 disabled:opacity-50"
              >
                {copied ? "✓ Skopiowano" : "📋 Skopiuj"}
              </button>
            </div>
            {prompt ? (
              <>
                <p className="mb-2 text-[11px] text-slate-600">
                  {promptItemCount} fragmentów do tłumaczenia. Wklej w <a href="https://claude.ai/new" target="_blank" rel="noreferrer" className="underline">claude.ai/new</a>.
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-slate-600 hover:text-slate-900">▸ Pokaż prompt</summary>
                  <textarea
                    readOnly
                    value={prompt}
                    rows={10}
                    className="mt-2 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
                  />
                </details>
              </>
            ) : (
              <p className="text-xs text-slate-500">Ładuję prompt...</p>
            )}
          </div>

          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <h4 className="mb-2 text-sm font-semibold text-slate-900">Krok 2 — Wklej JSON odpowiedzi</h4>
            <p className="mb-2 text-[11px] text-slate-600">
              Format: <code>{`{"translations":{"<element_id>":"<tłumaczenie>"}}`}</code> (tak zwraca Claude przy zastosowaniu prompta).
            </p>
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              placeholder='{"translations": {"abcd-1234-...": "Brzi vodič", "...": "..."}}'
              rows={8}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={busy || !importJson.trim()}
                onClick={importTranslation}
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                {busy ? "Importuję..." : `Importuj ${activeLang.toUpperCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
