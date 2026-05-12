import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Oznacza projekt jako zatwierdzony (lub cofa zatwierdzenie).
 *  Body: { approved_by?: string } — gdy podany niepusty = approve, null = unapprove. */
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
  if (project?.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { approved_by?: string | null };
  const approvedBy = typeof body.approved_by === "string" && body.approved_by.trim()
    ? body.approved_by.trim().slice(0, 100)
    : null;

  const { error } = await sb
    .from("gen4_projects")
    .update({
      approved_by: approvedBy,
      approved_at: approvedBy ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ approved_by: approvedBy });
}
