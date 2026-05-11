/**
 * Shared logic for v4 (AI-first) project generation:
 * - Building the system + user prompts (deterministic from input)
 * - Validating the AI/imported JSON shape
 * - Bulk-inserting pages + elements into the gen4_* tables
 *
 * Lives in lib/ so both `generate` (auto) and `import` (manual) routes can
 * share it. Server-only — uses the Supabase admin client.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  type DocumentType,
  type DeviceType,
  DOCUMENT_TYPE_LABELS,
  DEVICE_TYPE_LABELS,
  renderRequirementsForPrompt,
} from "@/lib/v4LegalTemplates";

export interface GenerationInput {
  name: string;
  model_code: string;
  model_name: string;
  features: Array<{ key: string; label: string; enabled: boolean }>;
  step_count: number;
  /** @deprecated — wynika teraz z document_type. Zostawione, bo starsze projekty mają je w ai_input. */
  warranty_mode: "full" | "short" | "none";
  page_size_mm: { width: number; height: number };
  /** Typ tworzonego dokumentu (QSG, KG, pełna instrukcja). Determinuje listę wymaganych sekcji. */
  document_type: DocumentType;
  /** Typ urządzenia — wpływa na sekcje device-specific (RODO dziecka, zastrzeżenia medyczne, IP rating). */
  device_type: DeviceType;
}

export interface GeneratedProject {
  pages: Array<{
    template: string;
    page_number: number;
    width_mm: number;
    height_mm: number;
    title: string | null;
    elements: Array<{
      type: string;
      x_mm: number;
      y_mm: number;
      w_mm: number;
      h_mm: number;
      z_index?: number;
      properties: Record<string, unknown>;
    }>;
  }>;
}

const VALID_TEMPLATES = new Set([
  "blank", "cover", "toc", "step", "warranty_terms", "warranty_stamp", "contact",
]);
const VALID_TYPES = new Set([
  "text", "image", "line", "rect", "qr", "page_number", "callout",
]);

export async function loadGlossaryDoNotTranslate(): Promise<string[]> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("gen3_glossary")
    .select("source_term")
    .eq("do_not_translate", true);
  return (data ?? []).map((g) => g.source_term);
}

/** Returns the project's active design system: default row from
 *  gen4_design_systems if any, otherwise the legacy gen4_projects.design_system
 *  column, otherwise null. */
export async function loadProjectDesignSystem(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const sb = getSupabaseAdmin();
  // 1) Default row in the new table.
  const { data: defaultDs } = await sb
    .from("gen4_design_systems")
    .select("content")
    .eq("project_id", projectId)
    .eq("is_default", true)
    .maybeSingle();
  if (defaultDs?.content && typeof defaultDs.content === "object") {
    return defaultDs.content as Record<string, unknown>;
  }
  // 2) Legacy column.
  const { data: proj } = await sb
    .from("gen4_projects")
    .select("design_system")
    .eq("id", projectId)
    .single();
  return (proj?.design_system as Record<string, unknown> | null) ?? null;
}

export interface DocumentScope {
  document_type: DocumentType;
  device_type: DeviceType;
}

export function buildSystemPrompt(
  doNotTranslate: string[],
  designSystem?: Record<string, unknown> | null,
  scope?: DocumentScope | null,
): string {
  const requirements = scope
    ? renderRequirementsForPrompt(scope.document_type, scope.device_type)
    : null;
  return [
    "Jesteś asystentem generującym strukturalne instrukcje obsługi (QSG + Karta Gwarancyjna)",
    "dla urządzeń marki Locon (Bezpieczna Rodzina). Każda instrukcja jest drukowana",
    "w formacie 76×76 mm, w skali szarości, na cienkim papierze.",
    ...(designSystem
      ? [
          "",
          "DESIGN SYSTEM (priorytet — używaj poniższych tokenów spójnie):",
          "```json",
          JSON.stringify(designSystem, null, 2),
          "```",
          "Trzymaj się kolorów, czcionek, spacing i guidelines z design systemu.",
          "Jeśli design system nie określa czegoś, korzystaj z zasad poniżej.",
        ]
      : []),
    "",
    "Zasady językowe:",
    "- Język bazowy generacji: POLSKI. Zwracaj treść tylko po polsku.",
    "- BEZWZGLĘDNIE używaj poprawnych polskich znaków diakrytycznych:",
    "  ą ć ę ł ń ó ś ź ż / Ą Ć Ę Ł Ń Ó Ś Ź Ż.",
    '  Pisz \'Skrócona instrukcja obsługi\' - NIE \'Skrocona instrukcja obslugi\'.',
    '  Pisz \'Włóż\', \'Naładuj\', \'Załóż konto\' - NIE \'Wloz\', \'Naladuj\', \'Zaloz\'.',
    "  W odpowiedzi JSON używaj surowych znaków UTF-8, nie sekwencji \\uXXXX.",
    "- NIE TŁUMACZ ani nie zmieniaj poniższych terminów (zostawiaj dosłownie):",
    doNotTranslate.map((t) => `  - ${t}`).join("\n"),
    "- Nie tłumacz adresów URL, kodów modeli (GJD.XX), nazwy firmy Locon Sp. z o.o.",
    "",
    "Zasady layoutu:",
    "- Strona ma marginesy ~3 mm od każdej krawędzi.",
    "- Czcionki w punktach (pt). Nagłówki: 11-14pt, body: 6-8pt, podpisy: 4-5pt.",
    "- Kolory grayscale: tekst #0f172a, accent #475569, jasny #94a3b8.",
    "- Numeracja stron: zawsze element typu page_number z formatem '{LANG} {n}/{N}'",
    "  w prawym dolnym rogu każdej strony, font 4-5pt.",
    "",
    "Tytuły stron i spis treści (BEZWZGLĘDNIE):",
    "- Każda strona musi mieć pole `title` (krótki nagłówek strony, max ~40 znaków).",
    "- Wyjątek: strona z `template: cover` ma `title: null` (okładka nie potrzebuje tytułu).",
    "- DRUGA strona w dokumencie (zaraz po cover) MUSI być template `toc` ze",
    "  `title: 'Spis treści'`. Wygeneruj jej elementy jako numerowaną listę",
    "  pozostałych stron z ich tytułami i numerami (np. `2. Pierwsze uruchomienie ........ 3`).",
    "  Spis treści NIE wymienia samego siebie ani okładki.",
    "- Pole `title` MUSI też pojawić się jako widoczny nagłówek strony w `elements`",
    "  (zwykle text na górze strony, font 11-14pt). W ten sposób edytor może bocznym",
    "  panelem nawigacji pokazać tytuł identyczny z tym na wydruku.",
    "",
    "Format odpowiedzi:",
    "ZAPISZ wynik jako ARTEFAKT (artifact) typu `application/json` o nazwie",
    "`instrukcja.json` — dzięki temu użytkownik może go skopiować lub pobrać",
    "jednym kliknięciem zamiast zaznaczać tekst w oknie czatu.",
    "W treści artefaktu umieść WYŁĄCZNIE poprawny JSON (bez komentarzy, bez ``` fence)",
    "zgodnie ze schematem:",
    "{",
    "  \"pages\": [",
    "    {",
    "      \"template\": \"cover|toc|step|warranty_terms|warranty_stamp|contact|blank\",",
    "      \"page_number\": 1,",
    "      \"width_mm\": 76,",
    "      \"height_mm\": 76,",
    "      \"title\": \"Pierwsze uruchomienie\",   // null tylko dla cover",
    "      \"elements\": [",
    "        {",
    "          \"type\": \"text|image|line|rect|qr|page_number|callout\",",
    "          \"x_mm\": 5, \"y_mm\": 8, \"w_mm\": 66, \"h_mm\": 8,",
    "          \"z_index\": 0,",
    "          \"properties\": {",
    "            // text/callout: { content, font_size_pt, color, align: 'left|center|right' }",
    "            // line/rect:    { stroke_width, color, fill (rect only) }",
    "            // qr:           { url }",
    "            // page_number:  { format: '{LANG} {n}/{N}', font_size_pt }",
    "            // image:        { image_id, fit_mode } (image_id null — biblioteka pusta)",
    "          }",
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "",
    ...(requirements
      ? [requirements]
      : [
          "Struktura instrukcji (kolejność stron — sztywna):",
          "1. Cover (template=cover, title=null) — logo Bezpieczna Rodzina, model name + code,",
          "   podtytuł, wersja 003.",
          "2. Spis treści (template=toc, title='Spis treści') — lista pozostałych stron",
          "   z numerami (np. text element z treścią 'Pierwsze uruchomienie .... 3').",
          "3-N. Step — kolejne kroki uruchomienia (zgodnie z step_count z inputu),",
          "     każdy z własnym `title` (np. 'Naładuj zegarek', 'Włóż kartę SIM',",
          "     'Załóż konto w aplikacji').",
          "Następnie: warranty_terms (title='Warunki gwarancji', jeśli warranty_mode=full|short),",
          "warranty_stamp (title='Karta gwarancyjna'), contact (title='Kontakt').",
        ]),
    "",
    "Każdy element musi mieścić się w obszarze strony (uwzględnij marginesy).",
    "Bądź zwięzły i konkretny w treści — to drukowana instrukcja, nie marketing.",
    "Brakujące dane konkretne (numery, wartości techniczne, normy, IMEI, NIP) zostaw",
    "jako widoczne placeholdery — NIE WYMYŚLAJ ich. Lepiej '⚠️ DO UZUPEŁNIENIA: ...'",
    "niż błędna liczba która trafi do druku.",
  ].join("\n");
}

export function buildUserPrompt(input: GenerationInput): string {
  const features = input.features.filter((f) => f.enabled).map((f) => `- ${f.label}`).join("\n");
  const lines: string[] = [];
  if (input.document_type && input.device_type) {
    lines.push(`Wygeneruj dokument typu: ${DOCUMENT_TYPE_LABELS[input.document_type]}`);
    lines.push(`Dla urządzenia: ${DEVICE_TYPE_LABELS[input.device_type]}`);
  } else {
    lines.push("Wygeneruj instrukcję obsługi dla urządzenia:");
  }
  lines.push("");
  lines.push(`Nazwa: ${input.model_name}`);
  lines.push(`Kod modelu: ${input.model_code}`);
  lines.push(`Funkcje:`);
  lines.push(features || "- (brak)");
  lines.push("");
  lines.push(`Liczba kroków uruchomienia (orientacyjnie): ${input.step_count}`);
  lines.push(`Format strony: ${input.page_size_mm.width}×${input.page_size_mm.height} mm`);
  lines.push("");
  lines.push("Zwróć kompletny JSON ze strukturą wszystkich stron i elementów,");
  lines.push("zgodnie z listą wymaganych sekcji w prompcie systemowym (jeśli została podana —");
  lines.push("kolejność i tytuły są wiążące).");
  return lines.join("\n");
}

/** Soft-validate a parsed JSON tree as a GeneratedProject. Coerces missing
 *  fields to defaults, drops unknown element types — never throws on a
 *  semantically valid input. Caller should still try/catch JSON.parse. */
export function validateGenerated(data: unknown): GeneratedProject {
  if (!data || typeof data !== "object" || !("pages" in data)) {
    throw new Error("response missing 'pages' field");
  }
  const pages = (data as { pages: unknown }).pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("'pages' must be a non-empty array");
  }
  const out: GeneratedProject = { pages: [] };
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i] as Record<string, unknown>;
    const template =
      typeof p.template === "string" && VALID_TEMPLATES.has(p.template) ? p.template : "blank";
    // Cover: title forced to null. Other pages: take whatever the AI sent;
    // null is allowed (importer doesn't reject it — sidebar shows fallback).
    let title: string | null = null;
    if (template !== "cover") {
      if (typeof p.title === "string" && p.title.trim()) {
        title = p.title.trim();
      }
    }
    const page = {
      template,
      page_number: typeof p.page_number === "number" ? p.page_number : i + 1,
      width_mm: typeof p.width_mm === "number" ? p.width_mm : 76,
      height_mm: typeof p.height_mm === "number" ? p.height_mm : 76,
      title,
      elements: [] as GeneratedProject["pages"][number]["elements"],
    };
    const elements = Array.isArray(p.elements) ? p.elements : [];
    for (const e of elements) {
      const el = e as Record<string, unknown>;
      if (!VALID_TYPES.has(String(el.type))) continue;
      page.elements.push({
        type: String(el.type),
        x_mm: typeof el.x_mm === "number" ? el.x_mm : 0,
        y_mm: typeof el.y_mm === "number" ? el.y_mm : 0,
        w_mm: typeof el.w_mm === "number" ? el.w_mm : 10,
        h_mm: typeof el.h_mm === "number" ? el.h_mm : 5,
        z_index: typeof el.z_index === "number" ? el.z_index : 0,
        properties: (el.properties && typeof el.properties === "object")
          ? (el.properties as Record<string, unknown>)
          : {},
      });
    }
    out.pages.push(page);
  }
  return out;
}

/** Bulk-insert pages + elements for a project. All elements get origin='ai'.
 *  Pages are looked up by page_number after insert so we can map elements. */
export async function bulkInsertGeneratedProject(
  projectId: string,
  parsed: GeneratedProject,
): Promise<{ pages: number; elements: number }> {
  const sb = getSupabaseAdmin();

  const pageRows = parsed.pages.map((p) => ({
    project_id: projectId,
    page_number: p.page_number,
    width_mm: p.width_mm,
    height_mm: p.height_mm,
    template: p.template,
    title: p.title,
  }));

  const { data: insertedPages, error: pagesErr } = await sb
    .from("gen4_pages")
    .insert(pageRows)
    .select("id, page_number");
  if (pagesErr || !insertedPages) {
    throw new Error(pagesErr?.message ?? "pages insert failed");
  }
  const pageIdByNumber = new Map<number, string>();
  for (const row of insertedPages) pageIdByNumber.set(row.page_number, row.id);

  const elementRows: Array<Record<string, unknown>> = [];
  for (const p of parsed.pages) {
    const pageId = pageIdByNumber.get(p.page_number);
    if (!pageId) continue;
    p.elements.forEach((el, idx) => {
      elementRows.push({
        page_id: pageId,
        type: el.type,
        x_mm: el.x_mm,
        y_mm: el.y_mm,
        w_mm: el.w_mm,
        h_mm: el.h_mm,
        z_index: el.z_index ?? idx,
        properties: el.properties,
        origin: "ai",
      });
    });
  }

  if (elementRows.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < elementRows.length; i += CHUNK) {
      const slice = elementRows.slice(i, i + CHUNK);
      const { error } = await sb.from("gen4_elements").insert(slice);
      if (error) throw new Error(error.message);
    }
  }

  return { pages: parsed.pages.length, elements: elementRows.length };
}

/** Strips an optional ```json ... ``` fence and JSON.parse. Tolerates raw
 *  control characters inside string literals (a common artefact when copying
 *  multi-line LLM output through terminals / markdown viewers — they leave
 *  literal newlines inside what should be \\n-escaped). */
export function parseJsonFromAi<T = unknown>(text: string): T {
  let trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) trimmed = fenceMatch[1].trim();

  // First attempt: strict parse.
  try {
    return JSON.parse(trimmed) as T;
  } catch (errStrict) {
    // Second attempt: auto-escape raw control chars inside strings, then retry.
    const sanitized = escapeControlCharsInStrings(trimmed);
    try {
      return JSON.parse(sanitized) as T;
    } catch (errLenient) {
      const preview = trimmed.slice(0, 400);
      const msg = errLenient instanceof Error ? errLenient.message : "?";
      const original = errStrict instanceof Error ? errStrict.message : "?";
      throw new Error(
        `failed to parse JSON: ${msg} (original strict error: ${original})\nPreview: ${preview}`,
      );
    }
  }
}

/** Walks the input one char at a time, tracking whether we're inside a
 *  string literal, and replaces raw control characters (newlines, tabs,
 *  carriage returns, other 0x00-0x1F) with their JSON-escaped form. Outside
 *  of strings the input is preserved verbatim, so syntactic whitespace is
 *  untouched. */
function escapeControlCharsInStrings(raw: string): string {
  let out = "";
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }
    if (inString && ch === "\\") {
      out += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
    }
    out += ch;
  }
  return out;
}
