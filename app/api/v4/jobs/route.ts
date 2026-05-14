/**
 * POST /api/v4/jobs — tworzy long-running job + odpala Supabase Edge Function
 * worker (fire-and-forget, worker leci 150s w tle).
 *
 * Body:
 *   {
 *     type: "apply_ds_all" | "translate_all" | "apply_style_all" | ...,
 *     project_id: uuid,
 *     params: { ... per type ... }
 *   }
 *
 * Response: { job: {...} } z status='queued'/'running'
 *
 * Frontend pollu GET /api/v4/jobs/[id] co 2s zeby zobaczyc progress.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30;

const SUPPORTED_TYPES = new Set([
  "apply_ds_all",
  "translate_all",
  "apply_style_all",
  "validate_all",
  "export_pdf",
]);

export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { type?: string; project_id?: string; params?: Record<string, unknown> }
    | null;

  const type = body?.type;
  const projectId = body?.project_id;
  const params = body?.params ?? {};

  if (!type || !SUPPORTED_TYPES.has(type)) {
    return NextResponse.json({ error: `invalid type: ${type ?? "(missing)"}` }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: "missing project_id" }, { status: 400 });
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

  // INSERT do gen4_jobs (status='queued')
  const { data: job, error: insertErr } = await sb
    .from("gen4_jobs")
    .insert({
      project_id: projectId,
      type,
      params,
      user_email: auth.email,
    })
    .select()
    .single();
  if (insertErr || !job) {
    return NextResponse.json(
      { error: `job create failed: ${insertErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Wywolanie Supabase Edge Function (fire-and-forget — worker leci 150s).
  // Funkcja sama updateuje status na 'running' a potem 'completed'/'failed'.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && anonKey) {
    // Fire-and-forget — nie blokujemy response na worker (ktory bierze 30-90s).
    // Worker leci w tle, frontend pollu GET /api/v4/jobs/[id].
    fetch(`${supabaseUrl}/functions/v1/v4-jobs-worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ jobId: job.id }),
    }).catch((err) => {
      console.error(`[jobs] worker invoke failed for ${job.id}:`, err);
    });
  } else {
    console.warn("[jobs] SUPABASE_URL / SUPABASE_ANON_KEY not set — worker NIE bedzie wywolany. Job pozostanie 'queued'.");
  }

  return NextResponse.json({ job });
}
