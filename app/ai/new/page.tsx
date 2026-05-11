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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !modelCode.trim() || !modelName.trim()) return;
    setBusy(true);
    setError(null);
    setStage("Tworzenie projektu...");
    try {
      const res = await fetch(`${API_BASE}/projects/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
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
      const json = await res.json();
      if (!res.ok && json.mode !== "manual") {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Redirect to the project — the page itself decides whether to show
      // the editor (mode='auto', already populated) or the manual prompt
      // export UI (mode='manual', status='draft').
      window.location.href = `/generator-instrukcji/ai/projects/${json.id}`;
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
          <strong>Tryb auto (Claude API) aktywny:</strong> projekt zostanie wygenerowany
          automatycznie po kliknięciu przycisku. Koszt ~0,20 USD per projekt (Sonnet 4.6),
          czas generacji ~30–60 s. Jeśli API padnie, przygotujemy też prompt do
          ręcznego skopiowania jako fallback.
        </div>
      )}
      {mode === "manual" && (
        <div className="mb-8 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Tryb manualny aktywny:</strong> brak ANTHROPIC_API_KEY w środowisku.
          Po stworzeniu projektu pokażemy gotowy prompt do skopiowania — wkleisz go
          w nowej rozmowie z Claude.ai, dostaniesz JSON, który zaimportujesz tutaj.
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

        {stage && (
          <p className="rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-800">{stage}</p>
        )}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
            Błąd generacji: {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Link
            href="/ai"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Anuluj
          </Link>
          <button
            type="submit"
            disabled={busy || !name.trim() || !modelCode.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-purple-700 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-800 disabled:opacity-50"
          >
            {busy ? "Tworzenie..." : "✨ Stwórz projekt + przygotuj prompt"}
          </button>
        </div>
      </form>

      <p className="mt-6 text-xs text-slate-500">
        {mode === "auto"
          ? "Klucz API podpięty — koszt ~0,20 USD per projekt (Claude Sonnet 4.6). Budżet i zużycie sprawdzisz w Anthropic Console."
          : mode === "manual"
            ? "Tryb manualny — bez kosztów API (używasz subskrypcji Claude.ai)."
            : "Sprawdzanie trybu pracy..."}
      </p>
    </div>
  );
}
