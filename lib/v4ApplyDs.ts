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
import { loadActiveNotes, renderNotesForPrompt } from "@/lib/v4Notes";

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

/**
 * Usuwa pola identyfikujące inny model z DS jsonb zanim wyślemy go do AI.
 * DS często zawiera pola "model_name", "device_name", "product_name" które
 * leaknęły z poprzedniego projektu (np. "GOAT" w nowym projekcie Slay AI).
 * Strip jest TOP-LEVEL — nie wchodzimy głębiej żeby nie zniszczyć tokens.
 */
function sanitizeDsForPrompt(content: Record<string, unknown>): Record<string, unknown> {
  const stripKeys = new Set([
    "model_name",
    "model_code",
    "model",
    "device_name",
    "device_code",
    "device_type",
    "product_name",
    "product_code",
    "product",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(content)) {
    if (stripKeys.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function commonRules(
  doNotTranslate: string[],
  modelName?: string | null,
  modelCode?: string | null,
  pageWidth?: number,
  pageHeight?: number,
): string[] {
  const pw = pageWidth ?? 76;
  const ph = pageHeight ?? 76;
  const margin = 3;
  const maxX = pw - margin;
  const maxY = ph - margin;
  // Skalowanie max font_size dla formatu — dla 76x76 mm nagłówek max 11pt.
  // Dla większych formatów (np. A6 105x148) skala rośnie liniowo.
  const fontScale = Math.min(pw, ph) / 76;
  const maxHeader = Math.round(11 * fontScale);
  const maxBody = Math.round(7 * fontScale);
  const maxCaption = Math.round(5 * fontScale);

  return [
    "",
    "═══════════════════════════════════════════════════════════════",
    `WYMIARY STRONY — ${pw} × ${ph} mm (TWARDE OGRANICZENIA, BEZWZGLĘDNE):`,
    "═══════════════════════════════════════════════════════════════",
    `• Margines od kazdej krawedzi: ${margin} mm.`,
    `• ŻADEN element NIE MOŻE wyjść poza obszar:`,
    `    - x_mm >= ${margin} i x_mm + w_mm <= ${maxX}`,
    `    - y_mm >= ${margin} i y_mm + h_mm <= ${maxY}`,
    `• Maksymalne rozmiary czcionek dla ${pw}×${ph} mm:`,
    `    - Naglowek (tytul strony): max ${maxHeader} pt`,
    `    - Body / tresc: max ${maxBody} pt`,
    `    - Caption / podpis: max ${maxCaption} pt`,
    `• Jezeli DS proponuje wieksze fonty (np. 22pt dla titleLarge), MUSISZ je ZESKALOWAC`,
    `  do wymiarow tej strony. NIE kopiuj naiwnie wartosci z DS.`,
    "",
    "ZAKAZ DUPLIKOWANIA ELEMENTÓW (BEZWZGLĘDNY):",
    "Otrzymujesz aktualna liste elementow strony. Twoje zadanie: ZACHOWAĆ tę samą",
    "liczbę elementów (±2 maksymalnie). NIE dodawaj nowych elementow ktore powielaja",
    "tresc istniejacych. Jezeli zmieniasz styl 'listy cech', zmodyfikuj istniejaca,",
    "NIE wstawiaj drugiej listy obok. Sprawdz przed odpowiedzia: czy zwracasz +/-2",
    "elementy w stosunku do wejscia? Jezeli nie, popraw.",
    "",
    "ZAKAZ WYCHODZENIA POZA STRONĘ (TWARDY, BEZWZGLĘDNY — TOP PRIORITY):",
    `Element NIE MOŻE wystawać poza obszar strony (${pw}×${ph} mm) ani przekraczać`,
    `${margin}mm marginesu na żadnej krawędzi. Dla KAŻDEGO elementu sprawdź:`,
    `  - x_mm >= ${margin} I x_mm + w_mm <= ${maxX}`,
    `  - y_mm >= ${margin} I y_mm + h_mm <= ${maxY}`,
    "Jeśli proponowany element by wystawał — SKRÓĆ jego w_mm/h_mm albo PRZESUŃ.",
    "NIGDY nie wracaj elementu który łamie tą zasadę. Drukarnia obetnie 3mm",
    "z każdej krawędzi — wszystko poza marginesem jest stracone.",
    "",
    "GDY TREŚĆ NIE MIEŚCI SIĘ NA STRONIE — 3 STRATEGIE (W TEJ KOLEJNOŚCI):",
    "1. **Skróć treść**: usuń mniej istotne zdania, parafrazuj zwarcie.",
    "2. **Zmniejsz font** body do max 6pt (czytelność OK przy druku 76×76 mm).",
    "3. **Zaproponuj split**: jeśli mimo skrócenia + zmniejszenia fontu nadal",
    "   nie mieści się — zostaw w content notkę '/* TODO_SPLIT: ta sekcja",
    "   wymaga rozbicia na 2 strony */'. User uruchomi endpoint split lub",
    "   stworzy nową stronę z kontynuacją '(2/2)'. NIE upycaj na siłę.",
    "",
    "SPÓJNOŚĆ FONTÓW (ważne dla wyglądu projektu):",
    "Wszystkie sekcje/strony powinny używać tych SAMYCH font_size_pt dla:",
    `  - Nagłówek (page title): zwykle ${Math.round(maxHeader * 0.85)}-${maxHeader} pt`,
    `  - Body (treść): zwykle ${Math.round(maxBody * 0.7)}-${maxBody} pt (typowo 7-8 pt)`,
    `  - Caption (podpisy): zwykle ${Math.round(maxCaption * 0.8)}-${maxCaption} pt (5-6 pt)`,
    "Nie zmieniaj font_size_pt strony do strony bez powodu — projekt ma wyglądać spójnie.",
    "Wyjątek: gdy strona ma DUŻO treści i wybrałeś strategię '2. Zmniejsz font' — wtedy OK",
    "zmniejszyć do 6pt, ale tylko na TĘ stronę i tylko w body.",
    "",
    "ZAKAZ NAKŁADANIA TEKSTÓW (BEZWZGLĘDNY):",
    "ŻADNE dwa elementy typu text/callout NIE MOGĄ się nakładać (boxy axis-aligned",
    "muszą być rozłączne). To rzeczywisty bug — czytelność dokumentu znika gdy 2-3",
    "bloki tekstu są na tych samych koordynatach. Sprawdź dla każdej pary text/callout:",
    "  - jeśli a.y_mm + a.h_mm > b.y_mm I a.y_mm < b.y_mm + b.h_mm,",
    "  - I a.x_mm + a.w_mm > b.x_mm I a.x_mm < b.x_mm + b.w_mm,",
    "  - TO NAKŁADAJĄ SIĘ — przesuń jeden z nich pionowo (zwiększ y_mm) tak żeby",
    "    nie nachodziły. Marża 1mm między blokami tekstu jest OK.",
    "Jeśli musisz dodać nowy text/callout, znajdź WOLNE miejsce w stronie",
    "(np. dolna połowa, między istniejącymi blokami) — NIE wstawiaj na",
    "tę samą pozycję co istniejący.",
    "",
    "PRIORYTET 'replace' NAD 'add' (dla patches mode):",
    "Gdy potrzebujesz zmienic istniejacy element (kolor, font, pozycja), uzyj 'replace'",
    "z konkretnego path. Operacji 'add /elements/-' uzywaj TYLKO gdy element jest",
    "fundamentalnie NOWY (np. brakuje page_number a wzorzec go ma).",
    "",
    ...(modelName && modelCode
      ? [
          "JEDEN MODEL — RYGOR (BEZWZGLĘDNIE):",
          `Cały dokument jest dla DOKŁADNIE JEDNEGO modelu: ${modelName} (${modelCode}).`,
          "Nie mieszaj z innymi modelami/kodami GJD.XX. Jeśli w snapshocie albo w DS",
          "istnieje wzmianka o innym modelu (np. 'GOAT', 'Slay AI', 'Sigma') — IGNORUJ",
          `ja i uzyj WYLACZNIE '${modelName}'. DS zawiera czasem placeholdery typu`,
          `'[CURRENT_MODEL]' lub nazwy z innych projektow — w treści generowanej`,
          `MUSISZ uzyc tylko '${modelName}', niezaleznie od tego co widzisz w DS.`,
          "",
        ]
      : []),
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
    "  image:        { image_id, fit_mode, opacity, grayscale? }",
    "",
    "WATERMARK / TLO (opacity + grayscale dla image):",
    "Gdy obrazek pelni role TLA strony pod elementami tekstowymi, ustaw opacity",
    "0.10-0.20. Pelne obrazki (logo, foto) bez opacity albo z opacity 1.0.",
    "",
    "CZARNO-BIALY — gdy user prosi o watermark/obrazek 'w czerni i bieli',",
    "'czarno-bialy', 'bez kolorow', 'grayscale' — dodaj `\"grayscale\": true`",
    "do properties. Renderer wymusi desaturacje. Bez tej flagi obrazek leci",
    "w oryginalnych kolorach. Default: false.",
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

  // Model docelowy z ai_input projektu.
  const { data: projectMeta } = await sb
    .from("gen4_projects")
    .select("ai_input, owner_email, document_type, device_type")
    .eq("id", projectId)
    .single();
  const aiInput = (projectMeta?.ai_input ?? {}) as Record<string, unknown>;
  const modelName = typeof aiInput.model_name === "string" ? aiInput.model_name : null;
  const modelCode = typeof aiInput.model_code === "string" ? aiInput.model_code : null;
  const notes = projectMeta?.owner_email
    ? await loadActiveNotes({
        owner_email: projectMeta.owner_email,
        document_type: projectMeta.document_type,
        device_type: projectMeta.device_type,
        project_id: projectId,
      })
    : [];
  const notesBlock = renderNotesForPrompt(notes);

  const system = [
    ...(notesBlock ? [notesBlock, ""] : []),
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
    JSON.stringify(sanitizeDsForPrompt(ds.content), null, 2),
    "```",
    ...commonRules(
      doNotTranslate,
      modelName,
      modelCode,
      pages[0]?.width_mm ?? 76,
      pages[0]?.height_mm ?? 76,
    ),
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
  options?: { mode?: "full" | "patches" },
): Promise<{
  system: string;
  user: string;
  combined: string;
  elementCount: number;
  dsName: string;
  pageNumber: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: any[];
  mode: "full" | "patches";
} | null> {
  const mode = options?.mode ?? "full";
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

  // Model docelowy z ai_input projektu.
  const { data: projectMeta } = await sb
    .from("gen4_projects")
    .select("ai_input, owner_email, document_type, device_type")
    .eq("id", page.project_id)
    .single();
  const aiInput = (projectMeta?.ai_input ?? {}) as Record<string, unknown>;
  const modelName = typeof aiInput.model_name === "string" ? aiInput.model_name : null;
  const modelCode = typeof aiInput.model_code === "string" ? aiInput.model_code : null;
  const notes = projectMeta?.owner_email
    ? await loadActiveNotes({
        owner_email: projectMeta.owner_email,
        document_type: projectMeta.document_type,
        device_type: projectMeta.device_type,
        project_id: page.project_id,
      })
    : [];
  const notesBlock = renderNotesForPrompt(notes);

  const system = [
    ...(notesBlock ? [notesBlock, ""] : []),
    "Jesteś asystentem AI zastosowującym design system do POJEDYNCZEJ strony",
    "drukowanej instrukcji obsługi smartwatcha marki Locon.",
    "",
    "Otrzymujesz aktualny stan strony i design system. Przepisz tę stronę tak, aby",
    "była wizualnie spójna z design systemem - kolory, fonty, spacing, tone-of-voice.",
    "Zachowaj sens treści.",
    "",
    "DESIGN SYSTEM (nazwa: " + ds.name + "):",
    "```json",
    JSON.stringify(sanitizeDsForPrompt(ds.content), null, 2),
    "```",
    ...commonRules(doNotTranslate, modelName, modelCode, page.width_mm, page.height_mm),
    "",
    renderImagesForPrompt(projectImages, page.page_number),
    "",
    ...(mode === "patches"
      ? [
          "Format odpowiedzi — RFC 6902 JSON PATCH (BARDZO WAZNE):",
          "Zamiast zwracac pelna liste elementow, zwracasz LISTE OPERACJI na",
          "dokumencie `{elements: [...]}`. Redukuje koszt o ~85%.",
          "",
          "Operacje:",
          "  - { op: 'replace', path: '/elements/N/properties/color', value: '#FFFFFF' }",
          "  - { op: 'add', path: '/elements/-', value: {...nowy element...} }",
          "  - { op: 'remove', path: '/elements/N' }",
          "",
          "Sciezki uzywaja indeksow z aktualnego stanu (patrz JSON ponizej).",
          "Po remove indeksy sie zmieniaja — bezpieczniej najpierw remove od najwiekszego",
          "indeksu w dol, potem add/replace.",
          "",
          "Zwracaj TYLKO zmiany. Nie kopiuj reszty.",
          "Strukture wymusza tool `submit_page_patches`.",
        ]
      : [
          "Format odpowiedzi:",
          "ZAPISZ wynik jako ARTEFAKT (artifact) typu `application/json` o nazwie",
          `\`strona-${page.page_number}-z-ds.json\` - WYŁĄCZNIE poprawny JSON wg schematu:`,
          "{",
          '  "elements": [',
          "    { ...element1... },",
          "    { ...element2... }",
          "  ]",
          "}",
        ]),
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
  userLines.push(
    mode === "patches"
      ? `Zastosuj design system "${ds.name}" do tej strony — zwroc LISTE PATCHES (RFC 6902).`
      : `Zastosuj design system "${ds.name}" do tej strony i zwróć kompletny nowy JSON elementów.`,
  );

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
    elements: elements ?? [],
    mode,
  };
}
