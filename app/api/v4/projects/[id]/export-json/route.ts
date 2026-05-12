import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Eksport projektu jako neutralny JSON — do importu w Figma/InDesign/dowolnym
 *  layout tool. Format: { project, pages: [{ ...meta, elements: [...] }],
 *  design_systems: [...] }. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("id, name, default_lang, document_type, device_type, ai_input, created_at, updated_at, approved_by, approved_at")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm, template, title, notes")
    .eq("project_id", id)
    .order("page_number", { ascending: true });
  const pageIds = (pages ?? []).map((p) => p.id);
  const { data: elements } = pageIds.length > 0
    ? await sb
        .from("gen4_elements")
        .select("page_id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
        .in("page_id", pageIds)
        .order("z_index", { ascending: true })
    : { data: [] };
  const byPage = new Map<string, Array<Record<string, unknown>>>();
  for (const e of elements ?? []) {
    const arr = byPage.get(e.page_id) ?? [];
    arr.push({
      type: e.type,
      x_mm: e.x_mm,
      y_mm: e.y_mm,
      w_mm: e.w_mm,
      h_mm: e.h_mm,
      z_index: e.z_index,
      rotation_deg: e.rotation_deg,
      properties: e.properties,
    });
    byPage.set(e.page_id, arr);
  }
  const { data: designSystems } = await sb
    .from("gen4_design_systems")
    .select("name, content, is_default")
    .eq("project_id", id);

  const exportPayload = {
    project: {
      name: project.name,
      default_lang: project.default_lang,
      document_type: project.document_type,
      device_type: project.device_type,
      model_code: (project.ai_input as Record<string, unknown> | null)?.model_code,
      model_name: (project.ai_input as Record<string, unknown> | null)?.model_name,
      approved_by: project.approved_by,
      approved_at: project.approved_at,
      created_at: project.created_at,
      updated_at: project.updated_at,
    },
    pages: (pages ?? []).map((p) => ({
      page_number: p.page_number,
      width_mm: p.width_mm,
      height_mm: p.height_mm,
      template: p.template,
      title: p.title,
      notes: p.notes,
      elements: byPage.get(p.id) ?? [],
    })),
    design_systems: designSystems ?? [],
    schema_version: "gen4-export-v1",
    exported_at: new Date().toISOString(),
  };

  const filename = `${project.name.normalize("NFD").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "instrukcja"}.json`;
  return new NextResponse(JSON.stringify(exportPayload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
