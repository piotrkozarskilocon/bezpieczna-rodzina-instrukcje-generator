import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createVersion } from "@/lib/v4Versions";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function ownProject(sb: ReturnType<typeof getSupabaseAdmin>, id: string, email: string): Promise<boolean> {
  const { data } = await sb.from("gen4_projects").select("owner_email").eq("id", id).single();
  return data?.owner_email === email;
}

/** GET — lista wszystkich wersji projektu (bez snapshot — tylko metadata). */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { data } = await sb
    .from("gen4_project_versions")
    .select("id, version_number, description, created_by, created_at")
    .eq("project_id", id)
    .order("version_number", { ascending: false });
  return NextResponse.json({ versions: data ?? [] });
}

/** POST — ręczny snapshot przed dużą zmianą.
 *  Body: { description?: string } */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  if (!(await ownProject(sb, id, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as { description?: string };
  await createVersion(id, body.description ?? "Ręczny snapshot", auth.email);
  return NextResponse.json({ ok: true });
}
