import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { parseJsonFromAi } from "@/lib/v4Generate";

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

  const body = (await request.json().catch(() => null)) as { instruction?: string } | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }

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
    "Schemat odpowiedzi (zwróć WYŁĄCZNIE poprawny JSON, bez ``` fence, bez prozy):",
    "{",
    '  "element": {',
    '    "type": "text|image|line|rect|qr|page_number|callout",',
    '    "x_mm": number, "y_mm": number, "w_mm": number, "h_mm": number,',
    '    "z_index": number, "rotation_deg": number,',
    '    "properties": { ... }',
    "  }",
    "}",
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
    "Zwróć tylko ten jeden element po poprawce.",
  ]
    .filter(Boolean)
    .join("\n");

  let ai;
  try {
    ai = await callClaude({
      system,
      user,
      model: EDIT_MODEL,
      maxTokens: 1500, // jeden element = max ~500 tokenów JSON-a
    });
  } catch (err) {
    return NextResponse.json(
      { error: `AI call failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 },
    );
  }

  let parsed: { element?: Record<string, unknown> };
  try {
    parsed = parseJsonFromAi<{ element?: Record<string, unknown> }>(ai.text);
  } catch (err) {
    return NextResponse.json(
      { error: `AI response parse failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 },
    );
  }
  const updated = parsed.element;
  if (!updated || typeof updated !== "object") {
    return NextResponse.json({ error: "AI didn't return an element" }, { status: 502 });
  }

  // Aplikuj — zachowujemy id i page_id, podmieniamy resztę.
  const patch: Record<string, unknown> = {};
  for (const key of ["type", "x_mm", "y_mm", "w_mm", "h_mm", "z_index", "rotation_deg", "properties"]) {
    if (key in updated) patch[key] = (updated as Record<string, unknown>)[key];
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
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
  });
}
