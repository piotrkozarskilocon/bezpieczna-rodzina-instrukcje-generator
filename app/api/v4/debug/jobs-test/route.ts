/**
 * Smoke test dla long-running jobs pipeline. Self-contained — bez UI.
 *
 * Co robi:
 *   1. Bierze ?projectId i ?dsId (lub wybiera pierwszy DS w projekcie)
 *   2. INSERT do gen4_jobs (status='queued')
 *   3. Invokuje Supabase Edge Function v4-jobs-worker (fire-and-forget)
 *   4. Poluje gen4_jobs status N razy x 2s
 *   5. Zwraca raport (job state + transitions + Edge Function URL)
 *
 * Uzycie:
 *   GET /api/v4/debug/jobs-test?projectId=<uuid>
 *   GET /api/v4/debug/jobs-test?projectId=<uuid>&dsId=<uuid>&pollSeconds=20
 *
 * Verdict w response:
 *   - "WORKER COMPLETED" — Edge Function odpaliła i skończyła sukcesem
 *   - "WORKER FAILED" — Edge Function odpaliła ale job failed
 *   - "WORKER NEVER STARTED" — status pozostal queued (Edge Function niewywolana
 *     lub nieosiagalna)
 *   - "WORKER STILL RUNNING" — poll skończył sie przed jobem
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

interface JobRow {
  id: string;
  status: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  progress: Record<string, any>;
  result: unknown;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "missing ?projectId=<uuid>" }, { status: 400 });
  }
  const pollSeconds = Math.min(parseInt(request.nextUrl.searchParams.get("pollSeconds") ?? "20", 10) || 20, 50);
  const explicitDsId = request.nextUrl.searchParams.get("dsId");

  const sb = getSupabaseAdmin();

  // Auth + project check
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  // Wybierz DS — explicit albo pierwszy w projekcie
  let dsId = explicitDsId;
  if (!dsId) {
    const { data: dsList } = await sb
      .from("gen4_design_systems")
      .select("id, name")
      .eq("project_id", projectId)
      .limit(1);
    if (!dsList || dsList.length === 0) {
      return NextResponse.json(
        { error: "no design system in project — create one first, or pass ?dsId=<uuid>" },
        { status: 400 },
      );
    }
    dsId = dsList[0].id;
  }

  // Krok 1: INSERT do gen4_jobs
  const { data: job, error: insertErr } = await sb
    .from("gen4_jobs")
    .insert({
      project_id: projectId,
      type: "apply_ds_all",
      params: { ds_id: dsId, instruction: "[smoke test]" },
      user_email: auth.email,
    })
    .select("id")
    .single();
  if (insertErr || !job) {
    return NextResponse.json({ error: `job insert failed: ${insertErr?.message ?? "unknown"}` }, { status: 500 });
  }
  const jobId = job.id;
  const insertedAt = Date.now();

  // Krok 2: invokuj Edge Function (jak w jobs route — fire-and-forget)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const apiKey =
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  const edgeUrl = supabaseUrl ? `${supabaseUrl}/functions/v1/v4-jobs-worker` : null;
  let edgeInvokeOk = false;
  let edgeInvokeError: string | null = null;
  if (edgeUrl && apiKey) {
    try {
      // Czekamy synchronicznie na response Edge Function — gdy jest osiagalna,
      // odpowie szybko (worker pracuje w tle, ale handler zwraca status 200 od razu
      // po przyjeciu? nie — nasz Deno handler czeka az job sie wykona. To znaczy
      // ze ta linia bedzie blokowac do max 150s).
      // Dla smoke testu — uzyjemy AbortController 2s timeout. Worker poleci dalej
      // w tle Supabase, my tylko sprawdzamy ze sie podjal.
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      try {
        const res = await fetch(edgeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ jobId }),
          signal: ctl.signal,
        });
        edgeInvokeOk = res.ok;
        if (!res.ok) {
          edgeInvokeError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        }
      } catch (err) {
        // AbortError = timeout 3s — worker pewnie startuje w tle, to OK
        if (err instanceof Error && err.name === "AbortError") {
          edgeInvokeOk = true;
          edgeInvokeError = "request aborted po 3s (worker leci w tle — OK)";
        } else {
          edgeInvokeError = err instanceof Error ? err.message : "unknown";
        }
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      edgeInvokeError = err instanceof Error ? err.message : "unknown error";
    }
  } else {
    edgeInvokeError = `missing config: supabaseUrl=${!!supabaseUrl} apiKey=${!!apiKey}`;
  }

  // Krok 3: polluj job status
  const transitions: Array<{ at_ms: number; status: string; progress: Record<string, unknown> }> = [];
  let lastJob: JobRow | null = null;
  const pollStart = Date.now();
  for (let i = 0; i < pollSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data } = await sb
      .from("gen4_jobs")
      .select("id, status, progress, result, error, started_at, completed_at")
      .eq("id", jobId)
      .single();
    if (!data) continue;
    const jobNow = data as JobRow;
    const prev = transitions[transitions.length - 1];
    if (!prev || prev.status !== jobNow.status || JSON.stringify(prev.progress) !== JSON.stringify(jobNow.progress)) {
      transitions.push({
        at_ms: Date.now() - pollStart,
        status: jobNow.status,
        progress: jobNow.progress,
      });
    }
    lastJob = jobNow;
    if (jobNow.status === "completed" || jobNow.status === "failed" || jobNow.status === "cancelled") break;
  }

  const finalStatus = lastJob?.status ?? "unknown";
  const verdict =
    finalStatus === "completed" ? "WORKER COMPLETED" :
    finalStatus === "failed" ? "WORKER FAILED" :
    finalStatus === "queued" ? "WORKER NEVER STARTED (queued)" :
    finalStatus === "running" ? `WORKER STILL RUNNING after ${pollSeconds}s poll (probably OK, just slow)` :
    `unexpected status: ${finalStatus}`;

  return NextResponse.json({
    verdict,
    job_id: jobId,
    ds_id: dsId,
    project_id: projectId,
    edge_function: {
      url: edgeUrl,
      invoke_ok: edgeInvokeOk,
      invoke_error: edgeInvokeError,
    },
    poll: {
      duration_seconds: pollSeconds,
      transitions,
    },
    final_job_state: lastJob,
    insert_to_first_transition_ms: transitions[0]?.at_ms ?? null,
    tip: finalStatus === "queued"
      ? "Job 'queued' przez caly poll oznacza ze Edge Function NIE odpalila joba. Sprawdz Supabase Functions logs: https://supabase.com/dashboard/project/ceewqhcoztcdsfwkwgtx/functions/v4-jobs-worker/logs"
      : finalStatus === "failed"
        ? "Job 'failed' — sprawdz final_job_state.error + Edge Function logs"
        : "Sprawdz progress.errors w final_job_state jezeli jakies stronki padly",
  });
}
