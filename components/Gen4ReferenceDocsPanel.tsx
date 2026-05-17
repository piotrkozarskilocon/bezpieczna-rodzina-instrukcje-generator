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
  const [busyResummarize, setBusyResummarize] = useState<string | null>(null);
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
      const finJson = (await finRes.json().catch(() => ({}))) as { doc?: { id: string } };
      const newDocId = finJson.doc?.id;
      setPendingFile(null);
      setPendingKind("tech_spec");
      setPendingLang("pl");
      await refresh();
      // Auto-trigger ekstrakcji wartości AI dla nowego pliku — fire-and-forget.
      // User widzi w UI że plik się ładuje + wartości pojawią się gdy ekstrakcja
      // skończy (60-180s). NIE blokujemy UI uploadu — jeśli klient zamknie kartę,
      // można zawsze później kliknąć "✨ Wyciągnij wartości" bulk.
      if (newDocId) {
        void extractStructured(newDocId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  /** Ponowne wygenerowanie streszczenia (extracted_summary) dla pliku.
   *  Uzywane gdy stare summary mowi "Nie widze pliku" — po fixie attachments
   *  z Supabase Storage trzeba odswiezyc. */
  const resummarize = async (docId: string) => {
    setBusyResummarize(docId);
    setError(null);
    try {
      const res = await fetch(`${API}/reference-docs/${docId}/resummarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; extracted_summary?: string; error?: string };
      if (!res.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? { ...d, extracted_summary: j.extracted_summary ?? null }
            : d,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "resummarize failed");
    } finally {
      setBusyResummarize(null);
    }
  };

  const extractStructured = async (docId: string) => {
    setBusyExtract(docId);
    setError(null);
    try {
      // Endpoint zwraca SSE — Gemini moze trwac 60-180s, plain JSON nie przejdzie
      // przez hub Edge middleware (~25-30s timeout). Czytamy chunki, szukamy
      // event 'done' (final wynik) lub 'error'.
      const res = await fetch(`${API}/reference-docs/${docId}/extract-structured`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "sar" }),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: { extracted: Record<string, unknown>; model: string } | null = null;
      let errorMsg: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE format: "event: <name>\ndata: <json>\n\n"
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? ""; // ostatni moze byc niepelny
        for (const evt of events) {
          const lines = evt.split("\n");
          let eventName = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (eventName === "done") {
              finalResult = data as { extracted: Record<string, unknown>; model: string };
            } else if (eventName === "error") {
              errorMsg = (data.error as string) ?? "extract failed";
            }
            // 'started' / 'ping' — ignore (mogliby pokazac progres ale UI go nie ma)
          } catch {
            /* zignoruj nie-JSON chunk */
          }
        }
      }

      if (errorMsg) throw new Error(errorMsg);
      if (!finalResult) throw new Error("stream zakonczyl sie bez wyniku");

      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                extracted_structured: finalResult.extracted,
                extracted_structured_at: new Date().toISOString(),
                extracted_structured_model: finalResult.model,
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

  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; doc_name: string } | null>(null);
  const [bulkResult, setBulkResult] = useState<{ ok: number; err: number } | null>(null);
  const [categorizeBusy, setCategorizeBusy] = useState(false);
  const [categorizeProgress, setCategorizeProgress] = useState<{ current: number; total: number; doc_name: string } | null>(null);

  /** Bulk re-summary dla WSZYSTKICH plikow projektu — uzywa SSE stream
   *  z progress updates. Bez force = tylko broken summaries (puste lub
   *  "nie widzę pliku"). Force=true = re-summary wszystkie, nadpisuje. */
  const resummarizeAll = async (force = false) => {
    // Heurystyka kliencka — broken summary = pusty lub fraza "nie widzę" / "I notice"
    const isBroken = (s: string | null) => {
      if (!s) return true;
      const lc = s.toLowerCase();
      return (
        lc.includes("nie widz") ||
        lc.includes("nie mam dostępu") ||
        lc.includes("czekam na plik") ||
        lc.includes("i notice you") ||
        lc.includes("załączonego pliku") ||
        lc.includes("oczekuję na zawartość") ||
        lc.includes("nie zobaczyłem") ||
        lc.includes("brakuje załączonego") ||
        lc.includes("brak załączonego")
      );
    };
    const broken = docs.filter((d) => isBroken(d.extracted_summary)).length;
    const already = docs.length - broken;
    if (broken === 0 && !force) {
      setError(`Wszystkie ${docs.length} plikow ma juz prawidlowe streszczenia. Uzyj '🔄 Re-summary wszystkie' aby zregenerowac.`);
      return;
    }
    const todo = force ? docs.length : broken;
    const msg = force
      ? `RE-SUMMARY WSZYSTKIE ${docs.length} plikow?\n\nNadpisze ${already} istniejace summaries + zrobi ${broken} brakujace/zlamane.\nKoszt: ~$${(docs.length * 0.001).toFixed(2)} Gemini · ~${Math.ceil(docs.length * 0.5)} min.`
      : `Re-summary ${todo} plikow ze zlamanymi/brakujacymi summary?\n\n${already > 0 ? `Pominiete ${already} plikow z prawidlowymi summary (idempotency — nie marnujemy tokenow).\n\n` : ""}Koszt: ~$${(todo * 0.001).toFixed(2)} Gemini · ~${Math.ceil(todo * 0.5)} min.`;
    if (!confirm(msg)) return;
    setBulkProgress({ current: 0, total: todo, doc_name: "..." });
    setBulkResult(null);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/resummarize-all${force ? "?force=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let okCount = 0;
      let errCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const lines = evt.split("\n");
          let eventName = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (eventName === "progress") {
              setBulkProgress({
                current: (data.current as number) ?? 0,
                total: (data.total as number) ?? docs.length,
                doc_name: (data.doc_name as string) ?? "...",
              });
              if (data.status === "done" && data.summary) {
                const docName = data.doc_name as string;
                const summary = data.summary as string;
                setDocs((prev) =>
                  prev.map((d) =>
                    d.name === docName ? { ...d, extracted_summary: summary } : d,
                  ),
                );
              }
            } else if (eventName === "done") {
              okCount = (data.ok as number) ?? 0;
              errCount = (data.err as number) ?? 0;
              setBulkResult({ ok: okCount, err: errCount });
              // Wczytaj swieze docs z DB zeby mieć pelne summaries
              void refresh();
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "bulk resummarize failed");
    } finally {
      setBulkProgress(null);
    }
  };

  const [extractBulkProgress, setExtractBulkProgress] = useState<{ current: number; total: number; doc_name: string } | null>(null);
  const [extractBulkResult, setExtractBulkResult] = useState<{ ok: number; err: number } | null>(null);
  const [applyBusy, setApplyBusy] = useState<"autofill" | "regenerate" | null>(null);

  /** Wypełnij placeholdery '⚠️ DO UZUPEŁNIENIA' wartościami z extracted_structured.
   *  Bezpieczne — tylko placeholdery, nie ruchne edycji. */
  const applyValuesAutofill = async () => {
    if (applyBusy) return;
    setApplyBusy("autofill");
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/autofill-placeholders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; filled?: number; total?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setExtractBulkResult(null);
      alert(`✅ Wypełniono ${j.filled ?? 0} z ${j.total ?? 0} placeholderów wartościami z plików.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "autofill failed");
    } finally {
      setApplyBusy(null);
    }
  };

  /** Regeneruj WSZYSTKIE strony od zera z nowymi wartościami. UWAGA: nadpisze
   *  ręczne edycje stron. Pyta o potwierdzenie. */
  const applyValuesRegenerate = async () => {
    if (applyBusy) return;
    if (!confirm("⚠️ REGENERACJA STRON nadpisze WSZYSTKIE ręczne edycje stron. Pewien? (Wypełnianie samych placeholderów jest bezpieczniejsze.)")) return;
    setApplyBusy("regenerate");
    setError(null);
    try {
      // regenerate-pages jest chunked (?from=N, has_more, next_offset).
      let fromOffset = 0;
      let totalOk = 0;
      while (true) {
        const res = await fetch(`${API}/projects/${projectId}/regenerate-pages?from=${fromOffset}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let nextOff: number | null = null;
        let hasMore = false;
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          buffer += decoder.decode(r.value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            const m = evt.match(/event: done[\s\S]*?data: (.+)/);
            if (m) {
              try {
                const d = JSON.parse(m[1]) as { ok?: number; next_offset?: number | null; has_more?: boolean };
                totalOk += d.ok ?? 0;
                nextOff = d.next_offset ?? null;
                hasMore = !!d.has_more;
              } catch { /* skip */ }
            }
          }
        }
        if (!hasMore || nextOff === null) break;
        fromOffset = nextOff;
      }
      setExtractBulkResult(null);
      alert(`✅ Zregenerowano ${totalOk} stron z nowymi wartościami.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "regenerate failed");
    } finally {
      setApplyBusy(null);
    }
  };

  /** Bulk extract structured: Gemini per-doc wyciaga wartosci wg schemy (SAR/
   *  tech_spec/manual/declaration/generic). Idempotent — pomija pliki z istniejacymi
   *  wartosciami. Force=true zeby re-extract wszystko. */
  const extractStructuredAll = async (force = false) => {
    const missing = docs.filter((d) => d.extracted_structured == null).length;
    const already = docs.length - missing;
    if (missing === 0 && !force) {
      setError(`Wszystkie ${docs.length} plikow ma juz wartosci AI. Uzyj '🔄 Re-extract wszystkie' aby zregenerowac.`);
      return;
    }
    const todo = force ? docs.length : missing;
    const msg = force
      ? `RE-EXTRACT WSZYSTKIE ${docs.length} plikow?\n\nNadpisze ${already} istniejace wyniki + zrobi ${missing} brakujace.\nKoszt: ~$${(docs.length * 0.005).toFixed(2)} Gemini · ~${Math.ceil(docs.length * 1.5)} min.`
      : `Wyciagnac wartosci AI dla ${todo} brakujacych plikow?\n\n${already > 0 ? `Pominiete ${already} plikow ktore JUZ MAJA wartosci (idempotency — nie marnujemy tokenow).\n\n` : ""}Koszt: ~$${(todo * 0.005).toFixed(2)} Gemini · ~${Math.ceil(todo * 1.5)} min.`;
    if (!confirm(msg)) return;
    setExtractBulkProgress({ current: 0, total: todo, doc_name: "..." });
    setExtractBulkResult(null);
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/extract-structured-all${force ? "?force=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let okCount = 0;
      let errCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const lines = evt.split("\n");
          let eventName = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (eventName === "progress") {
              setExtractBulkProgress({
                current: (data.current as number) ?? 0,
                total: (data.total as number) ?? todo,
                doc_name: (data.doc_name as string) ?? "...",
              });
            } else if (eventName === "done") {
              okCount = (data.ok as number) ?? 0;
              errCount = (data.err as number) ?? 0;
              setExtractBulkResult({ ok: okCount, err: errCount });
              void refresh();
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "bulk extract failed");
    } finally {
      setExtractBulkProgress(null);
    }
  };

  /** Bulk auto-categorize: AI rozpoznaje kind plików (sar/spec/decl/manual/other). */
  const categorizeAll = async (force = false) => {
    if (categorizeBusy) return;
    setCategorizeBusy(true);
    setCategorizeProgress({ current: 0, total: docs.length, doc_name: "..." });
    setError(null);
    try {
      const res = await fetch(`${API}/projects/${projectId}/categorize-all${force ? "?force=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const lines = evt.split("\n");
          let eventName = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (eventName === "progress") {
              setCategorizeProgress({
                current: (data.current as number) ?? 0,
                total: (data.total as number) ?? docs.length,
                doc_name: (data.doc_name as string) ?? "...",
              });
              if (data.status === "done" && data.kind) {
                const docName = data.doc_name as string;
                const newKind = data.kind as string;
                setDocs((prev) =>
                  prev.map((d) => d.name === docName ? { ...d, kind: newKind } : d),
                );
              }
            } else if (eventName === "done") {
              void refresh();
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "categorize failed");
    } finally {
      setCategorizeBusy(false);
      setCategorizeProgress(null);
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
        {docs.length > 0 && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => void categorizeAll()}
              disabled={categorizeBusy}
              className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-40 whitespace-nowrap"
              title="AI auto-rozpoznaje typ kazdego pliku (SAR/Spec/Decl/Manual/inne). Pomija juz skategoryzowane."
            >
              {categorizeProgress
                ? `🏷️ ${categorizeProgress.current}/${categorizeProgress.total}: ${categorizeProgress.doc_name.slice(0, 20)}...`
                : "🏷️ Auto-rozpoznaj typy"}
            </button>
            {(() => {
              const isBrokenSummary = (s: string | null) => {
                if (!s) return true;
                const lc = s.toLowerCase();
                return lc.includes("nie widz") || lc.includes("nie mam dostępu") || lc.includes("i notice you") || lc.includes("oczekuję na zawartość");
              };
              const brokenCount = docs.filter((d) => isBrokenSummary(d.extracted_summary)).length;
              return (
                <>
                  <button
                    type="button"
                    onClick={() => void resummarizeAll(false)}
                    disabled={!!bulkProgress}
                    className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-40 whitespace-nowrap"
                    title="Re-summary plikow ktore maja zlamane/brakujace streszczenia (puste lub 'nie widzę pliku'). Pliki z prawidlowymi summary sa pominiete (oszczednosc tokenow)."
                  >
                    {bulkProgress
                      ? `📝 ${bulkProgress.current}/${bulkProgress.total}: ${bulkProgress.doc_name.slice(0, 20)}...`
                      : `📝 Re-summary zlamane (${brokenCount})`}
                  </button>
                  {docs.length - brokenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void resummarizeAll(true)}
                      disabled={!!bulkProgress}
                      className="rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100 disabled:opacity-40 whitespace-nowrap"
                      title="RE-SUMMARY wszystkie pliki (nadpisze istniejace). Uzyj gdy zmieniles prompt summarizacji lub chcesz odswiezyc wyniki."
                    >
                      🔄 Re-summary wszystkie ({docs.length})
                    </button>
                  )}
                </>
              );
            })()}
            <button
              type="button"
              onClick={() => void extractStructuredAll(false)}
              disabled={!!extractBulkProgress}
              className="rounded border border-purple-300 bg-purple-50 px-2 py-1 text-[11px] font-semibold text-purple-800 hover:bg-purple-100 disabled:opacity-40 whitespace-nowrap"
              title="Wyciagnij wartosci AI (SAR/spec/manual values) dla wszystkich plikow KTORE JESZCZE NIE MAJA wynikow. Pliki z istniejacymi wartosciami sa pominiete (oszczednosc tokenow)."
            >
              {extractBulkProgress
                ? `✨ ${extractBulkProgress.current}/${extractBulkProgress.total}: ${extractBulkProgress.doc_name.slice(0, 20)}...`
                : `✨ Wyciągnij brakujące (${docs.filter((d) => d.extracted_structured == null).length})`}
            </button>
            {docs.some((d) => d.extracted_structured != null) && (
              <button
                type="button"
                onClick={() => void extractStructuredAll(true)}
                disabled={!!extractBulkProgress}
                className="rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100 disabled:opacity-40 whitespace-nowrap"
                title="RE-EXTRACT wszystkie pliki (nadpisze istniejace wartosci). Uzyj gdy schema sie zmienila lub chcesz odswiezyc wyniki."
              >
                🔄 Re-extract wszystkie ({docs.length})
              </button>
            )}
          </div>
        )}
      </div>
      {bulkResult && (
        <div className={`mb-2 rounded border px-2 py-1 text-[11px] ${bulkResult.err > 0 ? "border-amber-400 bg-amber-50 text-amber-800" : "border-green-400 bg-green-50 text-green-800"}`}>
          ✅ Bulk re-summary: {bulkResult.ok} OK, {bulkResult.err} blędow.
        </div>
      )}
      {extractBulkResult && (
        <div className={`mb-2 rounded border px-3 py-2 text-[12px] ${extractBulkResult.err > 0 ? "border-amber-400 bg-amber-50 text-amber-800" : "border-green-400 bg-green-50 text-green-900"}`}>
          <div className="font-semibold">
            ✨ Bulk ekstrakcja: {extractBulkResult.ok} OK, {extractBulkResult.err} błędów.
          </div>
          {extractBulkResult.ok > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-[11px] text-slate-700">
                Wartości są teraz w bazie — kolejne generacje/edycje AI będą ich używać automatycznie.
                Chcesz <strong>od razu zastosować je do projektu</strong>?
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void applyValuesAutofill()}
                  disabled={applyBusy !== null}
                  className="rounded border border-purple-300 bg-purple-50 px-2 py-1 text-[11px] font-semibold text-purple-800 hover:bg-purple-100 disabled:opacity-40 whitespace-nowrap"
                  title="Wypełnij placeholdery ⚠️ DO UZUPEŁNIENIA wartościami z plików. Bezpieczne — zmienia tylko placeholdery, nie ruchne edycji."
                >
                  {applyBusy === "autofill" ? "🪄 Wypełniam..." : "🪄 Wypełnij placeholdery"}
                </button>
                <button
                  type="button"
                  onClick={() => void applyValuesRegenerate()}
                  disabled={applyBusy !== null}
                  className="rounded border border-orange-300 bg-orange-50 px-2 py-1 text-[11px] font-semibold text-orange-800 hover:bg-orange-100 disabled:opacity-40 whitespace-nowrap"
                  title="Regeneruj WSZYSTKIE strony od zera z nowymi wartościami. UWAGA: nadpisze ręczne edycje stron."
                >
                  {applyBusy === "regenerate" ? "🔄 Regeneruję..." : "🔄 Regeneruj strony (nadpisze edycje)"}
                </button>
                <button
                  type="button"
                  onClick={() => setExtractBulkResult(null)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  Nie teraz
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
                    onClick={() => void resummarize(d.id)}
                    disabled={busyResummarize === d.id}
                    className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-40"
                    title="Ponownie wygeneruj krótkie streszczenie pliku (uzywane np. gdy stare mowi 'nie widzialem pliku')"
                  >
                    {busyResummarize === d.id ? "Streszczam..." : "📝 Re-summary"}
                  </button>
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
