import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Lista wywolan AI dla projektu — uzywana przez Panel Debug AI w editorze.
 * Sortowane od najnowszych. Query params:
 *   - limit: default 50, max 200
 *   - page_id: opcjonalny filtr (tylko wywolania dotyczace konkretnej strony)
 *   - element_id: opcjonalny filtr (tylko wywolania dotyczace elementu)
 *   - endpoint: opcjonalny filtr (np. "ai-edit", "apply-style")
 */
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
  if (project?.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const pageIdFilter = url.searchParams.get("page_id");
  const elementIdFilter = url.searchParams.get("element_id");
  const endpointFilter = url.searchParams.get("endpoint");

  let query = sb
    .from("gen4_ai_calls")
    .select(
      "id, page_id, element_id, endpoint, context_type, user_instruction, system_prompt, user_prompt, prompt_edited_by_user, model, max_tokens, temperature, response_text, error, tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens, duration_ms, user_email, created_at",
    )
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (pageIdFilter) query = query.eq("page_id", pageIdFilter);
  if (elementIdFilter) query = query.eq("element_id", elementIdFilter);
  if (endpointFilter) query = query.eq("endpoint", endpointFilter);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ calls: data ?? [] });
}
