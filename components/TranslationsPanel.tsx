"use client";

import { useCallback, useEffect, useState } from "react";

export const LANG_KEYS = ["pl", "bg", "hr", "ro", "mk", "sq", "en"] as const;
export type LangKey = (typeof LANG_KEYS)[number];

export const LANG_LABELS: Record<LangKey, string> = {
  pl: "Polski",
  bg: "Български",
  hr: "Hrvatski",
  ro: "Română",
  mk: "Македонски",
  sq: "Shqip",
  en: "English",
};

export interface TranslationRow {
  row_index: number;
  row_key: string | null;
  content: Partial<Record<LangKey, string>>;
}

interface TranslationsPanelProps {
  projectId: string;
  /** Notified whenever the in-memory translation set changes (load, upload, delete). */
  onChanged: (rows: TranslationRow[]) => void;
}

const API_BASE = "/generator-instrukcji/api";

export default function TranslationsPanel({ projectId, onChanged }: TranslationsPanelProps): React.ReactElement {
  const [rows, setRows] = useState<TranslationRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/translations`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: TranslationRow[] };
      const fetched = json.rows ?? [];
      setRows(fetched);
      onChanged(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    }
  }, [projectId, onChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Plik musi być .xlsx");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("xlsx", file);
      const res = await fetch(`${API_BASE}/projects/${projectId}/translations`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Usunąć wszystkie tłumaczenia z bazy? (Nie wpływa na bloki, tylko czyści tabelę.)")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/translations`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Tłumaczenia (multilang)</h3>
          <p className="text-xs text-slate-500">
            Wgraj Excel (.xlsx) z kolumnami{" "}
            {LANG_KEYS.map((k) => k.toUpperCase()).join(", ")}.
          </p>
        </div>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="rounded border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
          >
            Usuń wszystkie
          </button>
        )}
      </div>

      <label
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        className={
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center text-sm transition " +
          (dragActive ? "border-slate-900 bg-slate-50" : "border-slate-300 hover:border-slate-400") +
          (busy ? " pointer-events-none opacity-60" : "")
        }
      >
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          disabled={busy}
        />
        {busy ? (
          <span className="text-slate-500">Wgrywanie...</span>
        ) : rows.length > 0 ? (
          <span className="text-slate-700">
            <strong>{rows.length}</strong> wpisów wgranych ·{" "}
            <span className="text-slate-500">przeciągnij nowy .xlsx aby zastąpić</span>
          </span>
        ) : (
          <span className="text-slate-700">Przeciągnij .xlsx tutaj lub kliknij, aby wybrać</span>
        )}
      </label>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">
            zamknij
          </button>
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            {expanded ? "▾ Ukryj listę" : "▸ Pokaż listę wpisów"}
          </button>
          {expanded && (
            <ol className="mt-3 max-h-72 list-decimal list-inside space-y-0.5 overflow-y-auto text-xs text-slate-700">
              {rows.map((r) => (
                <li key={r.row_index} title={JSON.stringify(r.content, null, 2)}>
                  {r.content.pl ?? r.content.en ?? "(brak PL/EN)"}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
