/**
 * Pliki referencyjne projektu — wpinane jako PDF attachments w wywołaniach AI
 * (skeleton, auto-populate, ai-edit, apply-design). AI czyta zawartość PDF
 * bezpośrednio i wyciąga konkretne wartości techniczne zamiast wstawiać
 * placeholdery DO UZUPEŁNIENIA.
 */

import { getSupabaseAdmin } from "@/lib/supabase";

export interface ReferenceDoc {
  id: string;
  kind: string;
  name: string;
  source_lang: string | null;
  anthropic_file_id: string | null;
  extracted_summary: string | null;
}

const KIND_LABELS: Record<string, string> = {
  sar_report: "Raport SAR (wartości head/body, normy pomiaru)",
  tech_spec: "Specyfikacja techniczna (parametry, częstotliwości, IP, bateria)",
  manufacturer_manual: "Instrukcja od producenta",
  declaration_ce: "Deklaracja zgodności CE",
  other: "Inny dokument",
};

/** Lista plików referencyjnych projektu które już mają anthropic_file_id —
 *  gotowe do wpięcia jako attachments. Pomijamy pliki bez sync (np. uploadowane
 *  zanim klucz API był skonfigurowany). */
export async function loadReferenceDocs(projectId: string): Promise<ReferenceDoc[]> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("gen4_reference_docs")
    .select("id, kind, name, source_lang, anthropic_file_id, extracted_summary")
    .eq("project_id", projectId)
    .not("anthropic_file_id", "is", null)
    .order("created_at", { ascending: true });
  return (data ?? []) as ReferenceDoc[];
}

/** Renderuje sekcję promptu o plikach referencyjnych — krótki opis każdego
 *  pliku z jego streszczeniem, żeby Claude wiedział czego się spodziewać
 *  zanim zacznie czytać PDF. */
export function renderReferenceDocsForPrompt(docs: ReferenceDoc[]): string {
  if (docs.length === 0) return "";
  const lines: string[] = [
    "📎 PLIKI REFERENCYJNE PROJEKTU:",
    "Załączone PDF-y zawierają konkretne dane techniczne dla tego modelu.",
    "Używaj ich JAKO ŹRÓDŁA wartości w generowanym dokumencie — wyciągaj liczby,",
    "normy, częstotliwości, IP rating, wartości SAR head/body, datę badania itd.",
    "Zamiast wstawiać placeholder '⚠️ DO UZUPEŁNIENIA: wartość SAR' — wpisz",
    "konkretną liczbę którą widzisz w załączonym raporcie.",
    "",
    "Lista plików:",
  ];
  for (const d of docs) {
    lines.push(`- ${d.name} (${KIND_LABELS[d.kind] ?? d.kind}, język: ${d.source_lang ?? "pl"})`);
    if (d.extracted_summary) {
      lines.push(`    streszczenie: ${d.extracted_summary}`);
    }
  }
  lines.push("");
  lines.push("Jeśli plik jest w innym języku niż polski (np. chiński, angielski) —");
  lines.push("PRZETŁUMACZ wyciągnięte wartości i wpisz po polsku.");
  return lines.join("\n");
}

/** Zwraca tablicę anthropic_file_id do przekazania jako attachments do callClaude. */
export function getAttachmentFileIds(docs: ReferenceDoc[]): string[] {
  return docs.map((d) => d.anthropic_file_id).filter((id): id is string => !!id);
}
