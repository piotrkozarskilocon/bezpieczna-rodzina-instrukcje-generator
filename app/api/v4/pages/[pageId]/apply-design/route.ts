import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { ownPage, parsePageEditResponse, replacePageElements } from "@/lib/v4Edit";
import { buildApplyDsToPagePrompt } from "@/lib/v4ApplyDs";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";

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
    | { ds_id?: string; instruction?: string }
    | null;
  const dsId = body?.ds_id;
  if (!dsId) return NextResponse.json({ error: "missing ds_id" }, { status: 400 });

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

  try {
    const ai = await callClaude({
      system: built.system,
      user: built.user,
      model: EDIT_MODEL,
      maxTokens: 4000,
      attachments: attachments.length > 0 ? attachments : undefined,
      // Caching — w pętli apply-DS per page (typowo 14× w wizardzie 'Zastosuj DS
      // do projektu') system prompt jest identyczny (DS content + notes + ref).
      // Pierwsze wywołanie tworzy cache, kolejne 13 ~10% kosztu input.
      cacheSystemPrompt: true,
    });
    const parsed = parsePageEditResponse(ai.text);
    const count = await replacePageElements(pageId, parsed);

    const sb = getSupabaseAdmin();
    const { data: page } = await sb
      .from("gen4_pages")
      .select("project_id, page_number, template")
      .eq("id", pageId)
      .single();
    if (page) {
      await sb.from("gen4_ai_history").insert({
        project_id: page.project_id,
        role: "assistant",
        content: `apply-design page ${page.page_number} → DS "${built.dsName}": ${count} elementów`,
        structured: {
          workflow_type: "apply_design_page",
          page_id: pageId,
          page_number: page.page_number,
          template: page.template,
          ds_id: dsId,
          ds_name: built.dsName,
          elements_count: count,
          cache_creation_tokens: ai.cacheCreationTokens,
          cache_read_tokens: ai.cacheReadTokens,
        },
        model: ai.model,
        input_tokens: ai.inputTokens,
        output_tokens: ai.outputTokens,
        latency_ms: ai.latencyMs,
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
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
