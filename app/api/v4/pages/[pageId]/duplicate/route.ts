/**
 * Duplikuj strone z elementami. POST /api/v4/pages/[pageId]/duplicate
 * Tworzy nowa strone tuż za oryginalem (page_number + 1, reszta przesunieta),
 * kopiuje wszystkie elementy. Zwraca { page } z nowa strona.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: src } = await sb
    .from("gen4_pages")
    .select("id, project_id, page_number, width_mm, height_mm, template, title, notes")
    .eq("id", pageId)
    .single();
  if (!src) return NextResponse.json({ error: "page not found" }, { status: 404 });

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", src.project_id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Bump wszystkie page_number > src.page_number o +1.
  const { data: laterPages } = await sb
    .from("gen4_pages")
    .select("id, page_number")
    .eq("project_id", src.project_id)
    .gt("page_number", src.page_number);
  // Atomic: najpierw temp (page_number + 10000), potem +1 zeby zachowac unique constraint.
  for (const p of laterPages ?? []) {
    await sb.from("gen4_pages").update({ page_number: 10000 + p.page_number }).eq("id", p.id);
  }
  for (const p of laterPages ?? []) {
    await sb.from("gen4_pages").update({ page_number: p.page_number + 1 }).eq("id", p.id);
  }

  // Stworz nowa strone (kopia z src + page_number + 1).
  const { data: newPage, error: insertErr } = await sb
    .from("gen4_pages")
    .insert({
      project_id: src.project_id,
      page_number: src.page_number + 1,
      width_mm: src.width_mm,
      height_mm: src.height_mm,
      template: src.template,
      title: src.title ? `${src.title} (kopia)` : null,
      notes: src.notes,
    })
    .select()
    .single();
  if (insertErr || !newPage) {
    return NextResponse.json({ error: insertErr?.message ?? "create failed" }, { status: 500 });
  }

  // Kopiuj elementy.
  const { data: srcElements } = await sb
    .from("gen4_elements")
    .select("type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .eq("page_id", src.id);
  if (srcElements && srcElements.length > 0) {
    const toInsert = srcElements.map((el) => ({
      page_id: newPage.id,
      type: el.type,
      x_mm: el.x_mm,
      y_mm: el.y_mm,
      w_mm: el.w_mm,
      h_mm: el.h_mm,
      z_index: el.z_index,
      rotation_deg: el.rotation_deg,
      properties: el.properties,
    }));
    await sb.from("gen4_elements").insert(toInsert);
  }

  return NextResponse.json({ page: newPage, copied_elements: srcElements?.length ?? 0 });
}
