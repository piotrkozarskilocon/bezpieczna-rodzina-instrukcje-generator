"use client";

/**
 * Panel plików referencyjnych projektu — PDF/DOCX/XLSX/TXT/MD/CSV/JSON
 * z raportem SAR, specyfikacją techniczną producenta, instrukcjami w obcych
 * językach. AI dostaje je jako attachments via Anthropic Files API
 * (DOCX/XLSX są konwertowane do tekstu po stronie serwera) i wyciąga
 * konkretne wartości zamiast wstawiać placeholder DO UZUPEŁNIENIA.
 */

import { useCallback, useEffect, useState } from "react";

const ACCEPT_TYPES = ".pdf,.txt,.md,.csv,.json,.docx,.xlsx,application/pdf,text/plain,text/markdown,text/csv,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const API = "/generator-instrukcji/api/v4";

interface ReferenceDoc {
  id: string;
  kind: string;
  source_lang: string | null;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  anthropic_file_id: string | null;
  extracted_summary: string | null;
  extracted_structured: Record<string, unknown> | null;
  extracted_structured_at: string | null;
  extracted_structured_model: string | null;
  download_url: string | null;
  created_at: string;
}

const KIND_LABELS: Record<string, string> = {
  sar_report: "📡 Raport SAR",
  tech_spec: "📊 Specyfikacja techniczna",
  manufacturer_manual: "📘 Instrukcja producenta",
  declaration_ce: "✅ Deklaracja CE",
  other: "📎 Inne",
};

const KIND_OPTIONS = Object.keys(KIND_LABELS);

const LANG_OPTIONS = [
  { code: "pl", label: "Polski" },
  { code: "en", label: "Angielski" },
  { code: "zh", label: "Chiński" },
  { code: "de", label: "Niemiecki" },
  { code: "fr", label: "Francuski" },
  { code: "other", label: "Inny" },
];

interface Props {
  projectId: string;
}

export default function Gen4ReferenceDocsPanel({ projectId }: Props): React.ReactElement {
  const [docs, setDocs] = useState<ReferenceDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyExtract, setBusyExtract] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pending upload — user wybrał plik, jeszcze wybiera kind + lang
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingKind, setPendingKind] = useState<string>("tech_spec");
  const [pendingLang, setPendingLang] = useState<string>("pl");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/reference-docs/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { docs: ReferenceDoc[] };
      setDocs(j.docs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const upload = async () => {
    if (!pendingFile) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Pobierz signed upload URL — omija Vercel 4.5 MB cap, plik idzie
      //    direct do Supabase Storage.
      const initRes = await fetch(`${API}/projects/${projectId}/reference-docs/upload-url/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: pendingFile.name, size_bytes: pendingFile.size }),
      });
      if (!initRes.ok) {
        const text = await initRes.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${initRes.status} (upload-url)`);
      }
      const init = (await initRes.json()) as { signed_url: string; file_path: string; token: string };

      // 2. PUT plik bezpośrednio do bucket — może być duży (Vercel out of the way).
      // Niektóre przeglądarki / OS nie ustawiają MIME na DOCX/XLSX przy drag&drop —
      // wtedy spada na application/octet-stream (też jest na allowlist bucketa).
      const ctForPut = pendingFile.type && pendingFile.type.trim() ? pendingFile.type : "application/octet-stream";
      const putRes = await fetch(init.signed_url, {
        method: "PUT",
        headers: { "Content-Type": ctForPut },
        body: pendingFile,
      });
      if (!putRes.ok) {
        // Supabase Storage przy odrzuceniu zwraca JSON z `error` / `message` —
        // pokaż to userowi zamiast samego HTTP 400.
        const respText = await putRes.text().catch(() => "");
        let detail = "";
        try {
          const j = JSON.parse(respText) as { error?: string; message?: string };
          detail = j.error ?? j.message ?? "";
        } catch { detail = respText.slice(0, 200); }
        throw new Error(
          `storage PUT failed: HTTP ${putRes.status}${detail ? " — " + detail : ""}. ` +
          `Jeśli to typ pliku, bucket Supabase może mieć restrykcję MIME — uruchom migrację 0018.`,
        );
      }

      // 3. POST metadata — backend pobiera plik z storage, sync z Anthropic Files API.
      const finRes = await fetch(`${API}/projects/${projectId}/reference-docs/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_path: init.file_path,
          name: pendingFile.name,
          kind: pendingKind,
          source_lang: pendingLang,
          size_bytes: pendingFile.size,
          mime_type: pendingFile.type,
        }),
      });
      if (!finRes.ok) {
        const text = await finRes.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${finRes.status} (finalize)`);
      }
      setPendingFile(null);
      setPendingKind("tech_spec");
      setPendingLang("pl");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  const extractStructured = async (docId: string) => {
    setBusyExtract(docId);
    setError(null);
    try {
      const res = await fetch(`${API}/reference-docs/${docId}/extract-structured`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "sar" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as {
        ok: boolean;
        extracted: Record<string, unknown>;
        model: string;
        duration_ms: number;
      };
      // Update lokalny stan żeby user od razu widział wynik
      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                extracted_structured: j.extracted,
                extracted_structured_at: new Date().toISOString(),
                extracted_structured_model: j.model,
              }
            : d,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "extract failed");
    } finally {
      setBusyExtract(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Usunąć plik referencyjny? AI nie będzie z niego korzystał w kolejnych generacjach.")) return;
    try {
      const res = await fetch(`${API}/reference-docs/${id}/`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">📎 Pliki referencyjne</h3>
          <p className="text-xs text-slate-500">
            Wgraj pliki z konkretnymi danymi: raport SAR, specyfikacja techniczna, instrukcja
            producenta (może być w obcym języku). Akceptujemy <strong>PDF, DOCX, XLSX, TXT, MD, CSV, JSON</strong>
            (DOCX/XLSX są konwertowane do tekstu/CSV po stronie serwera). AI czyta je bezpośrednio
            i wstawia wartości w generowanej instrukcji zamiast placeholderów <em>DO UZUPEŁNIENIA</em>.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">zamknij</button>
        </div>
      )}

      {/* Upload area */}
      <div className="mb-4 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-3">
        {!pendingFile ? (
          <label className="flex cursor-pointer flex-col items-center gap-1 py-3 text-xs text-slate-600">
            <span className="font-medium">+ Wgraj plik referencyjny (PDF / DOCX / XLSX / TXT / MD / CSV / JSON, max 25 MB)</span>
            <span className="text-[10px] text-slate-500">Kliknij lub przeciągnij plik</span>
            <input
              type="file"
              accept={ACCEPT_TYPES}
              className="hidden"
              onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
            />
          </label>
        ) : (
          <div className="space-y-2 text-xs">
            <p className="font-medium text-slate-700">📎 {pendingFile.name} <span className="text-slate-400">({Math.round(pendingFile.size / 1024)} KB)</span></p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Typ pliku</span>
                <select value={pendingKind} onChange={(e) => setPendingKind(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-1.5 py-1 text-xs">
                  {KIND_OPTIONS.map((k) => (
                    <option key={k} value={k}>{KIND_LABELS[k]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Język źródła</span>
                <select value={pendingLang} onChange={(e) => setPendingLang(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-1.5 py-1 text-xs">
                  {LANG_OPTIONS.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-1.5">
              <button type="button" onClick={() => setPendingFile(null)} disabled={busy}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                Anuluj
              </button>
              <button type="button" onClick={() => void upload()} disabled={busy}
                className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-40">
                {busy ? "Wgrywam + AI sync (~10s)..." : "Wgraj i synchronizuj z AI"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lista plików */}
      {loading && <p className="py-3 text-center text-xs text-slate-500">Ładuję pliki...</p>}
      {!loading && docs.length === 0 && (
        <p className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
          Brak plików referencyjnych. AI będzie wstawiał placeholdery <em>DO UZUPEŁNIENIA</em> w miejscach które wymagają konkretnych wartości technicznych.
        </p>
      )}
      {!loading && docs.length > 0 && (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li key={d.id} className="rounded border border-slate-200 bg-white p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800">
                      {KIND_LABELS[d.kind] ?? d.kind}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {d.source_lang?.toUpperCase() ?? "PL"}
                    </span>
                    {d.anthropic_file_id ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-800">
                        ✓ AI ma dostęp
                      </span>
                    ) : (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800">
                        ⚠️ Tylko w storage (brak sync z AI)
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-slate-700" title={d.name}>{d.name}</p>
                  {d.extracted_summary && (
                    <p className="mt-1 rounded border border-emerald-100 bg-emerald-50 px-1.5 py-1 text-[10px] italic text-emerald-900">
                      💡 AI streszczenie: {d.extracted_summary}
                    </p>
                  )}
                  {d.extracted_structured && (
                    <details className="mt-1 rounded border border-purple-200 bg-purple-50 px-1.5 py-1">
                      <summary className="cursor-pointer text-[10px] font-semibold text-purple-900">
                        🔢 Wartości strukturalne (Gemini Vision) — {Object.keys(d.extracted_structured).length} pól
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[9px] text-purple-900">
                        {JSON.stringify(d.extracted_structured, null, 2)}
                      </pre>
                    </details>
                  )}
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    {d.size_bytes ? `${Math.round(d.size_bytes / 1024)} KB · ` : ""}
                    Wgrany: {new Date(d.created_at).toLocaleString("pl-PL")}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  {d.download_url && (
                    <a href={d.download_url} target="_blank" rel="noreferrer"
                      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50">
                      ↓ Pobierz
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void extractStructured(d.id)}
                    disabled={busyExtract === d.id}
                    className="rounded border border-purple-300 bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800 hover:bg-purple-100 disabled:opacity-40"
                    title="Gemini 2.5 Pro Vision wyciaga wartosci SAR / IP / frequencies z PDF"
                  >
                    {busyExtract === d.id ? "Czytam (~30-60s)..." : d.extracted_structured ? "🔄 Re-extract AI" : "✨ Wyekstrahuj wartości AI"}
                  </button>
                  <button type="button" onClick={() => void remove(d.id)}
                    className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-50">
                    Usuń
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
