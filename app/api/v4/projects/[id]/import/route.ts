import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  bulkInsertGeneratedProject,
  parseJsonFromAi,
  validateGenerated,
} from "@/lib/v4Generate";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Manual import endpoint — accepts the JSON output from a Claude.ai
 * conversation (or any source matching the GeneratedProject schema) and
 * bulk-inserts pages + elements into the project.
 *
 * Re-importing wipes existing pages/elements first (their CASCADE removes
 * elements). This makes "rerun the prompt and import again" idempotent.
 *
 * Body shape: { json: string }  — the raw text the user pasted from Claude.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project, error: pErr } = await sb
    .from("gen4_projects")
    .select("id, owner_email")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { json?: string } | null;
  const raw = body?.json?.trim();
  if (!raw) return NextResponse.json({ error: "missing json" }, { status: 400 });

  let parsed;
  try {
    parsed = validateGenerated(parseJsonFromAi(raw));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid JSON" },
      { status: 400 },
    );
  }

  // Wipe existing pages (CASCADE removes elements) so import is idempotent.
  const { error: delErr } = await sb.from("gen4_pages").delete().eq("project_id", id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  let counts: { pages: number; elements: number };
  try {
    counts = await bulkInsertGeneratedProject(id, parsed);
  } catch (err) {
    await sb.from("gen4_projects").update({ status: "error" }).eq("id", id);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "insert failed" },
      { status: 500 },
    );
  }

  // Append a log entry — useful when admin later switches to API mode and
  // wants to see this project was originally imported manually.
  const { data: cur } = await sb
    .from("gen4_projects")
    .select("ai_log")
    .eq("id", id)
    .single();
  const log = Array.isArray(cur?.ai_log) ? cur.ai_log : [];
  log.push({ step: "manual_import", timestamp: new Date().toISOString(), pages: counts.pages, elements: counts.elements });

  await sb
    .from("gen4_projects")
    .update({ status: "ready", ai_log: log })
    .eq("id", id);

  return NextResponse.json({ ok: true, pages: counts.pages, elements: counts.elements });
}
