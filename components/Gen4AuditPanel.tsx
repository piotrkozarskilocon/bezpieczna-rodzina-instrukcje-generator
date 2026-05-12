"use client";

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface AuditEvent {
  id: string;
  source: "manual" | "ai" | "ai_edit";
  created_at: string;
  description: string;
  details?: {
    workflow?: string;
    model?: string;
    latency_ms?: number;
  };
}

const SOURCE_LABELS: Record<AuditEvent["source"], { label: string; color: string }> = {
  manual: { label: "✏️ Manual", color: "bg-amber-100 text-amber-900" },
  ai: { label: "🤖 AI", color: "bg-emerald-100 text-emerald-900" },
  ai_edit: { label: "🤖 AI edit", color: "bg-emerald-100 text-emerald-900" },
};

interface Props {
  projectId: string;
}

export default function Gen4AuditPanel({ projectId }: Props): React.ReactElement {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "manual" | "ai">("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/edit-log/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { events: AuditEvent[] };
      setEvents(j.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { if (expanded) void refresh(); }, [refresh, expanded]);

  const filtered = events.filter((e) => {
    if (filter === "all") return true;
    if (filter === "manual") return e.source === "manual";
    return e.source === "ai" || e.source === "ai_edit";
  });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-baseline justify-between hover:opacity-80"
      >
        <div className="text-left">
          <h3 className="text-sm font-semibold text-slate-900">📜 Historia zmian (audit log)</h3>
          <p className="text-xs text-slate-500">
            Wszystkie operacje na projekcie — manualne edycje + wywołania AI — w porządku chronologicznym.
            {!expanded && " Kliknij aby rozwinąć."}
          </p>
        </div>
        <span className="text-slate-500">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <>
          {error && <p className="my-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

          <div className="mt-2 mb-2 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Filtr:</span>
            {(["all", "manual", "ai"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={
                  "rounded border px-2 py-0.5 text-[10px] " +
                  (filter === f
                    ? "border-slate-700 bg-slate-800 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
                }
              >
                {f === "all" ? "Wszystkie" : f === "manual" ? "Manualne" : "AI"}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="ml-auto rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {loading ? "..." : "Odśwież"}
            </button>
          </div>

          {loading && events.length === 0 && <p className="py-3 text-center text-xs text-slate-500">Ładuję...</p>}
          {!loading && filtered.length === 0 && (
            <p className="py-3 text-center text-xs text-slate-500 italic">Brak zdarzeń w tym filtrze.</p>
          )}

          {filtered.length > 0 && (
            <ul className="max-h-96 space-y-1 overflow-auto text-[11px]">
              {filtered.map((e) => {
                const label = SOURCE_LABELS[e.source];
                return (
                  <li key={e.id} className="flex items-start gap-2 rounded border border-slate-100 bg-slate-50 px-2 py-1.5">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${label.color}`}>
                      {label.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-slate-800">{e.description}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400">
                        {new Date(e.created_at).toLocaleString("pl-PL")}
                        {e.details?.workflow && ` · ${e.details.workflow}`}
                        {e.details?.model && ` · ${e.details.model.replace("claude-", "").replace(/-\d{8}$/, "")}`}
                        {e.details?.latency_ms && ` · ${(e.details.latency_ms / 1000).toFixed(1)}s`}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
