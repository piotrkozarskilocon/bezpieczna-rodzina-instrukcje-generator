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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  progress?: Record<string, any>;
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

/** Dispatch dla apply_ds_all — pętla po stronach + wywolanie Vercel API.
 *  Chunking: Edge Function ma 150s budget. Gdy zbliżamy się do limitu (lub
 *  poprzednia strona zajela na tyle czasu ze kolejna nie zmiesci sie w
 *  pozostalym czasie), zapisujemy progress.next_offset + re-invokujemy
 *  siebie. Job pozostaje 'running' miedzy chunkami. */
async function runApplyDsAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  job: Job,
): Promise<{ ok: boolean; result?: unknown; error?: string; partial?: boolean }> {
  const dsId = job.params?.ds_id;
  const model = job.params?.model;
  const instruction = job.params?.instruction;
  if (!dsId) return { ok: false, error: "missing ds_id in job params" };

  const startTime = Date.now();
  // Edge Function ma 150s budgetu. Stronka apply-design typowo 4-12s.
  // Zostawiamy 30s margin na: save progress, re-invoke fetch, finish.
  const TIMEOUT_BUDGET_MS = 120_000; // bezwzgledny limit dla tego chunka
  const PAGE_TIME_BUFFER_MS = 15_000; // dodatkowy bufor dla kolejnej strony

  // Lista stron projektu.
  const { data: pages, error } = await sb
    .from("gen4_pages")
    .select("id, page_number")
    .eq("project_id", job.project_id)
    .order("page_number", { ascending: true });
  if (error) return { ok: false, error: error.message };
  if (!pages || pages.length === 0) return { ok: false, error: "project has no pages" };

  const total = pages.length;
  // Resumable: jezeli job ma juz progress z poprzedniego chunka, zacznij od next_offset.
  const startOffset = typeof job.progress?.next_offset === "number" ? job.progress.next_offset : 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevErrors: Array<{ page_number: number; error: string }> = (job.progress?.errors as any[]) ?? [];
  const errors = [...prevErrors];

  if (startOffset === 0) {
    await updateJob(sb, job.id, { progress: { done: 0, total, errors: [], next_offset: 0 } });
  } else {
    console.log(`[v4-jobs-worker] resuming job ${job.id} from offset ${startOffset}/${total}`);
  }

  const vercelOrigin = Deno.env.get("VERCEL_ORIGIN") ?? "https://bezpieczna-rodzina-instrukcje-gener.vercel.app";
  const proxySecret = Deno.env.get("INTERNAL_PROXY_SECRET") ?? "";
  const totalElements: number[] = [];
  let done = startOffset;

  for (let i = startOffset; i < pages.length; i++) {
    const page = pages[i];
    const pageStartTime = Date.now();
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
    done = i + 1;
    await updateJob(sb, job.id, {
      progress: {
        done,
        total,
        current_step: `Strona ${page.page_number}/${total}`,
        errors,
        next_offset: done,
      },
    });

    // CHUNKING: sprawdz czy mamy czas na kolejna strone.
    const elapsed = Date.now() - startTime;
    const lastPageTime = Date.now() - pageStartTime;
    const hasMorePages = i + 1 < pages.length;
    if (hasMorePages && (elapsed > TIMEOUT_BUDGET_MS || elapsed + lastPageTime + PAGE_TIME_BUFFER_MS > 150_000)) {
      console.log(`[v4-jobs-worker] chunking — elapsed=${elapsed}ms, last page=${lastPageTime}ms, re-invoking at offset ${done}/${total}`);
      // Re-invoke siebie (fire-and-forget). Verify_jwt=false wiec bez auth.
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      if (supabaseUrl) {
        fetch(`${supabaseUrl}/functions/v1/v4-jobs-worker`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.id }),
        }).catch((err) => console.error("[v4-jobs-worker] re-invoke failed:", err));
      }
      return {
        ok: false,
        partial: true,
        result: {
          pages_processed: done,
          pages_total: total,
          next_offset: done,
          chunked: true,
        },
      };
    }
  }

  return {
    ok: errors.length === 0,
    result: {
      pages_processed: done,
      pages_succeeded: done - errors.length,
      pages_total: total,
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
    .select("id, project_id, type, status, params, progress, user_email")
    .eq("id", jobId)
    .single();
  if (error || !job) {
    return new Response(JSON.stringify({ error: "job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Akceptujemy 'queued' (pierwsza inwokacja) lub 'running' z next_offset > 0
  // (resume po chunking). Wszystko inne — 409.
  const isQueued = job.status === "queued";
  const isResume = job.status === "running" && typeof job.progress?.next_offset === "number" && job.progress.next_offset > 0;
  if (!isQueued && !isResume) {
    return new Response(JSON.stringify({ error: `job already ${job.status}, no resume offset` }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pierwsza inwokacja → ustaw status running + started_at. Resume → tylko leci dalej.
  if (isQueued) {
    await updateJob(sb, job.id, { status: "running", started_at: new Date().toISOString() });
  }

  let outcome: { ok: boolean; result?: unknown; error?: string; partial?: boolean };
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

  // Gdy partial=true (chunking → re-invoke), zostawiamy status 'running' i NIE
  // ustawiamy completed_at. Worker re-invoked siebie sam, dokonczy w kolejnym call.
  if (outcome.partial) {
    return new Response(
      JSON.stringify({ jobId: job.id, ...outcome }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  await updateJob(sb, job.id, {
    status: outcome.ok ? "completed" : "failed",
    completed_at: new Date().toISOString(),
    result: outcome.result ?? null,
    error: outcome.error ?? null,
  });

  return new Response(
    JSON.stringify({ jobId: job.id, ...outcome }),
    { headers: { "Content-Type": "application/json" } },
  );
});
