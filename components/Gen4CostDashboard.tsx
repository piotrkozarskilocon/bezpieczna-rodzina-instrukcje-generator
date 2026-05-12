"use client";

/**
 * Panel pokazujący koszty AI per projekt: suma USD, breakdown per workflow,
 * lista ostatnich wywołań. Dane z gen4_ai_history zsumowane po stronie
 * serwera w endpoint /api/v4/projects/[id]/ai-history.
 */

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface HistoryEntry {
  id: string;
  role: string;
  content: string;
  structured: Record<string, unknown> | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  cost_usd: number;
  created_at: string;
}

interface Totals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface ByWorkflow {
  workflow: string;
  count: number;
  cost: number;
  input: number;
  output: number;
}

const WORKFLOW_LABELS: Record<string, string> = {
  initial_generation: "Pierwotna generacja",
  skeleton_generation: "Szkielet stron",
  auto_populate: "Wypełnianie stron",
  ai_edit: "Edycja przez Assistant",
  apply_design_page: "Apply DS — strona",
  apply_design_project: "Apply DS — projekt",
  image_mapping_preview: "Propozycja obrazków",
  translation: "Tłumaczenie",
  other: "Inne",
};

interface Props {
  projectId: string;
}

export default function Gen4CostDashboard({ projectId }: Props): React.ReactElement {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [byWorkflow, setByWorkflow] = useState<ByWorkflow[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/ai-history/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { totals: Totals; by_workflow: ByWorkflow[]; history: HistoryEntry[] };
      setTotals(j.totals);
      setByWorkflow(j.by_workflow);
      setHistory(j.history);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">💰 Koszty AI dla tego projektu</h3>
          <p className="text-xs text-slate-500">
            Suma wywołań Claude API zarejestrowanych w gen4_ai_history. Cennik z {""}
            <a href="https://docs.claude.com/en/docs/about-claude/pricing" target="_blank" rel="noreferrer" className="underline">docs.claude.com</a>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          {loading ? "..." : "Odśwież"}
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
      )}

      {totals && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Wywołania" value={totals.calls.toString()} />
          <Stat
            label="Suma kosztów"
            value={`$${totals.cost_usd.toFixed(3)}`}
            highlight
          />
          <Stat label="Input tokens" value={totals.input_tokens.toLocaleString("pl-PL")} />
          <Stat label="Output tokens" value={totals.output_tokens.toLocaleString("pl-PL")} />
        </div>
      )}

      {byWorkflow.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Per workflow
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-1">Workflow</th>
                <th className="py-1 text-right">Wywołania</th>
                <th className="py-1 text-right">Input / Output</th>
                <th className="py-1 text-right">Koszt</th>
              </tr>
            </thead>
            <tbody>
              {byWorkflow
                .sort((a, b) => b.cost - a.cost)
                .map((wf) => (
                  <tr key={wf.workflow} className="border-b border-slate-100">
                    <td className="py-1">{WORKFLOW_LABELS[wf.workflow] ?? wf.workflow}</td>
                    <td className="py-1 text-right font-mono">{wf.count}</td>
                    <td className="py-1 text-right font-mono text-slate-500">
                      {wf.input.toLocaleString("pl-PL")} / {wf.output.toLocaleString("pl-PL")}
                    </td>
                    <td className="py-1 text-right font-mono font-semibold">${wf.cost.toFixed(3)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <details
          open={expanded}
          onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
          className="mt-4"
        >
          <summary className="cursor-pointer text-xs font-semibold text-slate-700 hover:text-slate-900">
            ▸ Pokaż historię wywołań ({history.length})
          </summary>
          <table className="mt-2 w-full text-[11px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-1">Czas</th>
                <th className="py-1">Workflow</th>
                <th className="py-1">Model</th>
                <th className="py-1 text-right">Tokens (in/out)</th>
                <th className="py-1 text-right">Latency</th>
                <th className="py-1 text-right">Koszt</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const wf = (h.structured?.workflow_type as string | undefined) ?? "other";
                const date = new Date(h.created_at);
                return (
                  <tr key={h.id} className="border-b border-slate-100">
                    <td className="py-1 font-mono text-slate-500">
                      {date.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}
                    </td>
                    <td className="py-1">{WORKFLOW_LABELS[wf] ?? wf}</td>
                    <td className="py-1 font-mono text-slate-500">
                      {h.model?.replace("claude-", "").replace(/-\d{8}$/, "") ?? "—"}
                    </td>
                    <td className="py-1 text-right font-mono text-slate-500">
                      {(h.input_tokens ?? 0).toLocaleString("pl-PL")} / {(h.output_tokens ?? 0).toLocaleString("pl-PL")}
                    </td>
                    <td className="py-1 text-right font-mono text-slate-500">
                      {h.latency_ms ? `${(h.latency_ms / 1000).toFixed(1)}s` : "—"}
                    </td>
                    <td className="py-1 text-right font-mono">${h.cost_usd.toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}

      {!loading && totals && totals.calls === 0 && (
        <p className="mt-4 rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
          Brak wywołań AI dla tego projektu. Wygeneruj projekt lub użyj Assistant AI w editorze.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={
        "rounded border p-2 " +
        (highlight ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50")
      }
    >
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={
          "mt-0.5 font-mono text-base font-semibold " +
          (highlight ? "text-emerald-800" : "text-slate-800")
        }
      >
        {value}
      </div>
    </div>
  );
}
