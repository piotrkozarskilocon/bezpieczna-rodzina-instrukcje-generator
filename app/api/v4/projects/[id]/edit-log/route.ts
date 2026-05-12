import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface UnifiedEvent {
  id: string;
  source: "manual" | "ai" | "ai_edit";
  created_at: string;
  description: string;
  details?: Record<string, unknown>;
}

/** Audit log — chronologiczna lista akcji w projekcie: manualne edycje
 *  (gen4_post_edit_log source=manual) + wywołania AI (gen4_ai_history). */
export async function GET(request: NextRequest, ctx: RouteContext) {
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

  const [{ data: manualEdits }, { data: aiHistory }] = await Promise.all([
    sb
      .from("gen4_post_edit_log")
      .select("id, source, description, created_at, before_state, after_state")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    sb
      .from("gen4_ai_history")
      .select("id, content, structured, model, latency_ms, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const events: UnifiedEvent[] = [];
  for (const e of manualEdits ?? []) {
    events.push({
      id: e.id,
      source: e.source as "manual" | "ai_edit",
      created_at: e.created_at,
      description: e.description ?? "(brak opisu)",
      details: {
        before: e.before_state,
        after: e.after_state,
      },
    });
  }
  for (const a of aiHistory ?? []) {
    events.push({
      id: a.id,
      source: "ai",
      created_at: a.created_at,
      description: a.content,
      details: {
        workflow: (a.structured as Record<string, unknown> | null)?.workflow_type,
        model: a.model,
        latency_ms: a.latency_ms,
      },
    });
  }

  events.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return NextResponse.json({ events });
}
