import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL, resolveModel } from "@/lib/anthropic";
import { logAiCall } from "@/lib/v4AiLog";
import { SingleElementPatchResponseSchema, type SingleElementPatchResponse } from "@/lib/v4Schemas";
import { applyPatch, type Operation } from "fast-json-patch";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string; elementId: string }>;
}

async function ownElement(
  sb: ReturnType<typeof getSupabaseAdmin>,
  pageId: string,
  elementId: string,
  email: string,
): Promise<boolean> {
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
  if (project?.owner_email !== email) return false;
  const { data: el } = await sb
    .from("gen4_elements")
    .select("id")
    .eq("id", elementId)
    .eq("page_id", pageId)
    .single();
  return el !== null;
}

/**
 * POST — popraw JEDEN element przez AI.
 *
 * Body: { instruction: string }
 *
 * Zwraca: { element } z nowymi wartościami (zachowane id, page_id).
 *
 * Działa szybko (Haiku, ~3-5s) bo dotyka tylko jednego elementu i nie zwraca
 * całej strony. Idealne do "popraw ten tekst", "zwiększ ten box", "zmień kolor
 * tego nagłówka". Kontekst pozostałych elementów strony przekazywany jako
 * read-only żeby AI rozumiał sąsiedztwo (overlap, contrast z tłem, alignment).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { pageId, elementId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownElement(sb, pageId, elementId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { instruction?: string; model?: string; custom_system?: string; custom_user?: string }
    | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }
  const chosenModel = resolveModel(body?.model, EDIT_MODEL);

  // Pobierz target element + kontekst (pozostałe elementy strony) + page meta.
  const { data: page } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm, template, title, project_id")
    .eq("id", pageId)
    .single();
  if (!page) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const { data: target } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .eq("id", elementId)
    .single();
  if (!target) return NextResponse.json({ error: "element not found" }, { status: 404 });

  const { data: others } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, properties")
    .eq("page_id", pageId)
    .neq("id", elementId)
    .order("z_index", { ascending: true });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured — funkcja niedostępna w trybie manualnym" },
      { status: 503 },
    );
  }

  // Załaduj design system z projektu (jeśli jest)
  const { data: project } = await sb
    .from("gen4_projects")
    .select("design_system, model_name, model_code")
    .eq("id", page.project_id)
    .single();

  const system = [
    "Jesteś asystentem AI do edycji POJEDYNCZEGO elementu na stronie drukowanej",
    "instrukcji obsługi smartwatcha Locon. Strona ma format",
    `${page.width_mm}x${page.height_mm} mm. Pracujesz w skali szarości lub kolorze.`,
    "",
    "Otrzymujesz: JEDEN konkretny element + listę pozostałych elementów strony",
    "(jako kontekst, NIE edytuj ich). Twoje zadanie: zwrócić TYLKO ten jeden",
    "poprawiony element wg polecenia użytkownika.",
    "",
    project?.design_system
      ? [
          "DESIGN SYSTEM projektu (trzymaj się tokenów):",
          "```json",
          JSON.stringify(project.design_system, null, 2),
          "```",
          "",
        ].join("\n")
      : "",
    project?.model_name && project?.model_code
      ? [
          "JEDEN MODEL — RYGOR:",
          `Cały dokument jest dla DOKŁADNIE JEDNEGO modelu: ${project.model_name} (${project.model_code}).`,
          "Nie wprowadzaj innych kodów ani nazw modeli.",
          "",
        ].join("\n")
      : "",
    "Zasady:",
    "- Polskie znaki diakrytyczne (ą ć ę ł ń ó ś ź ż) gdy generujesz polski tekst.",
    "- Surowy UTF-8 w JSON, nie sekwencje \\uXXXX.",
    "- Marginesy strony ~3 mm od każdej krawędzi — nie wychodź poza obszar.",
    "- Czcionki w pt: nagłówki 11-14, body 6-8, podpisy 4-5.",
    "- Jeśli polecenie dotyczy kontrastu: sprawdź na czym leży ten element",
    "  (rect z fill pod spodem, porównaj z_index). Ciemne tło → jasny tekst,",
    "  jasne tło → ciemny tekst.",
    "- Zachowaj `type` (nie zmieniaj text→image itd. chyba że user wprost prosi).",
    "",
    "FORMAT ODPOWIEDZI — RFC 6902 JSON Patch (BARDZO WAZNE):",
    "Zamiast zwracac caly element po zmianie, zwracasz LISTE OPERACJI ktore",
    "trzeba na nim wykonac. To redukuje koszt o ~85% i pozwala na undo.",
    "",
    "Operacje (RFC 6902):",
    "  - { op: 'replace', path: '/properties/color', value: '#FFFFFF' }",
    "    → podmienia istniejaca wartosc w tym path",
    "  - { op: 'add', path: '/properties/grayscale', value: true }",
    "    → dodaje nowe pole gdy go nie ma",
    "  - { op: 'remove', path: '/properties/opacity' }",
    "    → usuwa pole calkowicie",
    "",
    "Path to JSON Pointer (RFC 6901):",
    "  - '/x_mm'                       (pole top-level)",
    "  - '/properties/color'           (zagniezdzone)",
    "  - '/properties/font_size_pt'    (font size)",
    "",
    "PRZYKLAD — user mowi 'zmien kolor tego tekstu na bialy i zwieksz do 14pt':",
    "  patches: [",
    "    { op: 'replace', path: '/properties/color', value: '#FFFFFF' },",
    "    { op: 'replace', path: '/properties/font_size_pt', value: 14 }",
    "  ]",
    "",
    "REGUŁY:",
    "- Zwracaj TYLKO te pola ktore SIE ZMIENIAJA. Nie kopiuj reszty.",
    "- Uzywaj 'replace' gdy path istnieje, 'add' gdy nie istnieje.",
    "- NIE generuj patches ktore nic nie zmieniaja (no-op).",
    "- Jezeli zmieniasz typ elementu (type: text→image), wykonaj replace na",
    "  '/type' + nadaj nowe properties (replace/add per pole).",
    "- Pole 'rationale' (opcjonalne) — 1-2 zdania co i dlaczego zmieniles.",
    "",
    "Strukturę odpowiedzi wymusza tool `submit_element_patches` — zwroc liste",
    "patches zgodna z RFC 6902.",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `Strona numer ${page.page_number} (${page.width_mm}×${page.height_mm} mm).`,
    page.title ? `Tytuł strony: "${page.title}".` : "",
    "",
    "ELEMENT DO POPRAWY:",
    "```json",
    JSON.stringify(target, null, 2),
    "```",
    "",
    "POZOSTAŁE ELEMENTY STRONY (kontekst — NIE edytuj ich):",
    "```json",
    JSON.stringify(others ?? [], null, 2),
    "```",
    "",
    "POLECENIE UŻYTKOWNIKA:",
    instruction,
    "",
    "Zwroc LISTE PATCHES (RFC 6902) — tylko te pola ktore sie zmieniaja.",
  ]
    .filter(Boolean)
    .join("\n");

  // Override promptu przez usera (debug "Edytuj prompt przed uruchomieniem").
  const systemPrompt = body?.custom_system && body.custom_system.trim() ? body.custom_system : system;
  const userPrompt = body?.custom_user && body.custom_user.trim() ? body.custom_user : user;
  const promptEdited = !!(body?.custom_system || body?.custom_user);
  const maxTokens = 1500;
  const startedAt = Date.now();

  console.log(`[ai-fix-element] start model=${chosenModel} element=${elementId} system_len=${systemPrompt.length} user_len=${userPrompt.length}`);

  let ai;
  try {
    ai = await callClaude<SingleElementPatchResponse>({
      system: systemPrompt,
      user: userPrompt,
      model: chosenModel,
      maxTokens, // patches: zwykle 1-5 operacji = ~100-300 tokenow output
      outputSchema: {
        name: "submit_element_patches",
        description: "Submit RFC 6902 JSON Patch operations to apply on the target element.",
        schema: SingleElementPatchResponseSchema,
      },
    });
    console.log(`[ai-fix-element] AI ok in ${Date.now() - startedAt}ms, parsed=${!!ai.parsed}, patches=${ai.parsed?.patches?.length ?? 0}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[ai-fix-element] AI call failed after ${Date.now() - startedAt}ms:`, msg);
    void logAiCall({
      project_id: page.project_id,
      page_id: pageId,
      element_id: elementId,
      endpoint: "ai-fix-element",
      context_type: "element",
      user_instruction: instruction,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      prompt_edited_by_user: promptEdited,
      model: chosenModel,
      max_tokens: maxTokens,
      error: `AI call failed: ${msg}`,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: `AI call failed: ${msg}` }, { status: 502 });
  }

  // Structured output via tool_use — `ai.parsed` jest już zwalidowanym
  // SingleElementResponse (Zod sprawdził shape). Nie ma jak być błąd parsowania,
  // chyba że Anthropic w ogóle nie zwrócił tool_use bloku (catch wyżej).
  const parsed = ai.parsed;
  if (!parsed) {
    void logAiCall({
      project_id: page.project_id,
      page_id: pageId,
      element_id: elementId,
      endpoint: "ai-fix-element",
      context_type: "element",
      user_instruction: instruction,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      prompt_edited_by_user: promptEdited,
      model: chosenModel,
      max_tokens: maxTokens,
      response_text: ai.text,
      error: "AI did not return parsed tool_use output",
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: "AI did not return structured output" }, { status: 502 });
  }
  const patches = parsed.patches ?? [];
  if (!Array.isArray(patches) || patches.length === 0) {
    return NextResponse.json({ error: "AI did not return any patches (no changes)" }, { status: 502 });
  }

  // RFC 6902 apply na biezacy target element. validate=true rzuca gdy
  // ktorys patch ma niepoprawny path lub op (np. replace na non-existent).
  // Po apply mamy nowy obiekt z naniesionymi zmianami.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updated: Record<string, unknown>;
  try {
    const result = applyPatch(
      target as Record<string, unknown>,
      patches as Operation[],
      /* validateOperation */ true,
      /* mutateDocument */ false,
    );
    updated = result.newDocument as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown patch error";
    console.warn(`[ai-fix-element] applyPatch failed: ${msg}, patches=`, patches);
    return NextResponse.json(
      { error: `AI patches invalid: ${msg}`, patches, rationale: parsed.rationale },
      { status: 502 },
    );
  }

  // Aplikuj do DB — zachowujemy id i page_id, podmieniamy reszte.
  const patch: Record<string, unknown> = {};
  for (const key of ["type", "x_mm", "y_mm", "w_mm", "h_mm", "z_index", "rotation_deg", "properties"]) {
    if (key in updated) patch[key] = updated[key];
  }
  patch.updated_at = new Date().toISOString();
  const { data: saved, error } = await sb
    .from("gen4_elements")
    .update(patch)
    .eq("id", elementId)
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .single();
  if (error || !saved) {
    return NextResponse.json({ error: error?.message ?? "update failed" }, { status: 500 });
  }

  // Debug log — pelna konwersacja z AI dla panelu debug.
  void logAiCall({
    project_id: page.project_id,
    page_id: pageId,
    element_id: elementId,
    endpoint: "ai-fix-element",
    context_type: "element",
    user_instruction: instruction,
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    prompt_edited_by_user: promptEdited,
    model: chosenModel,
    max_tokens: maxTokens,
    response_text: ai.text,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
    cache_creation_tokens: ai.cacheCreationTokens ?? null,
    cache_read_tokens: ai.cacheReadTokens ?? null,
    duration_ms: Date.now() - startedAt,
    user_email: auth.email,
  });

  // Zapisz w edit log (jeśli tabela istnieje — fire-and-forget, ignoruj błędy).
  await sb
    .from("gen4_post_edit_log")
    .insert({
      project_id: page.project_id,
      page_id: pageId,
      action: "ai_fix_element",
      details: { element_id: elementId, instruction: instruction.slice(0, 500) },
      user_email: auth.email,
    })
    .then(() => {}, () => {});

  return NextResponse.json({
    element: saved,
    patches, // RFC 6902 list — frontend moze wyswietlic "co AI zmienilo"
    rationale: parsed.rationale ?? null,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
  });
}
