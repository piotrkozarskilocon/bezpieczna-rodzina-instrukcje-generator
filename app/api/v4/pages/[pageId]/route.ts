import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/** Verify caller owns the project the page belongs to. */
async function ownPage(
  sb: ReturnType<typeof getSupabaseAdmin>,
  pageId: string,
  email: string,
): Promise<boolean> {
  const { data } = await sb
    .from("gen4_pages")
    .select("id, project_id, gen4_projects!inner(owner_email)")
    .eq("id", pageId)
    .single();
  // Supabase nested filter may not enforce — double-check explicitly.
  if (!data) return false;
  const { data: pr } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", data.project_id)
    .single();
  return pr?.owner_email === email;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownPage(sb, pageId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    template?: string;
    notes?: string;
    title?: string | null;
    width_mm?: number;
    height_mm?: number;
    page_number?: number;
  };

  const update: Record<string, unknown> = {};
  if (typeof body.template === "string") update.template = body.template;
  if (typeof body.notes === "string") update.notes = body.notes;
  // Title: empty string / null clears it; non-empty string sets it.
  if ("title" in body) {
    if (body.title === null || (typeof body.title === "string" && !body.title.trim())) {
      update.title = null;
    } else if (typeof body.title === "string") {
      update.title = body.title.trim();
    }
  }
  if (typeof body.width_mm === "number" && body.width_mm > 0) update.width_mm = body.width_mm;
  if (typeof body.height_mm === "number" && body.height_mm > 0) update.height_mm = body.height_mm;
  if (typeof body.page_number === "number" && body.page_number > 0) update.page_number = body.page_number;

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { error } = await sb.from("gen4_pages").update(update).eq("id", pageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownPage(sb, pageId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error } = await sb.from("gen4_pages").delete().eq("id", pageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
