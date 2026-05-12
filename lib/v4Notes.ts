/**
 * AI Notebook — lessons learned które AI ma stosować w każdej generacji.
 *
 * Notatki są wpinane do system prompta wszystkich workflow-ów (skeleton,
 * auto-populate, ai-edit, apply-design). Filtrujemy je per scope, żeby
 * np. globalna reguła "BEZWZGLĘDNIE używaj polskich diakrytyków" była zawsze,
 * a "Dla zegarków dziecięcych zawsze RODO art. 8 na osobnej stronie" tylko
 * gdy device_type=watch_kid.
 *
 * Po wywołaniu AI wywołujemy incrementUsedCount(noteIds) — żeby najczęściej
 * używane notatki były na górze listy w UI.
 */

import { getSupabaseAdmin } from "@/lib/supabase";

export type NoteScope = "global" | "document_type" | "device_type" | "project";

export interface AiNote {
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

/** Filter używany przy injection do prompta. Brak project_id → tylko globalne
 *  i scoped do document/device. */
export interface NoteContext {
  owner_email: string;
  document_type?: string | null;
  device_type?: string | null;
  project_id?: string | null;
}

/** Zwraca aktywne notatki które pasują do podanego kontekstu. Sortowane po
 *  used_count desc — najpopularniejsze najpierw. Cap 50 by nie zalewać prompta. */
export async function loadActiveNotes(ctx: NoteContext): Promise<AiNote[]> {
  const sb = getSupabaseAdmin();
  // Pojedynczy zapytanie z OR-em na 4 scope-y. PostgREST `or()` syntax.
  const orParts: string[] = ['scope.eq.global'];
  if (ctx.document_type) {
    orParts.push(`and(scope.eq.document_type,scope_value.eq.${ctx.document_type})`);
  }
  if (ctx.device_type) {
    orParts.push(`and(scope.eq.device_type,scope_value.eq.${ctx.device_type})`);
  }
  if (ctx.project_id) {
    orParts.push(`and(scope.eq.project,scope_value.eq.${ctx.project_id})`);
  }
  const { data } = await sb
    .from("gen4_ai_notes")
    .select("id, scope, scope_value, content, why, is_active, used_count, created_at, updated_at")
    .eq("owner_email", ctx.owner_email)
    .eq("is_active", true)
    .or(orParts.join(","))
    .order("used_count", { ascending: false })
    .limit(50);
  return (data ?? []) as AiNote[];
}

/** Renderuje notatki do bloku tekstowego wpinanego do system prompta. */
export function renderNotesForPrompt(notes: AiNote[]): string {
  if (notes.length === 0) return "";
  const lines: string[] = [
    "📚 NOTATKI / LESSONS LEARNED (BEZWZGLĘDNIE stosuj poniższe reguły):",
    "Te notatki pochodzą z poprzednich projektów. Każda została dodana przez",
    "użytkownika po zauważeniu konkretnego problemu lub utrwaleniu dobrego wzorca.",
    "Złamanie którejkolwiek = wprowadzenie regresji jakości.",
    "",
  ];
  for (const n of notes) {
    const scopeLabel =
      n.scope === "global" ? "[GLOBAL]"
      : n.scope === "document_type" ? `[DOC:${n.scope_value}]`
      : n.scope === "device_type" ? `[DEV:${n.scope_value}]`
      : "[PROJEKT]";
    lines.push(`- ${scopeLabel} ${n.content}`);
    if (n.why) lines.push(`    (kontekst: ${n.why})`);
  }
  return lines.join("\n");
}

/** Inkrement licznika użycia — wywoływane po sukcesie generacji. Fire-and-forget,
 *  nie blokuje response. */
export async function incrementUsedCount(noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  const sb = getSupabaseAdmin();
  // PostgREST nie ma atomic increment per row bez RPC, więc bulk select + update.
  // Dla małych count (< 50) to akceptowalne.
  const { data } = await sb
    .from("gen4_ai_notes")
    .select("id, used_count")
    .in("id", noteIds);
  if (!data) return;
  for (const row of data) {
    await sb
      .from("gen4_ai_notes")
      .update({ used_count: (row.used_count ?? 0) + 1 })
      .eq("id", row.id);
  }
}
