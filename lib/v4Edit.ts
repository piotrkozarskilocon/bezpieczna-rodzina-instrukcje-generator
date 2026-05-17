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
import { loadActiveNotes, renderNotesForPrompt } from "@/lib/v4Notes";

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
  options?: { mode?: "full" | "patches" },
): Promise<{
  system: string;
  user: string;
  combined: string;
  elementCount: number;
  elements: ElementRow[];
  mode: "full" | "patches";
} | null> {
  const mode = options?.mode ?? "full";
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

  // Model docelowy + notatki AI — wyciągamy z ai_input projektu, żeby AI
  // nie mieszał wcześniejszych modeli i pamiętał lessons learned.
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("ai_input, owner_email, document_type, device_type")
    .eq("id", page.project_id)
    .single();
  const aiInput = (project?.ai_input ?? {}) as Record<string, unknown>;
  const modelName = typeof aiInput.model_name === "string" ? aiInput.model_name : null;
  const modelCode = typeof aiInput.model_code === "string" ? aiInput.model_code : null;
  const notes = project?.owner_email
    ? await loadActiveNotes({
        owner_email: project.owner_email,
        document_type: project.document_type,
        device_type: project.device_type,
        project_id: page.project_id,
      })
    : [];
  const notesBlock = renderNotesForPrompt(notes);

  const system = [
    ...(notesBlock ? [notesBlock, ""] : []),
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
    "ITERACJA PO WSZYSTKICH ELEMENTACH (BEZWZGLĘDNIE):",
    "Gdy polecenie dotyczy WSZYSTKICH elementów określonego typu",
    "(np. 'popraw kontrast tekstów', 'zwiększ wszystkie nagłówki o 2pt',",
    "'zmień kolor akcentów'), MUSISZ przejść po KAŻDYM elemencie tego typu",
    "osobno i zastosować zmianę do KAŻDEGO z nich. NIE pomijaj żadnego.",
    "Przed odpowiedzią sprawdź: czy moja zwrócona lista zawiera tę samą liczbę",
    "elementów co wejściowa? Czy wszystkie elementy typu którego dotyczy",
    "polecenie zostały zaktualizowane?",
    "",
    "KONTRAST (gdy polecenie dotyczy kontrastu/widoczności):",
    "- Zidentyfikuj tło każdego tekstu — sprawdź rect z fill który jest pod nim",
    "  (porównaj x/y/w/h boxów i z_index).",
    "- Ciemne tło (fill < #888888) → tekst musi być JASNY (#FFFFFF lub bardzo jasny).",
    "- Jasne tło (fill > #888888 lub brak) → tekst musi być CIEMNY (#0f172a).",
    "- Jeśli tekst leży na rect który sam ma akcentowy kolor (np. pomarańczowy),",
    "  użyj białego dla pewnego kontrastu.",
    "- TO DOTYCZY KAŻDEGO TEKSTU NA STRONIE, w tym nagłówków, podpisów, list.",
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
    '    // image:        { image_id, fit_mode, opacity, grayscale? } — image_id MUSI pochodzić z listy poniżej',
    "  }",
    "}",
    "",
    "WATERMARK / TŁO OBRAZKOWE (opacity + grayscale):",
    "Gdy obrazek ma być TŁEM/watermarkiem (pełna szerokość strony, pod tekstem),",
    "użyj `opacity` 0.10–0.20 (NIE 0.03 — to byłoby niemal niewidoczne).",
    "Dla pełnego obrazka (logo, foto produktu) NIE ustawiaj opacity lub ustaw 1.0.",
    "",
    "CZARNO-BIAŁY / GRAYSCALE — gdy user prosi o watermark/obrazek 'w czerni i bieli',",
    "'czarno-biały', 'bez kolorów', 'grayscale' — dodaj `\"grayscale\": true` do properties.",
    "Renderer wymusi desaturację (CSS filter:grayscale(100%) w editorze, konwersję",
    "bytes przed embed w PDF). Bez tej flagi obrazek leci w oryginalnych kolorach.",
    "Default: grayscale FALSE (pełny kolor).",
    "",
    renderImagesForPrompt(projectImages, page.page_number),
    "",
    ...(mode === "patches"
      ? [
          "Format odpowiedzi — RFC 6902 JSON PATCH (BARDZO WAZNE):",
          "Zamiast zwracac kompletna liste elementow, zwracasz LISTE OPERACJI",
          "do wykonania na dokumencie `{elements: [...]}`. To redukuje koszt o ~85%.",
          "",
          "Operacje (RFC 6902):",
          "  - replace: zmiana wartosci w istniejacej sciezce",
          "    { op: 'replace', path: '/elements/3/properties/color', value: '#FFFFFF' }",
          "  - add: dodanie nowej wartosci lub elementu",
          "    { op: 'add', path: '/elements/-', value: {...nowy element...} }   // append",
          "    { op: 'add', path: '/elements/2/properties/grayscale', value: true }",
          "  - remove: usuniecie",
          "    { op: 'remove', path: '/elements/5' }",
          "",
          "Sciezki (JSON Pointer, RFC 6901):",
          "  /elements/N         — N-ty element (indeks 0-based!)",
          "  /elements/N/x_mm    — pole top-level elementu",
          "  /elements/N/properties/color    — zagniezdzona property",
          "  /elements/-         — append (TYLKO dla 'add' operacji)",
          "",
          "WAZNE:",
          "- Indeksy odnosza sie do AKTUALNEGO stanu strony (patrz JSON ponizej).",
          "- Operacje stosowane SEKWENCYJNIE — po 'remove /elements/3' kolejne indeksy",
          "  sie zmieniaja. NIE generuj patches ktore odwoluja sie do indeksow PO",
          "  jakims remove jezeli nie chcesz tych indeksow przesuwac. Bezpieczniej:",
          "  najpierw remove (od najwiekszego indeksu w dol), potem add/replace.",
          "- Zwracaj TYLKO te pola ktore SIE ZMIENIAJA. Nie kopiuj reszty.",
          "- Pole 'rationale' (opcjonalne) — 1-2 zdania co i dlaczego zmieniles.",
          "",
          "Strukture odpowiedzi wymusza tool `submit_page_patches` — zwroc patches.",
        ]
      : [
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
        ]),
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
    mode === "patches"
      ? "Zwroc LISTE PATCHES (RFC 6902) — tylko te pola ktore sie zmieniaja."
      : "Zwróć kompletną nową listę elementów dla tej strony.",
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

  return { system, user, combined, elementCount: elements.length, elements, mode };
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
  opts: { autoDedupe?: boolean } = {},
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

  // Post-process: deterministyczne rozwiązanie text-text overlap. AI często
  // dodaje 2-3 nakładające bloki na te same koordynaty, mimo zakazów w prompt.
  // Resolver układa je pionowo z 1mm gap — zapisuje patches do DB.
  if (opts.autoDedupe !== false) {
    try {
      await applyAutoDedupeOverlap(pageId);
    } catch (err) {
      console.warn(`[replacePageElements] auto-dedupe failed for page ${pageId}:`, err);
    }
  }

  return rows.length;
}

/** Pobiera pageHeight + świeże elementy, oblicza overlap patches, aplikuje update. */
async function applyAutoDedupeOverlap(pageId: string): Promise<void> {
  const { findOverlapGroups, resolveTextOverlaps } = await import("@/lib/v4OverlapResolver");
  const sb = getSupabaseAdmin();

  const { data: page } = await sb
    .from("gen4_pages")
    .select("height_mm")
    .eq("id", pageId)
    .single();
  if (!page) return;

  const { data: freshElements } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
    .eq("page_id", pageId);

  const els = (freshElements ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    x_mm: e.x_mm,
    y_mm: e.y_mm,
    w_mm: e.w_mm,
    h_mm: e.h_mm,
    z_index: e.z_index,
  }));

  const groups = findOverlapGroups(els);
  if (groups.length === 0) return;

  const patches = resolveTextOverlaps(els, page.height_mm, 3, 1.0);
  for (const p of patches) {
    const update: Record<string, number> = {};
    if (p.y_mm !== undefined) update.y_mm = p.y_mm;
    if (p.h_mm !== undefined) update.h_mm = p.h_mm;
    if (Object.keys(update).length === 0) continue;
    await sb.from("gen4_elements").update(update).eq("id", p.id);
  }
}
