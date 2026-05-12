import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

/** GET — lista wszystkich projektów oznaczonych jako template (user owns).
 *  Używane w wizardzie 'Nowy projekt' jako alternatywa do generacji AI. */
export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabaseAdmin();
  const { data: projects, error } = await sb
    .from("gen4_projects")
    .select("id, name, default_lang, document_type, device_type, ai_input, created_at, updated_at")
    .eq("owner_email", auth.email)
    .eq("is_template", true)
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const projectIds = (projects ?? []).map((p) => p.id);
  const pageCounts = new Map<string, number>();
  if (projectIds.length > 0) {
    const { data: pages } = await sb
      .from("gen4_pages")
      .select("project_id")
      .in("project_id", projectIds);
    for (const p of pages ?? []) {
      pageCounts.set(p.project_id, (pageCounts.get(p.project_id) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    templates: (projects ?? []).map((p) => ({
      ...p,
      pages_count: pageCounts.get(p.id) ?? 0,
    })),
  });
}
