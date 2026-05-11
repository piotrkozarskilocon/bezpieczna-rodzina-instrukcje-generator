"use client";

import { useCallback, useEffect, useState } from "react";

const API = "/generator-instrukcji/api/v4";

interface DesignSystem {
  id: string;
  name: string;
  content: Record<string, unknown>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface PageRow { id: string; page_number: number; template: string | null; title: string | null }

interface Props {
  projectId: string;
  /** When parent already knows the page list, pass it in to avoid the
   *  extra fetch when the user opens the per-page apply dropdown. */
  pages?: PageRow[];
}

export default function Gen4DesignSystemPanel({ projectId, pages: pagesProp }: Props): React.ReactElement {
  const [systems, setSystems] = useState<DesignSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [pages, setPages] = useState<PageRow[]>(pagesProp ?? []);

  // Apply-prompt modal state. When non-null, the modal is open.
  const [applyState, setApplyState] = useState<
    | null
    | { ds: DesignSystem; scope: "project" }
    | { ds: DesignSystem; scope: "page"; pageId: string; pageNumber: number }
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setGlobalError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/design-systems/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { design_systems: DesignSystem[] };
      setSystems(j.design_systems ?? []);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Fetch pages if not provided by parent (used by the page-scope apply UI).
  useEffect(() => {
    if (pagesProp) {
      setPages(pagesProp);
      return;
    }
    void fetch(`${API}/projects/${projectId}/pages/`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const j = (await r.json()) as { pages: PageRow[] };
        setPages(j.pages ?? []);
      });
  }, [projectId, pagesProp]);

  const handleUpload = async (file: File) => {
    setGlobalError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("plik nie zawiera obiektu JSON");

      // Use the file's basename as the default name so the user gets a
      // recognisable label even if the JSON itself has no "name" field.
      const guessName =
        (typeof parsed.name === "string" && parsed.name) ||
        file.name.replace(/\.json$/i, "");
      const isFirst = systems.length === 0;

      const res = await fetch(`${API}/projects/${projectId}/design-systems/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: guessName,
          content: parsed,
          is_default: isFirst, // first DS becomes default automatically
        }),
      });
      const respText = await res.text();
      if (!res.ok) {
        if (respText.startsWith("<")) throw new Error(`HTTP ${res.status}: HTML response`);
        let parsedResp: { error?: string } = {};
        try { parsedResp = JSON.parse(respText); } catch { /* ignore */ }
        throw new Error(parsedResp.error ?? `HTTP ${res.status}: ${respText.slice(0, 200)}`);
      }
      await refresh();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "upload failed");
    }
  };

  const setDefault = async (dsId: string) => {
    try {
      const res = await fetch(`${API}/projects/${projectId}/design-systems/${dsId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "update failed");
    }
  };

  const rename = async (ds: DesignSystem) => {
    const next = window.prompt("Nowa nazwa design systemu:", ds.name);
    if (!next || !next.trim() || next === ds.name) return;
    try {
      const res = await fetch(`${API}/projects/${projectId}/design-systems/${ds.id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "rename failed");
    }
  };

  const remove = async (ds: DesignSystem) => {
    if (!confirm(`Usunąć design system "${ds.name}"?`)) return;
    try {
      const res = await fetch(`${API}/projects/${projectId}/design-systems/${ds.id}/`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "delete failed");
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-slate-900">Design Systems</h3>
        <span className="text-xs text-slate-500">{systems.length} {systems.length === 1 ? "system" : "systemów"}</span>
      </div>

      <p className="mb-4 text-xs text-slate-600">
        Wczytaj jeden lub więcej design systemów (JSON). Każdy może mieć własną estetykę
        — kolory, fonty, spacing. Z każdego możesz wygenerować prompt AI „zastosuj ten DS"
        do całego projektu lub do wybranej strony.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">
          📁 Wczytaj plik .json
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
            className="sr-only"
          />
        </label>
      </div>

      {globalError && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{globalError}</p>
      )}

      {loading && <p className="text-xs text-slate-500">Ładuję...</p>}

      {!loading && systems.length === 0 && (
        <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-500">
          Brak design systemów. Wczytaj plik .json, aby zacząć.
        </p>
      )}

      {systems.length > 0 && (
        <ul className="space-y-2">
          {systems.map((ds) => (
            <DsCard
              key={ds.id}
              ds={ds}
              pages={pages}
              onSetDefault={() => void setDefault(ds.id)}
              onRename={() => void rename(ds)}
              onRemove={() => void remove(ds)}
              onApplyProject={() => setApplyState({ ds, scope: "project" })}
              onApplyPage={(pageId, pageNumber) =>
                setApplyState({ ds, scope: "page", pageId, pageNumber })
              }
            />
          ))}
        </ul>
      )}

      {applyState && (
        <ApplyDsModal
          state={applyState}
          projectId={projectId}
          onClose={() => setApplyState(null)}
        />
      )}
    </div>
  );
}

interface DsCardProps {
  ds: DesignSystem;
  pages: PageRow[];
  onSetDefault: () => void;
  onRename: () => void;
  onRemove: () => void;
  onApplyProject: () => void;
  onApplyPage: (pageId: string, pageNumber: number) => void;
}

function DsCard({ ds, pages, onSetDefault, onRename, onRemove, onApplyProject, onApplyPage }: DsCardProps): React.ReactElement {
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);

  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">{ds.name}</span>
            {ds.is_default && (
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                domyślny
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            Dodany: {new Date(ds.created_at).toLocaleString("pl-PL")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={onApplyProject}
            className="rounded-md bg-purple-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-purple-800"
            title='Wygeneruj prompt AI "zastosuj DS do całego projektu".'
          >
            ✨ Zastosuj do całego projektu
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPageMenuOpen((v) => !v)}
              className="rounded-md border border-purple-300 bg-white px-2 py-1 text-[11px] font-semibold text-purple-700 hover:bg-purple-50"
            >
              ✨ Dla strony ▾
            </button>
            {pageMenuOpen && (
              <div className="absolute right-0 top-full z-10 mt-1 max-h-72 w-48 overflow-y-auto rounded-md border border-slate-300 bg-white shadow-lg">
                {pages.length === 0 ? (
                  <p className="p-2 text-center text-[11px] text-slate-500">Brak stron</p>
                ) : (
                  <ul>
                    {pages.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPageMenuOpen(false);
                            onApplyPage(p.id, p.page_number);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50"
                        >
                          <span className="font-mono font-semibold text-slate-500">#{p.page_number}</span>{" "}
                          <span className="text-slate-700">
                            {p.template === "cover"
                              ? "Okładka"
                              : p.title ?? p.template ?? "blank"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          {!ds.is_default && (
            <button
              type="button"
              onClick={onSetDefault}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
              title="Ustaw jako domyślny"
            >
              ⭐ Domyślny
            </button>
          )}
          <button
            type="button"
            onClick={onRename}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Zmień nazwę
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded border border-red-200 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50"
          >
            Usuń
          </button>
        </div>
      </div>
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setContentOpen((v) => !v)}
          className="text-[11px] text-slate-600 hover:text-slate-900"
        >
          {contentOpen ? "▾ Ukryj zawartość" : "▸ Pokaż zawartość JSON"}
        </button>
        {contentOpen && (
          <pre className="mt-2 max-h-72 overflow-auto rounded border border-slate-200 bg-white p-2 text-[10px] text-slate-700">
            {JSON.stringify(ds.content, null, 2)}
          </pre>
        )}
      </div>
    </li>
  );
}

type ApplyState =
  | { ds: DesignSystem; scope: "project" }
  | { ds: DesignSystem; scope: "page"; pageId: string; pageNumber: number };

interface ApplyDsModalProps {
  state: ApplyState;
  projectId: string;
  onClose: () => void;
}

function ApplyDsModal({ state, projectId, onClose }: ApplyDsModalProps): React.ReactElement {
  const [instruction, setInstruction] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [importJson, setImportJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isProjectScope = state.scope === "project";

  const buildPrompt = async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const url = isProjectScope
        ? `${API}/projects/${projectId}/apply-design-prompt/`
        : `${API}/pages/${state.pageId}/apply-design-prompt/`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ds_id: state.ds.id, instruction: instruction.trim() || undefined }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: HTML response`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const j = JSON.parse(text) as { combined: string };
      setPrompt(j.combined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "build prompt failed");
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
    } catch { /* ignore */ }
  };

  const applyResponse = async () => {
    if (!importJson.trim()) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      // Project scope → POST /import (replace whole project).
      // Page scope    → POST /pages/[pageId]/replace-elements.
      const url = isProjectScope
        ? `${API}/projects/${projectId}/import/`
        : `${API}/pages/${state.pageId}/replace-elements/`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: importJson }),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) throw new Error(`HTTP ${res.status}: HTML response`);
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      let summary = "Zastosowano.";
      try {
        const j = JSON.parse(text) as { elements?: number; pages?: number; blocks?: number };
        const parts: string[] = [];
        if (typeof j.pages === "number") parts.push(`${j.pages} stron`);
        if (typeof j.elements === "number") parts.push(`${j.elements} elementów`);
        if (typeof j.blocks === "number") parts.push(`${j.blocks} bloków`);
        if (parts.length > 0) summary = `Zastosowano: ${parts.join(", ")}.`;
      } catch { /* ignore */ }
      setInfo(`${summary} Strona przeładuje się za 2 s — jeśli nie widzisz zmian, naciśnij Ctrl+Shift+R.`);
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "apply failed");
      setBusy(false);
    }
  };

  const title = isProjectScope
    ? `Zastosuj „${state.ds.name}" do całego projektu`
    : `Zastosuj „${state.ds.name}" do strony ${state.pageNumber}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="my-12 w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>

        <div className="space-y-4 p-5 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Dodatkowe wytyczne (opcjonalne)
            </label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              placeholder='np. "tylko kolory, zachowaj layout" lub "skróć teksty o 20%"'
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => void buildPrompt()}
                className="rounded-md bg-purple-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-800 disabled:opacity-50"
              >
                {busy ? "..." : prompt ? "Wygeneruj ponownie" : "Wygeneruj prompt"}
              </button>
            </div>
          </div>

          {prompt && (
            <div className="rounded-lg border border-purple-200 bg-purple-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">Krok 1 — skopiuj prompt</span>
                <button
                  type="button"
                  onClick={copyPrompt}
                  className="rounded bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-slate-700"
                >
                  {copied ? "✓ Skopiowano" : "📋 Skopiuj"}
                </button>
              </div>
              <p className="text-[11px] text-slate-600">
                Wklej w <a href="https://claude.ai/new" target="_blank" rel="noreferrer" className="underline">claude.ai/new</a>.
                Claude zwróci artifact JSON — wklej go w Krok 2.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-900">▸ Pokaż prompt</summary>
                <textarea
                  readOnly
                  value={prompt}
                  rows={8}
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[10px]"
                />
              </details>
            </div>
          )}

          {prompt && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <span className="mb-2 block text-xs font-semibold text-slate-800">
                Krok 2 — wklej JSON odpowiedzi
              </span>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder={isProjectScope ? '{"pages": [...]}' : '{"elements": [...]}'}
                rows={8}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[10px]"
              />
              <p className="mt-1 text-[10px] text-slate-500">
                {isProjectScope
                  ? "Operacja zastąpi WSZYSTKIE strony i elementy w projekcie."
                  : `Operacja zastąpi wszystkie elementy strony ${state.pageNumber}.`}
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Anuluj
                </button>
                <button
                  type="button"
                  disabled={busy || !importJson.trim()}
                  onClick={() => void applyResponse()}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  {busy ? "Aplikuję..." : "Zastosuj"}
                </button>
              </div>
            </div>
          )}

          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
          {info && <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{info}</p>}
        </div>
      </div>
    </div>
  );
}
