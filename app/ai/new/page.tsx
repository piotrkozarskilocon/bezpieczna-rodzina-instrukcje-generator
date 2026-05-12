"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  DEVICE_TYPES,
  DEVICE_TYPE_LABELS,
  type DocumentType,
  type DeviceType,
} from "@/lib/v4LegalTemplates";

const API_BASE = "/generator-instrukcji/api/v4";

interface Feature { key: string; label: string; enabled: boolean }

const PRESET_FEATURES: Feature[] = [
  { key: "gps", label: "GPS — lokalizacja", enabled: true },
  { key: "lte", label: "LTE 4G — łączność", enabled: true },
  { key: "wifi", label: "Wi-Fi", enabled: true },
  { key: "ai", label: "Asystent AI", enabled: false },
  { key: "pulse", label: "Pulsoksymetr (puls + SpO2)", enabled: false },
  { key: "steps", label: "Krokomierz", enabled: false },
  { key: "sos", label: "Przycisk SOS", enabled: true },
  { key: "geofence", label: "Strefy bezpieczne", enabled: true },
  { key: "calls", label: "Rozmowy głosowe", enabled: true },
  { key: "messages", label: "Wiadomości tekstowe", enabled: false },
];

/** Domyślny warranty_mode wynika z typu dokumentu — backend ma to pole w
 *  GenerationInput dla wstecznej kompat, ale wizard już go nie pokazuje. */
function deriveWarrantyMode(doc: DocumentType): "full" | "short" | "none" {
  switch (doc) {
    case "kg_full":
    case "manual_full": return "full";
    case "qsg_full":
    case "kg_short": return "short";
    case "qsg_only": return "none";
  }
}

export default function AiNewProjectPage(): React.ReactElement {
  const [name, setName] = useState("");
  const [modelName, setModelName] = useState("Locon Watch");
  const [modelCode, setModelCode] = useState("GJD.");
  const [documentType, setDocumentType] = useState<DocumentType>("qsg_full");
  const [deviceType, setDeviceType] = useState<DeviceType>("watch_kid");
  const [features, setFeatures] = useState<Feature[]>(PRESET_FEATURES);
  const [stepCount, setStepCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "manual" | "unknown">("unknown");
  const [refFiles, setRefFiles] = useState<Array<{ file: File; kind: string; lang: string }>>([]);
  const [templates, setTemplates] = useState<Array<{
    id: string; name: string; document_type: string | null; device_type: string | null;
    pages_count: number; ai_input: Record<string, unknown> | null;
  }>>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/templates/`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { templates: typeof templates } | null) => {
        if (!cancelled && j) setTemplates(j.templates ?? []);
      })
      .catch(() => { /* templates są opcjonalne */ });
    return () => { cancelled = true; };
  }, []);

  const cloneFromTemplate = async (templateId: string, templateName: string) => {
    const newName = window.prompt("Nazwa nowego projektu:", `${templateName} (kopia)`);
    if (!newName?.trim()) return;
    setBusy(true);
    setError(null);
    setStage("Klonuję z templatu...");
    try {
      const res = await fetch(`${API_BASE}/projects/${templateId}/clone/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
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
      setStage(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/status`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { mode?: "auto" | "manual" } | null) => {
        if (!cancelled && j?.mode) setMode(j.mode);
      })
      .catch(() => { /* zostawiamy "unknown" — frontend pokaże neutralny komunikat */ });
    return () => { cancelled = true; };
  }, []);

  const toggleFeature = (key: string) => {
    setFeatures((prev) => prev.map((f) => (f.key === key ? { ...f, enabled: !f.enabled } : f)));
  };

  const submit = async (e: React.FormEvent, usePreset = false) => {
    e.preventDefault();
    if (!name.trim() || !modelCode.trim() || !modelName.trim()) return;
    setBusy(true);
    setError(null);
    setStage(usePreset
      ? "Tworzenie projektu z gotowego szablonu (bez AI)..."
      : "Tworzenie projektu i generowanie szkieletu stron...");
    try {
      const res = await fetch(`${API_BASE}/projects/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          use_preset: usePreset,
          input: {
            model_code: modelCode.trim(),
            model_name: modelName.trim(),
            features,
            step_count: stepCount,
            warranty_mode: deriveWarrantyMode(documentType),
            page_size_mm: { width: 76, height: 76 },
            document_type: documentType,
            device_type: deviceType,
          },
        }),
      });
      const json = (await res.json()) as {
        id?: string;
        mode?: "auto" | "manual" | "preset";
        skeleton?: boolean;
        page_list?: Array<{ id: string; page_number: number; template: string | null; title: string | null }>;
        error?: string;
      };
      if (!res.ok && json.mode !== "manual") {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      // Manual mode lub preset bez AI → redirect od razu (preset nie używa populate).
      if (json.mode === "manual" || json.mode === "preset" || !json.skeleton || !json.id || !json.page_list) {
        window.location.href = `/generator-instrukcji/ai/projects/${json.id}`;
        return;
      }

      // Wgraj pliki referencyjne (jeśli były) ZANIM ruszymy populate —
      // dzięki temu AI w generowaniu treści ma do nich dostęp. Direct upload
      // przez signed URL (omija Vercel 4.5 MB cap dla dużych SAR/spec PDF-ów).
      if (refFiles.length > 0) {
        for (let i = 0; i < refFiles.length; i++) {
          const { file, kind, lang } = refFiles[i];
          setStage(`Wgrywam i synchronizuję plik referencyjny ${i + 1}/${refFiles.length}: ${file.name}...`);
          try {
            // 1. Signed URL
            const initRes = await fetch(`${API_BASE}/projects/${json.id}/reference-docs/upload-url/`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
            });
            if (!initRes.ok) continue;
            const init = (await initRes.json()) as { signed_url: string; file_path: string };
            // 2. Direct PUT
            await fetch(init.signed_url, {
              method: "PUT",
              headers: { "Content-Type": file.type },
              body: file,
            });
            // 3. Finalize (metadata + Anthropic sync)
            await fetch(`${API_BASE}/projects/${json.id}/reference-docs/`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                file_path: init.file_path,
                name: file.name,
                kind,
                source_lang: lang,
                size_bytes: file.size,
                mime_type: file.type,
              }),
            });
          } catch {
            /* ignoruj — user może doupload-ować w panelu projektu */
          }
        }
      }

      // Auto mode (chunked) → pętla per-strona z progress UI.
      // Strony tytułowe + spis treści generujemy też przez AI dla spójności
      // (cover ma logo+model+wersja, toc ma listę pozostałych stron).
      const pages = json.page_list;
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        setStage(
          `Generuję treść strony ${i + 1}/${pages.length}: ${p.title ?? p.template ?? "strona"}...`,
        );
        try {
          const r = await fetch(`${API_BASE}/pages/${p.id}/auto-populate/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (r.ok) ok++;
          else failed++;
        } catch {
          failed++;
        }
      }
      setStage(`Gotowe — ${ok}/${pages.length} stron z treścią${failed > 0 ? ` (${failed} do retry)` : ""}.`);
      // Krótka pauza by user zobaczył komunikat końcowy, potem redirect.
      setTimeout(() => {
        window.location.href = `/generator-instrukcji/ai/projects/${json.id}`;
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "generation failed");
      setBusy(false);
      setStage(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-6 text-sm text-slate-500">
        <Link href="/" className="hover:text-slate-900">Generator</Link>
        <span className="mx-2">/</span>
        <Link href="/ai" className="hover:text-slate-900">Generator AI</Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">Nowy projekt</span>
      </div>

      <h2 className="mb-2 text-2xl font-semibold text-slate-900">Nowy projekt AI ✨</h2>
      <p className="mb-3 text-sm text-slate-500">
        Opisz model i jego funkcje — AI wygeneruje pełen szkielet instrukcji w PL.
      </p>
      {mode === "auto" && (
        <div className="mb-8 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <strong>Tryb auto (Claude API) aktywny:</strong> najpierw wygenerujemy szkielet
          stron (~10 s), potem treść każdej strony osobno (~5-10 s na stronę). Łącznie
          ~2-4 min dla 14-stronnego dokumentu. Model: Haiku 4.5, koszt ~0,15 USD per
          projekt. Postęp widoczny pod przyciskiem.
        </div>
      )}
      {mode === "manual" && (
        <div className="mb-8 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Tryb manualny aktywny:</strong> brak ANTHROPIC_API_KEY w środowisku.
          Po stworzeniu projektu pokażemy gotowy prompt do skopiowania — wkleisz go
          w nowej rozmowie z Claude.ai, dostaniesz JSON, który zaimportujesz tutaj.
        </div>
      )}

      {templates.length > 0 && (
        <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="mb-2 text-sm font-semibold text-amber-900">
            ⭐ Albo skopiuj z templatu ({templates.length})
          </h3>
          <p className="mb-3 text-xs text-amber-800">
            Skopiuj gotowy projekt zamiast generować od zera. Klon zachowuje strony,
            elementy, design system, notatki project-scoped i pliki referencyjne.
            Modyfikujesz tylko model po klonowaniu (przycisk „Klonuj" w widoku projektu).
          </p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void cloneFromTemplate(t.id, t.name)}
                  className="block w-full rounded-md border border-amber-300 bg-white p-3 text-left text-xs transition hover:border-amber-500 disabled:opacity-50"
                >
                  <p className="font-semibold text-slate-800">{t.name}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {t.pages_count} stron · {t.document_type ?? "?"} · {t.device_type ?? "?"}
                    {t.ai_input?.model_code ? ` · ${t.ai_input.model_code as string}` : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit} className="space-y-6 rounded-xl border border-slate-200 bg-white p-6">
        <div>
          <label className="block text-xs font-medium text-slate-700">
            Nazwa projektu <span className="text-red-600">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="np. GJD.20 — QSG+KG (PL)"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Typ dokumentu <span className="text-red-600">*</span>
            </label>
            <select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value as DocumentType)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              Determinuje listę wymaganych sekcji prawnych (RED, KC, RODO, MDR).
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Typ urządzenia <span className="text-red-600">*</span>
            </label>
            <select
              value={deviceType}
              onChange={(e) => setDeviceType(e.target.value as DeviceType)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              {DEVICE_TYPES.map((t) => (
                <option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              Wpływa na sekcje device-specific: zegarek dziecięcy → klauzula RODO art. 8;
              opaska seniorska → zastrzeżenie „nie jest wyrobem medycznym"; tracker
              zwierzęcy → bezpieczeństwo zwierzęcia + IP rating.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Nazwa modelu <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="Locon Watch GOAT"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Kod modelu <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={modelCode}
              onChange={(e) => setModelCode(e.target.value)}
              placeholder="GJD.20"
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">Funkcje urządzenia</label>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {features.map((f) => (
              <label key={f.key} className="flex cursor-pointer items-center gap-2 rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={() => toggleFeature(f.key)}
                  className="h-3.5 w-3.5"
                />
                <span className="text-slate-800">{f.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            Liczba kroków pierwszego uruchomienia
          </label>
          <input
            type="number"
            min={1}
            max={8}
            value={stepCount}
            onChange={(e) => setStepCount(parseInt(e.target.value, 10) || 4)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Wskazówka dla AI ile podkroków rozłożyć w sekcji „Pierwsze uruchomienie".
            Reszta sekcji (gwarancja, kontakt, deklaracja CE…) wynika z typu dokumentu.
          </p>
        </div>

        {/* Opcjonalne pliki referencyjne — AI wyciągnie z nich konkretne wartości */}
        <div>
          <label className="block text-xs font-medium text-slate-700">
            📎 Pliki referencyjne (opcjonalnie)
          </label>
          <p className="mt-1 mb-2 text-[11px] text-slate-500">
            Wgraj PDF-y z raportem SAR, specyfikacją techniczną, instrukcją producenta —
            AI wyciągnie z nich konkretne wartości (SAR head/body, normy, częstotliwości,
            IP rating) i wstawi je w generowanej instrukcji zamiast placeholderów{" "}
            <em>DO UZUPEŁNIENIA</em>. Maksymalnie 25 MB na plik.
          </p>
          {refFiles.length > 0 && (
            <ul className="mb-2 space-y-1">
              {refFiles.map((rf, idx) => (
                <li key={idx} className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
                  <span className="flex-1 truncate" title={rf.file.name}>
                    📄 {rf.file.name} <span className="text-slate-400">({Math.round(rf.file.size / 1024)} KB)</span>
                  </span>
                  <select
                    value={rf.kind}
                    onChange={(e) => {
                      const v = e.target.value;
                      setRefFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, kind: v } : f)));
                    }}
                    className="rounded border border-slate-300 px-1 py-0.5 text-[10px]"
                  >
                    <option value="sar_report">SAR</option>
                    <option value="tech_spec">Spec</option>
                    <option value="manufacturer_manual">Producent</option>
                    <option value="declaration_ce">CE</option>
                    <option value="other">Inne</option>
                  </select>
                  <select
                    value={rf.lang}
                    onChange={(e) => {
                      const v = e.target.value;
                      setRefFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, lang: v } : f)));
                    }}
                    className="rounded border border-slate-300 px-1 py-0.5 text-[10px]"
                  >
                    <option value="pl">PL</option>
                    <option value="en">EN</option>
                    <option value="zh">ZH</option>
                    <option value="de">DE</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setRefFiles((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-slate-400 hover:text-red-700"
                    title="Usuń"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-purple-400 hover:bg-purple-50">
            <span>+ Dodaj plik (PDF / DOCX / XLSX / TXT / MD / CSV / JSON)</span>
            <input
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,.docx,.xlsx,application/pdf,text/plain,text/markdown,text/csv,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                setRefFiles((prev) => [
                  ...prev,
                  ...files.map((f) => ({ file: f, kind: "tech_spec", lang: "pl" })),
                ]);
                // reset input value żeby można było wgrać ten sam plik ponownie
                e.target.value = "";
              }}
            />
          </label>
        </div>

        {stage && (
          <p className="rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-800">{stage}</p>
        )}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
            Błąd generacji: {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3">
          <Link
            href="/ai"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Anuluj
          </Link>
          <button
            type="button"
            disabled={busy || !name.trim() || !modelCode.trim()}
            onClick={(e) => void submit(e as unknown as React.FormEvent, true)}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Bez AI — tylko gotowy szkielet stron z legal templates (instant). AI dorobisz później per-page."
          >
            ⚡ Szybki start (bez AI)
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || !modelCode.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-purple-700 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-800 disabled:opacity-50"
          >
            {busy
              ? mode === "auto" ? "Generowanie..." : "Tworzenie..."
              : mode === "auto" ? "✨ Stwórz projekt (AI)" : "✨ Stwórz projekt + przygotuj prompt"}
          </button>
        </div>
      </form>

      <p className="mt-6 text-xs text-slate-500">
        {mode === "auto"
          ? "Klucz API podpięty — koszt ~0,15 USD per projekt (Claude Haiku 4.5, chunked: szkielet + treść per strona). Budżet i zużycie sprawdzisz w Anthropic Console."
          : mode === "manual"
            ? "Tryb manualny — bez kosztów API (używasz subskrypcji Claude.ai)."
            : "Sprawdzanie trybu pracy..."}
      </p>
    </div>
  );
}
