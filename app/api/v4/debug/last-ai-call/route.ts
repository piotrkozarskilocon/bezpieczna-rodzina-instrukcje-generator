/**
 * Endpoint diagnostyczny — zwraca ostatni AI call dla projektu z full
 * system/user prompt + response. Pomaga szybko zobaczyc co bylo wyslane
 * do Claude i co zwrocil, bez szukania w UI Panel debug AI.
 *
 * Uzycie: GET /api/v4/debug/last-ai-call?projectId=<uuid>
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "missing ?projectId=<uuid>" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: call } = await sb
    .from("gen4_ai_calls")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!call) {
    return NextResponse.json({ message: "no AI calls yet for this project" }, { status: 404 });
  }

  return NextResponse.json({ call });
}
