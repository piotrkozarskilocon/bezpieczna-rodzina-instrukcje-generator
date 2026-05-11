import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function ownProject(
  sb: ReturnType<typeof getSupabaseAdmin>,
  projectId: string,
  email: string,
): Promise<boolean> {
  const { data } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("id", projectId)
    .eq("owner_email", email)
    .single();
  return !!data;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data, error } = await sb
    .from("gen4_design_systems")
    .select("id, name, content, is_default, created_at, updated_at")
    .eq("project_id", id)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ design_systems: data ?? [] });
}

/** Creates a new design system for the project.
 *  Body: { name: string, content: object, is_default?: boolean } */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email)))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    content?: unknown;
    is_default?: boolean;
  };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 });
  if (!body.content || typeof body.content !== "object") {
    return NextResponse.json({ error: "content must be a JSON object" }, { status: 400 });
  }

  // If this one becomes default, unset any existing default first
  // (the partial unique index would otherwise reject the insert).
  if (body.is_default) {
    await sb
      .from("gen4_design_systems")
      .update({ is_default: false })
      .eq("project_id", id)
      .eq("is_default", true);
  }

  const { data, error } = await sb
    .from("gen4_design_systems")
    .insert({
      project_id: id,
      name,
      content: body.content,
      is_default: !!body.is_default,
    })
    .select("id, name, content, is_default, created_at, updated_at")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }
  return NextResponse.json({ design_system: data });
}
