import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS_V4 } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("gen4_projects")
    .select("*")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (error || !data) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Count translatable (text/callout) elements so the translations panel
  // can show coverage as N/total without an extra round-trip from the client.
  let textElementCount = 0;
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id")
    .eq("project_id", id);
  const pageIds = (pages ?? []).map((p) => p.id);
  if (pageIds.length > 0) {
    const { count } = await sb
      .from("gen4_elements")
      .select("id", { count: "exact", head: true })
      .in("page_id", pageIds)
      .in("type", ["text", "callout"]);
    textElementCount = count ?? 0;
  }

  return NextResponse.json({ project: { ...data, text_element_count: textElementCount } });
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    default_lang?: string;
    design_system?: Record<string, unknown> | null;
  };
  const update: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (typeof body.default_lang === "string" && body.default_lang.trim()) {
    update.default_lang = body.default_lang.trim().toLowerCase();
  }
  if (body.design_system === null) {
    update.design_system = null; // explicit clear
  } else if (body.design_system && typeof body.design_system === "object") {
    update.design_system = body.design_system;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("gen4_projects")
    .update(update)
    .eq("id", id)
    .eq("owner_email", auth.email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project, error: fetchErr } = await sb
    .from("gen4_projects")
    .select("id, owner_email")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (fetchErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Best-effort cleanup of all storage under this project's prefix.
  const prefix = `${auth.email}/${id}`;
  const { data: list } = await sb.storage.from(BUCKETS_V4.IMAGES).list(prefix);
  if (list && list.length > 0) {
    const paths = list.map((f) => `${prefix}/${f.name}`);
    await sb.storage.from(BUCKETS_V4.IMAGES).remove(paths);
  }

  await sb.from("gen4_projects").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}
