import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Batch zapisanie preferred_page_id dla wybranych obrazków po zatwierdzeniu
 * przez usera. Body: { mappings: [{ image_id, preferred_page_id | null }] }.
 * preferred_page_id=null czyści przypisanie.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
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

  const body = (await request.json().catch(() => null)) as
    | { mappings?: Array<{ image_id?: string; preferred_page_id?: string | null }> }
    | null;
  const mappings = Array.isArray(body?.mappings) ? body!.mappings : [];
  if (mappings.length === 0) {
    return NextResponse.json({ error: "missing mappings" }, { status: 400 });
  }

  // Walidacja: image_id i preferred_page_id (jeśli != null) muszą należeć
  // do tego projektu — zapobiega cross-project pisaniu.
  const imageIds = mappings.map((m) => m.image_id).filter((x): x is string => typeof x === "string");
  const pageIds = mappings
    .map((m) => m.preferred_page_id)
    .filter((x): x is string => typeof x === "string");

  const { data: validImages } = await sb
    .from("gen4_images")
    .select("id")
    .eq("project_id", id)
    .in("id", imageIds.length > 0 ? imageIds : ["00000000-0000-0000-0000-000000000000"]);
  const validImageIds = new Set((validImages ?? []).map((r) => r.id));

  const { data: validPages } = await sb
    .from("gen4_pages")
    .select("id")
    .eq("project_id", id)
    .in("id", pageIds.length > 0 ? pageIds : ["00000000-0000-0000-0000-000000000000"]);
  const validPageIds = new Set((validPages ?? []).map((r) => r.id));

  let updated = 0;
  for (const m of mappings) {
    if (!m.image_id || !validImageIds.has(m.image_id)) continue;
    const pageId =
      typeof m.preferred_page_id === "string" && validPageIds.has(m.preferred_page_id)
        ? m.preferred_page_id
        : null;
    const { error } = await sb
      .from("gen4_images")
      .update({ preferred_page_id: pageId })
      .eq("id", m.image_id);
    if (!error) updated++;
  }

  return NextResponse.json({ updated, total: mappings.length });
}
