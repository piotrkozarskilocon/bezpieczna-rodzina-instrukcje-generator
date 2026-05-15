import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { ownPage, parsePageEditResponse, replacePageElements } from "@/lib/v4Edit";
import { loadProjectImages, renderImagesForPrompt } from "@/lib/v4Generate";
import { getRequiredSections, type DocumentType, type DeviceType } from "@/lib/v4LegalTemplates";
import { loadActiveNotes, renderNotesForPrompt, incrementUsedCount } from "@/lib/v4Notes";
import { loadReferenceDocs, renderReferenceDocsForPrompt, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { loadProjectImagesForAi, getImageAttachmentFileIds, renderImagesGalleryForPrompt } from "@/lib/v4Images";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Generuje elementy dla pojedynczej strony — drugi krok chunked generation.
 * Wywoływane w pętli przez frontend wizardu dla każdej strony szkieletu.
 *
 * Krótki prompt (~1500 tokenów), output ~1000-2000 tokenów → wywołanie 5-15 s,
 * komfortowo mieści się w 60s Hobby cap.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const sb = getSupabaseAdmin();
  const { data: page } = await sb
    .from("gen4_pages")
    .select("id, project_id, page_number, template, title, width_mm, height_mm")
    .eq("id", pageId)
    .single();
  if (!page) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const { data: project } = await sb
    .from("gen4_projects")
    .select("ai_input, document_type, device_type")
    .eq("id", page.project_id)
    .single();
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const docType = (project.document_type ?? null) as DocumentType | null;
  const devType = (project.device_type ?? null) as DeviceType | null;
  const input = project.ai_input as Record<string, unknown>;

  // Znajdź wymagania dla tej strony żeby AI wiedział co dokładnie ma wygenerować.
  let sectionDescription = "";
  let sectionPlaceholders: string[] = [];
  let sectionLegalBasis = "";
  let sectionNeedsImage = false;
  if (docType && devType) {
    const stepCount =
      typeof input?.step_count === "number" && input.step_count > 0 ? input.step_count : 1;
    const sections = getRequiredSections(docType, devType, stepCount);
    // Mapujemy stronę → sekcja po position (cover=0, toc=1, reszta od 2).
    // Title match jako tie-breaker — gdy AI w szkielecie zmienił kolejność lub
    // wymyślił bardziej konkretne tytuły niż "Krok N" (np. "Krok 1: Naładuj").
    const idx = page.page_number - 1;
    let match = sections[idx];
    if (!match || (page.title && match.title !== page.title)) {
      // Tytuły kroków AI zazwyczaj zaczynają od "Krok N:" — dopasuj po prefiksie.
      const titleLower = (page.title ?? "").toLowerCase();
      match =
        sections.find((s) => s.title === page.title) ??
        sections.find((s) => titleLower.startsWith(s.title.toLowerCase())) ??
        sections[idx] ??
        match;
    }
    if (match) {
      sectionDescription = match.description;
      sectionPlaceholders = match.placeholders ?? [];
      sectionLegalBasis = match.legal_basis ?? "";
      sectionNeedsImage = match.needs_image ?? false;
    }
  }

  const modelName = typeof input?.model_name === "string" ? input.model_name : "Locon Watch";
  const modelCode = typeof input?.model_code === "string" ? input.model_code : "GJD.XX";

  // Lista obrazków projektu — AI dostaje katalog z opisami.
  const projectImages = await loadProjectImages(page.project_id);
  // Obrazki ktore user explicit przypisal do tej strony (drag-drop w UI albo
  // AI suggest). To 100% pewny match — w prompcie wymuszamy uzycie image_id.
  const preferredImages = projectImages.filter((img) => img.preferred_page_id === page.id);

  // Twarde ograniczenia wymiarowe per strona (skalowane do wymiarow page).
  // To samo co w lib/v4ApplyDs commonRules — wczesniej brakowalo w auto-populate
  // -> AI generowal elementy ktore wychodzily poza 76x76 mm.
  const pw = page.width_mm;
  const ph = page.height_mm;
  const margin = 3;
  const fontScale = Math.min(pw, ph) / 76;
  const maxHeader = Math.round(11 * fontScale);
  const maxBody = Math.round(7 * fontScale);
  const maxCaption = Math.round(5 * fontScale);

  const system = [
    "Jesteś asystentem generującym elementy POJEDYNCZEJ strony drukowanej instrukcji",
    `obsługi smartwatcha marki Locon (Bezpieczna Rodzina). Strona ma format ${pw}×${ph} mm,`,
    "druk w skali szarości, na cienkim papierze.",
    "",
    "Zasady językowe:",
    "- Pisz po POLSKU, używaj pełnych znaków diakrytycznych (ą ć ę ł ń ó ś ź ż).",
    "- Surowy UTF-8, nie sekwencje \\uXXXX.",
    "- Brakujące dane (numery, normy, IMEI, NIP, wartości SAR) wstaw jako placeholder:",
    "  ⚠️ DO UZUPEŁNIENIA: <opis>",
    "  NIE WYMYŚLAJ wartości technicznych ani prawnych.",
    "",
    "═══════════════════════════════════════════════════════════════",
    `TWARDE OGRANICZENIA WYMIAROWE — ${pw}×${ph} mm (BEZWZGLĘDNE):`,
    "═══════════════════════════════════════════════════════════════",
    `• Margines od kazdej krawedzi: ${margin} mm.`,
    `• ŻADEN element NIE MOŻE wyjść poza obszar:`,
    `    - x_mm >= ${margin} i x_mm + w_mm <= ${pw - margin}`,
    `    - y_mm >= ${margin} i y_mm + h_mm <= ${ph - margin}`,
    `• Maksymalne rozmiary czcionek dla ${pw}×${ph} mm:`,
    `    - Naglowek (tytul strony): max ${maxHeader} pt (y_mm ~${margin + 2})`,
    `    - Body / tresc: max ${maxBody} pt`,
    `    - Caption / podpis: max ${maxCaption} pt`,
    `• Liczba znakow w boxie text: szacuj ~0.5*font_size mm szerokosci na znak.`,
    `  Dla body ${maxBody}pt w boxie szerokim 66mm zmiesci sie ~${Math.floor(66 / (maxBody * 0.5 * 0.353))} znakow na linie.`,
    `  Box wysoki ${maxBody}mm zmiesci ~2 linie. Jezeli tresc jest dluzsza — uzyj wiekszego h_mm albo skroc.`,
    "• Numeracja stron: element page_number w prawym dolnym rogu (x=~58, y=~70 dla 76x76).",
    "• Kolory grayscale: tekst #0f172a, accent #475569, jasny #94a3b8.",
    "",
    "ZAKAZ OVERLAP (nakladanie elementow):",
    "Elementy text NIE moga sie nakladac na inne text/image elementy. Sprawdz",
    "x_mm+w_mm vs sasiednie elementy. Background rect i page_number sa wyjatkami.",
    "",
    "Schemat elementu:",
    "{",
    '  "type": "text|image|line|rect|qr|page_number|callout",',
    '  "x_mm": 5, "y_mm": 8, "w_mm": 66, "h_mm": 8,',
    '  "z_index": 0, "rotation_deg": 0,',
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
    "JEDEN MODEL — RYGOR (BEZWZGLĘDNIE):",
    `Cały dokument jest dla DOKŁADNIE JEDNEGO modelu: ${modelName} (${modelCode}).`,
    "NIE wymieniaj w treści innych modeli, kodów ani wariantów (np. nie pisz",
    "'GJD.15 / GJD.16', nie zostawiaj poprzednich nazw modeli z biblioteki",
    "promptów). Specyfikacja techniczna, oznaczenia, deklaracja CE — wszystko",
    "MUSI dotyczyć wyłącznie tego jednego urządzenia.",
    "",
    "Format odpowiedzi — KRYTYCZNE:",
    "Zwróć WYŁĄCZNIE surowy JSON. Twoja odpowiedź MUSI zacząć się od `{`",
    "i skończyć `}`. ZAKAZANE: markdown fence ``` lub ```json, prozą wprowadzenie,",
    "komentarze, dodatkowe pola poza schematem.",
    "Schemat:",
    '{ "elements": [ { ...el1... }, { ...el2... } ] }',
  ].join("\n");

  const userLines = [
    `Wygeneruj elementy dla strony ${page.page_number}/N`,
    `Template: ${page.template ?? "blank"}`,
    `Tytuł strony: ${page.title ?? "(brak - to okładka)"}`,
    "",
    `Kontekst dokumentu: instrukcja dla modelu ${modelName} (${modelCode}).`,
    "",
  ];
  if (sectionDescription) {
    userLines.push("Treść strony (z wymagań prawnych):");
    userLines.push(sectionDescription);
    if (sectionLegalBasis) userLines.push(`Podstawa prawna: ${sectionLegalBasis}`);
    if (sectionPlaceholders.length > 0) {
      userLines.push(`Wstaw placeholdery dla: ${sectionPlaceholders.join(", ")}`);
    }
    if (sectionNeedsImage) {
      if (preferredImages.length > 0) {
        // User ma juz przypisany obrazek do tej strony — wymusilismy go (no escape).
        userLines.push(
          "⚙️ TA STRONA MA PRZYPISANY OBRAZEK W BIBLIOTECE (preferred_page_id = ta strona).",
          "MUSISZ go wstawic — to user-decision, nie wymyslaj alternatywy.",
          ...preferredImages.map((img) =>
            `  → image_id: "${img.id}" (opis: ${img.description ?? "(brak)"})`,
          ),
          "Wstaw element: { type:'image', x_mm, y_mm, w_mm 30-50, h_mm 30-50, properties:{ image_id: '<id>', fit_mode: 'contain' } }",
          "ZAKAZ uzywania image_id=null gdy preferred image istnieje. ZAKAZ pomijania go.",
        );
      } else {
        // Brak preferred — AI sam decyduje czy pasuje cos z biblioteki.
        userLines.push(
          "⚙️ TA STRONA WYMAGA OBRAZKA: zostaw miejsce ~30-50 mm szerokości na image element.",
          "Sprawdz liste obrazkow z biblioteki (powyzej w 'DOSTĘPNE OBRAZKI'). Jezeli ktorys",
          "ma opis pasujacy do tematu tej strony — UZYJ JEGO image_id (preferowany sposob).",
          "Tylko jezeli NIC nie pasuje, wstaw image_id=null + properties.placeholder_description.",
        );
      }
    }
  } else {
    userLines.push("Treść strony: wypełnij zgodnie z template i tytułem.");
  }
  userLines.push("");
  userLines.push("Zwróć JSON z tablicą elementów (3-10 elementów dla większości stron).");

  // Notatki AI + pliki referencyjne dla tego kontekstu.
  const notes = await loadActiveNotes({
    owner_email: auth.email,
    document_type: docType ?? undefined,
    device_type: devType ?? undefined,
    project_id: page.project_id,
  });
  const notesBlock = renderNotesForPrompt(notes);
  const refDocs = await loadReferenceDocs(page.project_id);
  const refBlock = renderReferenceDocsForPrompt(refDocs);
  const galleryImages = await loadProjectImagesForAi(page.project_id);
  const galleryBlock = renderImagesGalleryForPrompt(galleryImages);
  // Anthropic API request limit (~5MB). Per-page generation nie potrzebuje
  // ZADNYCH binarnych attachmentow:
  //   - PDF refDocs → tekst (extracted_summary + extracted_structured w refBlock)
  //   - Obrazki → AI wybiera image_id na podstawie OPISU z renderImagesForPrompt,
  //     nie musi widziec pixeli (i tak zwraca tylko ID).
  // To eliminuje 413 przy projektach z duzymi obrazami (>1MB PNG).
  const attachments: string[] = [];

  const finalSystem = [notesBlock, refBlock, galleryBlock, system].filter(Boolean).join("\n\n");
  const finalUser = userLines.join("\n");
  const maxTokens = 3000;
  const startedAt = Date.now();
  try {
    const ai = await callClaude({
      system: finalSystem,
      user: finalUser,
      model: EDIT_MODEL,
      maxTokens,
      attachments: attachments.length > 0 ? attachments : undefined,
      // Caching system prompt — w pętli auto-populate ~14 wywołań z identycznym
      // systemem (notes + reference summary + design rules). Pierwsze tworzy cache,
      // kolejne 13 czytają za 10% kosztu — to ~70% oszczędności na całym projekcie.
      cacheSystemPrompt: true,
    });
    void incrementUsedCount(notes.map((n) => n.id));
    const parsed = parsePageEditResponse(ai.text);

    // POST-PROCESSING: deterministycznie wymus preferred images.
    // AI czesto pomija jeden z preferred (zwlaszcza gdy strona ma 3 preferred)
    // albo wstawia obcy image_id. Sprawdzamy ktorych preferred AI nie wstawil
    // i dodajemy je rece z heurystycznym layoutem.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elementsArr = (parsed as { elements: any[] }).elements;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insertedImageIds = new Set<string>(elementsArr
      .filter((el: { type: string; properties?: { image_id?: string } }) => el.type === "image" && el.properties?.image_id)
      .map((el: { properties?: { image_id?: string } }) => el.properties!.image_id as string));
    const missingPreferred = preferredImages.filter((img) => !insertedImageIds.has(img.id));
    if (missingPreferred.length > 0) {
      // Layout heurystyka: ulozenie w pionowej kolumnie po PRAWEJ stronie,
      // od y=14 mm (poniżej tytulu) w dol. Maks 30mm szerokosc, 30mm wysokosc.
      const imgW = Math.min(30, pw - 2 * margin - 30); // zostaw min 30mm na text po lewej
      const imgH = 28;
      const imgX = pw - margin - imgW;
      let imgY = 14;
      for (const img of missingPreferred) {
        if (imgY + imgH > ph - margin) break; // brak miejsca, zostawiamy resztę
        elementsArr.push({
          type: "image",
          x_mm: imgX,
          y_mm: imgY,
          w_mm: imgW,
          h_mm: imgH,
          z_index: 2,
          rotation_deg: 0,
          properties: {
            image_id: img.id,
            fit_mode: "contain",
          },
        });
        imgY += imgH + 2;
      }
    }
    // Usun duplikaty image_id (AI moze wstawic 2 razy ten sam) — zachowaj
    // pierwszy.
    const seenIds = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parsed as { elements: any[] }).elements = elementsArr.filter((el: { type: string; properties?: { image_id?: string } }) => {
      if (el.type !== "image" || !el.properties?.image_id) return true;
      if (seenIds.has(el.properties.image_id)) return false;
      seenIds.add(el.properties.image_id);
      return true;
    });

    // Usun image elementy z image_id ktore NIE pasuje do tej strony
    // (AI czasem wybiera obrazek przypisany do innej strony). Tolerujemy obrazki
    // bez preferred_page_id (AI decision) i te ktore preferred dla TEJ strony.
    const otherStrPreferred = new Set<string>(
      projectImages
        .filter((img) => img.preferred_page_id && img.preferred_page_id !== page.id)
        .map((img) => img.id),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parsed as { elements: any[] }).elements = (parsed as { elements: any[] }).elements.filter((el: { type: string; properties?: { image_id?: string } }) => {
      if (el.type !== "image" || !el.properties?.image_id) return true;
      // Jezeli image_id jest preferred dla innej strony, usun.
      return !otherStrPreferred.has(el.properties.image_id);
    });

    const count = await replacePageElements(pageId, parsed);

    // Pelna konwersacja AI dla panelu debug — gen4_ai_calls.
    void logAiCall({
      project_id: page.project_id,
      page_id: pageId,
      endpoint: "auto-populate",
      context_type: "page",
      system_prompt: finalSystem,
      user_prompt: finalUser,
      model: ai.model,
      max_tokens: maxTokens,
      response_text: ai.text,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      cache_creation_tokens: ai.cacheCreationTokens ?? null,
      cache_read_tokens: ai.cacheReadTokens ?? null,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });

    // Telemetria — dopisujemy do gen4_ai_history.
    await sb.from("gen4_ai_history").insert({
      project_id: page.project_id,
      role: "assistant",
      content: `auto-populate page ${page.page_number}: ${count} elementów`,
      structured: {
        workflow_type: "auto_populate",
        page_id: pageId,
        page_number: page.page_number,
        template: page.template,
        elements_count: count,
        cache_creation_tokens: ai.cacheCreationTokens,
        cache_read_tokens: ai.cacheReadTokens,
      },
      model: ai.model,
      input_tokens: ai.inputTokens,
      output_tokens: ai.outputTokens,
      latency_ms: ai.latencyMs,
    });

    return NextResponse.json({
      ok: true,
      page_id: pageId,
      page_number: page.page_number,
      elements: count,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    void logAiCall({
      project_id: page.project_id,
      page_id: pageId,
      endpoint: "auto-populate",
      context_type: "page",
      system_prompt: finalSystem,
      user_prompt: finalUser,
      model: EDIT_MODEL,
      max_tokens: maxTokens,
      error: msg,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: msg, page_id: pageId }, { status: 502 });
  }
}
