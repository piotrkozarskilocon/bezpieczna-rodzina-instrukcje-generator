import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface ProjectRow {
  id: string;
  name: string;
  default_lang: string;
  status: string;
  ai_input: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** GET — list user's v4 (AI-first) projects with derived page count. */
export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("gen4_projects")
    .select("id, name, default_lang, status, ai_input, created_at, updated_at")
    .eq("owner_email", auth.email)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const projectIds = (data ?? []).map((p) => p.id);
  const pageCounts = new Map<string, number>();
  if (projectIds.length > 0) {
    const { data: pages } = await sb
      .from("gen4_pages")
      .select("project_id")
      .in("project_id", projectIds);
    for (const p of pages ?? []) {
      pageCounts.set(p.project_id, (pageCounts.get(p.project_id) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    projects: (data ?? []).map((p: ProjectRow) => ({
      ...p,
      pages_count: pageCounts.get(p.id) ?? 0,
    })),
  });
}
