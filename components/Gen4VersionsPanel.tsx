"use client";

/**
 * Version history projektu — lista snapshotów (przed apply DS, batch
 * populate, manual import) z opcją cofnięcia projektu do wybranej wersji.
 */

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface Version {
  id: string;
  version_number: number;
  description: string | null;
  created_by: string | null;
  created_at: string;
}

interface Props {
  projectId: string;
}

export default function Gen4VersionsPanel({ projectId }: Props): React.ReactElement {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/versions/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { versions: Version[] };
      setVersions(j.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const snapshotNow = async () => {
    const description = window.prompt("Krótki opis snapshotu:", `Snapshot ręczny ${new Date().toLocaleString("pl-PL")}`);
    if (!description) return;
    setBusy(true);
    try {
      await fetch(`${API}/projects/${projectId}/versions/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "snapshot failed");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: Version) => {
    if (!confirm(
      `Przywrócić projekt do wersji ${version.version_number}?\n\n${version.description ?? ""}\n\n` +
      "Bieżący stan zostanie zapisany jako kolejna wersja — będzie można wrócić.",
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/versions/${version.id}/restore/`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "restore failed");
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-baseline justify-between hover:opacity-80"
      >
        <div className="text-left">
          <h3 className="text-sm font-semibold text-slate-900">🕒 Historia wersji</h3>
          <p className="text-xs text-slate-500">
            {versions.length === 0
              ? "Brak snapshotów. Tworzą się automatycznie przed dużymi zmianami (apply DS, regen)."
              : `${versions.length} wersji. Klik 'Przywróć' przy dowolnej cofa projekt — bieżący stan zostaje zapisany.`}
          </p>
        </div>
        <span className="text-slate-500">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <>
          {error && (
            <p className="my-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
          )}

          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void snapshotNow()}
              disabled={busy}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              📸 Zapisz snapshot teraz
            </button>
          </div>

          {loading && <p className="py-3 text-center text-xs text-slate-500">Ładuję...</p>}

          {!loading && versions.length > 0 && (
            <ul className="mt-2 space-y-1">
              {versions.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800">
                      v{v.version_number} · {new Date(v.created_at).toLocaleString("pl-PL")}
                    </p>
                    {v.description && <p className="text-[11px] text-slate-600">{v.description}</p>}
                    {v.created_by && <p className="text-[10px] text-slate-400">{v.created_by}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => void restore(v)}
                    disabled={busy}
                    className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-40"
                  >
                    Przywróć
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
