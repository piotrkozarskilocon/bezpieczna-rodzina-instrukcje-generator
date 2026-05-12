"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import Gen4Editor from "@/components/Gen4Editor";
import Gen4TranslationsPanel from "@/components/Gen4TranslationsPanel";
import Gen4DesignSystemPanel from "@/components/Gen4DesignSystemPanel";
import Gen4ExportPanel from "@/components/Gen4ExportPanel";
import Gen4ImagePanel from "@/components/Gen4ImagePanel";
import Gen4CostDashboard from "@/components/Gen4CostDashboard";
import Gen4NotesPanel from "@/components/Gen4NotesPanel";
import Gen4ReferenceDocsPanel from "@/components/Gen4ReferenceDocsPanel";

const PAGE_API_BASE = "/generator-instrukcji/api/v4";

interface ProjectDetail {
  id: string;
  name: string;
  default_lang: string;
  status: string;
  ai_input: Record<string, unknown> | null;
  ai_log: Array<Record<string, unknown>>;
  design_system: Record<string, unknown> | null;
  document_type?: string | null;
  device_type?: string | null;
  text_element_count?: number;
  created_at: string;
  updated_at: string;
}

interface PageRow {
  id: string;
  page_number: number;
  template: string | null;
  title: string | null;
}

const API_BASE = "/generator-instrukcji/api/v4";

interface ProjectPageProps { params: Promise<{ id: string }>; }

export default function AiProjectPage({ params }: ProjectPageProps): React.ReactElement {
  const { id } = use(params);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`${API_BASE}/projects/${id}`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`${API_BASE}/projects/${id}/pages`, { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([proj, pgs]) => {
        if (!active) return;
        if (proj.error) throw new Error(proj.error);
        setProject(proj.project);
        setPages(pgs.pages ?? []);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "fetch failed"); });
    return () => { active = false; };
  }, [id]);

  const handleClone = async () => {
    const currentModelName = (project?.ai_input?.model_name as string | undefined) ?? "";
    const currentModelCode = (project?.ai_input?.model_code as string | undefined) ?? "";
    const name = window.prompt("Nazwa nowego projektu:", `${project?.name ?? ""} (kopia)`);
    if (!name?.trim()) return;
    const modelCode = window.prompt(
      "Kod modelu (puste = zostaw jak w oryginale):",
      currentModelCode,
    );
    const modelName = window.prompt(
      "Nazwa modelu (puste = zostaw jak w oryginale):",
      currentModelName,
    );
    setBusy(true);
    try {
      const res = await fetch(`${PAGE_API_BASE}/projects/${id}/clone/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          model_code: modelCode?.trim() || undefined,
          model_name: modelName?.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { id: string };
      window.location.href = `/generator-instrukcji/ai/projects/${j.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "clone failed");
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Usunąć projekt? Operacja nieodwracalna.")) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = "/generator-instrukcji/ai/";
    } catch (err) {
      alert(err instanceof Error ? err.message : "delete failed");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-12">
      <div className="mb-6 text-sm text-slate-500">
        <Link href="/" className="hover:text-slate-900">Generator</Link>
        <span className="mx-2">/</span>
        <Link href="/ai" className="hover:text-slate-900">Generator AI</Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">{project?.name ?? id}</span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          Błąd: {error}
        </div>
      )}

      {!error && !project && (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">
          Ładowanie...
        </div>
      )}

      {project && (
        <>
          <div className="mb-6 flex items-start justify-between rounded-xl border border-slate-200 bg-white p-6">
            <div>
              <div className="flex items-baseline gap-3">
                <h2 className="text-2xl font-semibold text-slate-900">{project.name}</h2>
                <span className={
                  "rounded px-2 py-0.5 text-[10px] font-semibold uppercase " +
                  (project.status === "ready" ? "bg-emerald-100 text-emerald-800" :
                   project.status === "generating" ? "bg-amber-100 text-amber-800" :
                   project.status === "error" ? "bg-red-100 text-red-800" :
                   "bg-slate-100 text-slate-700")
                }>{project.status}</span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <dt className="text-slate-500">Język bazowy</dt>
                <dd className="text-slate-900">{project.default_lang.toUpperCase()}</dd>
                <dt className="text-slate-500">Liczba stron</dt>
                <dd className="text-slate-900">{pages.length}</dd>
                {project.ai_input && (
                  <>
                    <dt className="text-slate-500">Model</dt>
                    <dd className="text-slate-900">
                      {(project.ai_input.model_name as string) ?? "—"} · {(project.ai_input.model_code as string) ?? "—"}
                    </dd>
                  </>
                )}
                <dt className="text-slate-500">Utworzony</dt>
                <dd className="text-slate-900">{new Date(project.created_at).toLocaleString("pl-PL")}</dd>
                <dt className="text-slate-500">ID</dt>
                <dd className="font-mono text-xs text-slate-500">{project.id}</dd>
              </dl>
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleClone}
                disabled={busy}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                title="Skopiuj projekt z możliwością zmiany modelu — zachowuje strony, design system, notatki, pliki referencyjne"
              >
                📋 Klonuj projekt
              </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Usuń projekt
            </button>
            </div>
          </div>

          {project.status === "draft" && (
            <ManualImportPanel projectId={id} onImported={() => window.location.reload()} />
          )}

          {project.status === "ready" && (
            <>
              <details className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">
                  🔄 Wygeneruj ponownie (np. po poprawie prompta — zaktualizowane glosariusz / regule polskich znaków)
                </summary>
                <div className="mt-3">
                  <p className="mb-3 text-xs text-slate-600">
                    Pobierz aktualny prompt (uwzględnia najnowsze reguły) i powtórz workflow:
                    skopiuj → wklej w nową rozmowę z Claude.ai → wynik wklej poniżej. Import
                    zastąpi wszystkie istniejące strony i elementy.
                  </p>
                  <ManualImportPanel projectId={id} onImported={() => window.location.reload()} />
                </div>
              </details>

              <div className="mb-4">
                <Gen4DesignSystemPanel projectId={id} pages={pages} />
              </div>

              <div className="mb-4">
                <Gen4NotesPanel
                  projectId={id}
                  documentType={project.document_type ?? null}
                  deviceType={project.device_type ?? null}
                />
              </div>

              <div className="mb-4">
                <Gen4ReferenceDocsPanel projectId={id} />
              </div>

              <div className="mb-4">
                <Gen4ImagePanel projectId={id} pages={pages} />
              </div>

              <div className="mb-4">
                <Gen4TranslationsPanel
                  projectId={id}
                  totalTextElements={project.text_element_count ?? 0}
                />
              </div>

              <div className="mb-4">
                <Gen4ExportPanel
                  projectId={id}
                  defaultLang={project.default_lang}
                  totalTextElements={project.text_element_count ?? 0}
                />
              </div>

              <div className="mb-4">
                <Gen4CostDashboard projectId={id} />
              </div>

              <Gen4Editor projectId={id} defaultLang={project.default_lang} />
            </>
          )}

          {project.status === "generating" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-12 text-center">
              <p className="text-base font-medium text-slate-900">Generowanie w toku...</p>
              <p className="mt-2 text-sm text-slate-600">Odśwież stronę za chwilę.</p>
            </div>
          )}

          {project.status === "error" && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-12 text-center">
              <p className="text-base font-medium text-red-900">Błąd generacji</p>
              <p className="mt-2 text-sm text-red-700">
                Sprawdź logi: ai_log w gen4_projects. Stwórz nowy projekt lub zaimportuj JSON manualnie.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface ManualImportPanelProps {
  projectId: string;
  onImported: () => void;
}

function ManualImportPanel({ projectId, onImported }: ManualImportPanelProps): React.ReactElement {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loadingPrompt, setLoadingPrompt] = useState(true);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${PAGE_API_BASE}/projects/${projectId}/prompt/`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { if (active) setPrompt(j.combined as string); })
      .catch((err) => { if (active) setPromptError(err instanceof Error ? err.message : "fetch failed"); })
      .finally(() => { if (active) setLoadingPrompt(false); });
    return () => { active = false; };
  }, [projectId]);

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

  const submitImport = async () => {
    if (!importJson.trim()) return;
    setImporting(true);
    setImportError(null);
    try {
      // Trailing slash matters: Next.js + trailingSlash:true issues a 308 on
      // POSTs to URLs without one, which some browsers downgrade to GET.
      const res = await fetch(`${PAGE_API_BASE}/projects/${projectId}/import/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: importJson }),
      });
      // Read raw text first so we can show a useful error when the server
      // returned HTML (typical when the auth cookie expired and the hub
      // redirected to /login) instead of JSON.
      const text = await res.text();
      if (!res.ok) {
        if (text.startsWith("<")) {
          throw new Error(
            `HTTP ${res.status}: serwer zwrócił HTML zamiast JSON — prawdopodobnie wygasła sesja. ` +
            `Otwórz hub w nowej karcie, zaloguj się i wróć tu.`,
          );
        }
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* fall through */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      onImported();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "import failed");
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-purple-200 bg-purple-50 p-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Krok 1 — Skopiuj prompt</h3>
          <button
            type="button"
            disabled={!prompt || loadingPrompt}
            onClick={copyPrompt}
            className="rounded-md bg-purple-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-800 disabled:opacity-50"
          >
            {copied ? "✓ Skopiowano" : "📋 Skopiuj prompt do schowka"}
          </button>
        </div>
        <p className="mb-3 text-xs text-slate-600">
          Po skopiowaniu otwórz <a href="https://claude.ai/new" target="_blank" rel="noreferrer" className="underline">claude.ai/new</a> i wklej całość.
          Claude zwróci JSON ze strukturą instrukcji — skopiuj go i wklej w polu poniżej.
        </p>
        {loadingPrompt && <p className="text-xs text-slate-500">Ładuję prompt...</p>}
        {promptError && <p className="text-xs text-red-700">Błąd: {promptError}</p>}
        {prompt && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-600 hover:text-slate-900">
              ▸ Pokaż treść prompta ({prompt.length.toLocaleString("pl-PL")} znaków)
            </summary>
            <textarea
              readOnly
              value={prompt}
              rows={12}
              className="mt-2 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
            />
          </details>
        )}
      </div>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Krok 2 — Wklej odpowiedź JSON</h3>
        <p className="mb-3 text-xs text-slate-600">
          Wklej tu pełen JSON z odpowiedzi Claude (z lub bez ```` ```json ```` fence — parser sobie poradzi).
        </p>
        <textarea
          value={importJson}
          onChange={(e) => setImportJson(e.target.value)}
          placeholder='{"pages": [{"template": "cover", "page_number": 1, ...}]}'
          rows={10}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
        />
        {importError && (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
            Błąd importu: {importError}
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={!importJson.trim() || importing}
            onClick={submitImport}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {importing ? "Importuję..." : "Importuj JSON"}
          </button>
        </div>
      </div>
    </div>
  );
}
