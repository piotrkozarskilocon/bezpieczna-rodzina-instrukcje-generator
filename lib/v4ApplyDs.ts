/**
 * Build prompts that ask Claude to "rewrite this project / page applying
 * a specific design system" — same paste-back workflow as the existing
 * generate / page-edit prompts. Output schema is intentionally identical
 * to the matching importer endpoint, so the user can paste the JSON
 * directly into:
 *   - /api/v4/projects/[id]/import          (whole project)
 *   - /api/v4/pages/[pageId]/replace-elements (single page)
 */

import { getSupabaseAdmin } from "@/lib/supabase";
import {
  loadGlossaryDoNotTranslate,
  loadProjectImages,
  renderImagesForPrompt,
} from "@/lib/v4Generate";

interface DsRow {
  id: string;
  name: string;
  content: Record<string, unknown>;
}

async function loadDs(dsId: string, projectId: string): Promise<DsRow | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("gen4_design_systems")
    .select("id, name, content")
    .eq("id", dsId)
    .eq("project_id", projectId)
    .single();
  if (!data) return null;
  return data as DsRow;
}

function commonRules(doNotTranslate: string[]): string[] {
  return [
    "",
    "Zasady językowe:",
    "- Zachowaj polski tekst i polskie znaki diakrytyczne (ą ć ę ł ń ó ś ź ż).",
    "- Surowy UTF-8 w JSON, nie sekwencje \\uXXXX.",
    "- NIE TŁUMACZ / NIE zmieniaj poniższych terminów:",
    doNotTranslate.map((t) => `  - ${t}`).join("\n"),
    "- Nie tłumacz adresów URL, kodów modeli (GJD.XX), nazwy firmy Locon Sp. z o.o.",
    "",
    "Schemat elementu:",
    '{ "type": "text|image|line|rect|qr|page_number|callout",',
    '  "x_mm": 5, "y_mm": 8, "w_mm": 66, "h_mm": 8,',
    '  "z_index": 1, "rotation_deg": 0,',
    '  "properties": { ... type-specific fields, see schema below ... } }',
    "Properties per typ:",
    "  text/callout: { content, font_size_pt, color, align: left|center|right }",
    "  line/rect:    { stroke_width, color, fill (rect only) }",
    "  qr:           { url }",
    "  page_number:  { format: '{LANG} {n}/{N}', font_size_pt }",
    "  image:        { image_id, fit_mode }",
  ];
}

export async function buildApplyDsToProjectPrompt(
  projectId: string,
  dsId: string,
  extraInstruction?: string,
): Promise<{ system: string; user: string; combined: string; pageCount: number; dsName: string } | null> {
  const sb = getSupabaseAdmin();
  const ds = await loadDs(dsId, projectId);
  if (!ds) return null;

  // Pull whole project for the AI to rewrite.
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title, width_mm, height_mm")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  if (!pages || pages.length === 0) return null;

  const pageIds = pages.map((p) => p.id);
  const { data: elements } = await sb
    .from("gen4_elements")
    .select("page_id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .in("page_id", pageIds)
    .order("z_index", { ascending: true });

  const elsByPage = new Map<string, unknown[]>();
  for (const e of elements ?? []) {
    const arr = elsByPage.get(e.page_id) ?? [];
    arr.push({
      type: e.type,
      x_mm: e.x_mm,
      y_mm: e.y_mm,
      w_mm: e.w_mm,
      h_mm: e.h_mm,
      z_index: e.z_index,
      rotation_deg: e.rotation_deg,
      properties: e.properties,
    });
    elsByPage.set(e.page_id, arr);
  }

  const projectSnapshot = {
    pages: pages.map((p) => ({
      template: p.template,
      page_number: p.page_number,
      width_mm: p.width_mm,
      height_mm: p.height_mm,
      title: p.title ?? null,
      elements: elsByPage.get(p.id) ?? [],
    })),
  };

  const doNotTranslate = await loadGlossaryDoNotTranslate();
  const projectImages = await loadProjectImages(projectId);

  const system = [
    "Jesteś asystentem AI zastosowującym design system do KOMPLETNEJ instrukcji",
    "obsługi smartwatcha marki Locon. Otrzymujesz aktualny stan całego projektu",
    "(wszystkie strony i elementy) oraz design system (kolory, typografia, spacing,",
    "templates, brand voice).",
    "",
    "Twoja praca: PRZEPISZ wszystkie strony tak, aby były wizualnie spójne z design",
    "systemem - kolory, fonty, hierarchia, spacing, tone-of-voice. Zachowaj sens i",
    "kompletność treści (kroki, warunki gwarancji, kontakt itp.) - tylko dostosuj",
    "wygląd i sposób prezentacji.",
    "",
    "DESIGN SYSTEM (nazwa: " + ds.name + "):",
    "```json",
    JSON.stringify(ds.content, null, 2),
    "```",
    ...commonRules(doNotTranslate),
    "",
    renderImagesForPrompt(projectImages),
    "",
    "Tytuły stron i spis treści (BEZWZGLĘDNIE):",
    "- Każda strona ma pole `title` (krótki nagłówek). Zachowaj istniejące tytuły",
    "  ze snapshotu — nie zmieniaj ich brzmienia, jedynie dostosuj typografię w elementach.",
    "- Wyjątek: `template: cover` ma `title: null`.",
    "- Druga strona MUSI być template `toc` z `title: 'Spis treści'`. Jeśli w",
    "  snapshocie nie ma jeszcze strony toc, DODAJ ją zaraz po cover (wszystkie",
    "  pozostałe strony przesuwają się o +1 w numeracji) i zbuduj jej elementy",
    "  jako listę pozostałych tytułów + numerów stron.",
    "- Tytuł strony powinien też być widoczny w `elements` (zwykle jako text na",
    "  górze strony) — pomóż użytkownikowi widzieć ten sam tytuł w edytorze i na wydruku.",
    "",
    "Format odpowiedzi:",
    "ZAPISZ wynik jako ARTEFAKT (artifact) typu `application/json` o nazwie",
    "`projekt-z-ds.json` - WYŁĄCZNIE poprawny JSON wg schematu:",
    "{",
    '  "pages": [',
    '    { "template": "...", "page_number": 1, "width_mm": 76, "height_mm": 76,',
    '      "title": "Pierwsze uruchomienie", "elements": [...] }',
    "  ]",
    "}",
    "Zwróć WSZYSTKIE strony, w tej samej kolejności (z dodaną stroną toc, jeśli brakowała).",
  ].join("\n");

  const userLines = [
    "Aktualny stan projektu (do przepisania pod design system):",
    "```json",
    JSON.stringify(projectSnapshot, null, 2),
    "```",
  ];
  if (extraInstruction?.trim()) {
    userLines.push("");
    userLines.push("Dodatkowe wytyczne od użytkownika:");
    userLines.push(extraInstruction.trim());
  }
  userLines.push("");
  userLines.push(`Zastosuj design system "${ds.name}" do całego projektu i zwróć kompletny nowy JSON.`);

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

  return { system, user, combined, pageCount: pages.length, dsName: ds.name };
}

export async function buildApplyDsToPagePrompt(
  pageId: string,
  dsId: string,
  extraInstruction?: string,
): Promise<{ system: string; user: string; combined: string; elementCount: number; dsName: string; pageNumber: number } | null> {
  const sb = getSupabaseAdmin();
  const { data: page } = await sb
    .from("gen4_pages")
    .select("id, project_id, page_number, template, title, width_mm, height_mm")
    .eq("id", pageId)
    .single();
  if (!page) return null;

  const ds = await loadDs(dsId, page.project_id);
  if (!ds) return null;

  const { data: elements } = await sb
    .from("gen4_elements")
    .select("type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .eq("page_id", pageId)
    .order("z_index", { ascending: true });

  const doNotTranslate = await loadGlossaryDoNotTranslate();
  const projectImages = await loadProjectImages(page.project_id);

  const system = [
    "Jesteś asystentem AI zastosowującym design system do POJEDYNCZEJ strony",
    "drukowanej instrukcji obsługi smartwatcha marki Locon.",
    "",
    "Otrzymujesz aktualny stan strony i design system. Przepisz tę stronę tak, aby",
    "była wizualnie spójna z design systemem - kolory, fonty, spacing, tone-of-voice.",
    "Zachowaj sens treści.",
    "",
    "DESIGN SYSTEM (nazwa: " + ds.name + "):",
    "```json",
    JSON.stringify(ds.content, null, 2),
    "```",
    ...commonRules(doNotTranslate),
    "",
    renderImagesForPrompt(projectImages, page.page_number),
    "",
    "Format odpowiedzi:",
    "ZAPISZ wynik jako ARTEFAKT (artifact) typu `application/json` o nazwie",
    `\`strona-${page.page_number}-z-ds.json\` - WYŁĄCZNIE poprawny JSON wg schematu:`,
    "{",
    '  "elements": [',
    "    { ...element1... },",
    "    { ...element2... }",
    "  ]",
    "}",
  ].join("\n");

  const titleLine =
    page.template === "cover"
      ? "Tytuł strony: (brak — to okładka)"
      : `Tytuł strony: ${page.title ? `"${page.title}"` : "(jeszcze nieustalony — wymyśl krótki nagłówek pasujący do treści)"}.`;
  const userLines = [
    `Strona numer ${page.page_number} (template: ${page.template ?? "blank"}, format ${page.width_mm}x${page.height_mm} mm).`,
    titleLine,
    "Tytuł powinien pojawić się też jako widoczny nagłówek w elementach (text na górze strony).",
    `Liczba elementów obecnie: ${elements?.length ?? 0}.`,
    "",
    "Aktualny stan strony:",
    "```json",
    JSON.stringify({ elements: elements ?? [] }, null, 2),
    "```",
  ];
  if (extraInstruction?.trim()) {
    userLines.push("");
    userLines.push("Dodatkowe wytyczne od użytkownika:");
    userLines.push(extraInstruction.trim());
  }
  userLines.push("");
  userLines.push(`Zastosuj design system "${ds.name}" do tej strony i zwróć kompletny nowy JSON elementów.`);

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

  return {
    system,
    user,
    combined,
    elementCount: elements?.length ?? 0,
    dsName: ds.name,
    pageNumber: page.page_number,
  };
}
