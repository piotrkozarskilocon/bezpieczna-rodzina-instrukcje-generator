import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL, resolveModel } from "@/lib/anthropic";
import { parseJsonFromAi } from "@/lib/v4Generate";
import { replacePageElements } from "@/lib/v4Edit";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

async function ownPage(
  sb: ReturnType<typeof getSupabaseAdmin>,
  pageId: string,
  email: string,
): Promise<string | null> {
  const { data: page } = await sb
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  if (!page) return null;
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", page.project_id)
    .single();
  return project?.owner_email === email ? page.project_id : null;
}

/**
 * POST — zastosuj wygląd strony WZORCOWEJ do TEJ strony (target = `pageId` z URL).
 *
 * Body: { source_page_id: string }
 *
 * Frontend wywołuje ten endpoint w pętli (jeden raz per target page). Bierze
 * elementy ze source jako wzorzec stylowania (kolory, czcionki, layout patterns,
 * obecność/brak tła, akcentów, separatorów) i przepisuje target zachowując
 * jego TREŚĆ (content tekstów, image_id obrazów, page_number).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { pageId: targetPageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const projectId = await ownPage(sb, targetPageId, auth.email);
  if (!projectId) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as
    | { source_page_id?: string; model?: string; custom_system?: string; custom_user?: string }
    | null;
  const sourcePageId = body?.source_page_id?.trim();
  const chosenModel = resolveModel(body?.model, EDIT_MODEL);
  if (!sourcePageId) {
    return NextResponse.json({ error: "missing source_page_id" }, { status: 400 });
  }
  if (sourcePageId === targetPageId) {
    return NextResponse.json({ error: "source and target must differ" }, { status: 400 });
  }
  // Weryfikacja że source należy do tego samego projektu (anti-cross-project).
  const { data: srcPage } = await sb
    .from("gen4_pages")
    .select("project_id, page_number, width_mm, height_mm, template, title")
    .eq("id", sourcePageId)
    .single();
  if (!srcPage || srcPage.project_id !== projectId) {
    return NextResponse.json({ error: "source page not found in this project" }, { status: 404 });
  }

  const { data: tgtPage } = await sb
    .from("gen4_pages")
    .select("page_number, width_mm, height_mm, template, title")
    .eq("id", targetPageId)
    .single();
  if (!tgtPage) return NextResponse.json({ error: "target page not found" }, { status: 404 });

  const [{ data: srcElements }, { data: tgtElements }] = await Promise.all([
    sb
      .from("gen4_elements")
      .select("type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
      .eq("page_id", sourcePageId)
      .order("z_index", { ascending: true }),
    sb
      .from("gen4_elements")
      .select("type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
      .eq("page_id", targetPageId)
      .order("z_index", { ascending: true }),
  ]);

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 503 },
    );
  }

  const { data: project } = await sb
    .from("gen4_projects")
    .select("design_system, model_name, model_code")
    .eq("id", projectId)
    .single();

  const system = [
    "Jesteś asystentem AI ujednolicającym wygląd stron drukowanej instrukcji",
    `obsługi smartwatcha Locon. Format ${tgtPage.width_mm}x${tgtPage.height_mm} mm.`,
    "",
    "Otrzymujesz: stronę WZORCOWĄ (źródło stylu) i stronę DOCELOWĄ (do",
    "przepisania). Twoje zadanie: zastosować STYL ze wzorca do strony docelowej",
    "ZACHOWUJĄC jej TREŚĆ.",
    "",
    "CO PRZENIEŚĆ ZE WZORCA (style):",
    "- Kolory tekstów i tła (text color, rect fill).",
    "- Rozmiary czcionek per rola (nagłówek, body, podpis).",
    "- Sposób ułożenia: czy nagłówek na pasku tła, czy bez. Czy są separatory.",
    "  Czy są akcentowe boxy/listy. Czy są ikony / ozdobniki.",
    "- Marginesy i alignment.",
    "- z_index / kolejność warstw.",
    "",
    "CO ZACHOWAĆ Z DOCELOWEJ (treść):",
    "- Tekst (content) — NIE TŁUMACZ, NIE ZMIENIAJ słów.",
    "- image_id na elementach image (jeśli są).",
    "- page_number format i pozycja (chyba że wzorzec ma to inaczej i wtedy",
    "  weź pozycję ze wzorca, ale format zachowaj).",
    "- Tytuł strony — element nagłówka z napisem ze strony docelowej, ale",
    "  stylowany jak nagłówek wzorca.",
    "",
    project?.design_system
      ? [
          "DESIGN SYSTEM projektu (referencja):",
          "```json",
          JSON.stringify(project.design_system, null, 2),
          "```",
          "",
        ].join("\n")
      : "",
    project?.model_name && project?.model_code
      ? [
          "JEDEN MODEL — RYGOR:",
          `Cały dokument jest dla DOKŁADNIE JEDNEGO modelu: ${project.model_name} (${project.model_code}). Nie wprowadzaj innych kodów.`,
          "",
        ].join("\n")
      : "",
    "Zasady:",
    "- Polskie znaki diakrytyczne (ą ć ę ł ń ó ś ź ż).",
    "- UTF-8 w JSON.",
    "- Marginesy strony ~3 mm.",
    "- Strona docelowa może mieć INNĄ liczbę elementów niż wzorzec — odbuduj",
    "  na bazie potrzeb treści, ale stylując wg wzorca.",
    "",
    "Format odpowiedzi (WYŁĄCZNIE poprawny JSON, bez ``` fence, bez prozy):",
    "{",
    '  "elements": [',
    "    { ...element... }",
    "  ]",
    "}",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `STRONA WZORCOWA (źródło stylu) — strona ${srcPage.page_number}, template: ${srcPage.template ?? "blank"}, tytuł: ${srcPage.title ?? "(brak)"}.`,
    "Elementy wzorca:",
    "```json",
    JSON.stringify(srcElements ?? [], null, 2),
    "```",
    "",
    `STRONA DOCELOWA — strona ${tgtPage.page_number}, template: ${tgtPage.template ?? "blank"}, tytuł: ${tgtPage.title ?? "(brak)"}.`,
    "Elementy docelowej (treść do zachowania):",
    "```json",
    JSON.stringify(tgtElements ?? [], null, 2),
    "```",
    "",
    "Zastosuj styl wzorca do strony docelowej. Zachowaj treść.",
  ].join("\n");

  const systemPrompt = body?.custom_system && body.custom_system.trim() ? body.custom_system : system;
  const userPrompt = body?.custom_user && body.custom_user.trim() ? body.custom_user : user;
  const promptEdited = !!(body?.custom_system || body?.custom_user);
  const maxTokens = 12000;
  const startedAt = Date.now();
  const instructionDesc = `apply style from page ${srcPage.page_number} to page ${tgtPage.page_number}`;

  let ai;
  try {
    ai = await callClaude({
      system: systemPrompt,
      user: userPrompt,
      model: chosenModel,
      maxTokens,
      cacheSystemPrompt: true, // w pętli applyStyle systemy się powtarzają per target
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    void logAiCall({
      project_id: projectId,
      page_id: targetPageId,
      endpoint: "apply-style",
      context_type: "page",
      user_instruction: instructionDesc,
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

  let parsed: {
    elements?: Array<{
      type: string;
      x_mm: number;
      y_mm: number;
      w_mm: number;
      h_mm: number;
      z_index?: number;
      rotation_deg?: number;
      properties: Record<string, unknown>;
    }>;
  };
  try {
    parsed = parseJsonFromAi(ai.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    void logAiCall({
      project_id: projectId,
      page_id: targetPageId,
      endpoint: "apply-style",
      context_type: "page",
      user_instruction: instructionDesc,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      prompt_edited_by_user: promptEdited,
      model: chosenModel,
      max_tokens: maxTokens,
      response_text: ai.text,
      error: `AI response parse failed: ${msg}`,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: `AI response parse failed: ${msg}` }, { status: 502 });
  }
  if (!parsed.elements || !Array.isArray(parsed.elements)) {
    return NextResponse.json({ error: "AI didn't return elements array" }, { status: 502 });
  }

  const count = await replacePageElements(targetPageId, { elements: parsed.elements });

  void logAiCall({
    project_id: projectId,
    page_id: targetPageId,
    endpoint: "apply-style",
    context_type: "page",
    user_instruction: instructionDesc,
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

  await sb
    .from("gen4_post_edit_log")
    .insert({
      project_id: projectId,
      page_id: targetPageId,
      action: "apply_style_from_page",
      details: { source_page_id: sourcePageId, count },
      user_email: auth.email,
    })
    .then(() => {}, () => {});

  return NextResponse.json({
    count,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
  });
}
