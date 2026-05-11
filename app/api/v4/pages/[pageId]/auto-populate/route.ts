import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { ownPage, parsePageEditResponse, replacePageElements } from "@/lib/v4Edit";
import { loadProjectImages, renderImagesForPrompt } from "@/lib/v4Generate";
import { getRequiredSections, type DocumentType, type DeviceType } from "@/lib/v4LegalTemplates";

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
  if (docType && devType) {
    const sections = getRequiredSections(docType, devType);
    // Mapujemy stronę → sekcja po position (cover=0, toc=1, reszta od 2).
    // Title match jako tie-breaker — gdy AI w szkielecie zmienił kolejność.
    const idx = page.page_number - 1;
    const match =
      sections[idx] && (page.title === null || sections[idx].title === page.title)
        ? sections[idx]
        : sections.find((s) => s.title === page.title);
    if (match) {
      sectionDescription = match.description;
      sectionPlaceholders = match.placeholders ?? [];
      sectionLegalBasis = match.legal_basis ?? "";
    }
  }

  const modelName = typeof input?.model_name === "string" ? input.model_name : "Locon Watch";
  const modelCode = typeof input?.model_code === "string" ? input.model_code : "GJD.XX";

  // Lista obrazków projektu — AI dostaje katalog z opisami.
  const projectImages = await loadProjectImages(page.project_id);

  const system = [
    "Jesteś asystentem generującym elementy POJEDYNCZEJ strony drukowanej instrukcji",
    "obsługi smartwatcha marki Locon (Bezpieczna Rodzina). Strona ma format 76x76 mm,",
    "druk w skali szarości, na cienkim papierze.",
    "",
    "Zasady językowe:",
    "- Pisz po POLSKU, używaj pełnych znaków diakrytycznych (ą ć ę ł ń ó ś ź ż).",
    "- Surowy UTF-8, nie sekwencje \\uXXXX.",
    "- Brakujące dane (numery, normy, IMEI, NIP, wartości SAR) wstaw jako placeholder:",
    "  ⚠️ DO UZUPEŁNIENIA: <opis>",
    "  NIE WYMYŚLAJ wartości technicznych ani prawnych.",
    "",
    "Zasady layoutu (mm):",
    "- Marginesy ~3 mm od krawędzi strony.",
    "- Tytuł strony jako text 11-14pt na górze (y_mm ~5).",
    "- Body text 6-8pt, podpisy 4-5pt.",
    "- Kolory grayscale: tekst #0f172a, accent #475569, jasny #94a3b8.",
    "- Numeracja: element page_number z formatem '{LANG} {n}/{N}' w prawym dolnym rogu.",
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
  } else {
    userLines.push("Treść strony: wypełnij zgodnie z template i tytułem.");
  }
  userLines.push("");
  userLines.push("Zwróć JSON z tablicą elementów (3-10 elementów dla większości stron).");

  try {
    const ai = await callClaude({
      system,
      user: userLines.join("\n"),
      model: EDIT_MODEL,
      maxTokens: 3000, // ~10 elementów = ~600-1200 tokenów output
    });
    const parsed = parsePageEditResponse(ai.text);
    const count = await replacePageElements(pageId, parsed);

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
    return NextResponse.json({ error: msg, page_id: pageId }, { status: 502 });
  }
}
