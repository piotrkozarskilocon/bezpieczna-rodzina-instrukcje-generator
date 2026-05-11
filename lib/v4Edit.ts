/**
 * Per-page editing helpers for v4.
 *
 * The Assistant AI side panel inside the editor lets the user describe an
 * instruction for the current page (e.g. "make the cover more elegant",
 * "add a FAQ section", "tighten the spacing"). We:
 *   1. Build a prompt with the current state of that single page +
 *      user instruction + glossary.
 *   2. User runs it in Claude.ai, gets back a fresh elements array, pastes
 *      it into the import textarea.
 *   3. We replace the page's elements wholesale (delete + insert).
 *
 * Single-page scope keeps the prompt small and the round-trip fast — and
 * avoids the user having to deal with whole-document JSON for a tweak.
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  loadGlossaryDoNotTranslate,
  loadProjectDesignSystem,
  loadProjectImages,
  renderImagesForPrompt,
  parseJsonFromAi,
} from "@/lib/v4Generate";

const VALID_TYPES = new Set([
  "text", "image", "line", "rect", "qr", "page_number", "callout",
]);

interface PageRow {
  id: string;
  project_id: string;
  page_number: number;
  template: string | null;
  title: string | null;
  width_mm: number;
  height_mm: number;
}

interface ElementRow {
  id: string;
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  z_index: number;
  rotation_deg: number;
  properties: Record<string, unknown>;
}

export async function loadPageWithElements(
  pageId: string,
): Promise<{ page: PageRow; elements: ElementRow[] } | null> {
  const sb = getSupabaseAdmin();
  const { data: page } = await sb
    .from("gen4_pages")
    .select("id, project_id, page_number, template, title, width_mm, height_mm")
    .eq("id", pageId)
    .single();
  if (!page) return null;
  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .eq("page_id", pageId)
    .order("z_index", { ascending: true });
  return {
    page: page as PageRow,
    elements: (elements ?? []) as ElementRow[],
  };
}

export async function ownPage(pageId: string, email: string): Promise<boolean> {
  const sb = getSupabaseAdmin();
  const { data: page } = await sb
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  if (!page) return false;
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", page.project_id)
    .single();
  return project?.owner_email === email;
}

export async function buildPageEditPrompt(
  pageId: string,
  instruction: string,
): Promise<{ system: string; user: string; combined: string; elementCount: number } | null> {
  const data = await loadPageWithElements(pageId);
  if (!data) return null;
  const { page, elements } = data;
  const doNotTranslate = await loadGlossaryDoNotTranslate();

  // Pull the project's active design system (default row from gen4_design_systems,
  // else the legacy column).
  const designSystem = await loadProjectDesignSystem(page.project_id);

  // Lista obrazków projektu — AI dostaje katalog z opisami i może wstawiać
  // image elements z prawdziwymi image_id.
  const projectImages = await loadProjectImages(page.project_id);

  // Model docelowy — wyciągany z ai_input projektu, żeby AI nie mieszał
  // wcześniejszych modeli z biblioteki promptów.
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("ai_input")
    .eq("id", page.project_id)
    .single();
  const aiInput = (project?.ai_input ?? {}) as Record<string, unknown>;
  const modelName = typeof aiInput.model_name === "string" ? aiInput.model_name : null;
  const modelCode = typeof aiInput.model_code === "string" ? aiInput.model_code : null;

  const system = [
    "Jesteś asystentem AI do edycji POJEDYNCZEJ strony drukowanej instrukcji obsługi",
    "smartwatcha marki Locon. Strona ma format 76x76 mm, druk w skali szarości,",
    "na cienkim papierze.",
    ...(designSystem
      ? [
          "",
          "DESIGN SYSTEM (priorytet — używaj poniższych tokenów spójnie):",
          "```json",
          JSON.stringify(designSystem, null, 2),
          "```",
          "Trzymaj się kolorów, czcionek, spacing i guidelines z design systemu.",
        ]
      : []),
    "",
    "Otrzymujesz: aktualny stan strony (lista elementów) i polecenie uzytkownika.",
    "Zwróć: KOMPLETNĄ nową listę elementów dla tej strony - cały bieżący stan zostanie",
    "zastąpiony Twoją odpowiedzią. Możesz dodawać, usuwać, zmieniać dowolne elementy,",
    "byle wynik realizował polecenie użytkownika i mieścił się na stronie.",
    "",
    ...(modelName && modelCode
      ? [
          "JEDEN MODEL — RYGOR (BEZWZGLĘDNIE):",
          `Cały dokument jest dla DOKŁADNIE JEDNEGO modelu: ${modelName} (${modelCode}).`,
          "NIE wymieniaj w treści innych modeli, kodów ani wariantów (np. nie pisz",
          "'GJD.15 / GJD.16'). Jeśli usuwasz/poprawiasz istniejący element, w którym",
          "wcześniej AI wpisał wiele modeli — zostaw TYLKO ten jeden.",
        ]
      : []),
    "",
    "Zasady językowe (gdy generujesz teksty po polsku):",
    "- BEZWZGLĘDNIE używaj polskich znaków diakrytycznych (ą ć ę ł ń ó ś ź ż).",
    "- Surowy UTF-8 w JSON, nie sekwencje \\uXXXX.",
    "- NIE TŁUMACZ ani nie zmieniaj poniższych terminów:",
    doNotTranslate.map((t) => `  - ${t}`).join("\n"),
    "- Nie tłumacz adresów URL, kodów modeli (GJD.XX), nazwy firmy Locon Sp. z o.o.",
    "",
    "Zasady layoutu:",
    "- Marginesy strony ~3 mm od każdej krawędzi.",
    "- Czcionki w pt: nagłówki 11-14, body 6-8, podpisy 4-5.",
    "- Kolory grayscale: tekst #0f172a, accent #475569, jasny #94a3b8.",
    "- Zawsze zachowaj element page_number (jeśli był - zostaw lub odbuduj).",
    "",
    "Schemat elementu:",
    "{",
    '  "type": "text|image|line|rect|qr|page_number|callout",',
    '  "x_mm": 5, "y_mm": 8, "w_mm": 66, "h_mm": 8,',
    '  "z_index": 1,',
    '  "rotation_deg": 0,',
    '  "properties": {',
    '    // text/callout: { content, font_size_pt, color, align: "left|center|right" }',
    '    // line/rect:    { stroke_width, color, fill (rect only) }',
    '    // qr:           { url }',
    '    // page_number:  { format: "{LANG} {n}/{N}", font_size_pt }',
    '    // image:        { image_id, fit_mode } — image_id MUSI pochodzić z listy poniżej',
    "  }",
    "}",
    "",
    renderImagesForPrompt(projectImages, page.page_number),
    "",
    "Format odpowiedzi:",
    "ZAPISZ wynik jako ARTEFAKT (artifact) typu `application/json` o nazwie",
    `\`strona-${page.page_number}.json\` zawierający WYŁĄCZNIE poprawny JSON wg schematu:`,
    "{",
    '  "elements": [',
    "    { ...element1... },",
    "    { ...element2... }",
    "  ]",
    "}",
    "Bez komentarzy, bez ``` fence.",
  ].join("\n");

  const titleLine =
    page.template === "cover"
      ? "Tytuł strony: (brak — to okładka)."
      : `Tytuł strony: ${page.title ? `"${page.title}"` : "(jeszcze nieustalony)"}.`;
  const userLines: string[] = [
    `Strona numer ${page.page_number} (template: ${page.template ?? "blank"}, format ${page.width_mm}x${page.height_mm} mm).`,
    titleLine,
    "Tytuł powinien też pojawić się jako widoczny nagłówek w elementach (text na górze strony, font 11-14pt) — pomóż użytkownikowi widzieć ten sam tytuł w edytorze i na wydruku.",
    "",
    `Liczba elementów obecnie: ${elements.length}.`,
    "",
    "Aktualny stan strony (JSON):",
    "```json",
    JSON.stringify(
      {
        elements: elements.map((e) => ({
          type: e.type,
          x_mm: e.x_mm,
          y_mm: e.y_mm,
          w_mm: e.w_mm,
          h_mm: e.h_mm,
          z_index: e.z_index,
          rotation_deg: e.rotation_deg,
          properties: e.properties,
        })),
      },
      null,
      2,
    ),
    "```",
    "",
    "Polecenie użytkownika:",
    instruction,
    "",
    "Zwróć kompletną nową listę elementów dla tej strony.",
  ];

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

  return { system, user, combined, elementCount: elements.length };
}

interface ParsedElements {
  elements: Array<{
    type: string;
    x_mm: number;
    y_mm: number;
    w_mm: number;
    h_mm: number;
    z_index?: number;
    rotation_deg?: number;
    properties: Record<string, unknown>;
  }>;
}

/** Lenient JSON parse — deleguje do parseJsonFromAi z v4Generate (4-poziomowy
 *  fallback: strict → fence-strip → control-char-escape → bracket-extract). */
export function parsePageEditResponse(raw: string): ParsedElements {
  const parsed = parseJsonFromAi<unknown>(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("response is not an object");
  }
  // Accept either { elements: [...] } or a bare array.
  const list = Array.isArray((parsed as { elements?: unknown }).elements)
    ? (parsed as { elements: unknown[] }).elements
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : null;
  if (!list) throw new Error("missing 'elements' array");

  const out: ParsedElements = { elements: [] };
  for (let i = 0; i < list.length; i++) {
    const el = list[i] as Record<string, unknown>;
    if (!VALID_TYPES.has(String(el.type))) continue;
    out.elements.push({
      type: String(el.type),
      x_mm: typeof el.x_mm === "number" ? el.x_mm : 0,
      y_mm: typeof el.y_mm === "number" ? el.y_mm : 0,
      w_mm: typeof el.w_mm === "number" ? el.w_mm : 10,
      h_mm: typeof el.h_mm === "number" ? el.h_mm : 5,
      z_index: typeof el.z_index === "number" ? el.z_index : i,
      rotation_deg: typeof el.rotation_deg === "number" ? el.rotation_deg : 0,
      properties: (el.properties && typeof el.properties === "object")
        ? (el.properties as Record<string, unknown>)
        : {},
    });
  }
  return out;
}

/** Replaces all elements on a page with the given list. Idempotent — running
 *  it twice with the same input ends in the same final state. */
export async function replacePageElements(
  pageId: string,
  parsed: ParsedElements,
): Promise<number> {
  const sb = getSupabaseAdmin();
  const { error: delErr } = await sb.from("gen4_elements").delete().eq("page_id", pageId);
  if (delErr) throw new Error(delErr.message);

  if (parsed.elements.length === 0) return 0;

  const rows = parsed.elements.map((el, i) => ({
    page_id: pageId,
    type: el.type,
    x_mm: el.x_mm,
    y_mm: el.y_mm,
    w_mm: el.w_mm,
    h_mm: el.h_mm,
    z_index: el.z_index ?? i,
    rotation_deg: el.rotation_deg ?? 0,
    properties: el.properties,
    origin: "ai",
  }));
  const { error } = await sb.from("gen4_elements").insert(rows);
  if (error) throw new Error(error.message);
  return rows.length;
}
