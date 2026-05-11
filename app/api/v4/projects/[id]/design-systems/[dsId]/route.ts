import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string; dsId: string }>;
}

async function ownDs(
  sb: ReturnType<typeof getSupabaseAdmin>,
  projectId: string,
  dsId: string,
  email: string,
): Promise<boolean> {
  const { data: project } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("id", projectId)
    .eq("owner_email", email)
    .single();
  if (!project) return false;
  const { data: ds } = await sb
    .from("gen4_design_systems")
    .select("id")
    .eq("id", dsId)
    .eq("project_id", projectId)
    .single();
  return !!ds;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id, dsId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownDs(sb, id, dsId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    content?: unknown;
    is_default?: boolean;
  };
  const update: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (body.content && typeof body.content === "object") update.content = body.content;

  // Toggling is_default on requires unsetting whichever DS currently holds it.
  if (typeof body.is_default === "boolean") {
    if (body.is_default) {
      await sb
        .from("gen4_design_systems")
        .update({ is_default: false })
        .eq("project_id", id)
        .eq("is_default", true);
    }
    update.is_default = body.is_default;
  }

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { error } = await sb
    .from("gen4_design_systems")
    .update(update)
    .eq("id", dsId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id, dsId } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownDs(sb, id, dsId, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error } = await sb.from("gen4_design_systems").delete().eq("id", dsId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
