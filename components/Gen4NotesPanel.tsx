"use client";

/**
 * AI Notebook — UI dla lessons-learned które AI ma stosować w generacji.
 * Każda notatka ma scope (global / per typ dokumentu / per urządzenie / per
 * projekt). Notatki widoczne tutaj są wpinane do system promptów wszystkich
 * workflow-ów AI (skeleton, auto-populate, ai-edit, apply-design).
 *
 * Wyświetlenie: 4 sekcje per scope, sortowanie po used_count desc (najczęściej
 * używane notatki na górze).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  DEVICE_TYPES,
  DEVICE_TYPE_LABELS,
} from "@/lib/v4LegalTemplates";

const API = "/generator-instrukcji/api/v4";

type NoteScope = "global" | "document_type" | "device_type" | "project";

interface AiNote {
  id: string;
  scope: NoteScope;
  scope_value: string | null;
  content: string;
  why: string | null;
  is_active: boolean;
  used_count: number;
  created_at: string;
  updated_at: string;
}

interface Props {
  projectId: string;
  /** Aktualny typ dokumentu/urządzenia — pre-fill dla nowej notatki scoped to project. */
  documentType?: string | null;
  deviceType?: string | null;
}

const SCOPE_LABELS: Record<NoteScope, string> = {
  global: "🌐 Globalne",
  document_type: "📑 Typ dokumentu",
  device_type: "📱 Typ urządzenia",
  project: "🎯 Tylko ten projekt",
};

const SCOPE_DESCRIPTIONS: Record<NoteScope, string> = {
  global: "Stosowane w każdym projekcie. Np. zasady stylu, polskie znaki, marginesy.",
  document_type: "Tylko dla konkretnego typu dokumentu (QSG, pełna KG itd.).",
  device_type: "Tylko dla konkretnego typu urządzenia (zegarek dziecięcy, opaska senior, tracker).",
  project: "Tylko dla tego jednego projektu. Idealne dla wartości technicznych (SAR, IMEI).",
};

export default function Gen4NotesPanel({ projectId, documentType, deviceType }: Props): React.ReactElement {
  const [notes, setNotes] = useState<AiNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<NoteScope | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/ai-notes/`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { notes: AiNote[] };
      setNotes(j.notes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch notes failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async (scope: NoteScope, scope_value: string | null, content: string, why: string) => {
    try {
      const res = await fetch(`${API}/ai-notes/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, scope_value, content, why: why || undefined }),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } = {};
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      setAdding(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    }
  };

  const toggleActive = async (note: AiNote) => {
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, is_active: !n.is_active } : n)));
    try {
      await fetch(`${API}/ai-notes/${note.id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !note.is_active }),
      });
    } catch {
      await refresh();
    }
  };

  const updateNote = async (id: string, patch: { content?: string; why?: string | null }) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    try {
      await fetch(`${API}/ai-notes/${id}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      await refresh();
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Usunąć notatkę?")) return;
    try {
      const res = await fetch(`${API}/ai-notes/${id}/`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  // Notatki podzielone per scope, plus filtr "tylko relewantne dla tego projektu".
  const grouped = useMemo(() => {
    const g: Record<NoteScope, AiNote[]> = {
      global: [],
      document_type: [],
      device_type: [],
      project: [],
    };
    for (const n of notes) {
      // Pokazujemy tylko notatki które są relewantne dla bieżącego kontekstu:
      // - global zawsze
      // - document_type: tylko jeśli pasuje
      // - device_type: tylko jeśli pasuje
      // - project: tylko jeśli to nasz projekt
      if (n.scope === "global") g.global.push(n);
      else if (n.scope === "document_type" && (!documentType || n.scope_value === documentType)) g.document_type.push(n);
      else if (n.scope === "device_type" && (!deviceType || n.scope_value === deviceType)) g.device_type.push(n);
      else if (n.scope === "project" && n.scope_value === projectId) g.project.push(n);
    }
    return g;
  }, [notes, documentType, deviceType, projectId]);

  const activeCount = notes.filter((n) =>
    n.is_active && (
      n.scope === "global" ||
      (n.scope === "document_type" && n.scope_value === documentType) ||
      (n.scope === "device_type" && n.scope_value === deviceType) ||
      (n.scope === "project" && n.scope_value === projectId)
    )
  ).length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">📚 Notatki dla AI (lessons learned)</h3>
          <p className="text-xs text-slate-500">
            Reguły które AI ma stosować w każdej generacji. Wszystkie aktywne ({activeCount})
            notatki trafiają do system prompta. Dodawaj je gdy zauważysz powtarzający się problem
            — następna generacja go uniknie.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">zamknij</button>
        </div>
      )}

      {loading && <p className="py-4 text-center text-xs text-slate-500">Ładuję notatki...</p>}

      {!loading && (
        <div className="space-y-3">
          {(["global", "document_type", "device_type", "project"] as NoteScope[]).map((scope) => (
            <ScopeSection
              key={scope}
              scope={scope}
              notes={grouped[scope]}
              onAdd={() => setAdding(scope)}
              onToggle={(n) => void toggleActive(n)}
              onUpdate={(id, patch) => void updateNote(id, patch)}
              onRemove={(id) => void remove(id)}
              documentType={documentType}
              deviceType={deviceType}
            />
          ))}
        </div>
      )}

      {adding && (
        <AddNoteModal
          scope={adding}
          defaultDocumentType={documentType ?? null}
          defaultDeviceType={deviceType ?? null}
          projectId={projectId}
          onClose={() => setAdding(null)}
          onCreate={(scope_value, content, why) => void create(adding, scope_value, content, why)}
        />
      )}
    </div>
  );
}

interface ScopeSectionProps {
  scope: NoteScope;
  notes: AiNote[];
  onAdd: () => void;
  onToggle: (n: AiNote) => void;
  onUpdate: (id: string, patch: { content?: string; why?: string | null }) => void;
  onRemove: (id: string) => void;
  documentType?: string | null;
  deviceType?: string | null;
}

function ScopeSection({ scope, notes, onAdd, onToggle, onUpdate, onRemove, documentType, deviceType }: ScopeSectionProps): React.ReactElement {
  const scopeContext =
    scope === "document_type" ? documentType ? ` — ${DOCUMENT_TYPE_LABELS[documentType as keyof typeof DOCUMENT_TYPE_LABELS] ?? documentType}` : " — (wybierz typ dokumentu w wizardzie)"
    : scope === "device_type" ? deviceType ? ` — ${DEVICE_TYPE_LABELS[deviceType as keyof typeof DEVICE_TYPE_LABELS] ?? deviceType}` : " — (wybierz typ urządzenia w wizardzie)"
    : "";

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div>
          <h4 className="text-xs font-semibold text-slate-800">
            {SCOPE_LABELS[scope]}{scopeContext}
            <span className="ml-2 text-slate-400">({notes.length})</span>
          </h4>
          <p className="text-[10px] text-slate-500">{SCOPE_DESCRIPTIONS[scope]}</p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-slate-700"
        >
          + Dodaj
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="py-2 text-center text-[11px] italic text-slate-400">
          Brak notatek w tej kategorii.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              onToggle={() => onToggle(n)}
              onUpdate={(patch) => onUpdate(n.id, patch)}
              onRemove={() => onRemove(n.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteItem({ note, onToggle, onUpdate, onRemove }: {
  note: AiNote;
  onToggle: () => void;
  onUpdate: (patch: { content?: string; why?: string | null }) => void;
  onRemove: () => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(note.content);
  const [why, setWhy] = useState(note.why ?? "");

  const save = () => {
    const patch: { content?: string; why?: string | null } = {};
    if (content.trim() !== note.content) patch.content = content.trim();
    const newWhy = why.trim() || null;
    if (newWhy !== note.why) patch.why = newWhy;
    if (Object.keys(patch).length > 0) onUpdate(patch);
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="rounded border border-purple-300 bg-white p-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          className="mb-1 w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
        />
        <textarea
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          rows={1}
          placeholder="kontekst (opcjonalnie): kiedy/dlaczego dodałem tę regułkę"
          className="w-full rounded border border-slate-300 px-1.5 py-1 text-[10px] text-slate-600"
        />
        <div className="mt-1 flex justify-end gap-1">
          <button type="button" onClick={() => { setContent(note.content); setWhy(note.why ?? ""); setEditing(false); }}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50">
            Anuluj
          </button>
          <button type="button" onClick={save}
            className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-800">
            Zapisz
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={"flex items-start gap-2 rounded border bg-white p-2 " + (note.is_active ? "border-slate-200" : "border-dashed border-slate-300 opacity-60")}>
      <input
        type="checkbox"
        checked={note.is_active}
        onChange={onToggle}
        title={note.is_active ? "Aktywna — AI używa" : "Wyłączona — w archiwum"}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-slate-800">{note.content}</p>
        {note.why && <p className="mt-0.5 text-[10px] italic text-slate-500">↳ {note.why}</p>}
        <p className="mt-0.5 text-[9px] text-slate-400">
          użyto {note.used_count}× · {new Date(note.updated_at).toLocaleDateString("pl-PL")}
        </p>
      </div>
      <div className="flex flex-col gap-0.5">
        <button type="button" onClick={() => setEditing(true)} title="Edytuj"
          className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-100 hover:text-slate-900">✎</button>
        <button type="button" onClick={onRemove} title="Usuń"
          className="rounded px-1 text-[10px] text-slate-400 hover:bg-red-50 hover:text-red-700">×</button>
      </div>
    </li>
  );
}

interface AddNoteModalProps {
  scope: NoteScope;
  defaultDocumentType: string | null;
  defaultDeviceType: string | null;
  projectId: string;
  onClose: () => void;
  onCreate: (scope_value: string | null, content: string, why: string) => void;
}

function AddNoteModal({ scope, defaultDocumentType, defaultDeviceType, projectId, onClose, onCreate }: AddNoteModalProps): React.ReactElement {
  const [content, setContent] = useState("");
  const [why, setWhy] = useState("");
  const [scopeValue, setScopeValue] = useState<string>(
    scope === "document_type" ? defaultDocumentType ?? DOCUMENT_TYPES[0]
    : scope === "device_type" ? defaultDeviceType ?? DEVICE_TYPES[0]
    : scope === "project" ? projectId
    : "",
  );

  const examplesByScope: Record<NoteScope, string[]> = {
    global: [
      "Tekst NIE może wychodzić poza margines 3 mm od krawędzi strony",
      "Liczbę kroków numeruj 'Krok 1:', 'Krok 2:' (z dwukropkiem)",
      "Zawsze używaj polskich znaków diakrytycznych",
    ],
    document_type: [
      "W KG zawsze umieszczaj klauzulę o uprawnieniach konsumenckich z KC art. 579",
      "Dla QSG ogranicz cover do logo + nazwa + wersja — bez dodatkowych grafik",
    ],
    device_type: [
      "Dla zegarków dziecięcych RODO art. 8 (zgoda rodzica) na osobnej stronie",
      "Dla opasek seniorskich z czujnikami zdrowia obowiązkowe zastrzeżenie 'nie jest wyrobem medycznym'",
    ],
    project: [
      "SAR head dla tego modelu = 0,42 W/kg, body = 0,78 W/kg",
      "IMEI startuje od 8642510...",
    ],
  };

  const canSubmit = content.trim().length > 5 && (scope === "global" || scopeValue.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div className="my-12 w-full max-w-xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">
            Nowa notatka dla AI — {SCOPE_LABELS[scope]}
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>

        <div className="space-y-3 p-5 text-sm">
          {scope === "document_type" && (
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Dla typu dokumentu</span>
              <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm">
                {DOCUMENT_TYPES.map((t) => (
                  <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
          )}
          {scope === "device_type" && (
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Dla typu urządzenia</span>
              <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm">
                {DEVICE_TYPES.map((t) => (
                  <option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="text-xs font-medium text-slate-700">Treść regułki *</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              placeholder='np. "Numer wersji zawsze w formacie v1.0 / YYYY (np. v1.0 / 2026)"'
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
            <p className="mt-1 text-[10px] text-slate-500">Krótka regułka po polsku, max 1500 znaków. Trafia bezpośrednio do system prompta.</p>
          </label>

          <details className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
            <summary className="cursor-pointer text-[11px] text-slate-600 hover:text-slate-900">💡 Przykłady dla tej kategorii</summary>
            <ul className="mt-1 space-y-1 px-2 pb-1 text-[11px] text-slate-700">
              {examplesByScope[scope].map((ex, i) => (
                <li key={i}>
                  <button type="button" onClick={() => setContent(ex)} className="text-left hover:underline">
                    → {ex}
                  </button>
                </li>
              ))}
            </ul>
          </details>

          <label className="block">
            <span className="text-xs font-medium text-slate-700">Kontekst (opcjonalnie)</span>
            <textarea
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              rows={1}
              placeholder="np. 'Dodałem po projekcie GJD.16 gdzie AI wymyślił 'wersja 003' co jest niezgodne z naszą konwencją'"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </label>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button type="button" onClick={onClose}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              Anuluj
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => onCreate(scope === "global" ? null : scopeValue, content.trim(), why.trim())}
              className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Dodaj notatkę
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
