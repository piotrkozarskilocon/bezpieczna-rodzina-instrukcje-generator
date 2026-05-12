"use client";

/**
 * Panel debugowania wywolan AI dla projektu — listuje co generator wyslal do
 * Claude (system + user prompt), co Claude zwrocil i jakie sa metadane (model,
 * tokens, latency, blad). Pozwala na inspekcje promptu, ktory generator
 * automatycznie buduje pod konkretne polecenie usera. Lista odswieza sie
 * recznie (przycisk) zeby nie generowac ruchu w bazie.
 */

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface AiCall {
  id: string;
  page_id: string | null;
  element_id: string | null;
  endpoint: string;
  context_type: "page" | "element" | "project" | "global";
  user_instruction: string | null;
  system_prompt: string | null;
  user_prompt: string | null;
  prompt_edited_by_user: boolean;
  model: string | null;
  max_tokens: number | null;
  temperature: number | null;
  response_text: string | null;
  error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  duration_ms: number | null;
  user_email: string | null;
  created_at: string;
}

interface Props {
  projectId: string;
  /** Opcjonalny filtr — gdy pokazujemy panel kontekstowo dla konkretnej strony. */
  pageId?: string | null;
}

const ENDPOINT_LABELS: Record<string, string> = {
  "ai-edit": "Assistant AI (strona)",
  "ai-edit-stream": "Assistant AI stream (strona)",
  "ai-fix-element": "Popraw element przez AI",
  "apply-style": "Wygląd → inne strony",
  "apply-design": "Zastosuj Design System",
  "auto-populate": "Auto-populate strony",
  "ab-variants": "A/B warianty",
  "ai-notes/suggest": "AI Notatka — sugestia",
  translate: "Tłumaczenie",
  "compliance-check": "Compliance check",
};

export default function Gen4AiDebugPanel({ projectId, pageId }: Props): React.ReactElement {
  const [calls, setCalls] = useState<AiCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [filterEndpoint, setFilterEndpoint] = useState<string>("");
  const [filterPageOnly, setFilterPageOnly] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", "100");
      if (filterEndpoint) params.set("endpoint", filterEndpoint);
      if (filterPageOnly && pageId) params.set("page_id", pageId);
      const res = await fetch(`${API}/projects/${projectId}/ai-calls?${params.toString()}`, { cache: "no-store" });
      const text = await res.text();
      if (!res.ok) {
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        const e = parsed.error ?? `HTTP ${res.status}`;
        if (/relation|does not exist|gen4_ai_calls/i.test(e)) {
          throw new Error(
            "Tabela gen4_ai_calls nie istnieje — wykonaj migrację 0019_v4_ai_calls.sql w Supabase Dashboard (SQL Editor).",
          );
        }
        throw new Error(e);
      }
      const j = JSON.parse(text) as { calls: AiCall[] };
      setCalls(j.calls ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId, pageId, filterEndpoint, filterPageOnly]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
      >
        <div>
          <h3 className="text-sm font-semibold text-slate-900">🧪 Panel debug AI</h3>
          <p className="text-xs text-slate-500">
            Pełna historia wywołań AI: jaki prompt poszedł, jaki model, co Claude zwrócił, ile tokenów.
          </p>
        </div>
        <span className="text-xs text-slate-500">{open ? "▼ zwiń" : "▶ rozwiń"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-200 p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {loading ? "Ładuję..." : "↻ Odśwież"}
            </button>
            <select
              value={filterEndpoint}
              onChange={(e) => setFilterEndpoint(e.target.value)}
              className="rounded border border-slate-300 bg-white px-1.5 py-1"
            >
              <option value="">Wszystkie endpointy</option>
              {Object.entries(ENDPOINT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {pageId && (
              <label className="flex cursor-pointer items-center gap-1">
                <input
                  type="checkbox"
                  checked={filterPageOnly}
                  onChange={(e) => setFilterPageOnly(e.target.checked)}
                  className="h-3 w-3"
                />
                <span>Tylko ta strona</span>
              </label>
            )}
            <span className="ml-auto text-[10px] text-slate-500">
              {calls.length} wywołań (limit 100, sortowane od najnowszych)
            </span>
          </div>

          {error && (
            <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          )}

          {!loading && calls.length === 0 && (
            <p className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
              Brak wywołań AI w historii. Wykonaj akcję AI (Assistant, Napraw przez AI, Popraw element, Wygląd → inne strony)
              i odśwież tę listę.
            </p>
          )}

          {calls.length > 0 && (
            <ul className="space-y-2">
              {calls.map((c) => {
                const isExpanded = expanded.has(c.id);
                const totalTokens = (c.tokens_in ?? 0) + (c.tokens_out ?? 0);
                const cacheNote =
                  c.cache_read_tokens && c.cache_read_tokens > 0
                    ? ` · cache read: ${c.cache_read_tokens}`
                    : c.cache_creation_tokens && c.cache_creation_tokens > 0
                      ? ` · cache write: ${c.cache_creation_tokens}`
                      : "";
                return (
                  <li
                    key={c.id}
                    className={
                      "rounded border bg-white p-2 text-xs " +
                      (c.error ? "border-red-200" : "border-slate-200")
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleExpand(c.id)}
                      className="flex w-full items-start justify-between gap-2 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-slate-800">
                            {ENDPOINT_LABELS[c.endpoint] ?? c.endpoint}
                          </span>
                          <span className="rounded bg-slate-100 px-1 py-0.5 text-[9px] font-medium text-slate-700">
                            {c.context_type}
                          </span>
                          {c.prompt_edited_by_user && (
                            <span className="rounded bg-purple-100 px-1 py-0.5 text-[9px] font-medium text-purple-800">
                              prompt edytowany
                            </span>
                          )}
                          {c.error && (
                            <span className="rounded bg-red-100 px-1 py-0.5 text-[9px] font-medium text-red-800">
                              BŁĄD
                            </span>
                          )}
                          {c.model && (
                            <span className="rounded bg-blue-100 px-1 py-0.5 text-[9px] font-medium text-blue-800">
                              {c.model.replace("claude-", "")}
                            </span>
                          )}
                        </div>
                        {c.user_instruction && (
                          <p className="mt-0.5 line-clamp-2 italic text-slate-700">
                            „{c.user_instruction}"
                          </p>
                        )}
                        <p className="mt-0.5 text-[10px] text-slate-400">
                          {new Date(c.created_at).toLocaleString("pl-PL")} ·{" "}
                          {c.duration_ms != null ? `${(c.duration_ms / 1000).toFixed(1)}s · ` : ""}
                          {totalTokens > 0 ? `${totalTokens} tokens (${c.tokens_in ?? 0}→${c.tokens_out ?? 0})` : ""}
                          {cacheNote}
                        </p>
                      </div>
                      <span className="text-slate-400">{isExpanded ? "▼" : "▶"}</span>
                    </button>

                    {isExpanded && (
                      <div className="mt-2 space-y-2 border-t border-slate-200 pt-2">
                        {c.error && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-red-700">Błąd</div>
                            <pre className="mt-0.5 overflow-x-auto rounded bg-red-50 p-2 text-[10px] text-red-900 whitespace-pre-wrap">
                              {c.error}
                            </pre>
                          </div>
                        )}
                        {c.system_prompt && (
                          <details>
                            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                              System prompt ({c.system_prompt.length} znaków)
                            </summary>
                            <pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[10px] text-slate-800 whitespace-pre-wrap">
                              {c.system_prompt}
                            </pre>
                          </details>
                        )}
                        {c.user_prompt && (
                          <details>
                            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                              User prompt ({c.user_prompt.length} znaków)
                            </summary>
                            <pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[10px] text-slate-800 whitespace-pre-wrap">
                              {c.user_prompt}
                            </pre>
                          </details>
                        )}
                        {c.response_text && (
                          <details open>
                            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                              Odpowiedź AI ({c.response_text.length} znaków)
                            </summary>
                            <pre className="mt-1 max-h-64 overflow-auto rounded bg-emerald-50 p-2 text-[10px] text-emerald-900 whitespace-pre-wrap">
                              {c.response_text}
                            </pre>
                          </details>
                        )}
                        <div className="flex flex-wrap gap-2 text-[10px] text-slate-500">
                          {c.max_tokens && <span>max_tokens: {c.max_tokens}</span>}
                          {c.temperature != null && <span>temperature: {c.temperature}</span>}
                          {c.user_email && <span>user: {c.user_email}</span>}
                          {c.page_id && <span>page_id: {c.page_id.slice(0, 8)}…</span>}
                          {c.element_id && <span>element_id: {c.element_id.slice(0, 8)}…</span>}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
