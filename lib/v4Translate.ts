/**
 * Helpers for v4 translation workflow.
 *
 * Translation lives outside the elements: each translatable element
 * (text/callout) gets a row in gen4_translations per target language.
 * The default-language text stays in gen4_elements.properties.content.
 *
 * Workflow:
 *   1. Build a prompt that lists all source-language texts with stable IDs.
 *   2. User pastes the prompt into Claude.ai → gets back JSON mapping IDs
 *      to translated text → pastes into the import endpoint.
 *   3. Server upserts gen4_translations rows.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import { loadGlossaryDoNotTranslate, loadProjectDesignSystem } from "@/lib/v4Generate";

export const SUPPORTED_LANGS = ["bg", "hr", "ro", "mk", "sq", "en"] as const;
export type TargetLang = (typeof SUPPORTED_LANGS)[number];

export const LANG_LABELS: Record<TargetLang | "pl", string> = {
  pl: "Polski",
  bg: "Български",
  hr: "Hrvatski",
  ro: "Română",
  mk: "Македонски",
  sq: "Shqip",
  en: "English",
};

interface ElementForTranslation {
  id: string;
  page_number: number;
  text: string;
  context: string; // e.g. "cover" or "step 2"
}

/** Fetches all text-bearing elements (text + callout) for a project, sorted
 *  by page then z_index, returning just the bits the prompt needs. */
export async function listProjectTexts(projectId: string): Promise<ElementForTranslation[]> {
  const sb = getSupabaseAdmin();
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  if (!pages || pages.length === 0) return [];

  const pageIds = pages.map((p) => p.id);
  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, page_id, type, z_index, properties")
    .in("page_id", pageIds)
    .in("type", ["text", "callout"])
    .order("z_index", { ascending: true });
  if (!elements) return [];

  const pageById = new Map(pages.map((p) => [p.id, p]));
  const out: ElementForTranslation[] = [];
  for (const el of elements) {
    const page = pageById.get(el.page_id);
    if (!page) continue;
    const props = el.properties as Record<string, unknown>;
    const content = typeof props?.content === "string" ? props.content.trim() : "";
    if (!content) continue;
    out.push({
      id: el.id,
      page_number: page.page_number,
      text: content,
      context: page.template ?? "blank",
    });
  }
  return out;
}

export async function buildTranslationPrompt(
  projectId: string,
  targetLang: TargetLang,
): Promise<{ system: string; user: string; combined: string; itemCount: number }> {
  const doNotTranslate = await loadGlossaryDoNotTranslate();
  const items = await listProjectTexts(projectId);
  const targetName = LANG_LABELS[targetLang];

  // Pull design_system → brand_voice (tone/style guidance for translator).
  const designSystem = await loadProjectDesignSystem(projectId);
  const brandVoice =
    designSystem && typeof designSystem === "object" && "brand_voice" in designSystem
      ? (designSystem as { brand_voice?: Record<string, unknown> }).brand_voice
      : null;

  const system = [
    `Jesteś tłumaczem instrukcji obsługi z polskiego na ${targetName} (${targetLang.toUpperCase()}).`,
    "Tłumaczysz fragmenty tekstu z drukowanej instrukcji smartwatcha marki Locon.",
    ...(brandVoice
      ? [
          "",
          "BRAND VOICE (z design systemu projektu):",
          "```json",
          JSON.stringify(brandVoice, null, 2),
          "```",
        ]
      : []),
    "",
    "Zasady:",
    "- Tłumacz dokładnie i naturalnie, w stylu instrukcji obsługi (zwięźle, konkretnie).",
    `- Używaj poprawnych znaków diakrytycznych języka ${targetName}.`,
    "- Zachowaj długość zbliżoną do oryginału (instrukcja jest drukowana w 76x76 mm).",
    "- NIE TŁUMACZ poniższych terminów (zostaw dosłownie):",
    doNotTranslate.map((t) => `  - ${t}`).join("\n"),
    "- Nie tłumacz: adresów URL, kodów modeli (GJD.XX), nazwy firmy 'Locon Sp. z o.o.',",
    "  numeru VAT EU PL8521013334.",
    "",
    "Format odpowiedzi:",
    `ZAPISZ wynik jako ARTEFAKT (artifact) typu \`application/json\` o nazwie`,
    `\`tlumaczenie-${targetLang}.json\`.`,
    "Treść artefaktu — wyłącznie poprawny JSON wg schematu:",
    "{",
    '  "translations": {',
    '    "<element_id>": "<tłumaczenie>",',
    '    "<element_id>": "<tłumaczenie>"',
    "  }",
    "}",
    "Klucze (element_id) skopiuj 1:1 z wejściowej listy. Wartości - tylko przetłumaczony tekst",
    "(bez numeracji, bez oryginału, bez komentarzy).",
  ].join("\n");

  const userLines: string[] = [
    `Przetłumacz poniższe fragmenty z polskiego na ${targetName}.`,
    "Każdy fragment to wartość JSON-owego klucza element_id - zachowaj ten klucz w odpowiedzi.",
    "",
    "Lista do przetłumaczenia:",
    "",
  ];
  for (const it of items) {
    userLines.push(`element_id: ${it.id}`);
    userLines.push(`(strona ${it.page_number}, ${it.context})`);
    userLines.push(`PL: ${JSON.stringify(it.text)}`);
    userLines.push("");
  }

  const user = userLines.join("\n");
  const combined = [
    "# SYSTEM (kontekst dla Claude)",
    "",
    system,
    "",
    "# UŻYTKOWNIK (zadanie)",
    "",
    user,
  ].join("\n");

  return { system, user, combined, itemCount: items.length };
}

/** Parses raw JSON pasted by the user, accepting either { translations: {...} }
 *  or a flat { id: text } object. Auto-handles ```json fences (delegates to
 *  parseJsonFromAi). Returns a map element_id → text. */
export function parseTranslationResponse(raw: string): Map<string, string> {
  // Reuse the lenient JSON parser from v4Generate (handles fences + raw newlines).
  // Inline to avoid circular import — same approach.
  let trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) trimmed = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try escaping control chars in strings and retry — same trick as v4Generate.
    let inString = false;
    let escapeNext = false;
    let out = "";
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escapeNext) { out += ch; escapeNext = false; continue; }
      if (inString && ch === "\\") { out += ch; escapeNext = true; continue; }
      if (ch === '"') { inString = !inString; out += ch; continue; }
      if (inString) {
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
        const code = ch.charCodeAt(0);
        if (code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
      }
      out += ch;
    }
    parsed = JSON.parse(out);
  }

  const dict =
    parsed && typeof parsed === "object" && "translations" in parsed
      ? (parsed as { translations: Record<string, unknown> }).translations
      : (parsed as Record<string, unknown>);
  if (!dict || typeof dict !== "object") {
    throw new Error("response missing 'translations' object");
  }

  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === "string" && v.trim()) {
      out.set(k, v);
    }
  }
  return out;
}
