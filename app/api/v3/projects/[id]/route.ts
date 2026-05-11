import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS_V3 } from "@/lib/supabase";

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
    .from("gen3_projects")
    .select("*")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (error || !data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project: data });
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    default_lang?: string;
  };
  const update: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (typeof body.default_lang === "string" && body.default_lang.trim()) {
    update.default_lang = body.default_lang.trim().toLowerCase();
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("gen3_projects")
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
    .from("gen3_projects")
    .select("id, owner_email")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (fetchErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Best-effort cleanup of all storage under this project's prefix.
  const prefix = `${auth.email}/${id}`;
  const { data: list } = await sb.storage.from(BUCKETS_V3.IMAGES).list(prefix);
  if (list && list.length > 0) {
    const paths = list.map((f) => `${prefix}/${f.name}`);
    await sb.storage.from(BUCKETS_V3.IMAGES).remove(paths);
  }

  await sb.from("gen3_projects").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}
