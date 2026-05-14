/**
 * Pelna chronologiczna konwersacja AI dla projektu — wszystkie request/response
 * pary z gen4_ai_calls. Inaczej niz /ai-history (ktora pokazuje agregaty metryk
 * z gen4_ai_history dla cost dashboard), tu zwracamy KOMPLETNE prompty i
 * odpowiedzi tak jak user wpisuje i jak Claude odpowiada — gotowe do
 * przegladania w debug panelu albo eksportu do logu rozmowy.
 *
 * Uzycie:
 *   GET /api/v4/projects/[id]/ai-conversation
 *   GET /api/v4/projects/[id]/ai-conversation?pageId=<uuid>     (filter by page)
 *   GET /api/v4/projects/[id]/ai-conversation?limit=50&offset=0 (pagination)
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const pageId = request.nextUrl.searchParams.get("pageId");
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "200", 10) || 200, 1000);
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10) || 0;

  let query = sb
    .from("gen4_ai_calls")
    .select(
      "id, page_id, element_id, endpoint, context_type, user_instruction, system_prompt, user_prompt, prompt_edited_by_user, model, max_tokens, temperature, response_text, error, tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens, duration_ms, user_email, created_at",
    )
    .eq("project_id", id)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (pageId) query = query.eq("page_id", pageId);

  const { data: calls, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    project_id: id,
    page_id_filter: pageId,
    total_returned: calls?.length ?? 0,
    limit,
    offset,
    calls: calls ?? [],
  });
}
