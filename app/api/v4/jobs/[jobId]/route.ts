/**
 * GET /api/v4/jobs/[jobId] — status + progress + result long-running joba.
 * Frontend pollu co 2s zeby pokazac user'owi progress.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { jobId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: job } = await sb
    .from("gen4_jobs")
    .select("*, gen4_projects!inner(owner_email)")
    .eq("id", jobId)
    .single();

  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownerEmail = ((job as any).gen4_projects?.owner_email ?? null) as string | null;
  if (ownerEmail !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cleanJob = { ...(job as any) };
  delete cleanJob.gen4_projects;

  return NextResponse.json({ job: cleanJob });
}
