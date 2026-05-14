/**
 * Supabase Edge Function — worker dla long-running jobs (Generator Instrukcji v4).
 *
 * Runtime: Deno (NIE Node.js). Timeout: 150s.
 * Deploy: `supabase functions deploy v4-jobs-worker`
 *
 * Trigger: POST /functions/v1/v4-jobs-worker body { jobId }
 * Wywolywany przez Next.js endpoint POST /api/v4/jobs po utworzeniu wpisu
 * w tabeli gen4_jobs ze status='queued'. Worker:
 *   1. Loaduje job z bazy
 *   2. UPDATE status='running', started_at=now()
 *   3. Dispatching per job.type:
 *      - apply_ds_all → petla po stronach + wywolanie POST /api/v4/pages/[id]/apply-design
 *   4. Aktualizuje progress per krok
 *   5. UPDATE status='completed'/'failed', completed_at=now()
 *
 * Self-contained — uzywa fetch do Vercel API endpointow (z secret header
 * x-locon-proxy-secret), nie duplikuje logiki AI per endpoint.
 */

// Deno-specific imports — w Deno runtime to natywne. TypeScript moze pokazac
// "Cannot find module" w VS Code z Node config, ale dla Deno OK.
// @ts-expect-error Deno global available in runtime
const Deno = (globalThis as any).Deno;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSupabase(): Promise<any> {
  // Importujemy dynamicznie zeby modul ladowal sie tylko gdy worker faktycznie
  // jest wywolany. Lekkie, ale lepiej niz top-level import dla cold-start.
  // @ts-expect-error Deno-style npm import
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Edge Function env");
  }
  return createClient(url, key);
}

interface Job {
  id: string;
  project_id: string;
  type: string;
  status: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  user_email: string | null;
}

async function updateJob(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  jobId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: Record<string, any>,
): Promise<void> {
  const { error } = await sb.from("gen4_jobs").update(patch).eq("id", jobId);
  if (error) console.error(`[v4-jobs-worker] update job ${jobId} failed:`, error);
}

/** Dispatch dla apply_ds_all — pętla po stronach + wywolanie Vercel API. */
async function runApplyDsAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  job: Job,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const dsId = job.params?.ds_id;
  const model = job.params?.model;
  const instruction = job.params?.instruction;
  if (!dsId) return { ok: false, error: "missing ds_id in job params" };

  // Lista stron projektu — bedziemy iterowac po nich.
  const { data: pages, error } = await sb
    .from("gen4_pages")
    .select("id, page_number")
    .eq("project_id", job.project_id)
    .order("page_number", { ascending: true });
  if (error) return { ok: false, error: error.message };
  if (!pages || pages.length === 0) return { ok: false, error: "project has no pages" };

  const total = pages.length;
  await updateJob(sb, job.id, { progress: { done: 0, total, errors: [] } });

  const vercelOrigin = Deno.env.get("VERCEL_ORIGIN") ?? "https://bezpieczna-rodzina-instrukcje-gener.vercel.app";
  const proxySecret = Deno.env.get("INTERNAL_PROXY_SECRET") ?? "";
  const errors: Array<{ page_number: number; error: string }> = [];
  let done = 0;
  const totalElements: number[] = [];

  for (const page of pages) {
    try {
      const res = await fetch(`${vercelOrigin}/generator-instrukcji/api/v4/pages/${page.id}/apply-design/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-locon-proxy-secret": proxySecret,
          "x-locon-user-email": job.user_email ?? "",
        },
        body: JSON.stringify({ ds_id: dsId, model, instruction }),
      });
      if (!res.ok) {
        const text = await res.text();
        errors.push({ page_number: page.page_number, error: `HTTP ${res.status}: ${text.slice(0, 200)}` });
      } else {
        const j = (await res.json()) as { elements?: number };
        if (typeof j.elements === "number") totalElements.push(j.elements);
      }
    } catch (err) {
      errors.push({
        page_number: page.page_number,
        error: err instanceof Error ? err.message : "fetch failed",
      });
    }
    done++;
    await updateJob(sb, job.id, {
      progress: {
        done,
        total,
        current_step: `Strona ${page.page_number}/${total}`,
        errors,
      },
    });
  }

  return {
    ok: errors.length === 0,
    result: {
      pages_processed: done,
      pages_succeeded: done - errors.length,
      elements_total: totalElements.reduce((a, b) => a + b, 0),
    },
    error: errors.length > 0 ? `${errors.length}/${total} stron failed` : undefined,
  };
}

// Deno entry-point — handler dla HTTP request.
// @ts-expect-error Deno.serve global
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = (await req.json().catch(() => null)) as { jobId?: string } | null;
  const jobId = body?.jobId;
  if (!jobId) {
    return new Response(JSON.stringify({ error: "missing jobId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sb = await getSupabase();
  const { data: job, error } = await sb
    .from("gen4_jobs")
    .select("id, project_id, type, status, params, user_email")
    .eq("id", jobId)
    .single();
  if (error || !job) {
    return new Response(JSON.stringify({ error: "job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (job.status !== "queued") {
    return new Response(JSON.stringify({ error: `job already ${job.status}` }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  await updateJob(sb, job.id, { status: "running", started_at: new Date().toISOString() });

  let outcome: { ok: boolean; result?: unknown; error?: string };
  try {
    switch (job.type) {
      case "apply_ds_all":
        outcome = await runApplyDsAll(sb, job as Job);
        break;
      default:
        outcome = { ok: false, error: `unsupported job type: ${job.type}` };
    }
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }

  await updateJob(sb, job.id, {
    status: outcome.ok ? "completed" : "failed",
    completed_at: new Date().toISOString(),
    result: outcome.result ?? null,
    error: outcome.error ?? null,
  });

  return new Response(
    JSON.stringify({ jobId: job.id, ok: outcome.ok, ...outcome }),
    { headers: { "Content-Type": "application/json" } },
  );
});
