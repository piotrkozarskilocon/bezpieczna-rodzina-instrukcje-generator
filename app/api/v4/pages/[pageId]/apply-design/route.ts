import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL, resolveModel } from "@/lib/anthropic";
import { ownPage, replacePageElements } from "@/lib/v4Edit";
import { buildApplyDsToPagePrompt } from "@/lib/v4ApplyDs";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { logAiCall } from "@/lib/v4AiLog";
import { PageElementsResponseSchema, type PageElementsResponse } from "@/lib/v4Schemas";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Auto-tryb dla apply DS na pojedynczej stronie. Build prompt + callClaude
 * + replace w jednym wywołaniu. Frontend wywołuje to w pętli dla projektu
 * (po jednej stronie naraz, by zmieścić się w 60s Hobby).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { ds_id?: string; instruction?: string; model?: string; custom_system?: string; custom_user?: string }
    | null;
  const dsId = body?.ds_id;
  if (!dsId) return NextResponse.json({ error: "missing ds_id" }, { status: 400 });
  const chosenModel = resolveModel(body?.model, EDIT_MODEL);

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY nie skonfigurowany — użyj trybu manualnego" },
      { status: 503 },
    );
  }

  const built = await buildApplyDsToPagePrompt(pageId, dsId, body?.instruction);
  if (!built) return NextResponse.json({ error: "page or DS not found" }, { status: 404 });

  const sbForRef = getSupabaseAdmin();
  const { data: pageMeta } = await sbForRef
    .from("gen4_pages")
    .select("project_id")
    .eq("id", pageId)
    .single();
  const refDocs = pageMeta ? await loadReferenceDocs(pageMeta.project_id) : [];
  const attachments = getAttachmentFileIds(refDocs);

  const systemPrompt = body?.custom_system && body.custom_system.trim() ? body.custom_system : built.system;
  const userPrompt = body?.custom_user && body.custom_user.trim() ? body.custom_user : built.user;
  const promptEdited = !!(body?.custom_system || body?.custom_user);
  const maxTokens = 12000;
  const startedAt = Date.now();
  const instructionDesc = body?.instruction?.trim() || `apply DS "${built.dsName}" to page ${built.pageNumber}`;
  const projectIdForLog = pageMeta?.project_id ?? null;

  try {
    const ai = await callClaude<PageElementsResponse>({
      system: systemPrompt,
      user: userPrompt,
      model: chosenModel,
      maxTokens,
      attachments: attachments.length > 0 ? attachments : undefined,
      // Caching — w pętli apply-DS per page (typowo 14× w wizardzie 'Zastosuj DS
      // do projektu') system prompt jest identyczny (DS content + notes + ref).
      // Pierwsze wywołanie tworzy cache, kolejne 13 ~10% kosztu input.
      cacheSystemPrompt: true,
      outputSchema: {
        name: "submit_page_elements",
        description: "Submit the complete new list of elements for this page after applying the design system.",
        schema: PageElementsResponseSchema,
      },
    });
    if (!ai.parsed) {
      throw new Error("AI did not return structured output");
    }
    const count = await replacePageElements(pageId, ai.parsed);

    if (projectIdForLog) {
      void logAiCall({
        project_id: projectIdForLog,
        page_id: pageId,
        endpoint: "apply-design",
        context_type: "page",
        user_instruction: instructionDesc,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        prompt_edited_by_user: promptEdited,
        model: chosenModel,
        max_tokens: maxTokens,
        response_text: ai.text || JSON.stringify(ai.parsed ?? ai.rawToolInput ?? null),
        tokens_in: ai.inputTokens,
        tokens_out: ai.outputTokens,
        cache_creation_tokens: ai.cacheCreationTokens ?? null,
        cache_read_tokens: ai.cacheReadTokens ?? null,
        duration_ms: Date.now() - startedAt,
        user_email: auth.email,
      });
    }

    return NextResponse.json({
      ok: true,
      page_id: pageId,
      page_number: built.pageNumber,
      elements: count,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    if (projectIdForLog) {
      void logAiCall({
        project_id: projectIdForLog,
        page_id: pageId,
        endpoint: "apply-design",
        context_type: "page",
        user_instruction: instructionDesc,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        prompt_edited_by_user: promptEdited,
        model: chosenModel,
        max_tokens: maxTokens,
        error: msg,
        duration_ms: Date.now() - startedAt,
        user_email: auth.email,
      });
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
