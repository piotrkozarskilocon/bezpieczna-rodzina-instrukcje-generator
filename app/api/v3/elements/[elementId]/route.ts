import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ elementId: string }>;
}

async function ownElement(
  sb: ReturnType<typeof getSupabaseAdmin>,
  elementId: string,
  email: string,
): Promise<boolean> {
  const { data: el } = await sb
    .from("gen3_elements")
    .select("page_id")
    .eq("id", elementId)
    .single();
  if (!el) return false;
  const { data: page } = await sb
    .from("gen3_pages")
    .select("project_id")
    .eq("id", el.page_id)
    .single();
  if (!page) return false;
  const { data: project } = await sb
    .from("gen3_projects")
    .select("owner_email")
    .eq("id", page.project_id)
    .single();
  return project?.owner_email === email;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { elementId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownElement(sb, elementId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    x_mm?: number;
    y_mm?: number;
    w_mm?: number;
    h_mm?: number;
    z_index?: number;
    rotation_deg?: number;
    properties?: Record<string, unknown>;
  };

  const update: Record<string, unknown> = {};
  if (typeof body.x_mm === "number") update.x_mm = body.x_mm;
  if (typeof body.y_mm === "number") update.y_mm = body.y_mm;
  if (typeof body.w_mm === "number" && body.w_mm > 0) update.w_mm = body.w_mm;
  if (typeof body.h_mm === "number" && body.h_mm > 0) update.h_mm = body.h_mm;
  if (typeof body.z_index === "number") update.z_index = body.z_index;
  if (typeof body.rotation_deg === "number") update.rotation_deg = body.rotation_deg;
  if (body.properties && typeof body.properties === "object") update.properties = body.properties;

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { error } = await sb.from("gen3_elements").update(update).eq("id", elementId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { elementId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownElement(sb, elementId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error } = await sb.from("gen3_elements").delete().eq("id", elementId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
