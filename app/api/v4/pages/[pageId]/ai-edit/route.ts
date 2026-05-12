import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import {
  ownPage,
  buildPageEditPrompt,
  parsePageEditResponse,
  replacePageElements,
} from "@/lib/v4Edit";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Auto-tryb dla Assistant AI w editorze: jedno kliknięcie, AI wykonuje
 * polecenie i zapisuje wynik. Manualne endpointy /edit-prompt + /replace-elements
 * zostają dla fallbacku gdy klucza API nie ma.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { instruction?: string; skip_attachments?: boolean; layout_only?: boolean }
    | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }
  // layout_only / skip_attachments — pomijamy PDF reference docs gdy
  // operacja jest geometryczna (np. 'Napraw przez AI' z walidacji layoutu).
  // Bez tego Claude czyta wszystkie PDF (SAR + spec + chińska instrukcja) i
  // wywołanie przekracza 60s Vercel cap → 502/504.
  const skipAttachments = body?.skip_attachments === true || body?.layout_only === true;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY nie skonfigurowany — użyj trybu manualnego" },
      { status: 503 },
    );
  }

  const built = await buildPageEditPrompt(pageId, instruction);
  if (!built) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const sb = getSupabaseAdmin();
  const { data: pageMeta } = await sb
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  const refDocs = pageMeta && !skipAttachments ? await loadReferenceDocs(pageMeta.project_id) : [];
  const attachments = getAttachmentFileIds(refDocs);

  try {
    const ai = await callClaude({
      system: built.system,
      user: built.user,
      model: EDIT_MODEL,
      // Spis treści / strony z 20+ elementami potrafią potrzebować 6-8k tokenów
      // outputu — przy 4k Haiku obcinał JSON w środku tablicy. layout_only ma
      // niższy budżet bo zmienia tylko współrzędne, nie treść.
      maxTokens: skipAttachments ? 6000 : 12000,
      attachments: attachments.length > 0 ? attachments : undefined,
      cacheSystemPrompt: true,
    });
    const parsed = parsePageEditResponse(ai.text);
    const count = await replacePageElements(pageId, parsed);

    const { data: page } = await sb
      .from("gen4_pages")
      .select("project_id, page_number, template")
      .eq("id", pageId)
      .single();
    if (page) {
      await sb.from("gen4_ai_history").insert({
        project_id: page.project_id,
        role: "assistant",
        content: `ai-edit page ${page.page_number}: ${instruction.slice(0, 200)}`,
        structured: {
          workflow_type: "ai_edit",
          page_id: pageId,
          page_number: page.page_number,
          template: page.template,
          instruction,
          elements_count: count,
        },
        model: ai.model,
        input_tokens: ai.inputTokens,
        output_tokens: ai.outputTokens,
        latency_ms: ai.latencyMs,
      });
    }

    return NextResponse.json({ ok: true, elements: count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
