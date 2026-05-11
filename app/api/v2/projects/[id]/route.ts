import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin, BUCKETS_V2 as BUCKETS } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const sb = getSupabaseAdmin();
  const { data: project, error } = await sb
    .from("gen2_projects")
    .select("*")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();

  if (error || !project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ project });
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    source_pdf_pages_count?: number;
    name?: string;
  };

  const update: Record<string, unknown> = {};
  if (typeof body.source_pdf_pages_count === "number" && body.source_pdf_pages_count > 0) {
    update.source_pdf_pages_count = body.source_pdf_pages_count;
  }
  if (typeof body.name === "string" && body.name.trim()) {
    update.name = body.name.trim();
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("gen2_projects")
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
    .from("gen2_projects")
    .select("id, owner_email, source_pdf_path")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();

  if (fetchErr || !project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Best-effort: remove PDF + any files under the project prefix.
  const prefix = `${auth.email}/${id}`;
  const { data: list } = await sb.storage.from(BUCKETS.PDFS).list(prefix);
  if (list && list.length > 0) {
    const paths = list.map((f) => `${prefix}/${f.name}`);
    await sb.storage.from(BUCKETS.PDFS).remove(paths);
  }

  await sb.from("gen2_projects").delete().eq("id", id);

  return NextResponse.json({ ok: true });
}
